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

export interface RoleRuntimeBinding {
  roleId: string;
  runtimeId: string;
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
