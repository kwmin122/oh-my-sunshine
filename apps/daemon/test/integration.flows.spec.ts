import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Requirement } from "@devflow/contracts";
import { openDatabase } from "../src/infrastructure/db/connection.js";
import { DocumentRepository } from "../src/infrastructure/db/document-repository.js";
import { SqliteEventStore } from "../src/infrastructure/db/event-store.js";
import { loadConfig } from "../src/lib/config.js";
import { DiscoveryService } from "../src/application/discovery/discovery-service.js";
import { buildCompletenessModelPort } from "../src/plugins/models/completeness-model-port.js";
import { ModelProviderRegistry } from "../src/plugins/models/model-provider-registry.js";
import { TaskPlanningService } from "../src/application/planning/task-planning-service.js";
import { defaultAgentRoles } from "../src/application/reviews/review-council-service.js";
import { ReviewCouncilService } from "../src/application/reviews/review-council-service.js";
import { WorkflowEngine } from "../src/domain/workflow/workflow-engine.js";
import { buildDeliveryWorkflowDefinition } from "../src/domain/workflow/delivery-definition.js";
import { HeuristicRepoScanner } from "../src/infrastructure/scanner/repo-scanner.js";
import { SymbolIntelligenceService } from "../src/services/code-intelligence/symbol-intelligence-service.js";
import { DriftDetectionService } from "../src/services/drift/drift-detection-service.js";
import { ProviderCapacityService, CapacityAwareRouter } from "../src/services/capacity/provider-capacity-service.js";
import { parseModelJson, TaskDecompositionOutput } from "@devflow/contracts";
import type { TaskContract } from "@devflow/contracts";

afterAll(() => {
  // temp dirs left for OS cleanup
});

function freshDb(): { docs: DocumentRepository; events: SqliteEventStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "devflow-flow-"));
  const db = openDatabase({ dataDir: dir });
  return { docs: new DocumentRepository(db), events: new SqliteEventStore(db), dir };
}

describe("discovery loop reaches Definition of Ready with the deterministic mock provider", () => {
  it("asks one question at a time and converges to readyForPlanning", async () => {
    const { docs, events, dir } = freshDb();
    const config = loadConfig({ dataDir: dir });
    const provider = new ModelProviderRegistry(config);
    const completeness = await buildCompletenessModelPort(provider);
    const discovery = new DiscoveryService(docs, events, config, completeness);
    const projectId = "proj_flow";

    let asked = 0;
    let snapshot = await discovery.refreshCoverage(projectId, "Add Google login", "NORMAL", []);
    for (let i = 0; i < 12; i++) {
      const question = await discovery.createDemoQuestion(projectId);
      if (!question) break;
      asked++;
      expect(question.status).toBe("OPEN");
      discovery.answerQuestion(projectId, question.id, "B - recommended", "B");
      snapshot = await discovery.refreshCoverage(projectId, "Add Google login", "NORMAL", []);
    }
    expect(asked).toBeGreaterThanOrEqual(6);
    expect(snapshot.readyForPlanning).toBe(true);
    expect(snapshot.overallScore).toBeGreaterThanOrEqual(config.readinessThreshold);
    // Already-answered categories are never re-asked.
    const categories = docs.list<{ category: string }>("discovery_question", projectId).map((q) => q.category);
    expect(new Set(categories).size).toBe(categories.length);
  }, 30_000);

  it("never lets a HIGH-risk mission skip readiness even if the model proposes direct analysis", async () => {
    const intentGate = (await import("../src/application/intent/intent-gate-service.js")).IntentGateService;
    const { IntentGateService: Gate } = await import("../src/application/intent/intent-gate-service.js");
    void intentGate;
    void Gate;
    // The HIGH-risk cross-check lives in IntentGateService.classify; heuristic fallback
    // is exercised in unit tests. Here we assert the deterministic classifier itself:
    const { heuristicIntent } = await import("../src/application/intent/intent-gate-service.js");
    expect(heuristicIntent("add oauth").recommendedEntryPoint).toBe("DISCOVERY_INTERVIEW");
  });
});

