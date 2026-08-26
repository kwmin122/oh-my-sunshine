import type { Adr, Conflict, Recommendation, TaskContract } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * Conflict Detection (spec §3.8, §5.14). Contradictions between proposals and canon
 * become first-class Conflicts — never silently overwritten.
 * V1 uses deterministic keyword contradiction rules; richer semantic detection is an
 * adapter seam behind the same interface.
 */
export class ConflictDetectionService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  /** Checks a new proposal against accepted ADRs for direct contradictions. */
  detectProposalConflicts(projectId: string, proposalStatement: string): Conflict[] {
    const adrs = this.docs.list<Adr>("adr", projectId).filter((a) => a.status === "ACCEPTED");
    const conflicts: Conflict[] = [];
    const proposalText = proposalStatement.toLowerCase();

    const CONTRADICTION_RULES: ReadonlyArray<{ left: RegExp; right: RegExp; explanation: string }> = [
      {
        left: /\bserver[- ]side sessions?\b|\bsessions?\s+stored\s+server[- ]side\b/,
        right: /\blocalstorage\b|\bbearer token in localstorage\b/,
        explanation: "proposal stores auth state client-side while an accepted ADR mandates server-side session state",
      },
      {
        left: /\bpostgres(ql)?\b/,
        right: /\bmongodb\b|\bdynamodb\b/,
        explanation: "proposal switches the primary datastore away from the decided relational store",
      },
      {
        left: /\brest\b|\brestful api\b/,
        right: /\bgraphql\b/,
        explanation: "proposal changes the API style from the decided REST surface",
      },
    ];

    for (const adr of adrs) {
      const decisionText = `${adr.title} ${adr.decision}`.toLowerCase();
      for (const rule of CONTRADICTION_RULES) {
        if ((rule.left.test(decisionText) && rule.right.test(proposalText)) || (rule.right.test(decisionText) && rule.left.test(proposalText))) {
          const conflict = this.create({
            projectId,
            type: "DECISION_VS_ADR",
            severity: "HIGH",
            leftEntity: `ADR ${adr.stableKey}: ${adr.title}`,
            rightEntity: `Proposal: ${proposalStatement}`,
            explanation: `${rule.explanation}. Existing ADR '${adr.stableKey}' says "${adr.decision.slice(0, 120)}" while the new proposal contradicts it.`,
          });
          conflicts.push(conflict);
        }
      }
    }
    return conflicts;
  }

  create(params: Omit<Conflict, "id" | "status" | "resolution" | "createdAt" | "resolvedAt">): Conflict {
    const conflict: Conflict = {
      ...params,
      id: newId("conflict"),
      status: "OPEN",
      resolution: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.docs.put("conflict", conflict.id, conflict.projectId, conflict);
    this.events.append({ projectId: conflict.projectId, type: "conflict.detected", entityType: "conflict", entityId: conflict.id, actorType: "ENGINE", payload: { severity: conflict.severity } });
    return conflict;
  }

  resolve(conflictId: string, resolution: string, acceptAsIs: boolean): Conflict {
    const conflict = this.docs.require<Conflict>("conflict", conflictId);
    if (conflict.status !== "OPEN") throw new Error(`[conflict/resolve] conflict '${conflictId}' not open`);
    const resolved: Conflict = {
      ...conflict,
      status: acceptAsIs ? "ACCEPTED" : "RESOLVED",
      resolution,
      resolvedAt: new Date().toISOString(),
    };
    this.docs.put("conflict", resolved.id, resolved.projectId, resolved);
    this.events.append({ projectId: resolved.projectId, type: "conflict.resolved", entityType: "conflict", entityId: resolved.id, actorType: "USER", payload: { resolution } });
    return resolved;
  }

  listOpen(projectId: string): Conflict[] {
    return this.docs.list<Conflict>("conflict", projectId).filter((c) => c.status === "OPEN");
  }
}

/** Recommendation engine (spec §3.8, §5.15) — deterministic rule-derived suggestions.
 * A recommendation never executes anything by itself. */
export class RecommendationService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  computeForProject(projectId: string): Recommendation[] {
    const out: Recommendation[] = [];
    const tasks = this.docs.list<TaskContract>("task", projectId);
    void this.docs;

    // Blocked tasks → resume recommendation.
    for (const task of tasks.filter((t) => t.status === "BLOCKED")) {
      out.push(this.create(projectId, task.id, "resume_blocked_agent", `Task ${task.stableKey} is blocked: ${task.blockers[0] ?? "unknown blocker"}`, 0.9));
    }
    // Tasks in VERIFYING with missing evidence → run validation.
    for (const task of tasks.filter((t) => t.status === "VERIFYING")) {
      out.push(this.create(projectId, task.id, "run_validation", `Task ${task.stableKey} finished implementation but verification evidence is incomplete`, 0.85));
    }
    return out;
  }

  create(projectId: string, taskId: string | null, actionType: Recommendation["actionType"], reason: string, confidence: number): Recommendation {
    const rec: Recommendation = {
      id: newId("rec"),
      projectId,
      taskId,
      actionType,
      reason,
      source: "RULE",
      confidence,
      status: "OPEN",
      createdAt: new Date().toISOString(),
    };
    this.docs.put("recommendation", rec.id, projectId, rec);
    this.events.append({ projectId, type: "recommendation.created", entityType: "recommendation", entityId: rec.id, actorType: "ENGINE", payload: { actionType } });
    return rec;
  }

  dismiss(recId: string): void {
    const rec = this.docs.require<Recommendation>("recommendation", recId);
    const dismissed: Recommendation = { ...rec, status: "DISMISSED" };
    this.docs.put("recommendation", dismissed.id, dismissed.projectId, dismissed);
    this.events.append({ projectId: dismissed.projectId, type: "recommendation.dismissed", entityType: "recommendation", entityId: rec.id, actorType: "USER", payload: {} });
  }
}
