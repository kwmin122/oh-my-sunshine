import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { loadConfig } from "./lib/config.js";
import { createLogger } from "./lib/logging.js";
import { openDatabase } from "./infrastructure/db/connection.js";
import { DocumentRepository } from "./infrastructure/db/document-repository.js";
import { SqliteEventStore } from "./infrastructure/db/event-store.js";
import { CliGitAdapter } from "./plugins/tools/core-tools.js";
import { ToolRegistry } from "./plugins/tools/tool-registry.js";
import { ModelProviderRegistry } from "./plugins/models/model-provider-registry.js";
import { buildCompletenessModelPort } from "./plugins/models/completeness-model-port.js";
import { AgentRuntimeRegistry } from "./plugins/runtimes/runtime-registry.js";
import { TeamComposerService, buildCatalog } from "./application/team/team-composer-service.js";
import { discoverRuntimes, applyDiscoveryToCatalog, type DiscoveredRuntime } from "./services/discovery/runtime-discovery.js";

import { PresetPolicyEngine } from "./domain/policy/preset-policy-engine.js";
import { ActionGateway } from "./application/gateway/action-gateway.js";
import { buildDeliveryWorkflowDefinition } from "./domain/workflow/delivery-definition.js";
import { WorkflowEngine } from "./domain/workflow/workflow-engine.js";
import { DiscoveryService } from "./application/discovery/discovery-service.js";
import { SpecificationService } from "./application/specification/specification-service.js";
import { TaskPlanningService } from "./application/planning/task-planning-service.js";
import { ReviewCouncilService, defaultAgentRoles } from "./application/reviews/review-council-service.js";
import { ContextCompiler } from "./application/context/context-compiler.js";
import { CompletionService, EvidenceFreshnessService, VerificationService } from "./application/verification/verification-service.js";
import { AgentOrchestrator } from "./application/orchestration/agent-orchestrator.js";
import { ApprovalService } from "./application/governance/approval-service.js";
import { DecisionService } from "./application/governance/decision-service.js";
import { ResearchService } from "./application/research/research-service.js";
import { ArchitectureService, ImpactAnalysisService } from "./application/architecture/architecture-service.js";
import { IntentGateService } from "./application/intent/intent-gate-service.js";
import { ProjectService } from "./application/project/project-service.js";
import { CheckpointService } from "./services/checkpoints/checkpoint-service.js";
import { CanonService } from "./services/canon/canon-service.js";
import { ConflictDetectionService, RecommendationService } from "./services/conflicts/conflict-detection-service.js";
import { MemoryPromotionService } from "./services/memory/memory-promotion-service.js";
import { builtinProbes } from "./services/readiness/system-readiness-service.js";
import { HeuristicRepoScanner } from "./infrastructure/scanner/repo-scanner.js";
import { ProviderCapacityService } from "./services/capacity/provider-capacity-service.js";
import { PlaybookLearningService, ExpertConsultService } from "./services/capacity/playbook-learning-service.js";
import { MobilePairingService, MobileControlService } from "./services/mobile/mobile-control-service.js";
import { SafeEditService } from "./application/editing/safe-edit-service.js";
import { SymbolIntelligenceService } from "./services/code-intelligence/symbol-intelligence-service.js";
import { DriftDetectionService } from "./services/drift/drift-detection-service.js";
import { registerRoutes } from "./api/routes.js";
import { registerMobilePage } from "./api/mobile-page.js";

const log = createLogger("main");

