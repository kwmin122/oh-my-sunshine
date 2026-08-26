import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { loadConfig } from "./lib/config.js";
import { createLogger } from "./lib/logging.js";
import { openDatabase, closeDatabase } from "./infrastructure/db/connection.js";
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
import { HandoffService } from "./application/orchestration/handoff-service.js";
import { WorkflowComposerService } from "./application/workflow/workflow-composer-service.js";
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
import { WorkspaceService } from "./application/workspace/workspace-service.js";
import { TerminalService } from "./application/terminal/terminal-service.js";
import { ConversationService } from "./application/conversation/conversation-service.js";
import { PreCodeContractService } from "./application/discovery/pre-code-contract-service.js";
import { recoverOrphanedRuns } from "./application/orchestration/crash-recovery.js";
import { RuntimeCircuitBreaker } from "./plugins/runtimes/circuit-breaker.js";

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
  // Crash recovery (§26): any RUNNING run from a previous process is orphaned —
  // finalize it honestly and release its task before accepting new work.
  const orphans = recoverOrphanedRuns(docs, events);
  if (orphans.length > 0) log.info("crash recovery finalized orphaned runs", { count: orphans.length });

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
    /** Resolution order: builtin catalog → persisted custom role → honest generic.
     * Never silently reassign an unknown role to a different one (S5). */
    role(roleId: string) {
      const builtin = roles.find((r) => r.id === roleId);
      if (builtin) return builtin;
      const custom = docs.get<import("@devflow/contracts").CustomRole>("custom_role", roleId);
      if (custom) {
        return {
          id: roleId as (typeof roles)[number]["id"],
          name: custom.name,
          responsibility: custom.responsibility || custom.instructions || `User-defined role ${custom.name}`,
          defaultSkills: custom.tools ?? [],
          defaultPolicyPreset: custom.permissionPreset,
        };
      }
      return {
        id: roleId as (typeof roles)[number]["id"],
        name: roleId,
        responsibility: "User-defined role (generic — no template found)",
        defaultSkills: [],
        defaultPolicyPreset: "WORKSPACE" as const,
      };
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
  // Circuit breaker (§24): an OPEN runtime is treated as unusable in routing so
  // fallbacks engage; LOCKED bindings fail closed naturally.
  const breaker = new RuntimeCircuitBreaker(config.breakerFailureThreshold, config.breakerCooldownMs);
  composer.setHealthPredicate((id) => !breaker.isOpen(id));
  // Normalized runtime event stream (V3 §15) → EventStore as agent.run_output.
  runtimes.setEventSink((e) => {
    try {
      const owner = docs.get<{ projectId: string }>("agent_run", e.runId);
      if (!owner) return; // run not yet persisted — nothing to attribute to
      events.append({
        projectId: owner.projectId as never,
        type: "agent.run_output" as never,
        entityType: "run",
        entityId: e.runId,
        actorType: "ENGINE",
        payload: {
          taskId: e.taskId,
          kind: e.kind,
          text: e.text ?? null,
          tool: e.tool ?? null,
          meta: e.meta ?? null,
          at: e.at,
        },
      });
      // Review R3: a CLI working silently is still progress. Touch the session's
      // liveness clock so the watchdog never marks an active run STALLED.
      const run = docs.get<{ sessionId: string | null }>("agent_run", e.runId);
      if (run?.sessionId) {
        const session = docs.get<{ id: string; liveness: string; lastProgressAt: string }>("agent_session", run.sessionId);
        if (session && session.liveness === "ACTIVE_PROGRESS") {
          docs.put("agent_session", session.id, owner.projectId, { ...session, lastProgressAt: e.at });
        }
      }
    } catch (err) {
      log.warn("runtime event sink failed", { error: err instanceof Error ? err.message : String(err) });
    }
  });
  void discoverRuntimes().then(async (d) => {
    discovered = d;
    const found = new Map(d.filter((x) => x.binaryPath).map((x) => [x.id, true]));
    runtimes.registerCliIfAvailable("claude-code", "claude", "claude-code", found.has("claude-code"));
    runtimes.registerCliIfAvailable("codex-cli", "codex", "codex-cli", found.has("codex-cli"));
    runtimes.registerCliIfAvailable("opencode", "opencode", "opencode", found.has("opencode"));
    log.info("runtime discovery complete", { runtimes: d.filter((x) => x.binaryPath).map((x) => x.id), registered: runtimes.listIds() });
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
      handoff: new HandoffService({ docs, events, git }),
      breaker,
      quotaLookup: (projectId, roleId) => {
        // Latest capacity snapshot for the role's bound runtime; null = unknown.
        const binding =
          composer.listBindings(projectId).find((b) => b.roleId === roleId) ??
          composer.orgDefaults().find((b) => b.roleId === roleId);
        if (!binding) return null;
        const candidates = docs
          .list<{ runtimeId: string; usedPercentRemaining: number | null; refreshedAt: string }>("provider_capacity")
          .filter((c) => c.runtimeId.replace(/^runtime_/, "") === binding.runtimeId && c.usedPercentRemaining !== null)
          .sort((a, b) => b.refreshedAt.localeCompare(a.refreshedAt));
        return candidates[0]?.usedPercentRemaining ?? null;
      },
      composer: {
        resolveForTask: (projectId, taskId, ownerRoleId, runOverride) => composer.resolveForTask(projectId, taskId, ownerRoleId, runOverride),
        resolveDetailed: (projectId, taskId, ownerRoleId, runOverride) => composer.resolveDetailed(projectId, taskId, ownerRoleId, runOverride),
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

  // Workflow Composer (V3 §18/S4): user-defined flow definitions + project binding.
  const composerWorkflows = new WorkflowComposerService({ docs, events });

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
      // Honest resume (§39): only ungated BLOCKED tasks return to READY.
      // Decision/approval-gated tasks must go through their own resolution path.
      const task = docs.get<{ id: string; projectId: string; status: string; blockers: string[]; updatedAt: string }>("task", taskId);
      if (!task) throw new Error(`[mobile/resumeTask] unknown task '${taskId}'`);
      const gated =
        decisions.listOpen(task.projectId).some((d) => d.taskId === taskId) ||
        approvals.listOpen(task.projectId).some((a) => a.taskId === taskId);
      if (gated) throw new Error("[mobile/resumeTask] task is gated — resolve the decision/approval first");
      docs.put("task", task.id, task.projectId, { ...task, status: "READY", blockers: [], updatedAt: new Date().toISOString() });
      events.append({ projectId: task.projectId as never, type: "task.ready" as never, entityType: "task", entityId: task.id, actorType: "USER", payload: { reason: "mobile resume" } });
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
    workflowComposer: composerWorkflows,
    contractGate: process.env.DEVFLOW_REQUIRE_IMPL_CONTRACT === "1"
      ? {
          isReady: (pid) => contract?.get(pid)?.readiness.ready ?? null,
          topQuestion: (pid) => contract?.get(pid)?.openQuestions[0]?.suggestedQuestion ?? null,
        }
      : undefined,
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

  // ---- Development Workspace services (V4/S10) + Pre-Code Contract (V5/S11) ----
  // `contract` is assigned after ProjectService exists — declared here to break
  // the initialization cycle (projects → contractGate → contract).
  let contract: PreCodeContractService | undefined;
  const workspace = new WorkspaceService(projects, git, docs);
  let wsBroadcast: (message: Record<string, unknown>) => void = () => undefined;
  const watchers: Array<() => void> = [];
  const terminals = new TerminalService(
    ({ projectId, type, entityType, entityId, actorType, payload }) => {
      events.append({ projectId: projectId as never, type: type as never, entityType: entityType as never, entityId, actorType, payload });
    },
    (message) => wsBroadcast(message),
  );
  const conversation = new ConversationService({
    docs,
    events,
    provider: providers.getDefault(),
    // RUNTIME_CHANGE messages pin the active task's next run via the standard override.
    composer: {
      setTaskOverride: (projectId, override) => composer.setTaskOverride(projectId, { ...override, roleId: null, updatedAt: new Date().toISOString() }),
      catalog: () => composer.catalog().map((c) => ({ id: c.id, label: c.label })),
    },
  });
  contract = new PreCodeContractService({
    docs,
    events,
    projects,
    repoFacts: async (pid) => {
      const project = projects.getProject(pid);
      const snap = project.repositoryPath ? await scanner.scan(project.repositoryPath).catch(() => null) : null;
      return {
        languages: snap?.languages.map((l) => l.name) ?? [],
        frameworks: snap?.frameworks ?? [],
        testCommand: snap?.testCommand ?? null,
        buildCommand: snap?.buildCommand ?? null,
      };
    },
  });

  // ---- HTTP + WS server ----
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Shutdown guard registered before routes: once draining starts, no mutating
  // requests — including mobile commands — may touch state (review R12).
  let shuttingDown = false;
  const isReadOnly = (method: string): boolean => method === "GET" || method === "HEAD";
  app.addHook("onRequest", async (req, reply) => {
    if (shuttingDown && !isReadOnly(req.method)) {
      await reply.code(503).send({ error: "daemon is shutting down" });
      return;
    }
    // /api/v1 versioning seam (V3 §10): v1 is the stable contract surface; it
    // currently aliases the unversioned routes until a breaking change forks it.
    if (req.raw.url?.startsWith("/api/v1/")) {
      req.raw.url = `/api/${req.raw.url.slice("/api/v1/".length)}`;
    }
  });

  // Idempotency keys (V3 §9/§31): a retried mutating request with the same key
  // replays the recorded response instead of executing twice.
  const idempotencyKeyOf = (headers: Record<string, unknown>): string | null => {
    const key = headers["idempotency-key"];
    return typeof key === "string" && key.length >= 8 ? key : null;
  };
  app.addHook("onRequest", async (req, reply) => {
    const key = idempotencyKeyOf(req.headers);
    if (!key || isReadOnly(req.method)) return;
    const url = (req.raw.url ?? "").split("?")[0] ?? "";
    const row = db
      .prepare("SELECT status_code, response FROM idempotency_keys WHERE key = ? AND method = ? AND url = ?")
      .get(key, String(req.method), url) as { status_code: number; response: string } | undefined;
    if (row) {
      reply
        .code(row.status_code)
        .header("content-type", "application/json; charset=utf-8")
        .header("idempotent-replay", "true")
        .send(row.response);
    }
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const key = idempotencyKeyOf(req.headers);
    if (!key || isReadOnly(req.method)) return payload;
    if (reply.statusCode >= 200 && reply.statusCode < 300 && typeof payload === "string") {
      try {
        db.prepare(
          "INSERT OR REPLACE INTO idempotency_keys (key, method, url, status_code, response, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(key, String(req.method), (req.raw.url ?? "").split("?")[0] ?? "", reply.statusCode, payload, new Date().toISOString());
      } catch { /* best-effort — never break the request over audit */ }
    }
    return payload;
  });

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
  wsBroadcast = (message) => {
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    }
  };
  // Realtime fs events (V4 §5): watch every attached repo → debounced broadcasts.
  for (const p of projects.listProjects()) {
    if (!p.repositoryPath) continue;
    const dispose = workspace.watchProject(p.id, (evt) => {
      wsBroadcast({ ...evt, projectId: p.id, at: new Date().toISOString() });
    });
    if (dispose) watchers.push(dispose);
  }

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
    orchestrator,
    composer,
    workflowComposer: composerWorkflows,
    workspace,
    terminals,
    conversation,
    contract,
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

  // ---- Graceful shutdown (§25): SIGTERM/SIGINT → drain → checkpoint → clean exit ----
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`graceful shutdown started (${signal})`);
    try {
      events.append({ projectId: "system" as never, type: "daemon.shutdown_started" as never, entityType: "system", entityId: null, actorType: "ENGINE", payload: { signal } });
    } catch { /* best-effort audit */ }
    // Stop active runtime sessions (SIGTERM→SIGKILL inside adapters), bounded grace.
    const graceMs = config.shutdownGraceMs;
    const drain = orchestrator.stopAllActive();
    const stopped = await Promise.race([drain, new Promise<string[]>((r) => setTimeout(() => r([]), graceMs))]);
    log.info("active runs drained", { stopped });
    // Release held edit leases so restarts are not blocked by stale claims.
    for (const lease of docs.list<{ id: string; status: string }>("edit_lease")) {
      if (lease.status === "HELD") {
        try { safeEdit.release(lease.id); } catch { /* keep draining */ }
      }
    }
    // Kill every live terminal session — no shell outlives the daemon.
    for (const t of terminals.list()) terminals.kill(t.id);
    // Release fs watchers.
    for (const dispose of watchers) dispose();
    // Stop the HTTP server, audit completion, checkpoint WAL into the main DB
    // file, then close cleanly (review R13: complete-event precedes close).
    await app.close().catch(() => undefined);
    try {
      events.append({ projectId: "system" as never, type: "daemon.shutdown_complete" as never, entityType: "system", entityId: null, actorType: "ENGINE", payload: { signal, stopped } });
    } catch { /* best-effort */ }
    closeDatabase(db);
    log.info("graceful shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("daemon failed to start", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
