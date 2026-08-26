/** Domain entities (spec §6). Plain typed data — persistence and transport live elsewhere. */
import type {
  ActionId,
  AdrId,
  AgentRoleId,
  AgentRunId,
  AgentRuntimeConfigId,
  ApprovalId,
  ArchitectureNodeId,
  ArtifactId,
  CheckpointId,
  ConflictId,
  DecisionId,
  EvidenceId,
  GoalId,
  MemoryItemId,
  ProjectId,
  RecommendationId,
  RequirementId,
  ResearchRecordId,
  ReviewFindingId,
  ReviewId,
  SessionId,
  TaskId,
  WorkflowDefinitionId,
  WorkflowInstanceId,
  WorkflowNodeId,
} from "./ids.js";
import type {
  ActionRisk,
  AgentRunStatus,
  ApprovalStatus,
  ConflictStatus,
  CoverageState,
  DecisionStatus,
  FindingDisposition,
  FindingSeverity,
  LivenessState,
  MemoryLifecycle,
  PermissionDecision,
  RequirementCategory,
  ReviewType,
  RiskTier,
  TaskStatus,
  WorkflowInstanceStatus,
} from "./state-machines.js";

export interface Project {
  id: ProjectId;
  name: string;
  description: string;
  repositoryPath: string | null;
  status: "ACTIVE" | "ARCHIVED";
  riskProfile: RiskTier;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: GoalId;
  projectId: ProjectId;
  parentGoalId: GoalId | null;
  title: string;
  description: string;
  successMetrics: string[];
  status: "OPEN" | "IN_PROGRESS" | "ACHIEVED" | "ABANDONED";
}

export interface Mission {
  id: GoalId; // a mission is the initial goal of a project
  projectId: ProjectId;
  rawRequest: string;
  createdAt: string;
}

