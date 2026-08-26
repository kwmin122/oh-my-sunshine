import type {
  CoverageState,
  DiscoveryQuestion,
  ModelProvider,
  Requirement,
  RequirementCategory,
  RequirementCoverage,
  TaskContract,
} from "@devflow/contracts";
import { NextQuestionOutput, parseModelJson, RequirementCoverageAnalysisOutput } from "@devflow/contracts";
import type { DevFlowConfig } from "../../lib/config.js";

/** Ports so the engine can be tested without any model provider. */
export interface CompletenessModelPort {
  analyzeCoverage(input: {
    rawRequest: string;
    existingRequirements: Requirement[];
    answeredQuestions: Array<{ category: string; question: string; answer: string }>;
    repoFacts: string[];
    riskTier: string;
  }): Promise<RequirementCoverageAnalysisOutput>;

  proposeNextQuestion(input: {
    rawRequest: string;
    coverage: RequirementCoverage[];
    askedCategories: RequirementCategory[];
  }): Promise<NextQuestionOutput | null>;
}

/**
 * Requirement Completeness Engine (spec §9).
 * Pure scoring lives here (deterministic); ambiguity detection uses the model port
 * but every output passes schema validation before touching state.
 */
export class RequirementCompletenessEngine {
  constructor(
    private readonly model: CompletenessModelPort,
    private readonly config: Pick<DevFlowConfig, "readinessThreshold" | "criticalMissingAllowed">,
  ) {}

  async computeCoverage(params: {
    rawRequest: string;
    requirements: Requirement[];
    answeredQuestions: Array<{ category: string; question: string; answer: string }>;
    repoFacts: string[];
    riskTier: string;
  }): Promise<RequirementCoverage[]> {
    const analysis = await this.model.analyzeCoverage({
      rawRequest: params.rawRequest,
      existingRequirements: params.requirements,
      answeredQuestions: params.answeredQuestions,
      repoFacts: params.repoFacts,
      riskTier: params.riskTier,
    });

    // Repo facts upgrade categories the codebase already answers (never ask what we can inspect).
    const repoCovered = new Set(params.repoFacts.map((f) => f.split("::")[0] ?? ""));
    // Answered questions are direct evidence of clarity: they deterministically raise
    // their category's score and lower ambiguity (spec §2.2 — answers update readiness).
    const answeredByCategory = new Map<string, number>();
    for (const a of params.answeredQuestions) {
      answeredByCategory.set(a.category, (answeredByCategory.get(a.category) ?? 0) + 1);
    }
    return analysis.coverage.map((entry) => {
      let { score, state, ambiguity } = entry;
      const answers = answeredByCategory.get(entry.category) ?? 0;
      if (answers > 0) {
        score = Math.max(score, Math.min(1, 0.75 + answers * 0.08));
        ambiguity = Math.max(0.05, ambiguity - 0.3 * answers);
        state = score >= 0.85 ? "CLEAR" : "PARTIAL";
      }
      if (repoCovered.has(entry.category)) {
        score = Math.min(1, score + 0.2);
        state = score >= 0.85 ? "CLEAR" : state;
      }
      return {
        ...entry,
        score,
        state,
        ambiguity,
        notes:
          answers > 0 || repoCovered.has(entry.category)
            ? [...entry.notes, ...(answers > 0 ? [`clarified by ${answers} discovery answer(s)`] : []), ...(repoCovered.has(entry.category) ? ["upgraded by repository facts"] : [])]
            : entry.notes,
      };
    });
  }

  readiness(coverage: RequirementCoverage[]): { readyForPlanning: boolean; missing: string[] } {
    const applicable = coverage.filter((c) => c.state !== "NOT_APPLICABLE");
    if (applicable.length === 0) return { readyForPlanning: false, missing: ["coverage not computed yet"] };
    const overall = applicable.reduce((sum, c) => sum + c.score, 0) / applicable.length;
    const criticalMissing = applicable.filter((c) => c.riskImpact >= 0.7 && (c.state === "MISSING" || c.score < 0.4));
    const highRiskUnknowns = applicable.filter((c) => c.ambiguity >= 0.7 && c.riskImpact >= 0.5 && c.state !== "CLEAR");
    const missing: string[] = [];
    if (overall < this.config.readinessThreshold) {
      missing.push(`overall coverage ${(overall * 100).toFixed(0)}% below threshold ${(this.config.readinessThreshold * 100).toFixed(0)}%`);
    }
    if (criticalMissing.length > this.config.criticalMissingAllowed) {
      missing.push(...criticalMissing.map((c) => `critical category incomplete: ${c.category}`));
    }
    for (const u of highRiskUnknowns) {
      missing.push(`high-risk unknown: ${u.category}`);
    }
    return { readyForPlanning: missing.length === 0, missing };
  }

  /** Deterministic priority ranking: uncertainty × impact × irreversibility proxy. */
  rankCandidateCategories(coverage: RequirementCoverage[]): RequirementCoverage[] {
    const weight: Record<CoverageState, number> = { MISSING: 1.0, PARTIAL: 0.6, CLEAR: 0.1, NOT_APPLICABLE: 0 };
    return [...coverage].sort((a, b) => scoreOf(b) - scoreOf(a));
    function scoreOf(c: RequirementCoverage): number {
      return weight[c.state] * c.riskImpact * (0.5 + c.ambiguity / 2);
    }
  }

