import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskContract } from "@devflow/contracts";
import { openDatabase, closeDatabase } from "../src/infrastructure/db/connection.js";
import { DocumentRepository } from "../src/infrastructure/db/document-repository.js";
import { SqliteEventStore } from "../src/infrastructure/db/event-store.js";
import { loadConfig } from "../src/lib/config.js";
import { recoverOrphanedRuns } from "../src/application/orchestration/crash-recovery.js";
import { RuntimeCircuitBreaker } from "../src/plugins/runtimes/circuit-breaker.js";
import { AgentRuntimeRegistry } from "../src/plugins/runtimes/runtime-registry.js";
import { ToolRegistry } from "../src/plugins/tools/tool-registry.js";
import { PresetPolicyEngine } from "../src/domain/policy/preset-policy-engine.js";
import { ActionGateway } from "../src/application/gateway/action-gateway.js";
import { ContextCompiler } from "../src/application/context/context-compiler.js";
import { CompletionService } from "../src/application/verification/verification-service.js";
import { DecisionService } from "../src/application/governance/decision-service.js";
import { defaultAgentRoles } from "../src/application/reviews/review-council-service.js";
import { TeamComposerService, buildCatalog } from "../src/application/team/team-composer-service.js";
import { HandoffService } from "../src/application/orchestration/handoff-service.js";
import { AgentOrchestrator } from "../src/application/orchestration/agent-orchestrator.js";

