import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole, TaskContract } from "@devflow/contracts";
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
 * S6 evidence (V3 §21): conditional routing rules change the actual selection
 * per condition; LOCKED is immune; the orchestrator audits rule applications.
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function freshComposer() {
  const dir = mkdtempSync(join(tmpdir(), "devflow-s6-"));
  tempDirs.push(dir);
  const db = openDatabase({ dataDir: dir } as never);
  const composer = new TeamComposerService(
    { docs: new DocumentRepository(db), events: new SqliteEventStore(db) },
    () => buildCatalog(() => false), // catalog: only mock-runtime available
  );
  return { composer, close: () => closeDatabase(db) };
}

describe("S6a: rule condition semantics", () => {
  it("risk: HIGH routes to the rule's runtime; LOW/NORMAL do not", () => {
    const { composer, close } = freshComposer();
    const rules = [{ when: { risk: "HIGH" as const }, use: "codex-cli" }];
    expect(composer.evaluateRoutingRules(rules, { riskTier: "HIGH", primaryAvailable: true })?.runtimeId).toBe("codex-cli");
    expect(composer.evaluateRoutingRules(rules, { riskTier: "LOW", primaryAvailable: true })).toBeNull();
    expect(composer.evaluateRoutingRules(rules, { riskTier: "NORMAL", primaryAvailable: true })).toBeNull();
    close();
  });

  it("quotaBelowPct matches only when quota is KNOWN and below threshold — unknown never satisfies", () => {
    const { composer, close } = freshComposer();
    const rules = [{ when: { quotaBelowPct: 10 }, use: "local-model" }];
    expect(composer.evaluateRoutingRules(rules, { quotaPct: 5, primaryAvailable: true })?.runtimeId).toBe("local-model");
    expect(composer.evaluateRoutingRules(rules, { quotaPct: 50, primaryAvailable: true })).toBeNull();
    // unknown quota stays honest — no match
    expect(composer.evaluateRoutingRules(rules, { quotaPct: null, primaryAvailable: true })).toBeNull();
    close();
  });

  it("unavailable: matches when the primary is down; unavailable=false matches when healthy", () => {
    const { composer, close } = freshComposer();
    const rules = [{ when: { unavailable: true }, use: "claude-code" }];
    expect(composer.evaluateRoutingRules(rules, { primaryAvailable: false })?.runtimeId).toBe("claude-code");
    expect(composer.evaluateRoutingRules(rules, { primaryAvailable: true })).toBeNull();
    close();
  });

  it("failedAttemptsGte fires at and above the bound only", () => {
    const { composer, close } = freshComposer();
    const rules = [{ when: { failedAttemptsGte: 2 }, use: "codex-cli" }];
    expect(composer.evaluateRoutingRules(rules, { failedAttempts: 2, primaryAvailable: true })?.runtimeId).toBe("codex-cli");
    expect(composer.evaluateRoutingRules(rules, { failedAttempts: 5, primaryAvailable: true })?.runtimeId).toBe("codex-cli");
    expect(composer.evaluateRoutingRules(rules, { failedAttempts: 1, primaryAvailable: true })).toBeNull();
    expect(composer.evaluateRoutingRules(rules, { primaryAvailable: true })).toBeNull(); // no attempts ≠ match
    close();
  });

  it("first matching rule wins", () => {
    const { composer, close } = freshComposer();
    const rules = [
      { when: { risk: "HIGH" as const }, use: "first" },
      { when: {}, use: "catch-all" },
    ];
    expect(composer.evaluateRoutingRules(rules, { riskTier: "HIGH", primaryAvailable: true })?.runtimeId).toBe("first");
    expect(composer.evaluateRoutingRules(rules, { riskTier: "LOW", primaryAvailable: true })?.runtimeId).toBe("catch-all");
    close();
  });
});