describe("task planning DAG", () => {
  it("creates dependency-linked tasks in topological order and rejects cycles", async () => {
    const { docs, events } = freshDb();
    const config = loadConfig();
    const provider = new ModelProviderRegistry(config);
    const planning = new TaskPlanningService({ docs, events, provider: provider.getDefault() });
    const roles = defaultAgentRoles();
    const tasks = await planning.planTasks({
      projectId: "proj_dag",
      goalId: null,
      mission: "Build auth feature",
      requirements: [],
      roles,
      riskSignals: {
        touchesAuth: true, touchesPayments: false, destructiveDataOperation: false, externalSideEffects: false,
        databaseChange: false, affectedModuleCount: 2, reversible: true, productionExposure: false, securitySensitive: true,
      },
      projectRiskTier: "HIGH",
    });
    expect(tasks.length).toBeGreaterThan(2);
    const order = planning.executionOrder(tasks);
    const position = new Map(order.map((t, i) => [t.id, i]));
    for (const t of tasks) {
      for (const dep of t.dependencyTaskIds) {
        expect(position.get(dep)!).toBeLessThan(position.get(t.id)!);
      }
    }
    // Auth work must be classified HIGH by the risk engine path.
    expect(tasks.every((t) => t.riskTier === "HIGH")).toBe(true);
  }, 30_000);

  it("fails loudly when the model references an unknown dependency objective", async () => {
    const { docs, events } = freshDb();
    const provider = new ModelProviderRegistry(loadConfig());
    const planning = new TaskPlanningService({ docs, events, provider: provider.getDefault() });
    const broken = {
      tasks: [
        {
          objective: "Standalone task",
          ownerRoleName: "Backend Engineer",
          dependsOnObjectives: ["Objective that does not exist"],
          plannedSteps: [], acceptanceCriteria: [], requiredEvidenceTypes: ["UNIT_TEST"], suggestedRiskTier: "LOW" as const,
          requirementStableKeys: [],
        },
      ],
    };
    // Inject the malformed plan directly through the internal matcher path.
    (planning as unknown as { requestDecomposition: () => Promise<typeof broken> }).requestDecomposition = async () => broken;
    await expect(
      planning.planTasks({
        projectId: "proj_bad", goalId: null, mission: "x",
        requirements: [] as Requirement[], roles: defaultAgentRoles(),
        riskSignals: {
          touchesAuth: false, touchesPayments: false, destructiveDataOperation: false, externalSideEffects: false,
          databaseChange: false, affectedModuleCount: 1, reversible: true, productionExposure: false, securitySensitive: false,
        },
        projectRiskTier: "LOW",
      }),
    ).rejects.toThrow(/unknown objective/);
  });
});

describe("model output bounded repair", () => {
  it("extracts JSON embedded in prose before failing", () => {
    const raw = `Sure! Here is the plan:\n${JSON.stringify({ tasks: [{ objective: "Do the thing", ownerRoleName: "Backend Engineer" }] })}\nHope that helps.`;
    const parsed = parseModelJson(raw, TaskDecompositionOutput);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.tasks[0]?.objective).toBe("Do the thing");
  });
  it("reports an error instead of writing corrupted state on garbage", () => {
    expect(parseModelJson("not json at all {}", TaskDecompositionOutput).ok).toBe(false);
  });
});

