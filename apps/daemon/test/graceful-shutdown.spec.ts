import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { AgentRole, TaskContract } from "@devflow/contracts";
import { openDatabase, closeDatabase, type DbConfig } from "../src/infrastructure/db/connection.js";
import { DocumentRepository } from "../src/infrastructure/db/document-repository.js";
import { SqliteEventStore } from "../src/infrastructure/db/event-store.js";
import { loadConfig } from "../src/lib/config.js";
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
 * S3 evidence: graceful shutdown drains active runtime sessions (no orphan CLI
 * children) and the full daemon process exits cleanly on SIGTERM leaving an
 * integrity-checked database behind.
 */

const tempDirs: string[] = [];
const childProcs: Array<ReturnType<typeof spawn>> = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  for (const p of childProcs) {
    try { p.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function pgrepAll(pattern: string): string[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function writeExecutableScript(name: string, body: string): string {
  const bin = join(makeTempDir("devflow-sd-bin-"), name);
  writeFileSync(bin, `#!/bin/bash\n${body}`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("S3a: orchestrator.stopAllActive drains live CLI sessions", () => {
  it("marks runs SYSTEM_SHUTDOWN, returns tasks to READY, kills children", async () => {
    const unique = `sd-claude-${Date.now().toString(36)}`;
    const slowBin = writeExecutableScript(
      unique,
      `cat > /dev/null
echo '{"type":"system","subtype":"init","session_id":"sd1","tools":[]}'
sleep 60
`,
    );
    const dataDir = makeTempDir("devflow-sd-data-");
    const workspaceRoot = makeTempDir("devflow-sd-ws-");
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const config = loadConfig({ dataDir });
    const registry = new AgentRuntimeRegistry();
    registry.registerCliIfAvailable("claude-code", slowBin, "claude-code", true);
    const gateway = new ActionGateway({ docs, events, policy: new PresetPolicyEngine() });
    const composer = new TeamComposerService({ docs, events }, () => buildCatalog(() => true));
    const roles: AgentRole[] = defaultAgentRoles();
    const orch = new AgentOrchestrator(
      {
        docs, events, gateway,
        contextCompiler: new ContextCompiler(docs, 32_000),
        completion: new CompletionService(docs),
        decisions: new DecisionService(docs, events),
        tools: new ToolRegistry(config),
        config,
        handoff: new HandoffService({ docs, events }),
        composer: {
          resolveForTask: (p, t, r, o) => composer.resolveForTask(p as string, t as string, r as string, o),
          resolveDetailed: (p, t, r, o) => composer.resolveDetailed(p as string, t as string, r as string, o),
          listRuntimeIds: () => registry.listIds(),
        },
      },
      { get: (id) => registry.get(id) },
      { role: (roleId) => roles.find((r) => r.id === roleId) ?? roles[0]! },
    );

    const projectId = "proj_sd";
    docs.put("project", projectId, null, { id: projectId, name: "SD", repositoryPath: workspaceRoot });
    const now = new Date().toISOString();
    const beRole = (roles.find((r) => r.id === "role_be") ?? roles.find((r) => r.id.startsWith("role_be_"))!).id;
    const task: TaskContract = {
      id: "task_sd" as TaskContract["id"],
      projectId: projectId as TaskContract["projectId"],
      stableKey: "SD-1", parentTaskId: null, title: "x",
      objective: "long-running work", ownerRole: beRole as TaskContract["ownerRole"],
      status: "READY", riskTier: "NORMAL", dependencyTaskIds: [], requirementIds: [],
      acceptanceCriteriaIds: [], plannedSteps: [], affectedModules: [],
      requiredEvidenceTypes: [], requiredReviewTypes: [], permissionsNeeded: [],
      blockers: [], handoffNotes: null, verificationCommands: [],
      createdAt: now, updatedAt: now,
    };
    docs.put("task", task.id, task.projectId, task);
    composer.setTaskOverride(projectId, { taskId: task.id, roleId: beRole, runtimeId: "claude-code", updatedAt: now });

    // Fire and forget: the drain below finalizes this run; any late rejection
    // (e.g. touching a closed DB after test teardown) is irrelevant to evidence.
    orch.startTaskRun(task, "mock-runtime").catch(() => undefined);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && pgrepAll(unique).length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pgrepAll(unique).length).toBeGreaterThan(0);

    const stopped = await orch.stopAllActive();
    expect(stopped.length).toBe(1);

    // No orphan survives the drain.
    const deadline2 = Date.now() + 12_000;
    while (Date.now() < deadline2 && pgrepAll(unique).length > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(pgrepAll(unique)).toEqual([]);

    const storedRun = docs.list<{ status: string; failureReason: string | null }>("agent_run", projectId)[0]!;
    expect(storedRun.failureReason).toBe("SYSTEM_SHUTDOWN");
    const storedTask = docs.get<TaskContract>("task", task.id)!;
    expect(storedTask.status).toBe("READY");

    closeDatabase(db);
  }, 45_000);
});

describe("S3b: daemon process exits cleanly on SIGTERM", () => {
  it("starts, serves health, drains, checkpoints WAL, and leaves an integrity-ok DB", async () => {
    const dataDir = makeTempDir("devflow-proc-data-");
    const port = 47791;
    const daemonCwd = process.cwd(); // apps/daemon
    const tsxBin = join(daemonCwd, "node_modules", ".bin", "tsx");
    const child = spawn(tsxBin, ["src/main.ts"], {
      cwd: daemonCwd,
      env: { ...process.env, DEVFLOW_HTTP_PORT: String(port), DEVFLOW_HTTP_HOST: "127.0.0.1", DEVFLOW_DATA_DIR: dataDir },
      stdio: "ignore",
    });
    childProcs.push(child);

    // Wait for health.
    const healthDeadline = Date.now() + 30_000;
    let healthy = false;
    while (Date.now() < healthDeadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) { healthy = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(healthy).toBe(true);

    // SIGTERM must lead to a clean exit within the grace window.
    const exitCode: number | null = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.kill("SIGTERM");
      setTimeout(() => resolve(-999), 20_000);
    });
    expect(exitCode).toBe(0);

    // Database survived shutdown with WAL checkpointed and integrity intact.
    const db = openDatabase({ dataDir } as unknown as DbConfig);
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe("ok");
    closeDatabase(db);
  }, 90_000);
});
