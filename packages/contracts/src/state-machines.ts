/** Canonical enumerations and state machines (spec §6, §8).
 * State transitions are engine-owned: the only legal moves are the ones listed here.
 */
import { z } from "zod";

export const RiskTier = z.enum(["LOW", "NORMAL", "HIGH"]);
export type RiskTier = z.infer<typeof RiskTier>;

export const ActionRisk = z.enum(["READ_ONLY", "WORKSPACE_WRITE", "ELEVATED", "DANGEROUS"]);
export type ActionRisk = z.infer<typeof ActionRisk>;

export const PermissionDecision = z.enum(["ALLOW", "ALLOW_ONCE", "DENY", "REQUIRE_APPROVAL"]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

// ---- Task state machine ----
export const TASK_STATES = [
  "DRAFT",
  "CLARIFYING",
  "READY",
  "QUEUED",
  "RUNNING",
  "BLOCKED",
  "VERIFYING",
  "REVIEW",
  "DONE",
] as const;
export const TaskStatus = z.enum(TASK_STATES);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  DRAFT: ["CLARIFYING", "READY"],
  CLARIFYING: ["READY", "BLOCKED"],
  READY: ["QUEUED"],
  QUEUED: ["RUNNING"],
  RUNNING: ["BLOCKED", "VERIFYING", "FAILED_REWORK" as never] as unknown as TaskStatus[],
  BLOCKED: ["QUEUED", "RUNNING", "DONE" as never] as unknown as TaskStatus[],
  VERIFYING: ["REVIEW", "RUNNING"],
  REVIEW: ["RUNNING", "DONE"],
  DONE: [],
};
// Rework paths are expressed explicitly to keep the machine total:
export const TASK_LEGAL_TRANSITIONS: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
  ["DRAFT", "CLARIFYING"],
  ["DRAFT", "READY"],
  ["CLARIFYING", "READY"],
  ["CLARIFYING", "BLOCKED"],
  ["READY", "QUEUED"],
  ["QUEUED", "RUNNING"],
  ["RUNNING", "BLOCKED"],
  ["RUNNING", "VERIFYING"],
  ["BLOCKED", "QUEUED"],
  ["VERIFYING", "REVIEW"],
  ["VERIFYING", "RUNNING"],
  ["REVIEW", "RUNNING"],
  ["REVIEW", "DONE"],
];

