import type {
  AgentRole,
  AgentRunId,
  ModelProvider,
  Requirement,
  Review,
  ReviewFinding,
  ReviewType,
  TaskContract,
} from "@devflow/contracts";
import { FindingSeverity, newId, parseModelJson, ReviewFindingsOutput } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { DevFlowConfig } from "../../lib/config.js";

export interface ReviewCouncilPorts {
  docs: DocumentRepository;
  events: EventStore;
  provider: ModelProvider;
  config: Pick<DevFlowConfig, "findingBlockerConfidenceThreshold">;
}

/**
 * Review Council (spec §4 Step 8, §18) + two-stage review (spec §18/Step 18).
 * Findings carry severity AND confidence; low-confidence blockers do not gate (configurable).
 * Dispositions are durable — an ignored finding keeps its reason forever.
 */
export class ReviewCouncilService {
  constructor(private readonly ports: ReviewCouncilPorts) {}

  async runReview(params: {
    projectId: string;
    taskId: TaskContract | null;
    type: ReviewType;
    reviewerRole: AgentRole;
    subject: { objective: string; requirements: Requirement[]; diffSummary: string; testSummary: string };
    evidenceIds: string[];
  }): Promise<Review> {
    const { projectId, taskId, type, reviewerRole, subject } = params;
    this.ports.events.append({
      projectId,
      type: "review.started",
      entityType: "task",
      entityId: taskId?.id ?? null,
      actorType: "AGENT",
      payload: { reviewType: type, reviewer: reviewerRole.name },
    });

    const response = await this.ports.provider.generate({
      purpose: "review",
      system: `You are the ${reviewerRole.name}. ${reviewerRole.responsibility}
Review strictly and return JSON with findings[] (severity BLOCKER|HIGH|MEDIUM|LOW|NOTE, confidence 0..1, statement, evidence) and score 0..100.`,
      messages: [
        {
          role: "user",
          content: [
            `Objective: ${subject.objective}`,
            `Requirements:\n${subject.requirements.map((r) => `- [${r.stableKey}] ${r.statement}`).join("\n") || "- none recorded"}`,
            `Diff summary:\n${subject.diffSummary || "(no diff)"}`,
            `Verification summary:\n${subject.testSummary || "(none)"}`,
          ].join("\n\n"),
        },
      ],
      responseSchemaHint: '{"findings":[{"severity":"BLOCKER","confidence":0.9,"statement":"...","evidence":"..."}],"score":85,"summary":"..." }',
      maxTokens: 1500,
    });

    const parsed = parseModelJson(response.raw, ReviewFindingsOutput);
    if (!parsed.ok) {
      throw new Error(`[review-council/run] invalid model output for ${type}: ${parsed.error}`);
    }

    const findings: ReviewFinding[] = parsed.value.findings.map((f) => ({
      id: newId("finding"),
      reviewId: "",
      severity: f.severity,
      confidence: f.confidence,
      statement: f.statement,
      evidence: f.evidence,
      disposition: "OPEN" as const,
      dispositionReason: null,
    }));
    // Confidence gating (spec §3.8): only findings at/above threshold count as blocking.
    const blockingCount = findings.filter(
      (f) =>
        f.severity === "BLOCKER" ||
        (f.severity === "HIGH" && f.confidence >= this.ports.config.findingBlockerConfidenceThreshold),
    ).length;

    const review: Review = {
      id: newId("rev"),
      projectId,
      taskId: taskId?.id ?? null,
      type,
      reviewerRoleId: reviewerRole.id,
      findings: findings.map((f) => ({ ...f, reviewId: "" })),
      blockingCount,
      score: parsed.value.score,
      status: blockingCount > 0 ? "BLOCKED" : "PASSED",
      evidenceIds: params.evidenceIds,
      createdAt: new Date().toISOString(),
    };
    review.findings = review.findings.map((f) => ({ ...f, reviewId: review.id }));
    this.ports.docs.put("review", review.id, projectId, review);
    this.ports.events.append({
      projectId,
      type: review.status === "BLOCKED" ? "review.blocked" : "review.passed",
      entityType: "review",
      entityId: review.id,
      actorType: "AGENT",
      payload: { reviewType: type, blockingCount, score: review.score },
    });
    return review;
  }

