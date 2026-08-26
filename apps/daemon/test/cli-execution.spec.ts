import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentRole, TaskContract } from "@devflow/contracts";
import { openDatabase } from "../src/infrastructure/db/connection.js";
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
import { AgentOrchestrator } from "../src/application/orchestration/agent-orchestrator.js";
import { HandoffService } from "../src/application/orchestration/handoff-service.js";

/**
 * S1 behavior evidence (V3-S1): a real child process — not the mock runtime —
 * executes through the full chain: resolve → start → structured events →
 * FINISH → persisted run/task state. The "CLI" is a tiny bash script emitting
 * valid stream-json so parsers run against genuine process semantics.
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

function writeExecutableScript(name: string, body: string): string {
  const bin = join(makeTempDir("devflow-bin-"), name);
  writeFileSync(bin, `#!/bin/bash\n${body}`);
  chmodSync(bin, 0o755);
  return bin;
}

interface Harness {
  orch: AgentOrchestrator;
  docs: DocumentRepository;
  events: SqliteEventStore;
  composer: TeamComposerService;
  registry: AgentRuntimeRegistry;
  workspaceRoot: string;
}

function harness(opts?: { cliBin?: string; cliKind?: "claude-code" | "codex-cli" | "opencode"; registerCli?: boolean; cliProbe?: (bin: string) => boolean; extraBins?: Array<{ id: string; bin: string; kind: "claude-code" | "codex-cli" | "opencode" }> }): Harness {
  const dataDir = makeTempDir("devflow-s1-data-");
  const workspaceRoot = makeTempDir("devflow-s1-ws-");
  const db = openDatabase({ dataDir } as never);
  const docs = new DocumentRepository(db);
  const events = new SqliteEventStore(db);
  const config = loadConfig({ dataDir });
  const registry = new AgentRuntimeRegistry();
  if (opts?.registerCli && opts.cliBin && opts.cliKind) {
    // Register exactly like main.ts does post-discovery: catalog id → binary.
    registry.registerCliIfAvailable(opts.cliKind, opts.cliBin, opts.cliKind, true);
  }
  for (const extra of opts?.extraBins ?? []) {
    registry.registerCliIfAvailable(extra.id, extra.bin, extra.kind, true);
  }
  // Wire the normalized runtime event stream into the EventStore exactly like main.ts.
  registry.setEventSink((e) => {
    const owner = docs.get<{ projectId: string }>("agent_run", e.runId);
    if (!owner) return;
    events.append({
      projectId: owner.projectId as never,
      type: "agent.run_output" as never,
      entityType: "run",
      entityId: e.runId,
      actorType: "ENGINE",
      payload: { taskId: e.taskId, kind: e.kind, text: e.text ?? null, tool: e.tool ?? null, meta: e.meta ?? null, at: e.at },
    });
  });
  const gateway = new ActionGateway({ docs, events, policy: new PresetPolicyEngine() });
  const tools = new ToolRegistry(config);
  const decisions = new DecisionService(docs, events);
  const completion = new CompletionService(docs);
  const contextCompiler = new ContextCompiler(docs, 32_000);
  const composer = new TeamComposerService({ docs, events }, () => buildCatalog(opts?.cliProbe ?? (() => true)));
  const roles: AgentRole[] = defaultAgentRoles();
  const orch = new AgentOrchestrator(
    {
      docs,
      events,
      gateway,
      contextCompiler,
      completion,
      decisions,
      tools,
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
  return { orch, docs, events, composer, registry, workspaceRoot };
}

/** A fake CLI binary: emits claude-style stream-json, writes a workspace file, exits 0. */
const FAKE_CLAUDE_BODY = `cat > /dev/null
echo '{"type":"system","subtype":"init","session_id":"fake-session-1","tools":[]}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","id":"w1"}]}}'
printf 's1 done\\n' > implemented-by-cli.txt
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"w1"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"implementation written"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"implementation complete"}'
`;