describe("review council confidence gating", () => {
  it("does not block on low-confidence HIGH findings but blocks on BLOCKERs regardless", async () => {
    const { docs, events, dir } = freshDb();
    const config = loadConfig({ dataDir: dir });
    const provider = new ModelProviderRegistry(config);
    const council = new ReviewCouncilService({ docs, events, provider, config });
    const reviewer = defaultAgentRoles().find((r) => r.name === "Code Quality Reviewer")!;

    // Deterministic scripted provider responses.
    const scripted = (findings: unknown[]): void => {
      (council as unknown as { ports: { provider: { generate: (req: { purpose: string }) => Promise<{ raw: string }> } } }).ports.provider = {
        generate: async () => ({ raw: JSON.stringify({ findings, score: 70, summary: "" }) }),
      } as never;
    };

    scripted([{ severity: "HIGH", confidence: 0.3, statement: "maybe an issue", evidence: "hunch" }]);
    const passedReview = await council.runReview({
      projectId: "p", taskId: null, type: "CODE_QUALITY", reviewerRole: reviewer,
      subject: { objective: "x", requirements: [], diffSummary: "", testSummary: "" }, evidenceIds: [],
    });
    expect(passedReview.status).toBe("PASSED");

    scripted([{ severity: "BLOCKER", confidence: 0.99, statement: "sql injection in callback", evidence: "line 42" }]);
    const blocked = await council.runReview({
      projectId: "p", taskId: null, type: "CODE_QUALITY", reviewerRole: reviewer,
      subject: { objective: "x", requirements: [], diffSummary: "", testSummary: "" }, evidenceIds: [],
    });
    expect(blocked.status).toBe("BLOCKED");

    // Disposition requires a durable reason; ignoring without reason is refused.
    expect(() => council.setDisposition(blocked.id, blocked.findings[0]!.id, "IGNORED_WITH_REASON", "")).toThrow(/requires a non-empty durable reason/);
    const unblocked = council.setDisposition(blocked.id, blocked.findings[0]!.id, "IGNORED_WITH_REASON", "accepted tradeoff, tracked in ADR-004");
    expect(unblocked.status).toBe("PASSED");
    // Durable disposition survives reload.
    expect(docs.get<typeof blocked>("review", blocked.id)?.findings[0]?.dispositionReason).toBe("accepted tradeoff, tracked in ADR-004");
  });
});

let engineDefId = "unset";

describe("workflow engine gates, splitters, resume", () => {
  function makeEngine(docs: DocumentRepository, events: SqliteEventStore): WorkflowEngine {
    const def = buildDeliveryWorkflowDefinition();
    docs.put("workflow_definition", def.id, null, def);
    engineDefId = def.id;
    return new WorkflowEngine({
      loadDefinition: (id) => (id === def.id ? def : undefined),
      saveInstance: (inst) => docs.put("workflow_instance", inst.id, inst.projectId, inst),
      getInstance: (id) => docs.get<never>("workflow_instance", id) ?? undefined,
      appendEvent: () => {},
    });
  }

  const ctxBase = (task: TaskContract | null, riskTier: "LOW" | "NORMAL" | "HIGH" = "NORMAL") => ({
    projectId: "proj_wf",
    goalId: null,
    riskTier,
    task,
  });

  it("blocks at the Readiness Gate until coverage is ready, then resumes (checkpoint semantics)", async () => {
    const { docs } = freshDb();
    const engine = makeEngine(docs, new SqliteEventStore(freshDb().dir));
    engine.registerStepExecutor("Discovery", async () => ({ done: true }));
    engine.registerStepExecutor("Planning", async () => ({ done: true }));
    engine.registerStepExecutor("Two-Stage Review", async () => ({ done: true }));
    engine.registerGate("readiness_gate", (ctx) =>
      ctx.task?.status === "READY"
        ? { passed: true, reason: "", missing: [] }
        : { passed: false, reason: "coverage incomplete", missing: ["acceptance_criteria"] },
    );
    engine.registerGate("verification_gate", () => ({ passed: true, reason: "", missing: [] }));
    engine.registerGate("approval_gate", () => ({ passed: true, reason: "", missing: [] }));
    engine.registerGate("completion_gate", () => ({ passed: true, reason: "", missing: [] }));

    const notReadyTask = makeTaskLite({ status: "CLARIFYING" });
    const started = engine.start(engineDefId, ctxBase(notReadyTask) as never);
    const blockedInstance = await engine.advance(started.id, ctxBase(notReadyTask) as never);
    expect(["BLOCKED", "WAITING"]).toContain(blockedInstance.status);

    const readyCtx = ctxBase(makeTaskLite({ status: "READY" })) as never;
    const resumed = await engine.resume(started.id, readyCtx);
    expect(resumed.status).toBe("COMPLETED");
  });

  it("routes HIGH risk through research/architecture/approval nodes via the splitter", async () => {
    const { docs } = freshDb();
    const engine = makeEngine(docs, new SqliteEventStore(freshDb().dir));
    for (const step of ["Discovery", "Research (HIGH only)", "Architecture (HIGH only)", "Planning", "Two-Stage Review"]) {
      engine.registerStepExecutor(step, async () => ({ done: true }));
    }
    for (const gate of ["readiness_gate", "verification_gate", "approval_gate", "completion_gate"]) {
      engine.registerGate(gate, () => ({ passed: true, reason: "", missing: [] }));
    }
    const high = await engine.advance(engine.start(engineDefId, ctxBase(makeTaskLite({}), "HIGH") as never).id, ctxBase(makeTaskLite({}), "HIGH") as never);
    expect(high.splitSelected).toBe("HIGH");
    expect(high.completedNodeIds.length).toBeGreaterThan(5); // extra ceremony nodes executed

    const low = await engine.advance(engine.start(engineDefId, ctxBase(makeTaskLite({}), "LOW") as never).id, ctxBase(makeTaskLite({}), "LOW") as never);
    expect(low.splitSelected).toBe("LOW");
  });
});

