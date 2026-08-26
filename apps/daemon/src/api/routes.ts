import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ReadinessProbe as SystemReadinessProbe } from "@devflow/contracts";
import type { CompletionService } from "../application/verification/verification-service.js";
import type { TeamComposerService, ComposerRoleSpec } from "../application/team/team-composer-service.js";
import type { ActionGateway } from "../application/gateway/action-gateway.js";
import type { ProjectService } from "../application/project/project-service.js";
import type { ApprovalService } from "../application/governance/approval-service.js";
import type { DecisionService } from "../application/governance/decision-service.js";
import type { ConflictDetectionService } from "../services/conflicts/conflict-detection-service.js";
import type { CanonService } from "../services/canon/canon-service.js";
import type { ProviderCapacityService } from "../services/capacity/provider-capacity-service.js";
import type { PlaybookLearningService } from "../services/capacity/playbook-learning-service.js";
import type { MobilePairingService, MobileControlService } from "../services/mobile/mobile-control-service.js";
import type { SafeEditService } from "../application/editing/safe-edit-service.js";
import type { SymbolIntelligenceService } from "../services/code-intelligence/symbol-intelligence-service.js";
import type { DriftDetectionService } from "../services/drift/drift-detection-service.js";
import type { EventStore } from "../infrastructure/db/event-store.js";
import type { DocumentRepository } from "../infrastructure/db/document-repository.js";
import type { ModelProviderRegistry } from "../plugins/models/model-provider-registry.js";

const IdParam = z.object({ id: z.string().min(1) });
const TaskParam = z.object({ taskId: z.string().min(1) });

/** Thin HTTP surface over application services. Route handlers validate input and delegate —
 * no business logic lives here (spec §33). */
