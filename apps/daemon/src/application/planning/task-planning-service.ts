import type {
  AgentRole,
  Goal,
  ModelProvider,
  ProjectId,
  Requirement,
  RiskTier,
  TaskContract,
} from "@devflow/contracts";
import { newId, parseModelJson, TaskDecompositionOutput } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import { nextStableKey } from "../discovery/discovery-service.js";
import type { RiskSignals } from "../../domain/risk/risk-engine.js";
import { assessRisk } from "../../domain/risk/risk-engine.js";

export interface PlanningPorts {
  docs: DocumentRepository;
  events: EventStore;
  provider: ModelProvider;
}

/**
 * TaskPlanningService (spec §4 Step 10–11, §20).
 * Produces a dependency-aware task DAG with right-sized contracts. Dependency edges are
 * matched by objective text then validated — dangling references fail loudly, never silently drop.
 */
export class TaskPlanningService {
  constructor(private readonly ports: PlanningPorts) {}

  async planTasks(params: {
    projectId: ProjectId;
    goalId: string | null;
    mission: string;
    requirements: Requirement[];
    roles: AgentRole[];
    riskSignals: RiskSignals;
    projectRiskTier: RiskTier;
  }): Promise<TaskContract[]> {
    const decomposition = await this.requestDecomposition(params.mission, params.requirements);

    // Match owner roles by name; unknown role names fail the plan rather than silently defaulting.
    const roleByName = new Map(params.roles.map((r) => [r.name.toLowerCase(), r]));
    const tasksByKey = new Map<string, TaskContract>();
    const existingKeys = this.ports.docs.list<TaskContract>("task", params.projectId).map((t: TaskContract) => t.stableKey);

    const drafts: Array<{ draft: TaskContract; dependsOnObjectives: string[] }> = [];
    for (const t of decomposition.tasks) {
      const role = roleByName.get(t.ownerRoleName.toLowerCase());
      if (!role) {
        throw new Error(`[task-planning/plan] model proposed unknown owner role '${t.ownerRoleName}'`);
      }
      const signals: RiskSignals =
        t.suggestedRiskTier === "HIGH"
          ? { ...params.riskSignals, securitySensitive: true }
          : params.riskSignals;
      const risk = assessRisk(signals);
      const stableKey = nextStableKey([...existingKeys, ...[...tasksByKey.values()].map((x) => x.stableKey)], "TASK");
      const now = new Date().toISOString();
      const task: TaskContract = {
        id: newId("task"),
        projectId: params.projectId,
        stableKey,
        parentTaskId: null,
        objective: t.objective,
        ownerRole: role.id,
        riskTier: t.suggestedRiskTier === "HIGH" ? "HIGH" : risk.tier,
        status: "READY",
        dependencyTaskIds: [],
        requirementIds: params.requirements.map((r) => r.id),
        acceptanceCriteriaIds: [],
        plannedSteps: t.plannedSteps,
        affectedModules: [],
        requiredEvidenceTypes: t.requiredEvidenceTypes.length > 0 ? t.requiredEvidenceTypes : ["UNIT_TEST"],
        requiredReviewTypes: risk.tier === "HIGH" ? ["SPEC_COMPLIANCE", "CODE_QUALITY", "SECURITY"] : ["SPEC_COMPLIANCE", "CODE_QUALITY"],
        permissionsNeeded: ["READ_ONLY", "WORKSPACE_WRITE"],
        blockers: [],
        handoffNotes: null,
        verificationCommands: ["npm test -- --run"],
        createdAt: now,
        updatedAt: now,
      };
      tasksByKey.set(t.objective, task);
      drafts.push({ draft: task, dependsOnObjectives: t.dependsOnObjectives });
      this.ports.docs.put("task", task.id, params.projectId, task);
      this.ports.events.append({
        projectId: params.projectId,
        type: "task.created",
        entityType: "task",
        entityId: task.id,
        actorType: "ENGINE",
        payload: { stableKey, objective: task.objective, riskTier: task.riskTier },
      });
    }

    // Resolve dependencies AFTER all tasks exist; unmatched references abort planning.
    for (const { draft, dependsOnObjectives } of drafts) {
      for (const depObjective of dependsOnObjectives) {
        const dep = tasksByKey.get(depObjective);
        if (!dep) {
          throw new Error(`[task-planning/plan] task '${draft.objective}' depends on unknown objective '${depObjective}'`);
        }
        draft.dependencyTaskIds.push(dep.id);
      }
      this.ports.docs.put("task", draft.id, params.projectId, draft);
      this.ports.events.append({
        projectId: params.projectId,
        type: "task.ready",
        entityType: "task",
        entityId: draft.id,
        actorType: "ENGINE",
        payload: { deps: draft.dependencyTaskIds },
      });
    }

    return [...tasksByKey.values()];
  }

  /** Deterministic topological order — independent tasks may run in parallel, dependents follow. */
  executionOrder(tasks: TaskContract[]): TaskContract[] {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const ordered: TaskContract[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (task: TaskContract): void => {
      if (done.has(task.id)) return;
      if (visiting.has(task.id)) {
        throw new Error(`[task-planning/order] dependency cycle involving '${task.objective}'`);
      }
      visiting.add(task.id);
      for (const depId of task.dependencyTaskIds) {
        const dep = byId.get(depId);
        if (dep) visit(dep);
      }
      visiting.delete(task.id);
      done.add(task.id);
      ordered.push(task);
    };
    for (const t of tasks) visit(t);
    return ordered;
  }

  private async requestDecomposition(mission: string, requirements: Requirement[]): Promise<TaskDecompositionOutput> {
    const response = await this.ports.provider.generate({
      purpose: "task_decomposition",
      system:
        "You are the Tech Lead. Decompose into right-sized tasks: one clear objective each, independently verifiable, explicit dependencies by exact objective text.",
      messages: [
        {
          role: "user",
          content: [
            `Mission: ${mission}`,
            `Requirements:\n${requirements.map((r) => `- [${r.stableKey}] ${r.statement}`).join("\n") || "- none"}`,
            `Owner roles available: Backend Engineer, Frontend Engineer, AI/ML Engineer, Database Engineer, QA Engineer, Security Engineer.`,
          ].join("\n"),
        },
      ],
      responseSchemaHint:
        '{"tasks":[{"objective":"...","ownerRoleName":"Backend Engineer","requirementStableKeys":[],"dependsOnObjectives":[],"plannedSteps":["..."],"acceptanceCriteria":["..."],"requiredEvidenceTypes":["UNIT_TEST"],"suggestedRiskTier":"NORMAL"}]}',
      maxTokens: 2500,
    });
    const parsed = parseModelJson(response.raw, TaskDecompositionOutput);
    if (!parsed.ok) {
      throw new Error(`[task-planning/decompose] invalid model output: ${parsed.error}`);
    }
    return parsed.value;
  }
}
