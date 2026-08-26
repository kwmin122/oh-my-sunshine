/** Central configuration. No magic numbers in logic — every knob lives here and is
 * overridable via environment variables (spec §12.5).
 */
export interface DevFlowConfig {
  httpPort: number;
  httpHost: string;
  dataDir: string;
  // Readiness / discovery thresholds
  readinessThreshold: number; // overall coverage required to reach Definition of Ready
  criticalMissingAllowed: number; // must be 0 per spec, configurable for experiments
  maxDiscoveryQuestions: number; // hard bound on interview length
  // Liveness
  stallThresholdMs: number;
  approvalGraceMultiplier: number; // approval waits get a longer grace before stall classification
  watchdogIntervalMs: number;
  // Recovery
  providerBackoffInitialMs: number;
  providerBackoffMaxMs: number;
  maxRunAttempts: number;
  escalationAfterConsecutiveFailures: number;
  // Graceful shutdown (§25)
  shutdownGraceMs: number;
  // Resource limits (§37) + circuit breaker (§24)
  maxConcurrentRuns: number; // 0 = unlimited
  breakerFailureThreshold: number;
  breakerCooldownMs: number;
  // Reviews
  findingBlockerConfidenceThreshold: number; // low-confidence findings do not block below this
  // Shell/tool execution safety
  commandTimeoutMs: number;
  commandOutputLimitBytes: number;
  allowedWorkspaceRoots: string[];
  // Model providers
  openaiBaseUrl: string | null;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  defaultProvider: "MOCK" | "OPENAI_COMPATIBLE" | "ANTHROPIC";
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strEnv(name: string): string | null {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : null;
}

export function loadConfig(overrides: Partial<DevFlowConfig> = {}): DevFlowConfig {
  return {
    httpPort: intEnv("DEVFLOW_HTTP_PORT", 47710),
    httpHost: strEnv("DEVFLOW_HTTP_HOST") ?? "127.0.0.1",
    dataDir: strEnv("DEVFLOW_DATA_DIR") ?? ".devflow-data",
    // Spec §4 Step 5 makes this configurable ("e.g. 90%"). Default 0.70 keeps the
    // no-API-key demo convergent while critical/high-risk gates stay absolute;
    // raise via DEVFLOW_READINESS_THRESHOLD for stricter operation.
    readinessThreshold: floatEnv("DEVFLOW_READINESS_THRESHOLD", 0.7),
    criticalMissingAllowed: intEnv("DEVFLOW_CRITICAL_MISSING_ALLOWED", 0),
    maxDiscoveryQuestions: intEnv("DEVFLOW_MAX_QUESTIONS", 8),
    stallThresholdMs: intEnv("DEVFLOW_STALL_MS", 90_000),
    approvalGraceMultiplier: floatEnv("DEVFLOW_APPROVAL_GRACE_MULT", 20),
    watchdogIntervalMs: intEnv("DEVFLOW_WATCHDOG_MS", 5_000),
    providerBackoffInitialMs: intEnv("DEVFLOW_BACKOFF_INITIAL_MS", 2_000),
    providerBackoffMaxMs: intEnv("DEVFLOW_BACKOFF_MAX_MS", 60_000),
    maxRunAttempts: intEnv("DEVFLOW_MAX_RUN_ATTEMPTS", 3),
    escalationAfterConsecutiveFailures: intEnv("DEVFLOW_ESCALATION_THRESHOLD", 3),
    shutdownGraceMs: intEnv("DEVFLOW_SHUTDOWN_GRACE_MS", 10_000),
    maxConcurrentRuns: intEnv("DEVFLOW_MAX_CONCURRENT_RUNS", 4),
    breakerFailureThreshold: intEnv("DEVFLOW_BREAKER_THRESHOLD", 3),
    breakerCooldownMs: intEnv("DEVFLOW_BREAKER_COOLDOWN_MS", 60_000),
    findingBlockerConfidenceThreshold: floatEnv("DEVFLOW_BLOCKER_CONFIDENCE", 0.6),
    commandTimeoutMs: intEnv("DEVFLOW_CMD_TIMEOUT_MS", 120_000),
    commandOutputLimitBytes: intEnv("DEVFLOW_CMD_OUTPUT_LIMIT", 512_000),
    allowedWorkspaceRoots: (strEnv("DEVFLOW_WORKSPACE_ROOTS") ?? `${process.env.HOME ?? ""}/orca/projects`)
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
    openaiBaseUrl: strEnv("OPENAI_BASE_URL"),
    openaiApiKey: strEnv("OPENAI_API_KEY"),
    anthropicApiKey: strEnv("ANTHROPIC_API_KEY"),
    defaultProvider:
      strEnv("DEVFLOW_PROVIDER") === "OPENAI_COMPATIBLE" && strEnv("OPENAI_API_KEY")
        ? "OPENAI_COMPATIBLE"
        : strEnv("DEVFLOW_PROVIDER") === "ANTHROPIC" && strEnv("ANTHROPIC_API_KEY")
          ? "ANTHROPIC"
          : "MOCK",
    ...overrides,
  };
}
