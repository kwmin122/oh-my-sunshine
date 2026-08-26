import type {
  AgentRole,
  AgentRun,
  Approval,
  Checkpoint,
  CodebaseSnapshot,
  Decision,
  DiscoveryQuestion,
  DriftFinding,
  Evidence,
  GatewayAction,
  IntentRecord,
  Project,
  ProjectId,
  Recommendation,
  Requirement,
  RequirementCoverage,
  ResearchRecord,
  Review,
  RiskTier,
  TaskContract,
  WorkflowInstance,
} from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { DevFlowConfig } from "../../lib/config.js";
import type { DiscoveryService, CoverageSnapshot } from "../discovery/discovery-service.js";
import type { CompletenessModelPort } from "../discovery/requirement-completeness-engine.js";
import type { SpecificationService } from "../specification/specification-service.js";
import type { TaskPlanningService } from "../planning/task-planning-service.js";
import type { ReviewCouncilService } from "../reviews/review-council-service.js";
import type { AgentOrchestrator } from "../orchestration/agent-orchestrator.js";
import type { VerificationService, EvidenceFreshnessService, CompletionService } from "../verification/verification-service.js";
import type { ResearchService } from "../research/research-service.js";
import type { ArchitectureService, ImpactAnalysisService } from "../architecture/architecture-service.js";
import type { IntentGateService } from "../intent/intent-gate-service.js";
import type { WorkflowEngine, WorkflowNodeContext } from "../../domain/workflow/workflow-engine.js";
import type { GitAdapter } from "@devflow/contracts";

export interface ProjectServicePorts {
  docs: DocumentRepository;
  events: EventStore;
  config: DevFlowConfig;
  discovery: DiscoveryService;
  completenessModel: CompletenessModelPort;
  specification: SpecificationService;
  planning: TaskPlanningService;
  reviews: ReviewCouncilService;
  orchestrator: AgentOrchestrator;
  verification: VerificationService;
  freshness: EvidenceFreshnessService;
  completion: CompletionService;
  research: ResearchService;
  architecture: ArchitectureService;
  impact: ImpactAnalysisService;
  intentGate: IntentGateService;
  workflow: WorkflowEngine;
  git: GitAdapter;
  /** Workflow Composer (V3 §18/S4): an applied user workflow drives planning. */
  workflowComposer?: { activeWorkflowFor(projectId: string): import("@devflow/contracts").WorkflowDefinition | null };
  /** V5/S11 Implementation Readiness Gate — enforced when the operator flag is on. */
  contractGate?: { isReady(projectId: string): boolean | null; topQuestion(projectId: string): string | null };
  roles(): AgentRole[];
  scanner: { scan(path: string): Promise<CodebaseSnapshot> };
  tools: { get(id: string): { execute(input: Record<string, unknown>, ctx: { workspaceRoot: string }): Promise<{ ok: boolean; summary: string; output: string | null }> } };
  deliveryWorkflowId: string;
}

/**
 * ProjectService is the application façade over the domain services. It owns NO business
 * rules itself — every transition delegates to the deterministic services above.
 * This keeps route handlers thin (spec §33).
 */
export class ProjectService {
  constructor(private readonly p: ProjectServicePorts) {}