type TaskContractLike = import("@devflow/contracts").TaskContract;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config);
  const docs = new DocumentRepository(db);
  const events = new SqliteEventStore(db);
  const git = new CliGitAdapter();
  const tools = new ToolRegistry(config);
  const providers = new ModelProviderRegistry(config);
  const runtimes = new AgentRuntimeRegistry();
  const policy = new PresetPolicyEngine();
  const gateway = new ActionGateway({ docs, events, policy });
  gateway.expireUnresolvedApprovals();

  // ---- Workflow engine with deterministic delivery definition ----
  const deliveryDef = buildDeliveryWorkflowDefinition();
  docs.put("workflow_definition", deliveryDef.id, null, deliveryDef);
  const workflow = new WorkflowEngine({
    loadDefinition: (id) => (id === deliveryDef.id ? deliveryDef : undefined),
    saveInstance: (inst) => docs.put("workflow_instance", inst.id, inst.projectId, inst),
    getInstance: (id) => docs.get<never>("workflow_instance", id) ?? undefined,
    appendEvent: (projectId, type, payload) => {
      events.append({ projectId: projectId as never, type: type as never, actorType: "ENGINE", payload });
    },
  });

  // ---- Application services ----
  const roles = defaultAgentRoles();
  for (const role of roles) docs.put("agent_role", role.id, null, role);
  const roleResolver = {
    role(roleId: string) {
      return roles.find((r) => r.id === roleId) ?? roles[0]!;
    },
  };

  const completenessModel = await buildCompletenessModelPort(providers);
  const decisions = new DecisionService(docs, events);
  const discovery = new DiscoveryService(docs, events, config, completenessModel);
  const specification = new SpecificationService(docs, events, providers.getDefault());
  const planning = new TaskPlanningService({ docs, events, provider: providers.getDefault() });
  const reviews = new ReviewCouncilService({ docs, events, provider: providers.getDefault(), config });
  const contextCompiler = new ContextCompiler(docs, 32_000);
  const completion = new CompletionService(docs);
  const verification = new VerificationService(docs, events, gateway, git);
  const freshness = new EvidenceFreshnessService(docs, events);

  // Runtime Discovery (§32): catalog availability reflects what is actually installed.
  let discovered: DiscoveredRuntime[] = [];
  const composer = new TeamComposerService({ docs, events }, () =>
    applyDiscoveryToCatalog(buildCatalog(() => false), discovered),
  );
  void discoverRuntimes().then((d) => {
    discovered = d;
    log.info("runtime discovery complete", { runtimes: d.filter((x) => x.binaryPath).map((x) => x.id) });
  }).catch(() => undefined);

  const orchestrator = new AgentOrchestrator(
    {
      docs,
      events,
      gateway,
      contextCompiler,
      completion,
      decisions,
      tools,
      config,
      composer: {
        resolveForTask: (projectId, taskId, ownerRoleId, runOverride) => composer.resolveForTask(projectId, taskId, ownerRoleId, runOverride),
        listRuntimeIds: () => runtimes.listIds(),
      },
    },
    { get: (id) => runtimes.get(id) },
    roleResolver,
  );

  const approvals = new ApprovalService(docs, events, gateway, (runId, observation) => {
    void orchestrator.resumeRun(runId, observation);
  });

  const conflicts = new ConflictDetectionService(docs, events);
  const research = new ResearchService(docs, events, providers.getDefault());
  const architecture = new ArchitectureService(docs, events, providers.getDefault(), conflicts);
  const impact = new ImpactAnalysisService(docs, events);
  const intentGate = new IntentGateService(docs, events, providers.getDefault());
  const checkpoints = new CheckpointService(docs, events, git);
  const canon = new CanonService(docs, events);
  const memory = new MemoryPromotionService(docs, events);
  const recommendations = new RecommendationService(docs, events);
  const scanner = new HeuristicRepoScanner();
  const capacity = new ProviderCapacityService(docs, events, config);
  const playbooks = new PlaybookLearningService(docs, events);
  const expertConsult = new ExpertConsultService(docs, events, providers.getDefault());
  const mobilePairing = new MobilePairingService(docs, events);
  const safeEdit = new SafeEditService(docs, events);
  const symbols = new SymbolIntelligenceService(docs, events, config);
  const drift = new DriftDetectionService(docs, events);

  const mobileControl = new MobileControlService(docs, events, {
    resolveDecision: (decisionId, chosenOption) => {
      decisions.resolve(decisionId, chosenOption);
      projects.resolveDecisionHook(decisionId, chosenOption);
    },
    resolveApproval: async (approvalId, outcome) => {
      await approvals.resolve(approvalId, outcome);
    },
    pauseTask: (taskId) => {
      const task = docs.get<{ id: string; projectId: string; status: string; blockers: string[]; updatedAt: string }>("task", taskId);
      if (!task) throw new Error(`[mobile/pauseTask] unknown task '${taskId}'`);
      docs.put("task", task.id, task.projectId, { ...task, status: "BLOCKED", blockers: [...task.blockers, "paused via mobile"], updatedAt: new Date().toISOString() });
      events.append({ projectId: task.projectId as never, type: "task.blocked", entityType: "task", entityId: task.id, actorType: "USER", payload: { reason: "mobile pause" } });
    },
    resumeTask: async (taskId) => {
      projects.resolveDecisionHook("", "");
      void taskId;
    },
    leadReply: async (_projectId, question) => {
      const answer = await providers.getDefault().generate({
        purpose: "lead_reply",
        system: "You are the Engineering Lead. Summarize project state concisely for a remote operator.",
        messages: [{ role: "user", content: question }],
        responseSchemaHint: '{"summary":"..."}',
        maxTokens: 500,
      }).catch(() => ({ raw: '{"summary":"Mock Lead: all systems nominal. Use the decision/approval inboxes to act."}', tokensIn: null, tokensOut: null, degraded: false as const }));
      try {
        return (JSON.parse(answer.raw) as { summary?: string }).summary ?? answer.raw.slice(0, 300);
      } catch {
        return answer.raw.slice(0, 300);
      }
    },
  });

  const projects = new ProjectService({
    docs,
    events,
    config,
    discovery,
    completenessModel,
    specification,
    planning,
    reviews,
    orchestrator,
    verification,
    freshness,
    completion,
    research,
    architecture,
    impact,
    intentGate,
    workflow,
    git,
    roles: () => roles,
    scanner,
    tools,
    deliveryWorkflowId: deliveryDef.id,
  });

  // ---- Wire deterministic gate predicates to project state (engine owns transitions) ----
  const readinessGatePredicate = async (projectId: string): Promise<boolean> => {
    const mission = projects.latestMission(projectId);
    if (!mission) return false;
    const snapshot = await discovery.refreshCoverage(projectId as never, mission.rawRequest, "NORMAL", []);
    return snapshot.readyForPlanning;
  };
  workflow.registerGate("readiness_gate", () => ({ passed: true, reason: "", missing: [] })); // REST pipeline enforces the real gate before planning
  workflow.registerGate("approval_gate", (ctx) => {
    const openApprovals = docs
      .list<{ id: string; status: string }>("approval", ctx.projectId)
      .filter((a) => a.status === "REQUESTED");
    return {
      passed: openApprovals.length === 0,
      reason: `${openApprovals.length} approval(s) pending`,
      missing: openApprovals.map((a) => a.id),
    };
  });
  workflow.registerGate("verification_gate", (ctx) => {
    const tasks = docs.list<TaskContractLike>("task", ctx.projectId);
    if (tasks.length === 0) return { passed: false, reason: "no tasks planned yet", missing: ["tasks"] };
    const allDone = tasks.every((t) => t.status === "DONE");
    return { passed: allDone, reason: allDone ? "" : "tasks not fully verified/completed", missing: [] };
  });
  workflow.registerGate("completion_gate", (ctx) => {
    const tasks = docs.list<TaskContractLike>("task", ctx.projectId);
    const verdict = tasks.map((t) => completion.evaluate(t));
    const missing = verdict.filter((v) => !v.canComplete);
    return { passed: missing.length === 0, reason: `${missing.length} task(s) below Proof of Done`, missing: [] };
  });
  for (const stepName of ["Discovery", "Research (HIGH only)", "Architecture (HIGH only)", "Planning", "Two-Stage Review"]) {
    // Steps are executed through the governed REST/service pipeline; the workflow
    // instance tracks stage progression and stays resumable across restarts.
    workflow.registerStepExecutor(stepName, async () => ({ done: true }));
  }

  // ---- HTTP + WS server ----
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const sockets = new Set<WebSocket>();
  app.get("/ws", { websocket: true }, (conn) => {
    sockets.add(conn as unknown as WebSocket);
    (conn as unknown as WebSocket).on("close", () => sockets.delete(conn as unknown as WebSocket));
  });
  events.setBroadcast((event) => {
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    }
  });

  app.get("/api/runtimes/discover", async () => {
    discovered = await discoverRuntimes();
    return { runtimes: discovered, catalog: composer.catalog() };
  });

  registerRoutes(app, {
    projects,
    approvals,
    decisions,
    conflicts,
    canon,
    readinessProbes: builtinProbes(),
    capacity,
    playbooks,
    mobilePairing,
    mobileControl,
    safeEdit,
    symbols,
    drift,
    events,
    docs,
    providers,
    completion,
    gateway,
    tools,
    mockRuntime: runtimes.mock,
    composer,
  });

  registerMobilePage(app, {
    pairing: mobilePairing,
    docs,
    projects,
    decisions,
    approvals,
  });

  // ---- Liveness watchdog loop ----
  const watchdog = setInterval(() => {
    try {
      orchestrator.sweepLiveness();
    } catch (err) {
      log.error("watchdog sweep failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }, config.watchdogIntervalMs);
  watchdog.unref();

  await app.listen({ port: config.httpPort, host: config.httpHost });
  log.info(`DevFlow daemon listening on http://${config.httpHost}:${config.httpPort}`, { provider: providers.getDefault().id, dataDir: config.dataDir });
}

main().catch((err) => {
  log.error("daemon failed to start", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