export function isTaskTransitionLegal(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

// ---- Evidence state machine (freshness-aware) ----
export const EvidenceState = z.enum(["MISSING", "RUNNING", "PASS_FRESH", "PASS_STALE", "FAIL"]);
export type EvidenceState = z.infer<typeof EvidenceState>;

// ---- Decision state machine ----
export const DecisionStatus = z.enum(["OPEN", "ANSWERED", "SUPERSEDED", "CANCELLED"]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

// ---- Approval state machine ----
export const ApprovalStatus = z.enum([
  "REQUESTED",
  "ALLOWED_ONCE",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

// ---- Agent run state machine ----
export const AgentRunStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_DECISION",
  "PROVIDER_BACKOFF",
  "BLOCKED",
  "FAILED",
  "SUCCEEDED",
  "CANCELLED",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

export const AGENT_RUN_LEGAL_TRANSITIONS: ReadonlyArray<readonly [AgentRunStatus, AgentRunStatus]> = [
  ["QUEUED", "RUNNING"],
  ["QUEUED", "CANCELLED"],
  ["RUNNING", "WAITING_APPROVAL"],
  ["RUNNING", "WAITING_DECISION"],
  ["RUNNING", "PROVIDER_BACKOFF"],
  ["RUNNING", "SUCCEEDED"],
  ["RUNNING", "FAILED"],
  ["RUNNING", "CANCELLED"],
  ["RUNNING", "BLOCKED"],
  ["WAITING_APPROVAL", "RUNNING"],
  ["WAITING_APPROVAL", "FAILED"],
  ["WAITING_APPROVAL", "CANCELLED"],
  ["WAITING_DECISION", "RUNNING"],
  ["WAITING_DECISION", "FAILED"],
  ["WAITING_DECISION", "CANCELLED"],
  ["PROVIDER_BACKOFF", "RUNNING"],
  ["PROVIDER_BACKOFF", "FAILED"],
  ["PROVIDER_BACKOFF", "CANCELLED"],
  ["BLOCKED", "RUNNING"],
  ["BLOCKED", "CANCELLED"],
  ["FAILED", "QUEUED"], // bounded retry re-queue
];

export function isAgentRunTransitionLegal(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return AGENT_RUN_LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

// ---- Workflow instance state machine ----
export const WorkflowInstanceStatus = z.enum([
  "DRAFT",
  "READY",
  "RUNNING",
  "WAITING",
  "BLOCKED",
  "FAILED",
  "COMPLETED",
  "CANCELLED",
]);
export type WorkflowInstanceStatus = z.infer<typeof WorkflowInstanceStatus>;

export const WORKFLOW_LEGAL_TRANSITIONS: ReadonlyArray<readonly [WorkflowInstanceStatus, WorkflowInstanceStatus]> = [
  ["DRAFT", "READY"],
  ["READY", "RUNNING"],
  ["RUNNING", "WAITING"],
  ["RUNNING", "BLOCKED"],
  ["RUNNING", "COMPLETED"],
  ["RUNNING", "FAILED"],
  ["RUNNING", "CANCELLED"],
  ["WAITING", "RUNNING"],
  ["WAITING", "BLOCKED"],
  ["BLOCKED", "RUNNING"],
  ["BLOCKED", "CANCELLED"],
  ["FAILED", "RUNNING"],
];

export function isWorkflowTransitionLegal(from: WorkflowInstanceStatus, to: WorkflowInstanceStatus): boolean {
  return WORKFLOW_LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

// ---- Session liveness ----
export const LivenessState = z.enum([
  "ACTIVE_PROGRESS",
  "WAITING_FOR_TOOL",
  "WAITING_FOR_DECISION",
  "WAITING_FOR_APPROVAL",
  "PROVIDER_BACKOFF",
  "STALLED",
  "FAILED",
  "CLOSED",
]);
export type LivenessState = z.infer<typeof LivenessState>;

// ---- Workflow node types ----
export const WorkflowNodeType = z.enum(["STEP", "GATE", "SPLITTER", "DELEGATE", "TERMINAL"]);
export type WorkflowNodeType = z.infer<typeof WorkflowNodeType>;

// ---- Memory promotion lifecycle ----
export const MemoryLifecycle = z.enum(["OBSERVED", "EXTRACTED", "CONFIRMED", "CANONICAL"]);
export type MemoryLifecycle = z.infer<typeof MemoryLifecycle>;

export const MEMORY_PROMOTION_ORDER: ReadonlyArray<MemoryLifecycle> = [
  "OBSERVED",
  "EXTRACTED",
  "CONFIRMED",
  "CANONICAL",
];

export function canPromoteMemory(from: MemoryLifecycle, to: MemoryLifecycle): boolean {
  return MEMORY_PROMOTION_ORDER.indexOf(to) === MEMORY_PROMOTION_ORDER.indexOf(from) + 1;
}

// ---- Requirement coverage ----
export const CoverageState = z.enum(["CLEAR", "PARTIAL", "MISSING", "NOT_APPLICABLE"]);
export type CoverageState = z.infer<typeof CoverageState>;

export const RequirementCategory = z.enum([
  "problem",
  "target_user",
  "user_workflow",
  "functional_behavior",
  "non_goals",
  "data_model",
  "ux_states",
  "authentication",
  "authorization",
  "external_integrations",
  "failure_behavior",
  "performance",
  "scalability",
  "reliability",
  "observability",
  "security",
  "privacy_compliance",
  "concurrency",
  "constraints",
  "deployment",
  "rollback",
  "acceptance_criteria",
]);
export type RequirementCategory = z.infer<typeof RequirementCategory>;

// ---- Review finding severity / disposition ----
export const FindingSeverity = z.enum(["BLOCKER", "HIGH", "MEDIUM", "LOW", "NOTE"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;
export const FindingDisposition = z.enum(["OPEN", "FIXED", "ACCEPTED", "IGNORED_WITH_REASON"]);
export type FindingDisposition = z.infer<typeof FindingDisposition>;

export const ReviewType = z.enum(["SPEC_COMPLIANCE", "CODE_QUALITY", "SECURITY", "PRODUCT", "DESIGN_UX", "QA", "DEVEX"]);
export type ReviewType = z.infer<typeof ReviewType>;

// ---- Recommendation source ----
export const RecommendationSource = z.enum(["RULE", "AI", "HYBRID"]);
export type RecommendationSource = z.infer<typeof RecommendationSource>;

// ---- Conflict ----
export const ConflictStatus = z.enum(["OPEN", "RESOLVED", "ACCEPTED"]);
export type ConflictStatus = z.infer<typeof ConflictStatus>;