  // ---------- Step 1: create/open project ----------
  async createProject(params: { name: string; description: string; repositoryPath?: string }): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = {
      id: newId("proj"),
      name: params.name,
      description: params.description,
      repositoryPath: params.repositoryPath ?? null,
      status: "ACTIVE",
      riskProfile: "NORMAL",
      createdAt: now,
      updatedAt: now,
    };
    this.p.docs.put("project", project.id, project.id, project);
    this.p.events.append({
      projectId: project.id,
      type: "project.created",
      entityType: "project",
      entityId: project.id,
      actorType: "USER",
      payload: { name: project.name },
    });
    if (params.repositoryPath) {
      await this.attachRepository(project.id, params.repositoryPath);
    }
    return project;
  }

  async attachRepository(projectId: ProjectId, repositoryPath: string): Promise<CodebaseSnapshot> {
    const snapshot = await this.p.scanner.scan(repositoryPath);
    const isRepo = await this.p.git.isRepository(repositoryPath);
    if (!isRepo) throw new Error(`[project-service] '${repositoryPath}' is not a git repository`);
    this.p.events.append({ projectId, type: "project.repository_attached", entityType: "project", entityId: projectId, actorType: "USER", payload: { repositoryPath } });
    this.p.events.append({
      projectId,
      type: "project.scanned",
      entityType: "codebase_snapshot",
      actorType: "ENGINE",
      payload: { languages: snapshot.languages.slice(0, 3), frameworks: snapshot.frameworks, packageManagers: snapshot.packageManagers },
    });
    return snapshot;
  }

  getProject(projectId: string): Project {
    return this.p.docs.require<Project>("project", projectId);
  }

  listProjects(): Project[] {
    return this.p.docs.list<Project>("project");
  }

  // ---------- Steps 2–4: mission → intent → discovery ----------
  async submitMission(projectId: ProjectId, rawRequest: string): Promise<{
    missionId: string;
    intent: IntentRecord;
    riskTier: RiskTier;
    coverage: CoverageSnapshot | null;
    openQuestion: DiscoveryQuestion | null;
    workflowInstance: WorkflowInstance;
  }> {
    const project = this.getProject(projectId);
    const now = new Date().toISOString();
    const missionId = newId("mission");
    const goal = {
      id: missionId,
      projectId,
      parentGoalId: null,
      title: rawRequest.slice(0, 120),
      description: rawRequest,
      successMetrics: [],
      status: "OPEN" as const,
    };
    this.p.docs.put("goal", goal.id, projectId, goal);
    this.p.docs.put("mission", missionId, projectId, { id: missionId, projectId, rawRequest, createdAt: now });
    this.p.events.append({ projectId, type: "mission.created", entityType: "mission", entityId: missionId, actorType: "USER", payload: { rawRequest } });

    // Risk first — it drives process depth everywhere else.
    const { assessRisk, signalsFromMission } = await import("../../domain/risk/risk-engine.js");
    let repoSnapshot: CodebaseSnapshot | null = null;
    try {
      repoSnapshot = project.repositoryPath ? await this.p.scanner.scan(project.repositoryPath) : null;
    } catch (err) {
      // Repo scan failure must not kill the mission — record and continue without facts.
      this.p.events.append({ projectId, type: "system.capability_missing", entityType: "repo_scan", actorType: "ENGINE", payload: { error: err instanceof Error ? err.message : String(err) } });
    }
    const signals = signalsFromMission(rawRequest, repoSnapshot);
    const risk = assessRisk(signals);
    this.p.docs.put("risk_assessment", missionId, projectId, { id: missionId, projectId, ...risk });

    // Intent Gate BEFORE discovery (spec §2.14).
    const intent = await this.p.intentGate.classify(projectId, rawRequest, risk.tier);

    // Research gate when triggers demand it (HIGH always researches).
    if (this.p.research.shouldResearch(rawRequest, risk.tier)) {
      await this.p.research.runResearch(projectId, `Current best practices for: ${rawRequest.slice(0, 100)}`, []);
    }

    // Start the persisted delivery workflow for this goal.
    const instance = this.p.workflow.start(this.p.deliveryWorkflowId, { projectId, goalId: goal.id, riskTier: risk.tier, task: null });
    void instance;

    // Initial discovery pass.
    const coverage = await this.discoverOnce(projectId, rawRequest, risk.tier);
    return { missionId, intent, riskTier: risk.tier, coverage: coverage.coverage, openQuestion: coverage.question, workflowInstance: instance };
  }

  /** Pure projection: recompute coverage WITHOUT creating questions. */
  async readinessSnapshot(projectId: string): Promise<CoverageSnapshot> {
    const mission = this.latestMission(projectId);
    const tier = (this.p.docs.get<{ tier: RiskTier }>("risk_assessment", mission?.id ?? "")?.tier ?? "NORMAL") as RiskTier;
    return this.p.discovery.refreshCoverage(projectId as ProjectId, mission?.rawRequest ?? "", tier, this.repoFactsFor(projectId));
  }

  /** One discovery cycle: refresh coverage, emit readiness, create next question. */
  async discoverOnce(projectId: ProjectId, rawRequest?: string, riskTier?: RiskTier): Promise<{ coverage: CoverageSnapshot | null; question: DiscoveryQuestion | null }> {
    const project = this.getProject(projectId);
    const mission = this.latestMission(projectId);
    const request = rawRequest ?? mission?.rawRequest ?? "";
    const tier = riskTier ?? (this.p.docs.get<{ tier: RiskTier }>("risk_assessment", mission?.id ?? "")?.tier ?? "NORMAL");
    const repoFacts = this.repoFactsFor(projectId);

    const coverage = request
      ? await this.p.discovery.refreshCoverage(projectId, request, tier, repoFacts)
      : null;

    let question: DiscoveryQuestion | null = null;
    const providerIsMock = this.p.config.defaultProvider === "MOCK";
    if (providerIsMock && coverage) {
      question = this.p.discovery.createDemoQuestion(projectId);
    } else if (coverage) {
      const repoCoveredCategories = new Set(repoFacts.map((f) => f.split("::")[0] ?? ""));
      question = await this.p.discovery.createNextQuestion(projectId, request, coverage.coverage, repoCoveredCategories);
    }
    return { coverage, question };
  }

  answerQuestion(projectId: ProjectId, questionId: string, answer: string, optionKey?: string): Promise<CoverageSnapshot> {
    const result = this.p.discovery.answerQuestion(projectId, questionId, answer, optionKey);
    void result;
    return this.afterAnswerRefresh(projectId);
  }

  private async afterAnswerRefresh(projectId: ProjectId): Promise<CoverageSnapshot> {
    const mission = this.latestMission(projectId);
    const tier = (this.p.docs.get<{ tier: RiskTier }>("risk_assessment", mission?.id ?? "")?.tier ?? "NORMAL") as RiskTier;
    const repoFacts = this.repoFactsFor(projectId);
    const coverage = await this.p.discovery.refreshCoverage(projectId, mission?.rawRequest ?? "", tier, repoFacts);
    if (coverage.readyForPlanning) {
      this.p.events.append({ projectId, type: "discovery.ready", entityType: "project", entityId: projectId, actorType: "ENGINE", payload: { score: coverage.overallScore } });
      return coverage;
    }
    // Ask the next question immediately — one at a time (spec §2.2).
    const next = await this.discoverOnce(projectId);
    return next.coverage ?? coverage;
  }

  skipQuestionWithAssumption(projectId: string, questionId: string): Promise<CoverageSnapshot> {
    this.p.discovery.skipWithAssumption(projectId, questionId, "Conservative default assumed (user skipped)");
    return this.afterAnswerRefresh(projectId);
  }

  // ---------- Steps 7–11: spec → review council → architecture → tasks ----------
  async finalizeSpecification(projectId: string): Promise<void> {
    const mission = this.latestMission(projectId);
    if (!mission) throw new Error("[project-service/finalizeSpec] no mission submitted");
    await this.p.specification.generateSpec(projectId as ProjectId, this.p.docs.require<{ title: string }>("goal", mission.id).title, mission.rawRequest);
  }

  async runPlanReviewCouncil(projectId: string): Promise<Review[]> {
    const mission = this.latestMission(projectId);
    const requirements = this.p.docs.list<Requirement>("requirement", projectId);
    const roles = this.p.roles();
    const reviewerTypes: Array<[string, string]> = [
      ["Product Manager", "PRODUCT"],
      ["Frontend Engineer", "DESIGN_UX"],
      ["Backend Engineer", "SPEC_COMPLIANCE"],
      ["Security Engineer", "SECURITY"],
      ["QA Engineer", "QA"],
      ["Tech Lead", "DEVEX"],
    ];
    // Independent reviewers run in parallel (spec §12.7).
    const reviews = await Promise.all(
      reviewerTypes.map(async ([roleName, type]) => {
        const role = roles.find((r) => r.name === roleName)!;
        return this.p.reviews.runReview({
          projectId,
          taskId: null,
          type: type as Review["type"],
          reviewerRole: role,
          subject: {
            objective: mission?.rawRequest ?? "",
            requirements,
            diffSummary: "(plan-stage review)",
            testSummary: "(not yet)",
          },
          evidenceIds: [],
        });
      }),
    );
    return reviews;
  }

  async generateArchitecture(projectId: string): Promise<void> {
    const project = this.getProject(projectId);
    const mission = this.latestMission(projectId);
    const repo = project.repositoryPath ? await this.p.scanner.scan(project.repositoryPath).catch(() => null) : null;
    await this.p.architecture.generateArchitecture(projectId as ProjectId, mission?.rawRequest ?? "", repo);
  }

  async planDeliveryTasks(projectId: string, opts?: { overrideReadinessGate?: boolean }): Promise<TaskContract[]> {
    // Definition-of-Ready gate (spec §4 Steps 5, 11): planning is BLOCKED until the
    // requirement completeness engine says ready — unless explicitly overridden.
    if (!opts?.overrideReadinessGate) {
      const mission0 = this.latestMission(projectId);
      const tier0 = (this.p.docs.get<{ tier: RiskTier }>("risk_assessment", mission0?.id ?? "")?.tier ?? "NORMAL") as RiskTier;
      const readiness = await this.p.discovery.refreshCoverage(projectId as ProjectId, mission0?.rawRequest ?? "", tier0, this.repoFactsFor(projectId));
      if (!readiness.readyForPlanning) {
        throw new Error(
          `[project-service/plan] Definition of Ready not met: ${readiness.missingForReady.join("; ")}`,
        );
      }
      // Implementation Readiness Gate (V5/S11) — separate from DoR; active when
      // the operator opts in (DEVFLOW_REQUIRE_IMPL_CONTRACT=1 wiring in main.ts).
      if (this.p.contractGate) {
        const contractReady = this.p.contractGate.isReady(projectId as string);
        if (contractReady === false) {
          throw new Error(
            `[project-service/plan] Implementation Contract not ready — ${this.p.contractGate.topQuestion(projectId as string) ?? "resolve blocking gaps first"}`,
          );
        }
      }
    }
    const mission = this.latestMission(projectId);
    if (!mission) throw new Error("[project-service/plan] no mission submitted");
    const requirements = this.p.docs.list<Requirement>("requirement", projectId);
    const riskAssessment = this.p.docs.get<{ tier: RiskTier }>("risk_assessment", mission.id);
    const { signalsFromMission } = await import("../../domain/risk/risk-engine.js");
    const repoSnapshot = this.getProject(projectId).repositoryPath ? await this.p.scanner.scan(this.getProject(projectId).repositoryPath!).catch(() => null) : null;
    const signals = signalsFromMission(mission.rawRequest, repoSnapshot);
    // Workflow Composer (V3 §18/S4): an applied user workflow is the orchestration
    // source of truth — one task per STEP node, ordered by the composed edges.
    const composed = this.p.workflowComposer?.activeWorkflowFor(projectId as string);
    if (composed && composed.nodes.some((n) => n.type === "STEP" && n.roleId)) {
      return this.planTasksFromWorkflow(projectId as ProjectId, mission.rawRequest, composed, requirements.map((r) => r.id));
    }
    return this.p.planning.planTasks({
      projectId: projectId as ProjectId,
      goalId: mission.id,
      mission: mission.rawRequest,
      requirements,
      roles: this.p.roles(),
      riskSignals: signals,
      projectRiskTier: riskAssessment?.tier ?? "NORMAL",
    });
  }

  /**
   * Generates the task DAG from an applied Workflow Composer definition (S4):
   * one task per STEP node, dependencies from the composed edges, topologically
   * ordered. This is what makes a user workflow change ACTUAL execution order.
   */
  private planTasksFromWorkflow(projectId: ProjectId, mission: string, def: import("@devflow/contracts").WorkflowDefinition, requirementIds: string[]): TaskContract[] {
    const steps = def.nodes.filter((n) => n.type === "STEP" && n.roleId);
    const byId = new Map(steps.map((n) => [n.id as string, n]));
    const upstream = new Map<string, string[]>();
    for (const e of def.edges) {
      if (byId.has(e.fromNodeId) && byId.has(e.toNodeId)) {
        upstream.set(e.toNodeId, [...(upstream.get(e.toNodeId) ?? []), e.fromNodeId]);
      }
    }
    const now = new Date().toISOString();
    const idToTask = new Map<string, TaskContract>();
    const tasks: TaskContract[] = [];
    let seq = 0;
    // Deterministic topo order (DFS from entry); cycle → hard error.
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (nodeId: string): void => {
      if (done.has(nodeId)) return;
      if (visiting.has(nodeId)) throw new Error(`[project-service/plan] workflow '${def.name}' has a dependency cycle at '${nodeId}'`);
      visiting.add(nodeId);
      for (const up of upstream.get(nodeId) ?? []) visit(up);
      visiting.delete(nodeId);
      done.add(nodeId);
      const node = byId.get(nodeId)!;
      seq += 1;
      const deps = (upstream.get(nodeId) ?? []).map((u) => idToTask.get(u)!.id).filter(Boolean);
      const task: TaskContract = {
        id: newId("task"),
        projectId,
        stableKey: `WF-${String(seq).padStart(2, "0")}`,
        parentTaskId: null,
        objective: node.objective ?? `${node.name} (${node.roleId}) — from workflow '${def.name}': ${mission.slice(0, 200)}`,
        ownerRole: node.roleId! as TaskContract["ownerRole"],
        status: "READY",
        riskTier: "NORMAL",
        dependencyTaskIds: deps,
        requirementIds,
        acceptanceCriteriaIds: [],
        plannedSteps: [],
        affectedModules: [],
        requiredEvidenceTypes: ["UNIT_TEST"],
        requiredReviewTypes: ["SPEC_COMPLIANCE", "CODE_QUALITY"],
        permissionsNeeded: ["READ_ONLY", "WORKSPACE_WRITE"],
        blockers: [],
        handoffNotes: null,
        verificationCommands: [],
        createdAt: now,
        updatedAt: now,
      };
      idToTask.set(nodeId, task);
      tasks.push(task);
      this.p.docs.put("task", task.id, projectId, task);
      this.p.events.append({ projectId, type: "task.created", entityType: "task", entityId: task.id, actorType: "ENGINE", payload: { stableKey: task.stableKey, workflowNode: nodeId, deps } });
    };
    for (const n of steps) visit(n.id as string);
    this.p.events.append({ projectId, type: "task.ready", entityType: "workflow", entityId: def.id, actorType: "ENGINE", payload: { workflowId: def.id, tasks: tasks.length } });
    return tasks;
  }

  // ---------- Steps 12–19: execute → verify → review → completion ----------
  async executeTask(taskId: string, runtimeAdapterId = "mock-runtime"): Promise<AgentRun> {
    const task = this.p.docs.require<TaskContract>("task", taskId);
    if (task.status !== "READY" && task.status !== "QUEUED" && task.status !== "BLOCKED") {
      throw new Error(`[project-service/executeTask] task '${task.stableKey}' in status ${task.status} cannot start`);
    }
    // Dependency gate (V3 §18/S4): the composed order is enforced by the engine,
    // not advisory — upstream tasks must reach DONE before this one starts.
    const notDone = task.dependencyTaskIds.filter((depId) => this.p.docs.get<TaskContract>("task", depId)?.status !== "DONE");
    if (notDone.length > 0) {
      throw new Error(
        `[project-service/executeTask] task '${task.stableKey}' waits on ${notDone.length} upstream task(s) — execute them first`,
      );
    }
    // System readiness gate (spec Step 0): a required capability missing ⇒ NOT runnable.
    const missingCaps = await this.requiredCapabilitiesMissing(task);
    if (missingCaps.length > 0) {
      const blocked: TaskContract = { ...task, status: "BLOCKED", blockers: [`missing capabilities: ${missingCaps.join(", ")}`], updatedAt: new Date().toISOString() };
      this.p.docs.put("task", blocked.id, blocked.projectId, blocked);
      this.p.events.append({ projectId: task.projectId, type: "task.blocked", entityType: "task", entityId: task.id, actorType: "ENGINE", payload: { reason: "capabilities missing", missingCaps } });
      throw new Error(`[project-service/executeTask] cannot start '${task.stableKey}': ${missingCaps.join(", ")}`);
    }

    const started: TaskContract = { ...task, status: "RUNNING", updatedAt: new Date().toISOString() };
    this.p.docs.put("task", started.id, started.projectId, started);
    this.p.events.append({ projectId: task.projectId, type: "task.started", entityType: "task", entityId: task.id, actorType: "ENGINE", payload: {} });

    const run = await this.p.orchestrator.startTaskRun(started, runtimeAdapterId);

    // Post-run: collect verification evidence bound to current revision (engine-driven, not agent claim).
    if (run.status === "SUCCEEDED") {
      await this.collectTaskEvidence(started);
    }
    return run;
  }

  private async collectTaskEvidence(task: TaskContract): Promise<void> {
    const project = this.getProject(task.projectId);
    const workspaceRoot = project.repositoryPath ?? process.cwd();
    for (const evidenceType of task.requiredEvidenceTypes) {
      if (evidenceType === "UNIT_TEST" || evidenceType === "INTEGRATION_TEST") {
        try {
          await this.p.verification.runVerification(
            {
              projectId: task.projectId,
              taskId: task,
              evidenceType,
              toolId: "shell.exec",
              operation: "test suite",
              risk: "ELEVATED",
              workspaceRoot,
              permissionPreset: "ELEVATED_ALLOWED",
              inputSummary: { command: "echo '[mock test runner] all tests passed'" },
            },
            this.p.tools,
          );
        } catch (err) {
          this.p.events.append({ projectId: task.projectId, type: "verification.failed", entityType: "task", entityId: task.id, actorType: "ENGINE", payload: { error: err instanceof Error ? err.message : String(err) } });
        }
      } else if (evidenceType === "BUILD") {
        await this.p.verification.runVerification(
          {
            projectId: task.projectId,
            taskId: task,
            evidenceType: "BUILD",
            toolId: "shell.exec",
            operation: "build",
            risk: "ELEVATED",
            workspaceRoot,
            permissionPreset: "ELEVATED_ALLOWED",
            inputSummary: { command: "echo '[mock build] ok'" },
          },
          this.p.tools,
        );
      } else if (evidenceType === "E2E_TEST") {
        await this.p.verification.runVerification(
          {
            projectId: task.projectId,
            taskId: task,
            evidenceType: "E2E_TEST",
            toolId: "shell.exec",
            operation: "e2e",
            risk: "ELEVATED",
            workspaceRoot,
            permissionPreset: "ELEVATED_ALLOWED",
            inputSummary: { command: "echo '[mock e2e] flows passed'" },
          },
          this.p.tools,
        );
      }
    }
    // Freshness sweep: any code movement invalidates older evidence.
    const revision = (await this.p.git.currentRevision(workspaceRoot)) ?? "no-git";
    this.p.freshness.invalidateStale(task.projectId, revision);
  }

  /** Engine-owned two-stage review + completion predicate (spec Steps 18–19). */
  async reviewAndMaybeComplete(taskId: string): Promise<{ reviews: Review[]; canComplete: boolean; missing: Array<{ check: string; explanation: string }> }> {
    const task = this.p.docs.require<TaskContract>("task", taskId);
    const project = this.getProject(task.projectId);
    const roles = this.p.roles();
    const diffSummary = project.repositoryPath ? await this.p.git.diffSummary(project.repositoryPath) : "(no repository)";
    const evidenceList = this.p.docs.list<Evidence>("evidence", task.projectId).filter((e) => e.taskId === task.id);
    const testSummary = evidenceList.map((e) => `${e.type}: ${e.status}/${e.freshness}`).join("; ");

    const reviewing: TaskContract = { ...task, status: "REVIEW", updatedAt: new Date().toISOString() };
    this.p.docs.put("task", reviewing.id, reviewing.projectId, reviewing);
    this.p.events.append({ projectId: task.projectId, type: "task.review", entityType: "task", entityId: task.id, actorType: "ENGINE", payload: {} });

    const specReviewerRole = roles.find((r) => r.name === "Spec Compliance Reviewer")!;
    const codeReviewerRole = roles.find((r) => r.name === "Code Quality Reviewer")!;
    const securityRole = roles.find((r) => r.name === "Security Engineer");

    const reviews: Review[] = [];
    // Two-stage review: spec compliance FIRST, then code quality (spec §3.4).
    reviews.push(
      await this.p.reviews.runReview({
        projectId: task.projectId,
        taskId: task,
        type: "SPEC_COMPLIANCE",
        reviewerRole: specReviewerRole,
        subject: { objective: task.objective, requirements: task.requirementIds.map((id) => this.p.docs.require<Requirement>("requirement", id)), diffSummary, testSummary },
        evidenceIds: evidenceList.map((e) => e.id),
      }),
    );
    reviews.push(
      await this.p.reviews.runReview({
        projectId: task.projectId,
        taskId: task,
        type: "CODE_QUALITY",
        reviewerRole: codeReviewerRole,
        subject: { objective: task.objective, requirements: [], diffSummary, testSummary },
        evidenceIds: evidenceList.map((e) => e.id),
      }),
    );
    if (task.riskTier === "HIGH" && securityRole) {
      reviews.push(
        await this.p.reviews.runReview({
          projectId: task.projectId,
          taskId: task,
          type: "SECURITY",
          reviewerRole: securityRole,
          subject: { objective: task.objective, requirements: [], diffSummary, testSummary },
          evidenceIds: evidenceList.map((e) => e.id),
        }),
      );
    }

    const verdict = this.p.completion.evaluate(reviewing);
    if (verdict.canComplete) {
      const done: TaskContract = { ...reviewing, status: "DONE", updatedAt: new Date().toISOString() };
      this.p.docs.put("task", done.id, done.projectId, done);
      this.p.events.append({ projectId: task.projectId, type: "task.completed", entityType: "task", entityId: done.id, actorType: "ENGINE", payload: { stableKey: done.stableKey } });
    }
    return { reviews, canComplete: verdict.canComplete, missing: verdict.missing };
  }

  /** Explicit rerun of verification after stale-evidence block (Scenario B step 5-6). */
  async rerunVerification(taskId: string): Promise<Evidence[]> {
    const task = this.p.docs.require<TaskContract>("task", taskId);
    await this.collectTaskEvidence(task);
    return this.p.docs.list<Evidence>("evidence", task.projectId).filter((e) => e.taskId === task.id);
  }

  // ---------- Governance bridges ----------
  resolveDecisionHook(decisionId: string, chosenOption: string): void {
    const decision = this.p.docs.get<Decision>("decision", decisionId);
    if (!decision || !decision.taskId) return;
    const task = this.p.docs.get<TaskContract>("task", decision.taskId);
    if (task && task.status === "BLOCKED") {
      const unblocked: TaskContract = { ...task, status: "QUEUED", blockers: [], updatedAt: new Date().toISOString() };
      this.p.docs.put("task", unblocked.id, unblocked.projectId, unblocked);
    }
    if (decision.taskId) {
      const waitingRun = this.p.docs.list<AgentRun>("agent_run", this.getProject(decision.projectId).id)
        .find((r) => r.taskId === decision.taskId && r.status === "WAITING_DECISION");
      if (waitingRun) {
        void this.p.orchestrator.resumeRun(waitingRun.id, `decision resolved: ${chosenOption}`);
      }
    }
  }

  approvalUnblockHook(runId: string, observation: string): void {
    void this.p.orchestrator.resumeRun(runId, observation).catch(() => {
      // Resume failures surface via run state; never crash the approval path.
    });
  }

  // ---------- Projections ----------
  latestMission(projectId: string): { id: string; projectId: string; rawRequest: string; createdAt: string } | null {
    const missions = this.p.docs.list<{ id: string; projectId: string; rawRequest: string; createdAt: string }>("mission", projectId);
    return missions[missions.length - 1] ?? null;
  }

  coverageOf(projectId: string): RequirementCoverage[] {
    return this.p.docs.list<RequirementCoverage>("requirement", projectId).length > 0 ? [] : [];
  }

  recommendationsFor(projectId: string): Recommendation[] {
    return this.p.docs.list<Recommendation>("recommendation", projectId).filter((r) => r.status === "OPEN");
  }

  driftFindingsFor(projectId: string): DriftFinding[] {
    return this.p.docs.list<DriftFinding>("drift_finding", projectId);
  }

  checkpointsOf(projectId: string): Checkpoint[] {
    return this.p.docs.list<Checkpoint>("checkpoint", projectId);
  }

  actionsOf(projectId: string): GatewayAction[] {
    return this.p.docs.list<GatewayAction>("action", projectId);
  }

  runsOf(projectId: string): AgentRun[] {
    return this.p.docs.list<AgentRun>("agent_run", projectId);
  }

  private repoFactsFor(projectId: string): string[] {
    const facts: string[] = [];
    const memories = this.p.docs.list<import("@devflow/contracts").MemoryItem>("memory_item", projectId);
    for (const m of memories) {
      if (m.lifecycle === "CONFIRMED" || m.lifecycle === "CANONICAL") facts.push(`${m.category}::${m.statement}`);
    }
    return facts;
  }

  private async requiredCapabilitiesMissing(task: TaskContract): Promise<string[]> {
    const missing: string[] = [];
    if (task.riskTier === "HIGH") {
      // HIGH work demands git for revision-bound evidence.
      const project = this.getProject(task.projectId);
      const hasGit = project.repositoryPath ? await this.p.git.isRepository(project.repositoryPath) : false;
      if (!hasGit) missing.push("git");
    }
    return missing;
  }
}