  async nextBestQuestion(
    coverage: RequirementCoverage[],
    alreadyAsked: Set<RequirementCategory>,
  ): Promise<Omit<DiscoveryQuestion, "id" | "projectId" | "status" | "answer" | "answeredAt" | "createdAt"> | null> {
    const ranked = this.rankCandidateCategories(coverage).filter((c) => !alreadyAsked.has(c.category));
    if (ranked.length === 0 || ranked[0]!.state === "CLEAR") return null;
    try {
      const proposal = await this.model.proposeNextQuestion({ coverage, askedCategories: [...alreadyAsked], rawRequest: "" });
      if (!proposal) return null;
      return {
        category: proposal.category,
        question: proposal.question,
        whyItMatters: proposal.whyItMatters,
        affectsDecision: proposal.affectsDecision,
        options: proposal.options,
        recommendedOption: proposal.recommendedOption ?? ranked[0]!.category.replace(/_/g, " "),
        defaultAssumption: proposal.recommendedOption ?? null,
      };
    } catch {
      // Model failure must not crash discovery — fall back to a deterministic question template.
      const top = ranked[0]!;
      return deterministicFallbackQuestion(top);
    }
  }
}

function deterministicFallbackQuestion(c: RequirementCoverage): NonNullable<
  Awaited<ReturnType<RequirementCompletenessEngine["nextBestQuestion"]>>
> {
  return {
    category: c.category,
    question: `What is the expected behavior for "${c.category.replace(/_/g, " ")}"?`,
    whyItMatters: `This category is ${c.state.toLowerCase()} and carries risk impact ${c.riskImpact}.`,
    affectsDecision: "scope and acceptance criteria",
    options: [],
    recommendedOption: null,
    defaultAssumption: `Conservative default assumed for ${c.category}`,
  };
}

/** Static catalog used when no model is configured at all (demo determinism). */
export const DEMO_QUESTION_TEMPLATES: ReadonlyArray<{
  category: RequirementCategory;
  question: string;
  whyItMatters: string;
  affectsDecision: string;
  options: Array<{ key: string; label: string }>;
  recommendedOption: string;
}> = [
  {
    category: "authentication",
    question: "Should unauthenticated users be able to view any part of the product?",
    whyItMatters: "This changes routing, middleware, public API surface, and the authorization model.",
    affectsDecision: "auth architecture",
    options: [
      { key: "A", label: "Login required everywhere" },
      { key: "B", label: "Public read-only pages, login for private actions" },
      { key: "C", label: "Fully public" },
    ],
    recommendedOption: "B",
  },
  {
    category: "authorization",
    question: "Do different user roles need different permissions?",
    whyItMatters: "Role model determines data access rules and admin surfaces.",
    affectsDecision: "data model + API design",
    options: [
      { key: "A", label: "Single role" },
      { key: "B", label: "User / Admin" },
      { key: "C", label: "Fine-grained roles needed" },
    ],
    recommendedOption: "B",
  },
  {
    category: "external_integrations",
    question: "Which external providers/services must this integrate with at launch?",
    whyItMatters: "Integrations drive credentials, failure modes, and testing strategy.",
    affectsDecision: "architecture + risk tier",
    options: [],
    recommendedOption: "",
  },
  {
    category: "failure_behavior",
    question: "When an upstream dependency fails, should the feature degrade gracefully or fail loudly?",
    whyItMatters: "Determines retry policy, user messaging, and observability requirements.",
    affectsDecision: "failure handling design",
    options: [
      { key: "A", label: "Degrade gracefully" },
      { key: "B", label: "Fail loudly" },
    ],
    recommendedOption: "A",
  },
  {
    category: "functional_behavior",
    question: "What are the 2–3 concrete behaviors the feature MUST have at launch?",
    whyItMatters: "Concrete behaviors anchor task decomposition and acceptance criteria.",
    affectsDecision: "task DAG and scope",
    options: [],
    recommendedOption: "",
  },
  {
    category: "data_model",
    question: "Which core entities must be persisted, and who owns them?",
    whyItMatters: "Data ownership determines schema design, migrations, and access rules.",
    affectsDecision: "database design",
    options: [],
    recommendedOption: "",
  },
  {
    category: "security",
    question: "Which security requirements are mandatory at launch (secrets storage, transport encryption, audit logging)?",
    whyItMatters: "Security gaps discovered late force redesigns; this drives architecture and review depth.",
    affectsDecision: "risk tier and required reviews",
    options: [
      { key: "A", label: "Baseline: encrypted transport + secret store" },
      { key: "B", label: "Baseline plus audit logging" },
      { key: "C", label: "Compliance-grade (SOC2/HIPAA-like)" },
    ],
    recommendedOption: "B",
  },
  {
    category: "acceptance_criteria",
    question: "What observable outcome proves this feature works end to end?",
    whyItMatters: "Without measurable acceptance criteria completion cannot be verified.",
    affectsDecision: "verification plan",
    options: [],
    recommendedOption: "",
  },
];