  /** Ignoring a finding REQUIRES a durable reason (spec §3.8). */
  setDisposition(reviewId: string, findingId: string, disposition: Exclude<ReviewFinding["disposition"], "OPEN">, reason: string): Review {
    const review = this.ports.docs.require<Review>("review", reviewId);
    const finding = review.findings.find((f) => f.id === findingId);
    if (!finding) throw new Error(`[review-council/setDisposition] finding '${findingId}' not in review '${reviewId}'`);
    if ((disposition === "IGNORED_WITH_REASON" || disposition === "ACCEPTED") && reason.trim().length === 0) {
      throw new Error("[review-council/setDisposition] ignoring/accepting a finding requires a non-empty durable reason");
    }
    finding.disposition = disposition;
    finding.dispositionReason = reason;
    // Un-blocking: if no OPEN blocker remains, the review passes.
    const stillBlocking = review.findings.some(
      (f) =>
        f.disposition === "OPEN" &&
        (f.severity === "BLOCKER" || (f.severity === "HIGH" && f.confidence >= this.ports.config.findingBlockerConfidenceThreshold)),
    );
    review.blockingCount = stillBlocking ? 1 : 0;
    review.status = stillBlocking ? "BLOCKED" : "PASSED";
    this.ports.docs.put("review", review.id, review.projectId, review);
    return review;
  }
}

/** Default role catalog (spec §19). Roles are templates — instantiated only when needed. */
export function defaultAgentRoles(): AgentRole[] {
  const mk = (id: string, name: string, responsibility: string, preset: AgentRole["defaultPolicyPreset"]): AgentRole => ({
    id: newId(`role_${id}`),
    name,
    responsibility,
    defaultSkills: [],
    defaultPolicyPreset: preset,
  });
  return [
    mk("pm", "Product Manager", "Owns problem framing, scope, success metrics.", "READ_ONLY"),
    mk("discovery", "Discovery Interviewer", "Runs adversarial one-question-at-a-time requirement interviews.", "READ_ONLY"),
    mk("researcher", "Researcher", "Researches external facts with sources and freshness dates.", "READ_ONLY"),
    mk("specwriter", "Specification Writer", "Maintains canonical MASTER_SPEC with stable requirement IDs.", "WORKSPACE"),
    mk("architect", "Architect", "Proposes architecture and ADRs; maps work onto existing structure.", "READ_ONLY"),
    mk("techlead", "Tech Lead", "Coordinates implementation, resolves escalations, right-sizes tasks.", "READ_ONLY"),
    mk("fe", "Frontend Engineer", "Implements UI with states, accessibility, and tests.", "WORKSPACE"),
    mk("be", "Backend Engineer", "Implements APIs/data with contracts, failure handling, tests.", "WORKSPACE"),
    mk("aiml", "AI/ML Engineer", "Implements model integrations behind replaceable interfaces.", "WORKSPACE"),
    mk("dbeng", "Database Engineer", "Designs schema changes and safe migrations.", "ELEVATED_ALLOWED"),
    mk("security", "Security Engineer", "Reviews auth, injection, secrets, privilege boundaries.", "READ_ONLY"),
    mk("qa", "QA Engineer", "Builds verification plans, edge cases, regression suites.", "WORKSPACE"),
    mk("specreviewer", "Spec Compliance Reviewer", "Verifies we implemented exactly what was required.", "READ_ONLY"),
    mk("codereviewer", "Code Quality Reviewer", "Reviews correctness, maintainability, error handling, security.", "READ_ONLY"),
    mk("release", "Release Engineer", "Prepares release summaries, rollback notes, final checks.", "ELEVATED_ALLOWED"),
  ];
}
