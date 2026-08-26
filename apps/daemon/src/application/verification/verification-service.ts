import type {
  AcceptanceCriterion,
  Evidence,
  GatewayAction,
  ProjectId,
  Requirement,
  Review,
  TaskContract,
} from "@devflow/contracts";
import type { GitAdapter } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { ActionGateway } from "../gateway/action-gateway.js";

/**
 * VerificationService (spec §4 Steps 16–17). Evidence is bound to the git revision it
 * was produced against. A revision change later marks affected evidence STALE.
 */
export class VerificationService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly gateway: ActionGateway,
    private readonly git: GitAdapter,
  ) {}

  async runVerification(params: {
    projectId: ProjectId;
    taskId: TaskContract | null;
    evidenceType: Evidence["type"];
    toolId: string;
    operation: string;
    risk: GatewayAction["risk"];
    workspaceRoot: string;
    permissionPreset: string;
    inputSummary: Record<string, unknown>;
  }, registry: { get(id: string): { execute(input: Record<string, unknown>, ctx: { workspaceRoot: string }): Promise<{ ok: boolean; summary: string; output: string | null }> } }): Promise<Evidence> {
    const project = this.docs.require<{ id: string; repositoryPath: string | null; name: string }>("project", params.projectId);
    this.events.append({
      projectId: params.projectId,
      type: "verification.started",
      entityType: "task",
      entityId: params.taskId?.id ?? null,
      actorType: "ENGINE",
      payload: { evidenceType: params.evidenceType },
    });
    const tool = registry.get(params.toolId);
    const finished = await this.gateway.executeAction({
      projectId: params.projectId,
      runId: null,
      toolId: params.toolId,
      operation: params.operation,
      risk: params.risk,
      permissionPreset: params.permissionPreset,
      reversible: true,
      target: typeof params.inputSummary.path === "string" ? params.inputSummary.path : null,
      workspaceRoot: params.workspaceRoot || project.repositoryPath || process.cwd(),
      inputSummary: params.inputSummary,
      executor: { execute: (input, ctx) => tool.execute(input, ctx) },
    });
    // Evidence binds to the revision of the workspace the command actually ran in —
    // never the daemon's own cwd (spec §4 Step 17).
    const bindRoot = params.workspaceRoot || project.repositoryPath || process.cwd();
    const revision = (await this.git.currentRevision(bindRoot)) ?? "no-git";
    return this.recordFromAction(params, finished, revision);
  }

  async recordFromAction(
    params: {
      projectId: ProjectId;
      taskId: TaskContract | null;
      evidenceType: Evidence["type"];
      requirementIds?: string[];
    },
    action: GatewayAction,
    revisionOverride?: string,
  ): Promise<Evidence> {
    const revision = revisionOverride ?? (await this.git.currentRevision(action.target ?? ".")) ?? "no-git";
    const passed = action.status === "SUCCEEDED";
    const evidence: Evidence = {
      id: `ev_${action.id}`,
      projectId: params.projectId,
      taskId: params.taskId?.id ?? null,
      type: params.evidenceType,
      requirementIds: params.requirementIds ?? params.taskId?.requirementIds ?? [],
      acceptanceCriterionIds: params.taskId?.acceptanceCriteriaIds ?? [],
      revision,
      commandOrMethod: `${action.toolId}:${action.operation}`,
      status: passed ? "PASS" : "FAIL",
      freshness: "FRESH",
      outputSummary: action.resultSummary ?? "",
      artifactPath: null,
      createdAt: new Date().toISOString(),
    };
    this.docs.put("evidence", evidence.id, params.projectId, evidence);
    this.events.append({
      projectId: params.projectId,
      type: passed ? "verification.passed" : "verification.failed",
      entityType: "evidence",
      entityId: evidence.id,
      actorType: "ENGINE",
      payload: { evidenceType: evidence.type, revision, summary: evidence.outputSummary },
    });
    return evidence;
  }

  recordManualEvidence(params: {
    projectId: ProjectId;
    taskId: TaskContract | null;
    method: string;
    outputSummary: string;
  }): Evidence {
    const evidence: Evidence = {
      id: `ev_manual_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      projectId: params.projectId,
      taskId: params.taskId?.id ?? null,
      type: "MANUAL_APPROVAL",
      requirementIds: [],
      acceptanceCriterionIds: [],
      revision: "manual",
      commandOrMethod: params.method,
      status: "PASS",
      freshness: "FRESH",
      outputSummary: params.outputSummary,
      artifactPath: null,
      createdAt: new Date().toISOString(),
    };
    this.docs.put("evidence", evidence.id, params.projectId, evidence);
    this.events.append({
      projectId: params.projectId,
      type: "evidence.created",
      entityType: "evidence",
      entityId: evidence.id,
      actorType: "USER",
      payload: { manual: true, method: params.method },
    });
    return evidence;
  }
}

/** Evidence freshness (spec §4 Step 17): code moved ⇒ evidence for older revisions goes STALE. */
export class EvidenceFreshnessService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  /** Marks all FRESH evidence not matching the current revision as STALE. Returns count. */
  invalidateStale(projectId: ProjectId, currentRevision: string): number {
    let count = 0;
    for (const evidence of this.docs.list<Evidence>("evidence", projectId)) {
      if (
        evidence.freshness === "FRESH" &&
        evidence.type !== "MANUAL_APPROVAL" &&
        evidence.revision !== "manual" &&
        evidence.revision !== "no-git" &&
        evidence.revision !== currentRevision
      ) {
        const stale: Evidence = { ...evidence, freshness: "STALE" };
        this.docs.put("evidence", stale.id, projectId, stale);
        this.events.append({
          projectId,
          type: "evidence.stale",
          entityType: "evidence",
          entityId: stale.id,
          actorType: "ENGINE",
          payload: { oldRevision: evidence.revision, newRevision: currentRevision },
        });
        count++;
      }
    }
    return count;
  }
}

/**
 * Completion predicates (spec §30). Computed, never claimed.
 * Returns exactly WHY completion is blocked so the UI can explain it.
 */
export class CompletionService {
  constructor(private readonly docs: DocumentRepository) {}

  evaluate(task: TaskContract): {
    canComplete: boolean;
    missing: Array<{ check: string; explanation: string }>;
  } {
    const missing: Array<{ check: string; explanation: string }> = [];

    if (task.blockers.length > 0) {
      missing.push({ check: "blockers", explanation: `open blockers: ${task.blockers.join("; ")}` });
    }

    // Required evidence exists AND is fresh.
    const allEvidence = this.docs.list<Evidence>("evidence", task.projectId).filter((e) => e.taskId === task.id);
    for (const requiredType of task.requiredEvidenceTypes) {
      const matching = allEvidence.filter((e) => e.type === requiredType && e.status === "PASS" && e.freshness === "FRESH");
      if (matching.length === 0) {
        const failed = allEvidence.filter((e) => e.type === requiredType && e.status === "FAIL");
        const stale = allEvidence.filter((e) => e.type === requiredType && e.status === "PASS" && e.freshness === "STALE");
        missing.push({
          check: `evidence:${requiredType}`,
          explanation:
            stale.length > 0
              ? `required ${requiredType} evidence exists but is STALE (code changed after it ran)`
              : failed.length > 0
                ? `required ${requiredType} evidence last FAILED`
                : `missing required ${requiredType} evidence`,
        });
      }
    }

    // Acceptance criteria satisfied via fresh passing evidence linked to them.
    const acs = task.acceptanceCriteriaIds
      .map((acId) => this.docs.get<AcceptanceCriterion>("acceptance_criterion", acId))
      .filter((ac): ac is AcceptanceCriterion => ac !== null);
    for (const ac of acs) {
      const covered = allEvidence.some(
        (e) =>
          e.acceptanceCriterionIds.includes(ac.id) &&
          e.status === "PASS" &&
          e.freshness === "FRESH",
      );
      if (!covered) {
        missing.push({ check: `acceptance_criterion:${ac.stableKey}`, explanation: `AC '${ac.stableKey}' lacks fresh passing evidence` });
      }
    }

    // Required reviews passed (with OPEN blocking findings = blocked).
    for (const reviewType of task.requiredReviewTypes) {
      const reviews = this.docs
        .list<Review>("review", task.projectId)
        .filter((r) => r.taskId === task.id && r.type === reviewType)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const latest = reviews[reviews.length - 1];
      if (!latest) {
        missing.push({ check: `review:${reviewType}`, explanation: `required ${reviewType} review has not run yet` });
      } else if (latest.status !== "PASSED") {
        missing.push({ check: `review:${reviewType}`, explanation: `latest ${reviewType} review is ${latest.status}` });
      }
    }

    return { canComplete: missing.length === 0, missing };
  }

  complete(task: TaskContract): TaskContract {
    const verdict = this.evaluate(task);
    if (!verdict.canComplete) {
      throw new Error(
        `[completion-service/complete] cannot complete '${task.stableKey}': ${verdict.missing.map((m) => m.check).join(", ")}`,
      );
    }
    return task;
  }
}
