import type {
  DiscoveryQuestion,
  ProjectId,
  Requirement,
  RequirementCategory,
  RequirementCoverage,
  RiskTier,
} from "@devflow/contracts";
import { z } from "@devflow/contracts";
const RequirementCategoryList = z.enum([
  "problem","target_user","user_workflow","functional_behavior","non_goals","data_model","ux_states",
  "authentication","authorization","external_integrations","failure_behavior","performance","scalability",
  "reliability","observability","security","privacy_compliance","concurrency","constraints","deployment",
  "rollback","acceptance_criteria",
]).options;
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { DevFlowConfig } from "../../lib/config.js";
import type { CompletenessModelPort } from "./requirement-completeness-engine.js";
import { DEMO_QUESTION_TEMPLATES, RequirementCompletenessEngine } from "./requirement-completeness-engine.js";

export interface CoverageSnapshot {
  coverage: RequirementCoverage[];
  overallScore: number;
  readyForPlanning: boolean;
  missingForReady: string[];
}

/**
 * One-question-at-a-time discovery loop (spec §2.1–§2.3).
 * Answers immediately update requirements + readiness; already-answered categories are never re-asked.
 */
export class DiscoveryService {
  private readonly engine: RequirementCompletenessEngine;

  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly config: Pick<DevFlowConfig, "readinessThreshold" | "criticalMissingAllowed" | "maxDiscoveryQuestions">,
    modelPort: CompletenessModelPort,
  ) {
    this.engine = new RequirementCompletenessEngine(modelPort, config);
  }

  async refreshCoverage(
    projectId: ProjectId,
    rawRequest: string,
    riskTier: RiskTier,
    repoFacts: string[],
  ): Promise<CoverageSnapshot> {
    const requirements = this.docs.list<Requirement>("requirement", projectId);
    const answered = this.docs
      .list<DiscoveryQuestion>("discovery_question", projectId)
      .filter((q) => q.status === "ANSWERED")
      .map((q) => ({ category: q.category, question: q.question, answer: q.answer ?? "" }));
    const coverage = await this.engine.computeCoverage({
      rawRequest,
      requirements,
      answeredQuestions: answered,
      repoFacts,
      riskTier,
    });
    const readiness = this.engine.readiness(coverage);
    const overall = average(coverage);
    return {
      coverage,
      overallScore: overall,
      readyForPlanning: readiness.readyForPlanning,
      missingForReady: readiness.missing,
    };
  }

  async createNextQuestion(
    projectId: ProjectId,
    rawRequest: string,
    coverage: RequirementCoverage[],
    repoCoveredCategories: Set<string>,
  ): Promise<DiscoveryQuestion | null> {
    const asked = new Set<RequirementCategory>(
      this.docs
        .list<DiscoveryQuestion>("discovery_question", projectId)
        .filter((q) => q.status === "ANSWERED" || q.status === "SKIPPED_WITH_ASSUMPTION")
        .map((q) => q.category),
    );
    if (asked.size >= this.config.maxDiscoveryQuestions) return null;
    // Never ask what the repository already answers (spec §4 Step 3).
    for (const cat of repoCoveredCategories) {
      if (RequirementCategoryList.includes(cat as never)) asked.add(cat as RequirementCategory);
    }

    const proposal = await this.engine.nextBestQuestion(coverage, asked);
    if (!proposal) return null;
    const question: DiscoveryQuestion = {
      id: newId("dq"),
      projectId,
      category: proposal.category,
      question: proposal.question,
      whyItMatters: proposal.whyItMatters,
      affectsDecision: proposal.affectsDecision,
      options: proposal.options,
      recommendedOption: proposal.recommendedOption,
      defaultAssumption: proposal.defaultAssumption,
      status: "OPEN",
      answer: null,
      answeredAt: null,
      createdAt: new Date().toISOString(),
    };
    this.docs.put("discovery_question", question.id, projectId, question);
    this.events.append({
      projectId,
      type: "discovery.question_created",
      entityType: "discovery_question",
      entityId: question.id,
      actorType: "ENGINE",
      payload: { category: question.category, question: question.question },
    });
    return question;
  }

  /** Deterministic fallback used in demo mode with no provider: cycles the template catalog. */
  createDemoQuestion(projectId: ProjectId): DiscoveryQuestion | null {
    const existing = this.docs.list<DiscoveryQuestion>("discovery_question", projectId);
    const asked = new Set(existing.map((q) => q.category));
    const template = DEMO_QUESTION_TEMPLATES.find((t) => !asked.has(t.category));
    if (!template || existing.length >= this.config.maxDiscoveryQuestions) return null;
    const question: DiscoveryQuestion = {
      id: newId("dq"),
      projectId,
      category: template.category,
      question: template.question,
      whyItMatters: template.whyItMatters,
      affectsDecision: template.affectsDecision,
      options: [...template.options],
      recommendedOption: template.recommendedOption || null,
      defaultAssumption: null,
      status: "OPEN",
      answer: null,
      answeredAt: null,
      createdAt: new Date().toISOString(),
    };
    this.docs.put("discovery_question", question.id, projectId, question);
    this.events.append({
      projectId,
      type: "discovery.question_created",
      entityType: "discovery_question",
      entityId: question.id,
      actorType: "ENGINE",
      payload: { category: question.category, demo: true },
    });
    return question;
  }

  answerQuestion(
    projectId: ProjectId,
    questionId: string,
    answer: string,
    optionKey?: string,
  ): { question: DiscoveryQuestion; requirement: Requirement } {
    const question = this.docs.require<DiscoveryQuestion>("discovery_question", questionId);
    if (question.projectId !== projectId) {
      throw new Error(`[discovery/answer] question ${questionId} does not belong to project ${projectId}`);
    }
    if (question.status === "ANSWERED") {
      throw new Error(`[discovery/answer] question ${questionId} already answered`);
    }
    const now = new Date().toISOString();
    const answered: DiscoveryQuestion = {
      ...question,
      status: "ANSWERED",
      answer,
      answeredAt: now,
    };
    this.docs.put("discovery_question", question.id, projectId, answered);

    const requirement: Requirement = {
      id: newId("req"),
      projectId,
      goalId: null,
      stableKey: nextStableKey(this.docs.list<Requirement>("requirement", projectId).map((r) => r.stableKey), "REQ"),
      category: question.category,
      statement: `${question.question} → ${answer}`,
      rationale: `From discovery answer${optionKey ? ` (option ${optionKey})` : ""}`,
      priority: "MUST",
      status: "APPROVED",
      confidence: 0.9,
      source: "USER",
      assumptions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.docs.put("requirement", requirement.id, projectId, requirement);

    this.events.append({
      projectId,
      type: "discovery.answer_received",
      entityType: "discovery_question",
      entityId: question.id,
      actorType: "USER",
      payload: { answer, optionKey: optionKey ?? null },
    });
    this.events.append({
      projectId,
      type: "requirement.discovered",
      entityType: "requirement",
      entityId: requirement.id,
      actorType: "ENGINE",
      payload: { stableKey: requirement.stableKey, category: requirement.category },
    });
    return { question: answered, requirement };
  }

  skipWithAssumption(projectId: ProjectId, questionId: string, assumptionText: string): DiscoveryQuestion {
    const question = this.docs.require<DiscoveryQuestion>("discovery_question", questionId);
    const skipped: DiscoveryQuestion = { ...question, status: "SKIPPED_WITH_ASSUMPTION", answer: assumptionText };
    this.docs.put("discovery_question", skipped.id, projectId, skipped);
    this.events.append({
      projectId,
      type: "requirement.assumption_added",
      entityType: "discovery_question",
      entityId: question.id,
      actorType: "ENGINE",
      payload: { assumption: assumptionText },
    });
    return skipped;
  }
}

function average(coverage: RequirementCoverage[]): number {
  const applicable = coverage.filter((c) => c.state !== "NOT_APPLICABLE");
  if (applicable.length === 0) return 0;
  return applicable.reduce((sum, c) => sum + c.score, 0) / applicable.length;
}

export function nextStableKey(existingKeys: string[], prefix: string): string {
  let max = 0;
  for (const key of existingKeys) {
    const match = /^([A-Z]+)-(\d+)$/.exec(key);
    if (match && match[1] === prefix) max = Math.max(max, Number.parseInt(match[2]!, 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}