export function registerRoutes(app: FastifyInstance, deps: {
  projects: ProjectService;
  approvals: ApprovalService;
  decisions: DecisionService;
  conflicts: ConflictDetectionService;
  canon: CanonService;
  readinessProbes: SystemReadinessProbe[];
  capacity: ProviderCapacityService;
  playbooks: PlaybookLearningService;
  mobilePairing: MobilePairingService;
  mobileControl: MobileControlService;
  safeEdit: SafeEditService;
  symbols: SymbolIntelligenceService;
  drift: DriftDetectionService;
  events: EventStore;
  docs: DocumentRepository;
  providers: ModelProviderRegistry;
  completion: CompletionService;
  gateway: ActionGateway;
  mockRuntime: { setAlwaysFail(enabled: boolean): void };
  composer: TeamComposerService;
  orchestrator: { cancelRun(runId: string): Promise<unknown> };
  workflowComposer?: {
    create(name: string, nodes: Array<{ key: string; name?: string; roleId: string; objective?: string }>, edges: Array<{ from: string; to: string }>): unknown;
    list(): unknown[];
    get(id: string): unknown | null;
    update(id: string, name: string, nodes: Array<{ key: string; name?: string; roleId: string; objective?: string }>, edges: Array<{ from: string; to: string }>): unknown;
    archive(id: string): void;
    applyToProject(projectId: string, workflowId: string): unknown;
    clearForProject(projectId: string): void;
    bindingFor(projectId: string): { active: boolean; workflowId: string } | null;
  };
  tools: { get(id: string): { execute(input: Record<string, unknown>, ctx: { workspaceRoot: string }): Promise<{ ok: boolean; summary: string; output: string | null }> } };
}): void {
  const { projects } = deps;

  // Mobile device auth gate must be registered before routes it protects.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/m/") || req.url.startsWith("/api/mobile/pair")) return;
    const deviceId = req.headers["x-devflow-device"] as string | undefined;
    const secret = req.headers["x-devflow-secret"] as string | undefined;
    if (!deviceId || !secret) {
      await reply.code(401).send({ error: "device credentials required" });
      return;
    }
    try {
      (req as unknown as { device: unknown }).device = deps.mobilePairing.authenticate(deviceId, secret);
    } catch {
      await reply.code(401).send({ error: "device authentication failed" });
    }
  });

  app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  // ---- Projects ----
  app.get("/api/projects", async () => ({ projects: projects.listProjects() }));
  app.post("/api/projects", async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(200), description: z.string().max(4000).default(""), repositoryPath: z.string().min(1).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input", detail: body.error.flatten() });
    const project = await projects.createProject(body.data);
    return reply.code(201).send({ project });
  });
  app.get("/api/projects/:id", async (req, reply) => {
    const p = IdParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "bad id" });
    return { project: projects.getProject(p.data.id) };
  });

  app.get("/api/projects/:id/overview", async (req) => {
    const { id } = req.params as { id: string };
    const project = projects.getProject(id);
    const mission = projects.latestMission(id);
    const tasks = deps.docs.list<TaskContractShim>("task", id);
    void tasks;
    return {
      project,
      mission,
      openDecisions: deps.decisions.listOpen(id),
      openApprovals: deps.approvals.listOpen(id),
      recommendations: projects.recommendationsFor(id),
      driftFindings: projects.driftFindingsFor(id),
      checkpoints: projects.checkpointsOf(id),
      actions: projects.actionsOf(id),
      runs: projects.runsOf(id),
    };
  });

  // ---- Mission & discovery ----
  app.post("/api/projects/:id/mission", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ rawRequest: z.string().min(3).max(8000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid mission" });
    try {
      return await projects.submitMission(id as never, body.data.rawRequest);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/projects/:id/discovery", async (req) => {
    const { id } = req.params as { id: string };
    const questions = deps.docs.list<DiscoveryQuestionShim>("discovery_question", id);
    const open = questions.filter((q) => q.status === "OPEN");
    return {
      questions,
      coverageSnapshot: null,
      openQuestion: open[open.length - 1] ?? null,
      intent: deps.docs.list<unknown>("intent_record", id),
      requirements: deps.docs.list<unknown>("requirement", id),
    };
  });

  app.post("/api/projects/:id/discovery/refresh", async (req, reply) => {
    const { id } = req.params as { id: string };
    const snapshot = await projects.discoverOnce(id as never);
    return snapshot;
  });

  app.post("/api/projects/:id/questions/:questionId/answer", async (req, reply) => {
    const { id, questionId } = req.params as { id: string; questionId: string };
    const body = z.object({ answer: z.string().min(1).max(4000), optionKey: z.string().max(40).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid answer" });
    try {
      const coverage = await projects.answerQuestion(id as never, questionId, body.data.answer, body.data.optionKey);
      return reply.send({ coverage });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/projects/:id/questions/:questionId/skip", async (req) => {
    const { id, questionId } = req.params as { id: string; questionId: string };
    const coverage = await projects.skipQuestionWithAssumption(id, questionId);
    return { coverage };
  });

  // ---- Spec / review council / architecture / planning ----
  app.post("/api/projects/:id/finalize-spec", async (req) => {
    const { id } = req.params as { id: string };
    await projects.finalizeSpecification(id);
    return { ok: true };
  });
  app.post("/api/projects/:id/review-council", async (req) => {
    const { id } = req.params as { id: string };
    const reviews = await projects.runPlanReviewCouncil(id);
    return { reviews };
  });
  app.post("/api/projects/:id/architecture", async (req) => {
    const { id } = req.params as { id: string };
    await projects.generateArchitecture(id);
    return { ok: true };
  });
  app.post("/api/projects/:id/plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ overrideReadinessGate: z.boolean().optional() }).safeParse(req.body ?? {});
    try {
      const tasks = await projects.planDeliveryTasks(id, body.success ? body.data : undefined);
      return { tasks };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/projects/:id/readiness", async (req) => {
    const { id } = req.params as { id: string };
    return { readiness: await projects.readinessSnapshot(id) };
  });

  app.get("/api/projects/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return { tasks: deps.docs.list<unknown>("task", id) };
  });

  // ---- Execution / verification / completion ----
  app.post("/api/tasks/:taskId/execute", async (req, reply) => {
    const { taskId } = TaskParam.safeParse(req.params).data ?? {};
    if (!taskId) return reply.code(400).send({ error: "bad task id" });
    const body = z.object({ runtimeId: z.string().min(1).optional() }).safeParse(req.body ?? {});
    try {
      const run = await projects.executeTask(taskId, body.success ? body.data.runtimeId : undefined);
      return { run };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tasks/:taskId/review-complete", async (req, reply) => {
    const { taskId } = TaskParam.safeParse(req.params).data ?? {};
    if (!taskId) return reply.code(400).send({ error: "bad task id" });
    try {
      return await projects.reviewAndMaybeComplete(taskId);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/runs/:runId/cancel", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    try {
      return { run: await deps.orchestrator.cancelRun(runId) };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Active (running) runs for the project — drives the UI Stop buttons. */
  app.get("/api/projects/:id/runs", async (req) => {
    const { id } = req.params as { id: string };
    const runs = deps.docs.list<{ id: string; projectId: string; taskId: string | null; status: string; attempt: number; runtimeConfigId: string }>("agent_run", id);
    return {
      runs: runs
        .filter((r) => ["RUNNING", "WAITING_APPROVAL", "WAITING_DECISION"].includes(r.status))
        .map((r) => ({ id: r.id, taskId: r.taskId, status: r.status, attempt: r.attempt, runtime: r.runtimeConfigId.replace(/^runtime_/, "") })),
    };
  });

  app.post("/api/tasks/:taskId/rerun-verification", async (req) => {
    const { taskId } = TaskParam.safeParse(req.params).data ?? {};
    const evidence = await projects.rerunVerification(taskId!);
    return { evidence };
  });

  app.get("/api/tasks/:taskId/completion", async (req, reply) => {
    const parsed = TaskParam.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "bad task id" });
    const task = deps.docs.require<Parameters<CompletionService["evaluate"]>[0]>("task", parsed.data.taskId);
    return { completion: deps.completion.evaluate(task) };
  });

  // ---- Evidence / timeline ----
  app.get("/api/projects/:id/evidence", async (req) => {
    const { id } = req.params as { id: string };
    return { evidence: deps.docs.list<unknown>("evidence", id), reviews: deps.docs.list<unknown>("review", id) };
  });

  app.get("/api/projects/:id/events", async (req) => {
    const { id } = req.params as { id: string };
    const after = Number.parseInt((req.query as { after?: string }).after ?? "0", 10) || 0;
    return { events: deps.events.listByProject(id as never, { afterSequence: after, limit: 500 }), latestSequence: deps.events.latestSequence(id as never) };
  });

  // ---- Decisions & approvals ----
  app.get("/api/projects/:id/decisions", async (req) => ({ decisions: deps.decisions.listOpen((req.params as { id: string }).id) }));
  app.post("/api/decisions/:decisionId/resolve", async (req, reply) => {
    const { decisionId } = req.params as { decisionId: string };
    const body = z.object({ chosenOption: z.string().min(1).max(80), note: z.string().max(4000).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    try {
      return { result: deps.decisions.resolve(decisionId, body.data.chosenOption, body.data.note) };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/projects/:id/approvals", async (req) => ({ approvals: deps.approvals.listOpen((req.params as { id: string }).id) }));
  app.post("/api/approvals/:approvalId/resolve", async (req, reply) => {
    const { approvalId } = req.params as { approvalId: string };
    const body = z.object({ outcome: z.enum(["ALLOW_ONCE", "APPROVED", "REJECTED", "CANCELLED"]), note: z.string().max(4000).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    try {
      return { approval: await deps.approvals.resolve(approvalId, body.data.outcome, body.data.note) };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Readiness ----
  app.get("/api/readiness", async () => {
    const capabilities = await Promise.all(deps.readinessProbes.map(async (probe) => probe.check()));
    return { capabilities };
  });

  // ---- Conflicts ----
  app.get("/api/projects/:id/conflicts", async (req) => ({ conflicts: deps.conflicts.listOpen((req.params as { id: string }).id) }));
  app.post("/api/conflicts/:conflictId/resolve", async (req, reply) => {
    const { conflictId } = req.params as { conflictId: string };
    const body = z.object({ resolution: z.string().min(1).max(2000), acceptAsIs: z.boolean().default(false) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    return { conflict: deps.conflicts.resolve(conflictId, body.data.resolution, body.data.acceptAsIs) };
  });

  // ---- Capacity / routing / playbooks ----
  app.get("/api/capacity", async () => ({ capacities: deps.docs.list<unknown>("provider_capacity") }));
  app.post("/api/capacity/refresh", async () => {
    const snapshots = await deps.capacity.refreshAll([{ id: "runtime_mock-runtime", providerLabel: "mock" }]);
    return { snapshots };
  });
  app.get("/api/playbooks", async () => ({ playbooks: deps.docs.list<unknown>("playbook") }));
  app.post("/api/playbooks/:playbookId/promote", async (req, reply) => {
    const { playbookId } = req.params as { playbookId: string };
    try {
      return { playbook: deps.playbooks.promote(playbookId) };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Intent / symbols / drift / safe edit ----
  app.post("/api/projects/:id/symbols/index", async (req) => {
    const { id } = req.params as { id: string };
    const project = projects.getProject(id);
    const snapshot = await deps.symbols.indexProject(id as never, project.repositoryPath ?? process.cwd());
    return { snapshot };
  });
  app.get("/api/projects/:id/drift", async (req) => ({ drifts: projects.driftFindingsFor((req.params as { id: string }).id) }));

  // ---- Canon export/import ----
  app.post("/api/projects/:id/canon/export", async (req) => {
    const { id } = req.params as { id: string };
    const project = projects.getProject(id);
    const targetDir = project.repositoryPath ?? process.cwd();
    const written = await deps.canon.exportControlPacket(id as never, targetDir);
    return { written };
  });

  // ---- Mobile companion ----
  app.post("/api/mobile/pair/begin", async (req, reply) => {
    const body = z.object({ deviceName: z.string().min(1).max(80), requestedRole: z.enum(["VIEWER", "OPERATOR", "ADMIN"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    return deps.mobilePairing.beginPairing(null, body.data);
  });
  app.post("/api/mobile/pair/complete", async (req, reply) => {
    const body = z.object({ token: z.string().min(10) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    try {
      return { device: deps.mobilePairing.completePairing(body.data.token) };
    } catch (err) {
      return reply.code(401).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/api/mobile/devices/:deviceId/revoke", async (req) => {
    return { device: deps.mobilePairing.revoke((req.params as { deviceId: string }).deviceId) };
  });
  app.get("/api/mobile/devices", async () => ({ devices: deps.mobilePairing.listDevices() }));

  app.get("/api/m/status", async (req) => {
    const all = projects.listProjects();
    const requested = (req.query as { projectId?: string }).projectId;
    const project = all.find((p) => p.id === requested) ?? all[0] ?? null;
    const pid = project?.id;
    return {
      project: project ?? null,
      projects: all.map((p) => ({ id: p.id, name: p.name })),
      needsYou: pid
        ? { decisions: deps.decisions.listOpen(pid).length, approvals: deps.approvals.listOpen(pid).length }
        : { decisions: 0, approvals: 0 },
      openDecisions: pid ? deps.decisions.listOpen(pid) : [],
      openApprovals: pid ? deps.approvals.listOpen(pid) : [],
    };
  });

  app.post("/api/m/message", async (req, reply) => {
    const device = (req as unknown as { device?: import("@devflow/contracts").MobileDevice }).device;
    if (!device) return reply.code(401).send({ error: "not authenticated" });
    const body = z
      .object({
        kind: z.enum(["CHAT", "DECISION_ANSWER", "APPROVAL_OUTCOME", "COMMAND"]),
        text: z.string().min(1).max(2000),
        refId: z.string().nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    const outbound = await deps.mobileControl.handleMessage(device, {
      id: `msg_${Date.now().toString(36)}`,
      deviceId: device.id,
      kind: body.data.kind,
      text: body.data.text,
      refId: body.data.refId ?? null,
      receivedAt: new Date().toISOString(),
    });
    return { outbound };
  });

  // ---- Provider info ----
  app.get("/api/providers", async () => ({ providers: deps.providers.listIds(), default: deps.providers.getDefault().id }));

  /** Demo-mode control (spec §28): toggles the mock runtime's failure injection so the
   * repeated-failure → escalation scenario (D) is demonstrable end-to-end. */
  app.post("/api/runtimes/mock/fail-mode", async (req, reply) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    deps.mockRuntime.setAlwaysFail(body.data.enabled);
    return { enabled: body.data.enabled };
  });

  
  // ---- AI Team Composer (spec §31): Role → Runtime → Provider → Model → Effort → Fallback ----
  app.get("/api/team/catalog", async () => ({ catalog: deps.composer.catalog(), roles: deps.composer.roles() }));

  // ---- Custom roles (V3 §20/S5) ----
  app.get("/api/team/custom-roles", async () => ({ roles: deps.composer.listCustomRoles() }));

  app.post("/api/team/custom-roles", async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(80),
      responsibility: z.string().min(1).max(2000),
      instructions: z.string().max(8000).optional(),
      tools: z.array(z.string().max(80)).max(30).optional(),
      requiredCapabilities: z.array(z.enum(["filesystem", "shell", "git", "tests", "network"])).optional(),
      permissionPreset: z.enum(["READ_ONLY", "WORKSPACE", "ELEVATED_ALLOWED"]),
      defaultRuntimeId: z.string().max(80).nullish(),
      expectedOutputs: z.array(z.string().max(200)).max(20).optional(),
      reviewCriteria: z.array(z.string().max(300)).max(20).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input", detail: body.error.flatten() });
    try {
      const role = deps.composer.createCustomRole(body.data);
      return reply.code(201).send({ role });
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/team/custom-roles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.composer.deleteCustomRole(id);
    return { deleted: true };
  });

  app.get("/api/team/composition/:id", async (req) => {
    const { id } = req.params as { id: string };
    return {
      bindings: deps.composer.listBindings(id),
      orgDefaults: deps.composer.orgDefaults(),
      taskOverrides: deps.composer.listTaskOverrides(id),
      mismatches: deps.composer.validate(id),
      catalog: deps.composer.catalog(),
      roles: deps.composer.roles(),
    };
  });

  app.put("/api/team/org-defaults", async (req, reply) => {
    const body = z.object({ roleId: z.string().min(1), runtimeId: z.string().min(1), providerId: z.string().nullish(), model: z.string().nullish(), effort: z.enum(["LOW", "MEDIUM", "HIGH", "MAX"]).nullish() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    const binding = deps.composer.setOrgDefault({
      roleId: body.data.roleId, runtimeId: body.data.runtimeId, providerId: body.data.providerId ?? null,
      model: body.data.model ?? null, effort: body.data.effort ?? null, fallbacks: [],
      source: "MANUAL", reasons: ["org default set manually"], updatedAt: new Date().toISOString(),
    });
    return { binding };
  });

  app.put("/api/team/role", async (req, reply) => {
    const body = z.object({
      projectId: z.string().min(1), roleId: z.string().min(1), runtimeId: z.string().min(1),
      providerId: z.string().nullish(), model: z.string().nullish(),
      effort: z.enum(["LOW", "MEDIUM", "HIGH", "MAX"]).nullish(),
      routingMode: z.enum(["LOCKED", "PREFERRED", "AUTO"]).optional(),
      permissionPreset: z.enum(["READ_ONLY", "WORKSPACE", "ELEVATED_ALLOWED"]).optional(),
      fallbacks: z.array(z.object({ runtimeId: z.string(), providerId: z.string().nullish(), model: z.string().nullish(), effort: z.enum(["LOW", "MEDIUM", "HIGH", "MAX"]).nullish() })).default([]),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    const binding = deps.composer.setBinding(body.data.projectId, {
      roleId: body.data.roleId, runtimeId: body.data.runtimeId, providerId: body.data.providerId ?? null,
      model: body.data.model ?? null, effort: body.data.effort ?? null,
      permissionPreset: body.data.permissionPreset,
      routingMode: body.data.routingMode,
      fallbacks: body.data.fallbacks, source: "MANUAL", reasons: ["set manually in AI Team Composer"],
      updatedAt: new Date().toISOString(),
    });
    return { binding };
  });

  app.post("/api/team/auto-compose/:id", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { mode?: string };
    const mode = q.mode === "RECOMMENDED" ? "RECOMMENDED" : "AUTO";
    return { bindings: deps.composer.autoCompose(id, mode), mismatches: deps.composer.validate(id) };
  });

  app.post("/api/team/preset/apply", async (req, reply) => {
    const body = z.object({ projectId: z.string().min(1), preset: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    try {
      return { bindings: deps.composer.applyPreset(body.data.projectId, body.data.preset), mismatches: deps.composer.validate(body.data.projectId) };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/team/preset/save-my-team", async (req, reply) => {
    const body = z.object({ projectId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    deps.composer.saveAsMyTeam(body.data.projectId);
    return { saved: true };
  });

  app.get("/api/team/validate/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { mismatches: deps.composer.validate(id), roles: deps.composer.roles() as ComposerRoleSpec[] };
  });

  app.put("/api/tasks/:taskId/runtime-override", async (req, reply) => {
    const { taskId } = TaskParam.safeParse(req.params).data ?? {};
    if (!taskId) return reply.code(400).send({ error: "bad task id" });
    const body = z.object({
      projectId: z.string().min(1), runtimeId: z.string().nullish(), providerId: z.string().nullish(),
      model: z.string().nullish(), effort: z.enum(["LOW", "MEDIUM", "HIGH", "MAX"]).nullish(), reason: z.string().max(400).nullish(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    if (!body.data.runtimeId) {
      deps.composer.clearTaskOverride(body.data.projectId, taskId);
      return { cleared: true };
    }
    const override = deps.composer.setTaskOverride(body.data.projectId, {
      taskId, roleId: null, runtimeId: body.data.runtimeId, providerId: body.data.providerId ?? null,
      model: body.data.model ?? null, effort: body.data.effort ?? null, reason: body.data.reason ?? null,
      updatedAt: new Date().toISOString(),
    });
    return { override };
  });

  // ---- Workflow Composer (V3 §18/S4): user-defined flow definitions ----
  const NodeInput = z.object({
    key: z.string().min(1).max(60).regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().max(120).optional(),
    roleId: z.string().min(1).max(80),
    objective: z.string().max(2000).optional(),
  });
  const EdgeInput = z.object({ from: z.string().min(1), to: z.string().min(1) });

  app.get("/api/workflows", async () => {
    const workflows = deps.workflowComposer?.list() ?? [];
    return { workflows };
  });

  app.get("/api/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = deps.workflowComposer?.get(id);
    if (!wf) return reply.code(404).send({ error: "unknown workflow" });
    return { workflow: wf };
  });

  app.post("/api/workflows", async (req, reply) => {
    if (!deps.workflowComposer) return reply.code(501).send({ error: "workflow composer unavailable" });
    const body = z.object({ name: z.string().min(1).max(120), nodes: z.array(NodeInput).min(1).max(20), edges: z.array(EdgeInput).default([]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input", detail: body.error.flatten() });
    try {
      const workflow = deps.workflowComposer.create(body.data.name, body.data.nodes, body.data.edges);
      return reply.code(201).send({ workflow });
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/api/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.workflowComposer) return reply.code(501).send({ error: "workflow composer unavailable" });
    const body = z.object({ name: z.string().min(1).max(120), nodes: z.array(NodeInput).min(1).max(20), edges: z.array(EdgeInput).default([]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input", detail: body.error.flatten() });
    try {
      const workflow = deps.workflowComposer.update(id, body.data.name, body.data.nodes, body.data.edges);
      return { workflow };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.workflowComposer) return reply.code(501).send({ error: "workflow composer unavailable" });
    try {
      deps.workflowComposer.archive(id);
      return { archived: true };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/projects/:id/workflow/apply", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.workflowComposer) return reply.code(501).send({ error: "workflow composer unavailable" });
    const body = z.object({ workflowId: z.string().min(1).nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    try {
      if (!body.data.workflowId) {
        deps.workflowComposer.clearForProject(id);
        return { cleared: true };
      }
      return { binding: deps.workflowComposer.applyToProject(id, body.data.workflowId) };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/projects/:id/workflow", async (req) => {
    const { id } = req.params as { id: string };
    const binding = deps.workflowComposer?.bindingFor(id) ?? null;
    return { binding, workflow: binding ? deps.workflowComposer!.get(binding.workflowId) : null };
  });

  // ---- Safe edit demo/test seam ----
  app.post("/api/edit/lease", async (req, reply) => {
    const body = z.object({ projectId: z.string(), filePath: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    const project = projects.getProject(body.data.projectId);
    const lease = await deps.safeEdit.acquireLease({
      projectId: body.data.projectId as never,
      runId: null,
      taskId: null,
      workspaceRoot: project.repositoryPath ?? process.cwd(),
      filePath: body.data.filePath,
    });
    return { lease };
  });

  /** Governed shell access for the desktop UI (spec §29: the UI never invokes the shell
   * directly — every command passes the Action Gateway and may require approval). */
  app.post("/api/projects/:id/tools/shell", async (req, reply) => {
    const body = z.object({ command: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid input" });
    const project = projects.getProject((req.params as { id: string }).id);
    const workspaceRoot = project.repositoryPath ?? process.cwd();
    const { classifyShellCommand } = await import("../lib/path-guard.js");
    const cls = classifyShellCommand(body.data.command);
    const action = await deps.gateway.executeAction({
      projectId: project.id,
      runId: null,
      toolId: "shell.exec",
      operation: "run shell command",
      risk: cls.destructive ? "DANGEROUS" : cls.readOnly ? "READ_ONLY" : "ELEVATED",
      permissionPreset: "ELEVATED_ALLOWED",
      reversible: false,
      target: workspaceRoot,
      workspaceRoot,
      inputSummary: { command: body.data.command },
      executor: {
        execute: (input, ctx) => deps.tools.get("shell.exec").execute(input, ctx),
      },
    });
    return { action };
  });
}

type TaskContractShim = Record<string, unknown>;
type DiscoveryQuestionShim = { id: string; status: string; category: string; question: string };

// Re-export for main composition typing convenience.
export { IdParam };
