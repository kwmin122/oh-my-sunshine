/**
 * AI Team Composer (spec §31): Role → Runtime → Provider → Model → Effort →
 * Tools → Permissions → Capacity → Fallback. Roles stay abstract; humans (or the
 * auto-composer) decide which runtime/model executes each role, with per-task and
 * per-run overrides. Nearest override wins.
 */
export type EffortLevel = "LOW" | "MEDIUM" | "HIGH" | "MAX";

/** What a runtime can actually do — drives compatibility checks + fallback. */
export interface RuntimeCapabilitiesV2 {
  filesystem: boolean;
  shell: boolean;
  git: boolean;
  tests: boolean;
  network: boolean;
}

export interface ModelOption {
  providerId: string;
  model: string;
  label: string;
  efforts: EffortLevel[];
  /** 0..10 heuristic scores used by capacity-aware routing. Deterministic per model. */
  scores: { reasoning: number; planning: number; coding: number; review: number; capacity: number; cost: number; latency: number };
}

export interface RuntimeCatalogEntry {
  id: string;
  label: string;
  kind: "cli" | "api" | "mock";
  available: boolean;
  capabilities: RuntimeCapabilitiesV2;
  models: ModelOption[];
  unavailableReason?: string;
}

export interface RuntimeFallback {
  runtimeId: string;
  providerId?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
}

/** LOCKED = user-pinned (never auto-switch) · PREFERRED = primary+fallbacks · AUTO = system chooses */
export type RoutingMode = "LOCKED" | "PREFERRED" | "AUTO";

/**
 * Conditional routing rules (V3 §5/§21). First matching rule wins; applied ONLY
 * under PREFERRED/AUTO — LOCKED bindings are immune by definition. Unknown
 * inputs (e.g. quota unknown) never satisfy a rule.
 */
export interface RoutingRuleCondition {
  risk?: "LOW" | "NORMAL" | "HIGH";
  /** Match when provider capacity percent is known AND below this threshold. */
  quotaBelowPct?: number;
  /** Match when the primary runtime is unavailable right now. */
  unavailable?: boolean;
  /** Match when prior failed attempts for the task >= this number. */
  failedAttemptsGte?: number;
}

export interface RoutingRule {
  when: RoutingRuleCondition;
  /** Runtime id to use when the condition matches. */
  use: string;
}

export interface RoleRuntimeBinding {
  roleId: string;
  runtimeId: string;
  routingMode?: RoutingMode;
  routingRules?: RoutingRule[];
  providerId?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  permissionPreset?: "READ_ONLY" | "WORKSPACE" | "ELEVATED_ALLOWED";
  tools?: string[];
  timeoutMs?: number | null;
  maxRetries?: number | null;
  fallbacks: RuntimeFallback[];
  source: "AUTO" | "RECOMMENDED" | "MANUAL" | "PRESET";
  reasons: string[];
  updatedAt: string;
}

export interface TaskRuntimeOverride {
  taskId: string;
  roleId: string | null;
  runtimeId: string;
  providerId?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  reason?: string | null;
  updatedAt: string;
}

export interface CapabilityMismatch {
  roleId: string;
  runtimeId: string;
  required: string[];
  missing: string[];
  recommendedRuntimes: string[];
}

/** Result of resolving org → role → task → run for one execution. */
export interface ResolvedRuntime {
  runtimeId: string;
  providerId: string | null;
  model: string | null;
  effort: EffortLevel | null;
  permissionPreset: "READ_ONLY" | "WORKSPACE" | "ELEVATED_ALLOWED";
  requestedRuntimeId: string;
  fallbackUsed: boolean;
  chain: string[];
}

/**
 * User-defined Role (V3 §20): a responsibility template a human composes into
 * their AI organization. Ids are deterministic slugs so workflows, bindings,
 * and tasks can reference them across restarts.
 */
export interface CustomRole {
  /** Deterministic: role_custom_<slug-of-name>. */
  id: string;
  name: string;
  responsibility: string;
  instructions?: string;
  tools?: string[];
  requiredCapabilities?: Array<keyof RuntimeCapabilitiesV2>;
  permissionPreset: "READ_ONLY" | "WORKSPACE" | "ELEVATED_ALLOWED";
  /** Preferred runtime suggestion surfaced in the Team Composer. */
  defaultRuntimeId?: string | null;
  expectedOutputs?: string[];
  reviewCriteria?: string[];
  createdAt: string;
  updatedAt: string;
}
