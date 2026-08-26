/**
 * Normalized runtime execution model (V3 §15–16).
 * Provider-native events are mapped onto this shape; raw provider events may be
 * preserved alongside for debug/audit. UNKNOWN never gets guessed into something else.
 */

/** Failure taxonomy (V3 §16). Classifiers must stay honest — no reclassifying. */
export type RuntimeFailureKind =
  | "AUTH_EXPIRED"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "MODEL_UNAVAILABLE"
  | "RUNTIME_UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "PROCESS_CRASH"
  | "INVALID_OUTPUT"
  | "TOOL_FAILURE"
  | "POLICY_DENIED"
  | "STALE_EDIT"
  | "CONFLICT"
  | "UNKNOWN";

/** Lifecycle kinds every runtime maps its native events onto (V3 §15). */
export type RuntimeEventKind =
  | "STARTING"
  | "RUNNING"
  | "OUTPUT"
  | "ACTION_PROPOSED"
  | "ACTION_STARTED"
  | "ACTION_COMPLETED"
  | "WAITING"
  | "FINISHED"
  | "FAILED"
  | "CANCELLED";

export interface NormalizedRuntimeEvent {
  runId: string;
  taskId: string;
  kind: RuntimeEventKind;
  at: string;
  /** Human/summary text (assistant text chunks, tool names, errors…). */
  text?: string;
  /** Tool activity when kind is ACTION_* (tool requested/started/completed). */
  tool?: { name: string; phase: "proposed" | "started" | "completed"; summary?: string };
  /** Structured extras: session ids, usage, failure taxonomy… */
  meta?: Record<string, unknown>;
  /** Raw provider event preserved for audit when available. */
  raw?: unknown;
}

/** Settings a resolved assignment may carry that a given runtime cannot honor. */
export interface UnsupportedSetting {
  setting: "effort" | "model" | "provider" | "tools" | "skills";
  reason: string;
}