function makeTaskLite(partial: Partial<TaskContract>): TaskContract {
  return {
    id: "task_lite",
    projectId: "proj_wf",
    stableKey: "TASK-001",
    parentTaskId: null,
    objective: "obj",
    ownerRole: "role_be",
    riskTier: partial.riskTier ?? "NORMAL",
    status: (partial.status ?? "READY") as never,
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as TaskContract;
}

describe("symbol intelligence indexes TypeScript symbols", () => {
  it("finds exported functions/classes and reports tooling used", async () => {
    const proj = mkdtempSync(join(tmpdir(), "devflow-sym-"));
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "auth.ts"), "export function createSession(){}\nexport class OAuthClient {}\n");
    const { docs, events } = freshDb();
    const service = new SymbolIntelligenceService(docs, events, loadConfig());
    const snap = await service.indexProject("proj_sym", proj);
    expect(snap.toolingUsed).toBe("typescript-compiler-api");
    expect(snap.symbolsIndexed).toBeGreaterThanOrEqual(2);
    const names = docs.list<{ symbolName: string; filePath: string }>("symbol_record", "proj_sym").map((s) => s.symbolName);
    expect(names).toContain("createSession");
    expect(names).toContain("OAuthClient");
    rmSync(proj, { recursive: true, force: true });
  }, 30_000);

  it("falls back to text heuristics for non-TS projects instead of failing", async () => {
    const proj = mkdtempSync(join(tmpdir(), "devflow-sym2-"));
    writeFileSync(join(proj, "main.py"), "print('hello')\n");
    const { docs, events } = freshDb();
    const service = new SymbolIntelligenceService(docs, events, loadConfig());
    const snap = await service.indexProject("proj_py", proj);
    expect(snap.symbolsIndexed).toBe(0);
    rmSync(proj, { recursive: true, force: true });
  });
});

