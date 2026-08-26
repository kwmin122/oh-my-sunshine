/** V2 additions: intent, code intelligence, safe editing, drift, capacity,
 * playbooks, mobile companion (spec §2.14–§2.18, §3.9–§3.11, §6).
 */
import type {
  ProjectId,
  TaskId,
  AgentRunId,
  EvidenceId,
} from "./ids.js";
import type { RiskTier } from "./state-machines.js";

// ---- Intent Gate (§2.14, Step 3A) ----
export interface IntentRecord {
  id: string;
  projectId: ProjectId;
  taskId: TaskId | null;
  type: "GOAL" | "FEATURE" | "BUG" | "REFACTOR" | "RESEARCH" | "OPERATION" | "CLARIFICATION";
  literalRequest: string;
  inferredGoal: string;
  confidence: number; // 0..1
  hiddenDimensions: string[];
  recommendedEntryPoint: "DISCOVERY_INTERVIEW" | "DIRECT_IMPACT_ANALYSIS" | "RESEARCH_FIRST" | "BUG_INVESTIGATION";
  createdAt: string;
}

// ---- Symbol intelligence (§3.9, Step 3B) ----
export interface SymbolRecord {
  id: string;
  projectId: ProjectId;
  filePath: string;
  symbolName: string;
  symbolKind: "function" | "class" | "interface" | "type" | "variable" | "method" | "enum";
  language: string;
  range: { startLine: number; endLine: number };
  contentHash: string | null;
  references: Array<{ filePath: string; line: number }>;
  diagnostics: string[];
  indexedAt: string;
}

export interface CodeIntelligenceSnapshot {
  projectId: ProjectId;
  symbolsIndexed: number;
  filesIndexed: number;
  toolingUsed: "typescript-compiler-api" | "text-heuristic";
  indexedAt: string;
}

// ---- Safe Edit Guard / EditLease (§2.15) ----
export interface EditLease {
  id: string;
  projectId: ProjectId;
  runId: AgentRunId | null;
  taskId: TaskId | null;
  filePath: string;
  symbolId: string | null;
  expectedRevision: number; // monotonically bumped on each accepted write
  expectedHash: string | null;
  status: "HELD" | "CONSUMED" | "STALE_REJECTED" | "RELEASED";
  createdAt: string;
  releasedAt: string | null;
}

export type StaleEditCheck =
  | { verdict: "APPLY"; lease: EditLease }
  | { verdict: "STALE_REJECTED"; lease: EditLease; currentHash: string | null; explanation: string };

// ---- Drift detection (§2.16, Scenario H) ----
export interface DriftFinding {
  id: string;
  projectId: ProjectId;
  taskId: TaskId;
  runId: AgentRunId | null;
  severity: "LOW" | "MEDIUM" | "HIGH";
  expectedScope: string[];
  observedScope: string[];
  explanation: string;
  status: "OPEN" | "RETURNED_TO_TASK" | "SEPARATE_TASK_CREATED" | "SCOPE_CHANGE_APPROVED";
  resolution: string | null;
  createdAt: string;
}

// ---- Provider capacity (§5.16, §5.18) ----
export interface ProviderCapacity {
  id: string;
  runtimeId: string;
  provider: string;
  account: string | null;
  /** Different providers expose different quota semantics — never fabricate a unified value. */
  limitType: "WINDOW_5H" | "WEEKLY" | "CREDITS" | "TOKENS_DAILY" | "UNLIMITED" | "UNKNOWN";
  usedPercentRemaining: number | null;
  unit: string | null;
  resetAt: string | null;
  contextUsedTokens: number | null;
  contextLimitTokens: number | null;
  costUsd: number | null;
  credits: string | null;
  health: "GOOD" | "DEGRADED" | "DOWN" | "UNKNOWN";
  latencyMs: number | null;
  lastError: string | null;
  source: "NATIVE_API" | "CLI_REPORTED" | "HEURISTIC" | "USER_ENTERED";
  confidence: number;
  refreshedAt: string;
}

export interface RoutingRecommendation {
  id: string;
  reason: string;
  assignments: Array<{ taskKind: RiskTier; preferredRuntimeId: string; rationale: string }>;
  createdAt: string;
}

// ---- Learned playbooks (§2.18) ----
export interface Playbook {
  id: string;
  projectId: ProjectId | null;
  stableKey: string;
  title: string;
  triggerConditions: string[];
  procedure: string[];
  constraints: string[];
  failureModes: string[];
  evidenceRefs: EvidenceId[];
  lifecycle: "OBSERVED" | "REUSED" | "VERIFIED" | "PROMOTED";
  reuseCount: number;
  lastValidatedAt: string | null;
  createdAt: string;
}

// ---- Mobile companion (§5.17) ----
export interface MobileDevice {
  id: string;
  name: string;
  role: "VIEWER" | "OPERATOR" | "ADMIN";
  deviceIdentity: string;
  status: "PENDING_PAIRING" | "PAIRED" | "REVOKED";
  pairedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface PairingRequest {
  deviceName: string;
  requestedRole: MobileDevice["role"];
}

export interface PairingResult {
  deviceId: string;
  pairingToken: string; // short-lived, single-use
  expiresAt: string;
}

export interface MobileMessage {
  id: string;
  deviceId: string;
  kind: "CHAT" | "DECISION_ANSWER" | "APPROVAL_OUTCOME" | "COMMAND";
  text: string;
  refId: string | null; // decision/approval/task id when applicable
  receivedAt: string;
}

export interface MobileOutbound {
  kind: "NOTIFICATION" | "LEAD_REPLY" | "STATE_UPDATE";
  severity: "INFO" | "WARN" | "CRITICAL";
  text: string;
  refId: string | null;
  sentAt: string;
}