export interface Requirement {
  id: RequirementId;
  projectId: ProjectId;
  goalId: GoalId | null;
  stableKey: string; // REQ-001
  category: RequirementCategory;
  statement: string;
  rationale: string | null;
  priority: "MUST" | "SHOULD" | "COULD";
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "SUPERSEDED";
  confidence: number; // 0..1
  source: "USER" | "AI_PROPOSAL" | "REPO_FACT" | "ASSUMPTION" | "RESEARCH";
  assumptions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AcceptanceCriterion {
  id: string;
  requirementId: RequirementId;
  stableKey: string; // AC-001
  statement: string;
  verificationType: "TEST" | "BUILD" | "E2E" | "MANUAL" | "SECURITY_SCAN";
  status: "PENDING" | "SATISFIED" | "FAILED";
}

export interface RequirementCoverage {
  category: RequirementCategory;
  state: CoverageState;
  score: number; // 0..1
  ambiguity: number; // 0..1
  riskImpact: number; // 0..1
  notes: string[];
}

export interface DiscoveryQuestion {
  id: string;
  projectId: ProjectId;
  category: RequirementCategory;
  question: string;
  whyItMatters: string;
  affectsDecision: string;
  options: Array<{ key: string; label: string }>;
  recommendedOption: string | null;
  defaultAssumption: string | null;
  status: "OPEN" | "ANSWERED" | "SKIPPED_WITH_ASSUMPTION";
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
}

export interface ResearchRecord {
  id: ResearchRecordId;
  projectId: ProjectId;
  question: string;
  sources: Array<{ title: string; url: string; retrievedAt: string }>;
  findings: string[];
  confidence: number;
  freshnessDate: string;
  impactedRequirementIds: RequirementId[];
}

export interface Decision {
  id: DecisionId;
  projectId: ProjectId;
  taskId: TaskId | null;
  stableKey: string;
  kind: "DISCOVERY_ANSWER_NEEDED" | "IMPLEMENTATION_AMBIGUITY" | "CONFLICT_RESOLUTION" | "REVIEW_ESCALATION";
  question: string;
  context: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  options: Array<{ key: string; label: string; consequence: string }>;
  recommendation: string | null;
  status: DecisionStatus;
  answer: string | null;
  resolvedBy: "USER" | "SYSTEM_DEFAULT" | null;
  impactedEntities: string[];
  createdAt: string;
  resolvedAt: string | null;
}

export interface Adr {
  id: AdrId;
  projectId: ProjectId;
  stableKey: string; // ADR-001
  title: string;
  context: string;
  options: Array<{ key: string; label: string; tradeoffs: string }>;
  decision: string;
  consequences: string[];
  status: "PROPOSED" | "ACCEPTED" | "SUPERSEDED" | "REJECTED";
  createdAt: string;
}

export interface ArchitectureNode {
  id: ArchitectureNodeId;
  projectId: ProjectId;
  type: "COMPONENT" | "API" | "DATABASE" | "QUEUE" | "EXTERNAL_SERVICE" | "MODEL_PROVIDER" | "BOUNDARY";
  name: string;
  description: string;
  metadata: Record<string, string | number | boolean>;
}

export interface ArchitectureEdge {
  sourceId: ArchitectureNodeId;
  targetId: ArchitectureNodeId;
  relation: string;
}

export interface TaskContract {
  id: TaskId;
  projectId: ProjectId;
  stableKey: string; // TASK-001
  parentTaskId: TaskId | null;
  objective: string;
  ownerRole: AgentRoleId;
  riskTier: RiskTier;
  status: TaskStatus;
  dependencyTaskIds: TaskId[];
  requirementIds: RequirementId[];
  acceptanceCriteriaIds: string[];
  plannedSteps: string[];
  affectedModules: string[];
  requiredEvidenceTypes: string[]; // e.g. ["UNIT_TEST", "BUILD"]
  requiredReviewTypes: ReviewType[];
  permissionsNeeded: ActionRisk[];
  blockers: string[];
  handoffNotes: string | null;
  verificationCommands: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentRole {
  id: AgentRoleId;
  name: string;
  responsibility: string;
  defaultSkills: string[];
  defaultPolicyPreset: "READ_ONLY" | "WORKSPACE" | "ELEVATED_ALLOWED";
}

export interface AgentRuntimeConfig {
  id: AgentRuntimeConfigId;
  provider: "MOCK" | "OPENAI_COMPATIBLE" | "ANTHROPIC" | "CODEX_CLI" | "CLAUDE_CODE_CLI";
  model: string;
  tools: string[];
  skills: string[];
  permissionPreset: "READ_ONLY" | "WORKSPACE" | "ELEVATED_ALLOWED";
  sandboxPolicy: "NONE" | "WORKTREE" | "CONTAINER";
  contextBudgetTokens: number;
  retryLimit: number;
}

export interface AgentRun {
  id: AgentRunId;
  projectId: ProjectId;
  agentRoleId: AgentRoleId;
  runtimeConfigId: AgentRuntimeConfigId;
  sessionId: SessionId | null;
  taskId: TaskId | null;
  status: AgentRunStatus;
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
  failureReason: string | null;
  contextSnapshotId: string | null;
}

export interface AgentSession {
  id: SessionId;
  projectId: ProjectId;
  roleId: AgentRoleId;
  runtimeConfigId: AgentRuntimeConfigId;
  goalId: GoalId | null;
  taskId: TaskId | null;
  sessionClass: "ONE_SHOT" | "EPHEMERAL" | "DURABLE";
  liveness: LivenessState;
  waitingReason: string | null;
  startedAt: string;
  endedAt: string | null;
  lastProgressAt: string;
  stallThresholdMs: number;
}

export interface GatewayAction {
  id: ActionId;
  projectId: ProjectId;
  runId: AgentRunId | null;
  toolId: string;
  operation: string;
  risk: ActionRisk;
  target: string | null;
  summary: string;
  reversible: boolean;
  requestedPermission: PermissionDecision;
  policyDecision: PermissionDecision;
  approvalId: ApprovalId | null;
  inputSummary: Record<string, unknown>;
  resultSummary: string | null;
  status: "POLICY_CHECK" | "AWAITING_APPROVAL" | "DENIED" | "EXECUTING" | "SUCCEEDED" | "FAILED";
  createdAt: string;
}

export interface Approval {
  id: ApprovalId;
  actionId: ActionId | null;
  taskId: TaskId | null;
  projectId: ProjectId;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason: string;
  requestedActionSummary: string;
  requestingAgentRole: string;
  status: ApprovalStatus;
  resolvedBy: "USER" | null;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface Evidence {
  id: EvidenceId;
  projectId: ProjectId;
  taskId: TaskId | null;
  type:
    | "UNIT_TEST"
    | "INTEGRATION_TEST"
    | "E2E_TEST"
    | "BUILD"
    | "TYPECHECK"
    | "LINT"
    | "RUNTIME_LOG"
    | "API_CHECK"
    | "SECURITY_SCAN"
    | "PERFORMANCE"
    | "SCREENSHOT"
    | "MANUAL_APPROVAL";
  requirementIds: RequirementId[];
  acceptanceCriterionIds: string[];
  revision: string; // git sha or synthetic revision binding
  commandOrMethod: string;
  status: "PASS" | "FAIL";
  freshness: "FRESH" | "STALE";
  outputSummary: string;
  artifactPath: string | null;
  createdAt: string;
}

export interface ReviewFinding {
  id: ReviewFindingId;
  reviewId: ReviewId;
  severity: FindingSeverity;
  confidence: number; // 0..1
  statement: string;
  evidence: string;
  disposition: FindingDisposition;
  dispositionReason: string | null;
}

export interface Review {
  id: ReviewId;
  projectId: ProjectId;
  taskId: TaskId | null;
  type: ReviewType;
  reviewerRoleId: AgentRoleId;
  findings: ReviewFinding[];
  blockingCount: number;
  score: number; // 0..100
  status: "PENDING" | "PASSED" | "BLOCKED";
  evidenceIds: EvidenceId[];
  createdAt: string;
}

export interface Checkpoint {
  id: CheckpointId;
  projectId: ProjectId;
  taskId: TaskId | null;
  revision: string;
  dirtyFiles: string[];
  completedSummary: string;
  verificationSummary: string;
  blockers: string[];
  nextAction: string;
  createdAt: string;
}

export type DevFlowEventPayload = Record<string, unknown>;

export interface DevFlowEvent {
  id: string;
  projectId: ProjectId;
  sequence: number;
  type: string;
  entityType: string | null;
  entityId: string | null;
  actorType: "USER" | "AGENT" | "ENGINE" | "SYSTEM";
  actorId: string | null;
  payload: DevFlowEventPayload;
  timestamp: string;
}

export interface CanonArtifact {
  id: ArtifactId;
  projectId: ProjectId;
  type: "AGENTS_MD" | "MASTER_SPEC" | "ARCHITECTURE" | "STATE" | "README" | "TASK_CONTRACT" | "ADR";
  canonicalName: string;
  content: string;
  revision: number;
  path: string | null;
  updatedAt: string;
}

export interface WorkflowNodeDef {
  id: WorkflowNodeId;
  type: "STEP" | "GATE" | "SPLITTER" | "DELEGATE" | "TERMINAL";
  name: string;
  /** Deterministic gate predicate id executed by the engine, never by an LLM. */
  gatePredicate?: "readiness_gate" | "verification_gate" | "completion_gate" | "approval_gate";
  splitterKey?: "risk_tier";
  childWorkflowId?: WorkflowDefinitionId;
  retryLimit: number;
}

export interface WorkflowEdgeDef {
  fromNodeId: WorkflowNodeId;
  toNodeId: WorkflowNodeId;
  condition?: { kind: "RISK_TIER_EQUALS"; value: RiskTier } | { kind: "DEFAULT" };
}

export interface WorkflowDefinition {
  id: WorkflowDefinitionId;
  name: string;
  version: number;
  entryNodeId: WorkflowNodeId;
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
}

export interface WorkflowInstance {
  id: WorkflowInstanceId;
  projectId: ProjectId;
  goalId: GoalId | null;
  definitionId: WorkflowDefinitionId;
  currentNodeId: WorkflowNodeId | null;
  completedNodeIds: WorkflowNodeId[];
  status: WorkflowInstanceStatus;
  splitSelected: RiskTier | null;
  lastError: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface MemoryItem {
  id: MemoryItemId;
  projectId: ProjectId;
  goalId: GoalId | null;
  category: string;
  statement: string;
  lifecycle: MemoryLifecycle;
  source: "AGENT_OBSERVATION" | "REPO_SCAN" | "USER" | "RESEARCH" | "TEST_RESULT";
  confidence: number;
  canonicalArtifactRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Conflict {
  id: ConflictId;
  projectId: ProjectId;
  type: "DECISION_VS_ADR" | "PROPOSAL_VS_ARCHITECTURE" | "CODE_VS_REQUIREMENT" | "REQUIREMENT_VS_REQUIREMENT";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  leftEntity: string;
  rightEntity: string;
  explanation: string;
  status: ConflictStatus;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Recommendation {
  id: RecommendationId;
  projectId: ProjectId;
  taskId: TaskId | null;
  actionType:
    | "create_session"
    | "split_task"
    | "run_validation"
    | "request_security_review"
    | "review_output"
    | "mark_ready_for_completion"
    | "resolve_stale_evidence"
    | "resume_blocked_agent"
    | "answer_decision";
  reason: string;
  source: "RULE" | "AI" | "HYBRID";
  confidence: number | null;
  status: "OPEN" | "DISMISSED" | "EXECUTED";
  createdAt: string;
}

export interface SystemCapability {
  capability: string;
  status: "AVAILABLE" | "MISSING" | "DEGRADED";
  version: string | null;
  path: string | null;
  diagnostic: string;
  checkedAt: string;
}
