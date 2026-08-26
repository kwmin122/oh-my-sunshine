import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/**
 * LIVE SMOKE (V3-S1 DoD) — real subscription CLIs, no mocks.
 * Run explicitly:  DEVFLOW_LIVE_SMOKE=1 pnpm --filter @devflow/daemon test -- test/live-cli-smoke.spec.ts
 *
 * Each run: sandbox git repo → task → composer resolution → actual CLI execution
 * in the workspace → normalized events → FINISH → persisted state.
 */
const LIVE = process.env.DEVFLOW_LIVE_SMOKE === "1";
const tempDirs: string[] = [];
afterAll(() => {
  if (!LIVE) return;
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function liveHarness(cliId: "claude-code" | "codex-cli" | "opencode", bin: string) {
  const dataDir = makeTempDir("devflow-live-data-");
  const workspaceRoot = makeTempDir("devflow-live-ws-");
  // Codex requires a git repository context (or --skip-git-repo-check, which we pass);
  // init a repo anyway to mirror a realistic user workspace.
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspaceRoot });
    execFileSync("git", ["config", "user.email", "smoke@local"], { cwd: workspaceRoot });
    execFileSync("git", ["config", "user.name", "smoke"], { cwd: workspaceRoot });
  } catch {
    // non-git workspace is fine for claude/opencode
  }
  const db = openDatabase({ dataDir } as never);
  const docs = new DocumentRepository(db);
  const events = new SqliteEventStore(db);
  const config = loadConfig({ dataDir });
  const registry = new AgentRuntimeRegistry();
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
  registry.registerCliIfAvailable(cliId, bin, cliId, true);
  const gateway = new ActionGateway({ docs, events, policy: new PresetPolicyEngine() });
  const decisions = new DecisionService(docs, events);
  const completion = new CompletionService(docs);
  const contextCompiler = new ContextCompiler(docs, 32_000);
  const composer = new TeamComposerService({ docs, events }, () => buildCatalog(() => true));
  const roles: AgentRole[] = defaultAgentRoles();
  const orch = new AgentOrchestrator(
    {
      docs,
      events,
      gateway,
      contextCompiler,
      completion,
      decisions,
      tools: new ToolRegistry(config),
      config,
      composer: {
        resolveForTask: (p, t, r, o) => composer.resolveForTask(p as string, t as string, r as string, o),
        resolveDetailed: (p, t, r, o) => composer.resolveDetailed(p as string, t as string, r as string, o),
        listRuntimeIds: () => registry.listIds(),
      },
    },
    { get: (id) => registry.get(id) },
    { role: (roleId) => roles.find((r) => r.id === roleId) ?? roles[0]! },
  );
  return { orch, docs, events, composer, workspaceRoot, roles };
}

async function runLiveSmoke(cliId: "claude-code" | "codex-cli", bin: string) {
  const h = await liveHarness(cliId, bin);
  // Role ids are deterministic (role_be); fall back to prefix scan for safety.
  const beRoleId = (h.roles.find((r) => r.id === "role_be") ?? h.roles.find((r) => r.id.startsWith("role_be_")) ?? h.roles[0]!).id;
  const projectId = `proj_live_${cliId}`;
  h.docs.put("project", projectId, null, { id: projectId, name: `Live ${cliId}`, repositoryPath: h.workspaceRoot });
  const now = new Date().toISOString();
  const task: TaskContract = {
    id: `task_${cliId}` as TaskContract["id"],
    projectId: projectId as TaskContract["projectId"],
    stableKey: "LIVE-1",
    parentTaskId: null,
    title: "Live CLI smoke",
    objective:
      "Create a file named sunshine-live.txt in the current directory whose content is exactly LIVE_OK (no trailing whitespace). Do not do anything else.",
    ownerRole: beRoleId as TaskContract["ownerRole"],
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
  h.docs.put("task", task.id, task.projectId, task);
  h.composer.setTaskOverride(projectId, {
    taskId: task.id, roleId: beRoleId, runtimeId: cliId, updatedAt: now,
  });

  const run = await h.orch.startTaskRun(task, "mock-runtime");

  // Behavior evidence — every claim below is checked against reality:
  const filePath = join(h.workspaceRoot, "sunshine-live.txt");
  const fileCreated = existsSync(filePath);
  console.log(`[live-smoke/${cliId}] run.status=${run.status} failureReason=${run.failureReason}`);
  console.log(`[live-smoke/${cliId}] summary=${run.summary?.slice(0, 300)}`);
  console.log(`[live-smoke/${cliId}] file created=${fileCreated} content=${fileCreated ? readFileSync(filePath, "utf8").trim() : "(none)"}`);
  const stream = h.events.listByProject(projectId as never).filter((e) => e.type === "agent.run_output");
  console.log(`[live-smoke/${cliId}] normalized events: ${stream.map((e) => (e.payload as { kind: string }).kind).join(",")}`);

  expect(run.status).toBe("SUCCEEDED");
  expect(fileCreated).toBe(true);
  expect(readFileSync(filePath, "utf8").trim()).toBe("LIVE_OK");
  expect(h.docs.get<TaskContract>("task", task.id)!.status).toBe("VERIFYING");
  const kinds = stream.map((e) => (e.payload as { kind: string }).kind);
  expect(kinds).toContain("STARTING");
  expect(kinds).toContain("FINISHED");
}

describe.skipIf(!LIVE)("LIVE CLI smoke (DEVFLOW_LIVE_SMOKE=1)", () => {
  it(
    "claude-code executes a real task end-to-end",
    () => runLiveSmoke("claude-code", "claude"),
    420_000,
  );
  it(
    "codex-cli executes a real task end-to-end",
    () => runLiveSmoke("codex-cli", "codex"),
    420_000,
  );
});