describe("S6b: rules in resolution + LOCKED immunity + orchestration audit", () => {
  function makeHarness() {
    const dir = mkdtempSync(join(tmpdir(), "devflow-s6b-"));
    tempDirs.push(dir);
    return dir;
  }

  it("PREFERRED+rule reroutes HIGH-risk tasks; LOCKED ignores rules entirely", () => {
    makeHarness();
    const { composer, docs, events, close } = freshComposer();
    void docs; void events;
    // PREFERRED binding with a risk rule.
    composer.setBinding("proj_s6", {
      roleId: "role_backend", runtimeId: "mock-runtime", routingMode: "PREFERRED",
      routingRules: [{ when: { risk: "HIGH" }, use: "codex-cli" }],
      fallbacks: [], source: "MANUAL", reasons: [], updatedAt: new Date().toISOString(),
    });
    // Catalog has codex unavailable (probe=false) → rule target unusable → falls through to chain.
    const lowRisk = composer.resolveDetailed("proj_s6", "t1", "role_backend", undefined, { riskTier: "LOW", quotaPct: null });
    expect(lowRisk.runtime?.runtimeId).toBe("mock-runtime");
    expect(lowRisk.ruleApplied).toBeUndefined();

    // Make codex available via a fresh composer with probe=true.
    const db2dir = mkdtempSync(join(tmpdir(), "devflow-s6b2-"));
    tempDirs.push(db2dir);
    const db2 = openDatabase({ dataDir: db2dir } as never);
    const composer2 = new TeamComposerService(
      { docs: new DocumentRepository(db2), events: new SqliteEventStore(db2) },
      () => buildCatalog(() => true),
    );
    composer2.setBinding("proj_s6", {
      roleId: "role_backend", runtimeId: "mock-runtime", routingMode: "PREFERRED",
      routingRules: [{ when: { risk: "HIGH" }, use: "codex-cli" }],
      fallbacks: [], source: "MANUAL", reasons: [], updatedAt: new Date().toISOString(),
    });
    const highRisk = composer2.resolveDetailed("proj_s6", "t2", "role_backend", undefined, { riskTier: "HIGH", quotaPct: null });
    expect(highRisk.ruleApplied?.runtimeId).toBe("codex-cli");
    expect(highRisk.runtime?.runtimeId).toBe("codex-cli");
    expect(highRisk.runtime?.chain).toContain("rule→codex-cli");

    // LOCKED binding: identical rule must be IGNORED (user pin wins).
    composer2.setBinding("proj_s6", {
      roleId: "role_qa", runtimeId: "mock-runtime", routingMode: "LOCKED",
      routingRules: [{ when: { risk: "HIGH" }, use: "codex-cli" }],
      fallbacks: [], source: "MANUAL", reasons: ["user pinned"], updatedAt: new Date().toISOString(),
    });
    const locked = composer2.resolveDetailed("proj_s6", "t3", "role_qa", undefined, { riskTier: "HIGH", quotaPct: null });
    expect(locked.ruleApplied).toBeUndefined();
    expect(locked.runtime?.runtimeId).toBe("mock-runtime");

    close();
    closeDatabase(db2);
  });

  it("orchestrator executes a HIGH-risk task on the rule-selected runtime and records routing.rule_applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devflow-s6c-"));
    tempDirs.push(dir);
    const workspaceRoot = mkdtempSync(join(tmpdir(), "devflow-s6c-ws-"));
    // Fake claude binary so the rule target is registered AND executable.
    const bin = join(dir, "fake-claude");
    writeFileSync(bin, "#!/bin/bash\ncat > /dev/null\necho '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s\",\"tools\":[]}'\necho '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"high risk handled\"}'\n");
    chmodSync(bin, 0o755);

    const db = openDatabase({ dataDir: dir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const config = loadConfig({ dataDir: dir });
    const registry = new AgentRuntimeRegistry();
    registry.registerCliIfAvailable("claude-code", bin, "claude-code", true);
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
          resolveDetailed: (p, t, r, o, ctx) => composer.resolveDetailed(p as string, t as string, r as string, o, ctx),
          listRuntimeIds: () => registry.listIds(),
        },
      },
      { get: (id) => registry.get(id) },
      { role: (roleId) => roles.find((r) => r.id === roleId) ?? roles[0]! },
    );

    composer.setBinding("proj_s6c", {
      roleId: "role_security", runtimeId: "mock-runtime", routingMode: "AUTO",
      routingRules: [{ when: { risk: "HIGH" }, use: "claude-code" }],
      fallbacks: [], source: "MANUAL", reasons: [], updatedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    const task: TaskContract = {
      id: "task_s6c" as TaskContract["id"],
      projectId: "proj_s6c" as TaskContract["projectId"],
      stableKey: "S6-1", parentTaskId: null, title: "x",
      objective: "security-sensitive work", ownerRole: "role_security" as TaskContract["ownerRole"],
      status: "READY", riskTier: "HIGH", dependencyTaskIds: [], requirementIds: [],
      acceptanceCriteriaIds: [], plannedSteps: [], affectedModules: [],
      requiredEvidenceTypes: [], requiredReviewTypes: [], permissionsNeeded: [],
      blockers: [], handoffNotes: null, verificationCommands: [], createdAt: now, updatedAt: now,
    };
    docs.put("project", "proj_s6c", null, { id: "proj_s6c", name: "S6", repositoryPath: workspaceRoot });
    docs.put("task", task.id, task.projectId, task);

    const run = await orch.startTaskRun(task, "mock-runtime"); // caller default; rule overrides
    expect(run.status).toBe("SUCCEEDED");
    // The RULE-selected CLI actually ran — its summary prefix proves it.
    expect(run.summary).toContain("[claude-code]");
    const evt = events.listByProject("proj_s6c" as never).find((e) => e.type === "routing.rule_applied");
    expect(evt).toBeTruthy();
    expect((evt!.payload as { selectedRuntime: string }).selectedRuntime).toBe("claude-code");
    expect((evt!.payload as { riskTier: string }).riskTier).toBe("HIGH");

    closeDatabase(db);
  }, 30_000);
});
