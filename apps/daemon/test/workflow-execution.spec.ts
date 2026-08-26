import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
import { CompletionService, VerificationService } from "../src/application/verification/verification-service.js";
import { DecisionService } from "../src/application/governance/decision-service.js";
import { defaultAgentRoles } from "../src/application/reviews/review-council-service.js";
import { TeamComposerService, buildCatalog } from "../src/application/team/team-composer-service.js";
import { HandoffService } from "../src/application/orchestration/handoff-service.js";
import { AgentOrchestrator } from "../src/application/orchestration/agent-orchestrator.js";
import { WorkflowComposerService } from "../src/application/workflow/workflow-composer-service.js";
import { ProjectService } from "../src/application/project/project-service.js";
import { WorkflowEngine } from "../src/domain/workflow/workflow-engine.js";
import { buildDeliveryWorkflowDefinition } from "../src/domain/workflow/delivery-definition.js";
import { ModelProviderRegistry } from "../src/plugins/models/model-provider-registry.js";
import { buildCompletenessModelPort } from "../src/plugins/models/completeness-model-port.js";
import { DiscoveryService } from "../src/application/discovery/discovery-service.js";
import { SpecificationService } from "../src/application/specification/specification-service.js";
import { TaskPlanningService } from "../src/application/planning/task-planning-service.js";
import { ReviewCouncilService } from "../src/application/reviews/review-council-service.js";
import { ResearchService } from "../src/application/research/research-service.js";
import { ArchitectureService, ImpactAnalysisService } from "../src/application/architecture/architecture-service.js";
import { IntentGateService } from "../src/application/intent/intent-gate-service.js";
import { EvidenceFreshnessService } from "../src/application/verification/verification-service.js";
import { HeuristicRepoScanner } from "../src/infrastructure/scanner/repo-scanner.js";

/**
 * S4b evidence: a custom workflow applied to a project changes ACTUAL planning
 * output and execution order — Planner → Coder → Reviewer produces WF-01..03
 * with chained dependencies, and the engine refuses to execute a task whose
 * upstream has not reached DONE.
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

describe("S4b: composed workflow drives planning and execution order", () => {
  it("plans one task per composed step in dependency order and enforces it", async () => {
    const dataDir = makeTempDir("devflow-s4-data-");
    const workspaceRoot = makeTempDir("devflow-s4-ws-");
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const config = loadConfig({ dataDir });
    const provider = new ModelProviderRegistry(config);
    const completenessModel = await buildCompletenessModelPort(provider);

    const deliveryDef = buildDeliveryWorkflowDefinition();
    docs.put("workflow_definition", deliveryDef.id, null, deliveryDef);
    const workflow = new WorkflowEngine({
      loadDefinition: (id) => (id === deliveryDef.id ? deliveryDef : undefined),
      saveInstance: (inst) => docs.put("workflow_instance", inst.id, inst.projectId, inst),
      getInstance: (id) => docs.get<never>("workflow_instance", id) ?? undefined,
      appendEvent: () => undefined,
    });

    const registry = new AgentRuntimeRegistry();
    const composer = new TeamComposerService({ docs, events }, () => buildCatalog(() => false));
    const roles: AgentRole[] = defaultAgentRoles();
    for (const role of roles) docs.put("agent_role", role.id, null, role);

    const gateway = new ActionGateway({ docs, events, policy: new PresetPolicyEngine() });
    const decisions = new DecisionService(docs, events);
    const orchestrator = new AgentOrchestrator(
      {
        docs,
        events,
        gateway,
        contextCompiler: new ContextCompiler(docs, 32_000),
        completion: new CompletionService(docs),
        decisions,
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

    const workflowComposer = new WorkflowComposerService({ docs, events });
    const projects = new ProjectService({
      docs,
      events,
      config,
      discovery: new DiscoveryService(docs, events, config, completenessModel),
      completenessModel,
      specification: new SpecificationService(docs, events, provider.getDefault()),
      planning: new TaskPlanningService({ docs, events, provider: provider.getDefault() }),
      reviews: new ReviewCouncilService({ docs, events, provider: provider.getDefault(), config }),
      orchestrator,
      verification: new VerificationService(docs, events, gateway, { isRepository: async () => false } as never),
      freshness: new EvidenceFreshnessService(docs, events),
      completion: new CompletionService(docs),
      research: new ResearchService(docs, events, provider.getDefault()),
      architecture: new ArchitectureService(docs, events, provider.getDefault(), { listOpen: () => [] } as never),
      impact: new ImpactAnalysisService(docs, events),
      intentGate: new IntentGateService(docs, events, provider.getDefault()),
      workflow,
      git: { isRepository: async () => true, currentRevision: async () => "no-git", changedFiles: async () => [], diffSummary: async () => "", listBranches: async () => [] },
      workflowComposer,
      roles: () => roles,
      scanner: new HeuristicRepoScanner(),
      tools: new ToolRegistry(config),
      deliveryWorkflowId: deliveryDef.id,
    });

    // Compose a custom flow: Planner → Backend Coder → Code Reviewer.
    // Real git workspace so createProject's repository attach passes.
    execFileSync("git", ["init", "-q", workspaceRoot]);

    const wf = workflowComposer.create("Planner-led flow", [
      { key: "plan", roleId: "role_pm", objective: "Turn the mission into a concrete plan" },
      { key: "build", roleId: "role_be", objective: "Implement what the plan says" },
      { key: "review", roleId: "role_codereviewer", objective: "Review the implementation" },
    ], []);
    const project = await projects.createProject({ name: "S4", repositoryPath: workspaceRoot });
    await projects.submitMission(project.id, "Add Google login");
    workflowComposer.applyToProject(project.id as string, wf.id);

    const tasks = await projects.planDeliveryTasks(project.id as string, { overrideReadinessGate: true });
    expect(tasks.map((t) => t.stableKey)).toEqual(["WF-01", "WF-02", "WF-03"]);
    expect(tasks.map((t) => t.ownerRole)).toEqual(["role_pm", "role_be", "role_codereviewer"]);
    const [, coder, reviewer] = tasks;
    expect(coder!.dependencyTaskIds).toEqual([tasks[0]!.id]);
    expect(reviewer!.dependencyTaskIds).toEqual([coder!.id]);

    // Execution order is ENFORCED by the engine:
    await expect(projects.executeTask(reviewer!.id)).rejects.toThrow(/upstream task/);
    await expect(projects.executeTask(coder!.id)).rejects.toThrow(/upstream task/);

    // Upstream DONE unblocks the next stage.
    docs.put("task", tasks[0]!.id, project.id as string, { ...tasks[0]!, status: "DONE" } as TaskContract);
    const run2 = await projects.executeTask(coder!.id);
    expect(run2.status).toBe("SUCCEEDED"); // mock runtime completes the implementation

    closeDatabase(db);
  }, 60_000);
});
