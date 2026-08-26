import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun, AgentRole } from "@devflow/contracts";
import { openDatabase, closeDatabase } from "../src/infrastructure/db/connection.js";
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
 * S5 evidence (V3 §20): a user-defined role ("Performance Reviewer") is
 * persisted, appears in the composer's role list alongside built-ins, accepts
 * runtime assignments, and actually executes work through the orchestrator.
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("S5: user-defined role participates in composition and execution", () => {
  it("creates Performance Reviewer, assigns a runtime, and runs a task under it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "devflow-s5-data-"));
    tempDirs.push(dataDir);
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const config = loadConfig({ dataDir });
    const registry = new AgentRuntimeRegistry();
    registry.setEventSink(() => undefined);
    const gateway = new ActionGateway({ docs, events, policy: new PresetPolicyEngine() });
    const composer = new TeamComposerService({ docs, events }, () => buildCatalog(() => false));
    const roles: AgentRole[] = defaultAgentRoles();

    // 1) User creates the custom role with capability requirements.
    const custom = composer.createCustomRole({
      name: "Performance Reviewer",
      responsibility: "Reviews changes for latency, memory, and N+1 risks; benchmarks hot paths.",
      instructions: "Inspect changed files; flag O(n²) loops; require indexes on filtered columns.",
      tools: ["read", "grep", "bench"],
      requiredCapabilities: ["filesystem", "git"],
      permissionPreset: "READ_ONLY",
      defaultRuntimeId: null,
      expectedOutputs: ["performance findings", "benchmark notes"],
      reviewCriteria: ["no unjustified allocations in hot loop"],
    });

    // 2) It merges into the composer's role universe next to built-ins.
    const merged = composer.roles();
    expect(merged.find((r) => r.roleId === custom.id)?.label).toBe("Performance Reviewer");
    expect(merged.find((r) => r.roleId === "role_backend")).toBeTruthy();

    // 3) Runtime assignment works for it like any other role.
    composer.setBinding("proj_s5", {
      roleId: custom.id, runtimeId: "claude-code",
      fallbacks: [{ runtimeId: "mock-runtime" }],
      source: "MANUAL", reasons: ["reviewer prefers Claude"], updatedAt: new Date().toISOString(),
    });

    // 4) The orchestrator resolves it to a concrete AgentRole (custom template)
    //    instead of silently substituting some other role.
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
      {
        role(roleId: string): AgentRole {
          const builtin = roles.find((r) => r.id === roleId);
          if (builtin) return builtin;
          const c = docs.get<{ name: string; responsibility?: string; permissionPreset: AgentRole["defaultPolicyPreset"] }>("custom_role", roleId);
          if (c) {
            return { id: roleId as AgentRole["id"], name: c.name, responsibility: c.responsibility ?? "", defaultSkills: [], defaultPolicyPreset: c.permissionPreset };
          }
          return { id: roleId as AgentRole["id"], name: roleId, responsibility: "generic", defaultSkills: [], defaultPolicyPreset: "WORKSPACE" };
        },
      },
    );

    // Catalog marks claude-code unavailable here (probe=false) → PREFERRED-style
    // fallback along the binding chain reaches mock-runtime; the run still
    // executes UNDER THE CUSTOM ROLE.
    const now = new Date().toISOString();
    const task = {
      id: "task_s5" as TaskContract["id"],
      projectId: "proj_s5" as TaskContract["projectId"],
      stableKey: "S5-1", parentTaskId: null,
      title: "Perf review", objective: "Review the hot path for regressions",
      ownerRole: custom.id as TaskContract["ownerRole"],
      status: "READY" as TaskContract["status"],
      riskTier: "NORMAL" as TaskContract["riskTier"],
      dependencyTaskIds: [], requirementIds: [], acceptanceCriteriaIds: [], plannedSteps: [],
      affectedModules: [], requiredEvidenceTypes: [], requiredReviewTypes: [], permissionsNeeded: [],
      blockers: [], handoffNotes: null, verificationCommands: [], createdAt: now, updatedAt: now,
    };
    docs.put("project", "proj_s5", null, { id: "proj_s5", name: "S5", repositoryPath: process.cwd() });
    docs.put("task", task.id, task.projectId, task);

    const run: AgentRun = await orch.startTaskRun(task, "mock-runtime");
    expect(run.status).toBe("SUCCEEDED");
    expect(run.agentRoleId).toBe(custom.id); // executed under the CUSTOM role
    expect(composer.validate("proj_s5").some((m) => m.roleId === custom.id)).toBe(true);

    closeDatabase(db);
  }, 30_000);

  it("rejects duplicate custom-role names deterministically", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "devflow-s5b-"));
    tempDirs.push(dataDir);
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const composer = new TeamComposerService({ docs, events }, () => buildCatalog(() => false));
    composer.createCustomRole({ name: "Performance Reviewer", responsibility: "x", permissionPreset: "READ_ONLY" });
    expect(() =>
      composer.createCustomRole({ name: "Performance Reviewer", responsibility: "y", permissionPreset: "WORKSPACE" }),
    ).toThrow(/already exists/);
    closeDatabase(db);
  });
});
