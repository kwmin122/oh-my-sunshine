import type { DriftFinding, TaskContract } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * DriftDetectionService (§2.16, §3.9, Scenario H): compares the files an agent actually
 * touched against the task contract's approved scope. Deterministic scope analysis first;
 * AI judgment may refine severity but cannot silence a deterministic out-of-scope signal.
 */
export class DriftDetectionService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  detect(params: {
    projectId: string;
    task: TaskContract;
    runId: string | null;
    changedFiles: string[];
  }): DriftFinding | null {
    const expectedScope = new Set(params.task.affectedModules.map((m) => m.toLowerCase()));
    // Files written by the agent during this task (tracked via edit events) are in-scope by definition.
    const observed = params.changedFiles.map((f) => f.toLowerCase());

    const unrelated = observed.filter((f) => {
      if (expectedScope.size === 0) return false; // no declared scope ⇒ nothing to contradict
      if (f.includes(".devflow/")) return false; // control-plane artifacts are always allowed
      for (const module of expectedScope) {
        if (f.includes(module)) return false; // in-scope change
      }
      return true; // outside every approved module
    });

    if (expectedScope.size === 0 || unrelated.length === 0) return null;

    const finding: DriftFinding = {
      id: newId("drift"),
      projectId: params.projectId,
      taskId: params.task.id,
      runId: params.runId,
      severity: unrelated.length > 2 ? "HIGH" : "MEDIUM",
      expectedScope: [...expectedScope],
      observedScope: unrelated,
      explanation: `${unrelated.length} changed file(s) fall outside the approved task scope (${[...expectedScope].join(", ")})`,
      status: "OPEN",
      resolution: null,
      createdAt: new Date().toISOString(),
    };
    this.docs.put("drift_finding", finding.id, params.projectId, finding);
    this.events.append({
      projectId: params.projectId,
      type: "drift.detected",
      entityType: "drift_finding",
      entityId: finding.id,
      actorType: "ENGINE",
      payload: { severity: finding.severity, files: unrelated.slice(0, 10) },
    });
    return finding;
  }

  resolve(findingId: string, resolution: DriftFinding["status"], note: string): DriftFinding {
    const finding = this.docs.require<DriftFinding>("drift_finding", findingId);
    const resolved: DriftFinding = { ...finding, status: resolution, resolution: note };
    this.docs.put("drift_finding", resolved.id, resolved.projectId, resolved);
    this.events.append({
      projectId: resolved.projectId,
      type: "drift.resolved",
      entityType: "drift_finding",
      entityId: finding.id,
      actorType: "USER",
      payload: { resolution },
    });
    return resolved;
  }
}