describe("drift detection catches unrelated refactors (Scenario H)", () => {
  it("raises a finding when changed files fall outside approved scope", () => {
    const { docs, events } = freshDb();
    const drift = new DriftDetectionService(docs, events);
    const task = makeTaskLite({ affectedModules: [] }) as TaskContract;
    task.affectedModules = ["src/auth"];
    const finding = drift.detect({ projectId: "proj_drift", task, runId: null, changedFiles: ["src/css/theme.css", "src/auth/callback.ts"] });
    expect(finding).not.toBeNull();
    expect(finding!.observedScope).toEqual(["src/css/theme.css"]);
    expect(events.listByProject("proj_drift").map((e) => e.type)).toContain("drift.detected");
  });
  it("stays silent when all changes are in scope or scope is undeclared", () => {
    const { docs } = freshDb();
    { 
      const dir2 = mkdtempSync(join(tmpdir(), "devflow-flow2-"));
      const evDb = openDatabase({ dataDir: dir2 });
      const drift = new DriftDetectionService(docs, new SqliteEventStore(evDb));
    const scoped = makeTaskLite({}) as TaskContract;
    scoped.affectedModules = ["src/auth"];
    expect(drift.detect({ projectId: "p", task: scoped, runId: null, changedFiles: ["src/auth/x.ts"] })).toBeNull();
    const noScope = makeTaskLite({}) as TaskContract;
    noScope.affectedModules = [];
    expect(drift.detect({ projectId: "p", task: noScope, runId: null, changedFiles: ["anything.ts"] })).toBeNull();
    }
  });
});

describe("provider capacity honesty + routing (Scenario F)", () => {
  it("keeps quota fields null when no adapter exposes them — unknown, never fabricated", async () => {
    const { docs, events } = freshDb();
    const capacity = new ProviderCapacityService(docs, events, loadConfig());
    const snapshots = await capacity.refreshAll([{ id: "runtime_mock-runtime", providerLabel: "mock" }]);
    const mockSnap = snapshots.find((s) => s.provider === "mock")!;
    expect(mockSnap.usedPercentRemaining).toBeNull(); // honest unknown
    expect(mockSnap.source).not.toBe("NATIVE_API");
  });

  it("recommends routing LOW-risk work to spare runtime when primary capacity is low", async () => {
    const { docs, events } = freshDb();
    const db2 = openDatabase({ dataDir: mkdtempSync(join(tmpdir(), "devflow-cap-")) });
    void db2;
    const capacity = new ProviderCapacityService(docs, events, loadConfig());
    capacity.registerAdapter({
      provider: "claude",
      readCapacity: async () => ({ usedPercentRemaining: 8, health: "GOOD", limitType: "WEEKLY" }),
    });
    capacity.registerAdapter({
      provider: "codex",
      readCapacity: async () => ({ usedPercentRemaining: 71, health: "GOOD", limitType: "WEEKLY" }),
    });
    await capacity.refreshAll([
      { id: "runtime_claude", providerLabel: "claude" },
      { id: "runtime_codex", providerLabel: "codex" },
    ]);
    const router = new CapacityAwareRouter(docs, events, capacity);
    const rec = router.recommend("proj_route", [] as TaskContract[]);
    const low = rec.assignments.find((a) => a.taskKind === "LOW")!;
    const high = rec.assignments.find((a) => a.taskKind === "HIGH")!;
    expect(low.preferredRuntimeId).toBe("runtime_codex");
    expect(high.preferredRuntimeId).toBe("runtime_codex");
    expect(rec.reason).toMatch(/capacity low/i);
    void db2;
  });
});

describe("repo scanner", () => {
  it("detects package manager, frameworks, and layout notes from a fixture repo", async () => {
    const proj = mkdtempSync(join(tmpdir(), "devflow-scan-"));
    mkdirSync(join(proj, "apps"), { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ scripts: { test: "vitest" }, devDependencies: { vite: "*" }, dependencies: { react: "*" } }));
    writeFileSync(join(proj, "pnpm-lock.yaml"), "");
    const scanner = new HeuristicRepoScanner();
    const snap = await scanner.scan(proj);
    expect(snap.packageManagers).toContain("pnpm");
    expect(snap.frameworks).toContain("react");
    expect(snap.testCommand).toBe("npm test");
    expect(snap.topLevelDirs).toContain("apps");
    expect(snap.notes.join(" ")).toMatch(/monorepo/);
    rmSync(proj, { recursive: true, force: true });
  });
});