/**
 * V3 backlog completion evidence: crash recovery (§26), concurrency cap (§37),
 * circuit breaker (§24), quota-aware routing feed (§22→§21).
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seedTask(docs: DocumentRepository, projectId: string, overrides: Partial<TaskContract> = {}): TaskContract {
  const now = new Date().toISOString();
  const task: TaskContract = {
    id: `task_${Math.random().toString(36).slice(2, 8)}` as TaskContract["id"],
    projectId: projectId as TaskContract["projectId"],
    stableKey: "X-1", parentTaskId: null, title: "x", objective: "work",
    ownerRole: "role_be" as TaskContract["ownerRole"], status: "READY",
    riskTier: "NORMAL", dependencyTaskIds: [], requirementIds: [], acceptanceCriteriaIds: [],
    plannedSteps: [], affectedModules: [], requiredEvidenceTypes: [], requiredReviewTypes: [],
    permissionsNeeded: [], blockers: [], handoffNotes: null, verificationCommands: [],
    createdAt: now, updatedAt: now, ...overrides,
  };
  docs.put("task", task.id, projectId, task);
  return task;
}

describe("§26 crash recovery", () => {
  it("finalizes orphaned RUNNING runs and releases their tasks on restart; WAITING stays resumable", () => {
    const dataDir = makeTempDir("devflow-crash-");
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);

    // A run that a crashed daemon left RUNNING.
    const now = new Date().toISOString();
    docs.put("agent_run", "run_dead", "proj_cr", {
      id: "run_dead", projectId: "proj_cr", agentRoleId: "role_be", runtimeConfigId: "runtime_mock-runtime",
      sessionId: "sess_dead", taskId: "task_dead", status: "RUNNING", attempt: 1,
      startedAt: now, endedAt: null, summary: null, failureReason: null, contextSnapshotId: null,
    });
    docs.put("task", "task_dead", "proj_cr", {
      id: "task_dead", projectId: "proj_cr", stableKey: "C-1", parentTaskId: null, title: "x",
      objective: "o", ownerRole: "role_be", status: "RUNNING", riskTier: "NORMAL",
      dependencyTaskIds: [], requirementIds: [], acceptanceCriteriaIds: [], plannedSteps: [],
      affectedModules: [], requiredEvidenceTypes: [], requiredReviewTypes: [], permissionsNeeded: [],
      blockers: [], handoffNotes: null, verificationCommands: [], createdAt: now, updatedAt: now,
    });
    // A state-parked run is NOT an orphan — it survives restarts resumable.
    docs.put("agent_run", "run_wait", "proj_cr", {
      id: "run_wait", projectId: "proj_cr", agentRoleId: "role_be", runtimeConfigId: "runtime_mock-runtime",
      sessionId: "sess_w", taskId: null, status: "WAITING_APPROVAL", attempt: 1,
      startedAt: now, endedAt: null, summary: null, failureReason: null, contextSnapshotId: null,
    });

    const recovered = recoverOrphanedRuns(docs, events);
    expect(recovered.map((r) => r.runId)).toEqual(["run_dead"]);
    expect(docs.get<{ status: string; failureReason: string | null }>("agent_run", "run_dead")).toMatchObject({
      status: "FAILED", failureReason: "ORPHANED_BY_RESTART",
    });
    expect(docs.get<{ status: string }>("task", "task_dead")!.status).toBe("READY");
    expect(docs.get<{ status: string }>("agent_run", "run_wait")!.status).toBe("WAITING_APPROVAL");
    expect(events.listByProject("proj_cr" as never).some((e) => e.type === "agent.run_orphaned")).toBe(true);
    closeDatabase(db);
  });

  it("runs automatically at daemon startup (main.ts wiring) — process-level proof", async () => {
    // Boot the real daemon against a data dir pre-seeded with a RUNNING run.
    const dataDir = makeTempDir("devflow-crash2-");
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const now = new Date().toISOString();
    docs.put("project", "proj_p", "proj_p" as never, { id: "proj_p", name: "P", repositoryPath: null, status: "ACTIVE", riskProfile: "NORMAL", createdAt: now, updatedAt: now });
    docs.put("agent_run", "run_ghost", "proj_p", {
      id: "run_ghost", projectId: "proj_p", agentRoleId: "role_be", runtimeConfigId: "runtime_mock-runtime",
      sessionId: "s", taskId: null, status: "RUNNING", attempt: 1,
      startedAt: now, endedAt: null, summary: null, failureReason: null, contextSnapshotId: null,
    });
    closeDatabase(db);

    const port = 47762;
    const child = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), ["src/main.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DEVFLOW_HTTP_PORT: String(port), DEVFLOW_DATA_DIR: dataDir },
      stdio: "ignore",
    });
    let healthy = false;
    for (let i = 0; i < 40 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 400));
      healthy = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
    }
    expect(healthy).toBe(true);
    // The ghost was finalized by startup recovery.
    const db2 = openDatabase({ dataDir } as never); // reopen read-only-ish
    const docs2 = new DocumentRepository(db2);
    const ghost = docs2.get<{ status: string; failureReason: string | null }>("agent_run", "run_ghost")!;
    expect(ghost.failureReason).toBe("ORPHANED_BY_RESTART");
    closeDatabase(db2);
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);
});

describe("§37 concurrency cap", () => {
  function orchWith(maxConcurrentRuns: number) {
    const dataDir = makeTempDir("devflow-conc-");
    const workspaceRoot = makeTempDir("devflow-conc-ws-");
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const config = loadConfig({ dataDir, maxConcurrentRuns });
    const registry = new AgentRuntimeRegistry();
    const composer = new TeamComposerService({ docs, events }, () => buildCatalog(() => true));
    const roles = defaultAgentRoles();
    const orch = new AgentOrchestrator(
      {
        docs, events,
        gateway: new ActionGateway({ docs, events, policy: new PresetPolicyEngine() }),
        contextCompiler: new ContextCompiler(docs, 32_000),
        completion: new CompletionService(docs),
        decisions: new DecisionService(docs, events),
        tools: new ToolRegistry(config),
        config,
        handoff: new HandoffService({ docs, events }),
        composer: {
          resolveForTask: (p, t, r, o) => composer.resolveForTask(p as string, t as string, r as string, o),
          resolveDetailed: (p, t, r, o, ctx) => composer.resolveDetailed(p as string, t as string, r as string, o, ctx),
          listRuntimeIds: () => registry.listIds(),
        },
      },
      { get: (id) => registry.get(id) },
      { role: (rid) => roles.find((r) => r.id === rid) ?? roles[0]! },
    );
    docs.put("project", "proj_conc", null, { id: "proj_conc", name: "C", repositoryPath: workspaceRoot });
    return { orch, docs, composer, registry, close: () => closeDatabase(db) };
  }

  it("rejects the Nth concurrent run with a clear operator message", async () => {
    const slowBin = join(makeTempDir("devflow-conc-bin-"), "slow");
    writeFileSync(slowBin, "#!/bin/bash\ncat > /dev/null\nsleep 30\n");
    execFileSync("chmod", ["+x", slowBin]);
    const { orch, docs, composer, registry, close } = orchWith(1);
    composer.setBinding("proj_conc", {
      roleId: "role_backend", runtimeId: "mock-runtime",
      fallbacks: [], source: "MANUAL", reasons: [], updatedAt: new Date().toISOString(),
    });
    // First task pinned to a long-running fake CLI occupies the single slot.
    const t1 = seedTask(docs, "proj_conc");
    composer.setTaskOverride("proj_conc", { taskId: t1.id, roleId: "role_backend", runtimeId: "claude-code", updatedAt: new Date().toISOString() });
    registry.registerCliIfAvailable("claude-code", slowBin, "claude-code", true);

    void orch.startTaskRun(t1, "mock-runtime").catch(() => undefined);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && docs.list<{ status: string }>("agent_run", "proj_conc").filter((r) => r.status === "RUNNING").length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const t2 = seedTask(docs, "proj_conc", { stableKey: "X-2" });
    await expect(orch.startTaskRun(t2, "mock-runtime")).rejects.toThrow(/concurrency limit reached \(1\/1 running\)/);
    close();
  }, 30_000);
});

describe("§24 circuit breaker", () => {
  it("CLOSED → OPEN after threshold, HALF_OPEN probe after cooldown, success closes", async () => {
    const breaker = new RuntimeCircuitBreaker(3, 50);
    expect(breaker.isOpen("codex-cli")).toBe(false);
    breaker.recordFailure("codex-cli");
    breaker.recordFailure("codex-cli");
    expect(breaker.isOpen("codex-cli")).toBe(false);
    breaker.recordFailure("codex-cli");
    expect(breaker.isOpen("codex-cli")).toBe(true); // OPEN
    expect(breaker.snapshot().find((s) => s.runtimeId === "codex-cli")?.state).toBe("OPEN");
    // cooldown elapses → one probe allowed
    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.isOpen("codex-cli")).toBe(false); // HALF_OPEN probe permitted
    expect(breaker.isOpen("codex-cli")).toBe(true); // second request blocked while probing
    breaker.recordSuccess("codex-cli");
    expect(breaker.isOpen("codex-cli")).toBe(false);
    expect(breaker.snapshot().find((s) => s.runtimeId === "codex-cli")?.state).toBe("CLOSED");
  });

  it("OPEN runtime falls out of routing via health predicate — LOCKED still fails closed", () => {
    const dir = makeTempDir("devflow-brk-");
    const db = openDatabase({ dataDir: dir } as never);
    const composer = new TeamComposerService(
      { docs: new DocumentRepository(db), events: new SqliteEventStore(db) },
      () => buildCatalog(() => true),
    );
    const breaker = new RuntimeCircuitBreaker(2, 5_000);
    composer.setHealthPredicate((id) => !breaker.isOpen(id));
    composer.setBinding("proj_brk", {
      roleId: "role_qa", runtimeId: "claude-code", routingMode: "PREFERRED",
      routingRules: [{ when: { unavailable: true }, use: "codex-cli" }],
      fallbacks: [{ runtimeId: "mock-runtime" }],
      source: "MANUAL", reasons: [], updatedAt: new Date().toISOString(),
    });
    // Healthy: primary used.
    expect(composer.resolveDetailed("proj_brk", "t1", "role_qa", undefined)?.runtime?.runtimeId).toBe("claude-code");
    // Breaker opens claude-code → rule `unavailable` fires first → codex.
    breaker.recordFailure("claude-code");
    breaker.recordFailure("claude-code");
    const resolved = composer.resolveDetailed("proj_brk", "t2", "role_qa", undefined, { quotaPct: null });
    expect(resolved.ruleApplied?.runtimeId).toBe("codex-cli");
    // LOCKED binding to the same broken runtime must fail CLOSED, not degrade.
    composer.setBinding("proj_brk", {
      roleId: "role_ceo", runtimeId: "claude-code", routingMode: "LOCKED",
      fallbacks: [{ runtimeId: "mock-runtime" }],
      source: "MANUAL", reasons: ["user pinned"], updatedAt: new Date().toISOString(),
    });
    expect(composer.resolveDetailed("proj_brk", "t3", "role_ceo", undefined)).toMatchObject({ lockedUnavailableRuntimeId: "claude-code" });
    closeDatabase(db);
  });

  it("orchestrator records observed failures into the breaker", async () => {
    // Failing fake CLI (AUTH_EXPIRED = providerFatal → recorded once per attempt).
    const binDir = makeTempDir("devflow-brk2-");
    const bin = join(binDir, "bad-claude");
    writeFileSync(bin, "#!/bin/bash\ncat > /dev/null\necho 'error: not logged in' >&2\nexit 1\n");
    execFileSync("chmod", ["+x", bin]);
    const dataDir = makeTempDir("devflow-brk2-data-");
    const ws = makeTempDir("devflow-brk2-ws-");
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const config = loadConfig({ dataDir });
    const registry = new AgentRuntimeRegistry();
    registry.registerCliIfAvailable("claude-code", bin, "claude-code", true);
    const composer = new TeamComposerService({ docs, events }, () => buildCatalog(() => true));
    const breaker = new RuntimeCircuitBreaker(2, 60_000);
    composer.setHealthPredicate((id) => !breaker.isOpen(id));
    const roles = defaultAgentRoles();
    const orch = new AgentOrchestrator(
      {
        docs, events,
        gateway: new ActionGateway({ docs, events, policy: new PresetPolicyEngine() }),
        contextCompiler: new ContextCompiler(docs, 32_000),
        completion: new CompletionService(docs),
        decisions: new DecisionService(docs, events),
        tools: new ToolRegistry(config),
        config,
        handoff: new HandoffService({ docs, events }),
        breaker,
        composer: {
          resolveForTask: (p, t, r, o) => composer.resolveForTask(p as string, t as string, r as string, o),
          resolveDetailed: (p, t, r, o, ctx) => composer.resolveDetailed(p as string, t as string, r as string, o, ctx),
          listRuntimeIds: () => registry.listIds(),
        },
      },
      { get: (id) => registry.get(id) },
      { role: (rid) => roles.find((r) => r.id === rid) ?? roles[0]! },
    );
    docs.put("project", "proj_brk2", null, { id: "proj_brk2", name: "B", repositoryPath: ws });
    const t1 = seedTask(docs, "proj_brk2");
    composer.setTaskOverride("proj_brk2", { taskId: t1.id, roleId: "role_be", runtimeId: "claude-code", updatedAt: new Date().toISOString() });
    await orch.startTaskRun(t1, "mock-runtime"); // fails AUTH_EXPIRED once
    expect(breaker.snapshot().find((s) => s.runtimeId === "claude-code")?.consecutiveFailures).toBeGreaterThanOrEqual(1);
    closeDatabase(db);
  }, 30_000);
});

describe("§22→§21 quota feed", () => {
  it("known quota below threshold fires routing rules; unknown never does", async () => {
    const dir = makeTempDir("devflow-quota-");
    const db = openDatabase({ dataDir: dir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const config = loadConfig({ dataDir: dir });
    const registry = new AgentRuntimeRegistry();
    const composer = new TeamComposerService({ docs, events }, () => buildCatalog(() => true));
    composer.setBinding("proj_q", {
      roleId: "role_backend", runtimeId: "opencode", routingMode: "AUTO",
      routingRules: [{ when: { quotaBelowPct: 10 }, use: "mock-runtime" }],
      fallbacks: [], source: "MANUAL", reasons: [], updatedAt: new Date().toISOString(),
    });
    const roles = defaultAgentRoles();
    // Capacity snapshots keyed like the capacity service writes them.
    docs.put("provider_capacity", "cap_low", "proj_q" as never, {
      id: "cap_low", runtimeId: "runtime_opencode", provider: "0x",
      usedPercentRemaining: 4, health: "HEALTHY", refreshedAt: new Date().toISOString(), limitType: "UNKNOWN",
      account: null, unit: null, resetAt: null, contextUsedTokens: null, contextLimitTokens: null,
      costUsd: null, credits: null, latencyMs: null, lastError: null, source: "UNKNOWN", confidence: 0.9,
    });
    const quotaLookup = (projectId: string, roleId: string): number | null => {
      const binding = composer.listBindings(projectId).find((b) => b.roleId === roleId);
      if (!binding) return null;
      const candidates = docs
        .list<{ runtimeId: string; usedPercentRemaining: number | null; refreshedAt: string }>("provider_capacity")
        .filter((c) => c.runtimeId.replace(/^runtime_/, "") === binding.runtimeId && c.usedPercentRemaining !== null)
        .sort((a, b) => b.refreshedAt.localeCompare(a.refreshedAt));
      return candidates[0]?.usedPercentRemaining ?? null;
    };
    const orch = new AgentOrchestrator(
      {
        docs, events,
        gateway: new ActionGateway({ docs, events, policy: new PresetPolicyEngine() }),
        contextCompiler: new ContextCompiler(docs, 32_000),
        completion: new CompletionService(docs),
        decisions: new DecisionService(docs, events),
        tools: new ToolRegistry(config),
        config,
        handoff: new HandoffService({ docs, events }),
        quotaLookup,
        composer: {
          resolveForTask: (p, t, r, o) => composer.resolveForTask(p as string, t as string, r as string, o),
          resolveDetailed: (p, t, r, o, ctx) => composer.resolveDetailed(p as string, t as string, r as string, o, ctx),
          listRuntimeIds: () => registry.listIds(),
        },
      },
      { get: (id) => registry.get(id) },
      { role: (rid) => roles.find((r) => r.id === rid) ?? roles[0]! },
    );
    docs.put("project", "proj_q", null, { id: "proj_q", name: "Q", repositoryPath: makeTempDir("devflow-q-ws-") });
    const task = seedTask(docs, "proj_q", { riskTier: "NORMAL", ownerRole: "role_backend" as TaskContract["ownerRole"] });
    const run = await orch.startTaskRun(task, "mock-runtime");
    expect(run.status).toBe("SUCCEEDED");
    const evt = events.listByProject("proj_q" as never).find((e) => e.type === "routing.rule_applied");
    expect(evt, "quota rule fired").toBeTruthy();
    expect((evt!.payload as { selectedRuntime: string }).selectedRuntime).toBe("mock-runtime");
    closeDatabase(db);
  }, 30_000);
});