function makeTask(projectId: string): TaskContract {
  const now = new Date().toISOString();
  return {
    id: `task_s1_${Math.random().toString(36).slice(2, 8)}` as TaskContract["id"],
    projectId: projectId as TaskContract["projectId"],
    stableKey: "S1-1",
    parentTaskId: null,
    title: "Implement via CLI",
    objective: "create implemented-by-cli.txt",
    ownerRole: "role_backend" as TaskContract["ownerRole"],
    status: "READY",
    riskTier: "NORMAL",
    dependencyTaskIds: [],
    requirementIds: [],
    acceptanceCriteriaIds: [],
    plannedSteps: [],
    affectedModules: [],
    requiredEvidenceTypes: [],
    requiredReviewTypes: [],
    permissionsNeeded: [],
    blockers: [],
    handoffNotes: null,
    verificationCommands: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("S1: CLI runtime execution path end-to-end", () => {
  it("runs a real child process CLI through resolve→start→events→FINISH and persists results", async () => {
    const bin = writeExecutableScript("claude", FAKE_CLAUDE_BODY);
    const h = harness({ cliBin: bin, cliKind: "claude-code", registerCli: true });
    const projectId = "proj_s1";
    h.docs.put("project", projectId, null, { id: projectId, name: "S1", repositoryPath: h.workspaceRoot });
    const task = makeTask(projectId);
    h.docs.put("task", task.id, task.projectId, task);

    // Pin the task to the CLI runtime via a stored override (nearest wins) —
    // same shape the desktop UI writes through PUT /api/tasks/:taskId/runtime-override.
    h.composer.setTaskOverride(projectId, {
      taskId: task.id, roleId: "role_backend", runtimeId: "claude-code", updatedAt: new Date().toISOString(),
    });

    // No explicit runtime arg → composer resolution decides which adapter runs.
    const run = await h.orch.startTaskRun(task, "mock-runtime");

    expect(run.status).toBe("SUCCEEDED");
    expect(run.summary).toContain("claude-code");
    expect(run.summary).toContain("implementation complete");
    // Workspace actually changed by the CLI process itself (native agent loop respected).
    expect(existsSync(join(h.workspaceRoot, "implemented-by-cli.txt"))).toBe(true);
    expect(readFileSync(join(h.workspaceRoot, "implemented-by-cli.txt"), "utf8")).toContain("s1 done");
    // Task advanced by the engine, not by agent claim.
    const stored = h.docs.get<TaskContract>("task", task.id)!;
    expect(stored.status).toBe("VERIFYING");
    // Runtime event stream was persisted (normalized V3 §15 events).
    const stream = h.events.listByProject(projectId as never).filter((e) => e.type === "agent.run_output");
    const kinds = stream.map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).toContain("STARTING");
    expect(kinds).toContain("RUNNING");
    expect(kinds).toContain("ACTION_STARTED");
    expect(kinds).toContain("FINISHED");
    expect(stream.some((e) => (e.payload as { text: string | null }).text?.includes("implementation complete"))).toBe(true);
    // Routing decision is observable (§45).
    expect(
      h.events.listByProject(projectId as never).some(
        (e) => e.type === "runtime.selected" && (e.payload as { runtimeId: string }).runtimeId === "claude-code",
      ),
    ).toBe(true);
  }, 30_000);

  it("LOCKED binding to an unavailable runtime fails closed instead of silently using mock", async () => {
    const h = harness({ cliProbe: () => false }); // no CLIs installed in this scenario
    const projectId = "proj_locked";
    h.docs.put("project", projectId, null, { id: projectId, name: "L", repositoryPath: h.workspaceRoot });
    const task = makeTask(projectId);
    h.docs.put("task", task.id, task.projectId, task);

    h.composer.setBinding(projectId, {
      roleId: "role_backend",
      runtimeId: "claude-code",
      routingMode: "LOCKED",
      fallbacks: [{ runtimeId: "mock-runtime" }],
      source: "MANUAL",
      reasons: ["user pinned"],
      updatedAt: new Date().toISOString(),
    });

    await expect(h.orch.startTaskRun(task, "mock-runtime")).rejects.toThrow(/LOCKED runtime 'claude-code' is unavailable/);
    const stored = h.docs.get<TaskContract>("task", task.id)!;
    expect(stored.status).toBe("BLOCKED");
    expect(stored.blockers[0]).toContain("LOCKED");
    expect(h.events.listByProject(projectId as never).some((e) => e.type === "team.locked_unavailable")).toBe(true);
  }, 15_000);

  it("cancel kills the child process — no orphan remains and state stays honest", async () => {
    // Unique script name per test run — pgrep assertions must never match stale
    // processes from earlier runs.
    const unique = `slow-claude-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const slowBin = writeExecutableScript(
      unique,
      `cat > /dev/null
echo '{"type":"system","subtype":"init","session_id":"slow-1","tools":[]}'
sleep 60
`,
    );
    const h = harness({ cliBin: slowBin, cliKind: "claude-code", registerCli: true });
    const projectId = "proj_cancel";
    h.docs.put("project", projectId, null, { id: projectId, name: "C", repositoryPath: h.workspaceRoot });
    const task = makeTask(projectId);
    h.docs.put("task", task.id, task.projectId, task);
    h.composer.setTaskOverride(projectId, {
      taskId: task.id, roleId: "role_backend", runtimeId: "claude-code", updatedAt: new Date().toISOString(),
    });

    let settled = false;
    const runPromise = h.orch.startTaskRun(task, "mock-runtime").then((r) => {
      settled = true;
      return r;
    });
    // Wait until the child process is actually alive.
    const deadline = Date.now() + 10_000;
    while (!settled && Date.now() < deadline) {
      if (pgrepAll(unique).length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pgrepAll(unique).length).toBeGreaterThan(0);

    const runs = h.docs.list<{ id: string; sessionId: string | null; status: string }>("agent_run", projectId);
    const active = runs.find((r) => r.sessionId && r.status === "RUNNING");
    expect(active).toBeTruthy();

    await h.orch.cancelRun(active!.id);
    const run = await Promise.race([runPromise, new Promise((r) => setTimeout(() => r(undefined), 15_000))]);
    expect(settled).toBe(true);
    expect(run).toBeTruthy();

    // No orphan survives cancellation — the bash script AND its `sleep` child.
    const deadline2 = Date.now() + 12_000;
    while (Date.now() < deadline2) {
      if (pgrepAll(unique).length === 0 && pgrepAll("sleep 60").length === 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(pgrepAll(unique)).toEqual([]);
    expect(pgrepAll("sleep 60")).toEqual([]);

    const storedRun = h.docs.get<{ status: string; failureReason: string | null }>("agent_run", active!.id)!;
    expect(storedRun.status).toBe("FAILED");
    expect(storedRun.failureReason).toBe("CANCELLED_BY_USER");
    const storedTask = h.docs.get<TaskContract>("task", task.id)!;
    expect(storedTask.status).toBe("READY");
    expect(h.events.listByProject(projectId as never).some((e) => e.type === "agent.run_cancelled")).toBe(true);
  }, 45_000);
});

describe("S2: handoff on runtime switch", () => {
  it("runtime A fails → switch to runtime B → handoff generated, consumed, and received by B", async () => {
    // Runtime A: fails instantly as AUTH_EXPIRED (providerFatal — no retries).
    const failingBin = writeExecutableScript(
      "failing-cli",
      `cat > /dev/null
echo '{"type":"system","subtype":"init","session_id":"a1","tools":[]}' >&2
echo 'error: not logged in' >&2
exit 1
`,
    );
    // Runtime B: dumps its full context packet to disk (proving it RECEIVED the
    // handoff), completes the task normally.
    const workingBin = writeExecutableScript(
      "working-claude",
      `cat > received-context.md
echo '{"type":"system","subtype":"init","session_id":"b1","tools":[]}'
printf 'done by b\\n' > implemented-by-cli.txt
echo '{"type":"result","subtype":"success","is_error":false,"result":"implementation complete"}'
`,
    );
    const h = harness({
      cliBin: failingBin,
      cliKind: "claude-code",
      registerCli: true,
      cliProbe: () => true,
      extraBins: [{ id: "codex-cli", bin: workingBin, kind: "claude-code" }],
    });
    const projectId = "proj_s2";
    h.docs.put("project", projectId, null, { id: projectId, name: "S2", repositoryPath: h.workspaceRoot });
    const task = makeTask(projectId);
    h.docs.put("task", task.id, task.projectId, task);
    h.composer.setTaskOverride(projectId, {
      taskId: task.id, roleId: "role_backend", runtimeId: "claude-code", updatedAt: new Date().toISOString(),
    });

    // Attempt 1 on the failing runtime.
    const run1 = await h.orch.startTaskRun(task, "mock-runtime");
    expect(run1.status).toBe("FAILED");
    expect(run1.failureReason).toContain("AUTH_EXPIRED");
    const storedTaskAfterFail = h.docs.get<TaskContract>("task", task.id)!;
    expect(["READY", "BLOCKED"]).toContain(storedTaskAfterFail.status);

    // User switches the task override to runtime B.
    h.composer.setTaskOverride(projectId, {
      taskId: task.id, roleId: "role_backend", runtimeId: "codex-cli",
      reason: "switch after failure", updatedAt: new Date().toISOString(),
    });

    // Attempt 2 must be a HANDOFF, not a cold restart.
    const run2 = await h.orch.startTaskRun(storedTaskAfterFail.status === "BLOCKED" ? storedTaskAfterFail : { ...task, status: "READY" }, "mock-runtime");
    expect(run2.status).toBe("SUCCEEDED");

    const evs = h.events.listByProject(projectId as never);
    const generated = evs.find((e) => e.type === "agent.handoff_generated");
    const consumed = evs.find((e) => e.type === "agent.handoff_consumed");
    expect(generated, "handoff_generated event").toBeTruthy();
    expect(consumed, "handoff_consumed event").toBeTruthy();
    const genPayload = generated!.payload as { from: string; to: string; failureKind: string };
    expect(genPayload.from).toBe("claude-code");
    expect(genPayload.to).toBe("codex-cli");
    expect(genPayload.failureKind).toBe("AUTH_EXPIRED");

    // Packet persisted with durable fields.
    const packets = h.docs.list<{ previousRuntimeId: string; nextRuntimeId: string; lastFailureKind: string | null }>("handoff_packet", projectId);
    expect(packets.length).toBe(1);
    expect(packets[0]!.previousRuntimeId).toBe("claude-code");
    expect(packets[0]!.nextRuntimeId).toBe("codex-cli");
    expect(packets[0]!.lastFailureKind).toBe("AUTH_EXPIRED");

    // Runtime B actually received the handoff content in its context packet.
    const received = readFileSync(join(h.workspaceRoot, "received-context.md"), "utf8");
    expect(received).toContain("# Handoff Packet");
    expect(received).toContain(task.objective);
    expect(received).toContain("AUTH_EXPIRED");
    expect(received).toContain("claude-code");
    // And completed the work.
    expect(existsSync(join(h.workspaceRoot, "implemented-by-cli.txt"))).toBe(true);
  }, 45_000);

  it("first attempt generates no handoff (nothing to hand over)", async () => {
    const bin = writeExecutableScript("claude", FAKE_CLAUDE_BODY);
    const h = harness({ cliBin: bin, cliKind: "claude-code", registerCli: true });
    const projectId = "proj_s2_first";
    h.docs.put("project", projectId, null, { id: projectId, name: "F", repositoryPath: h.workspaceRoot });
    const task = makeTask(projectId);
    h.docs.put("task", task.id, task.projectId, task);
    h.composer.setTaskOverride(projectId, {
      taskId: task.id, roleId: "role_backend", runtimeId: "claude-code", updatedAt: new Date().toISOString(),
    });
    await h.orch.startTaskRun(task, "mock-runtime");
    expect(h.events.listByProject(projectId as never).some((e) => e.type === "agent.handoff_generated")).toBe(false);
  }, 30_000);
});

function pgrepAll(pattern: string): string[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
