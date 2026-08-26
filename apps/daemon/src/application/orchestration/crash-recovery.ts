import type { AgentRun, TaskContract } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * Crash recovery (V3 §26). A daemon restart means every RUNNING run lost its
 * child process — they are orphans by definition. WAITING_APPROVAL/WAITING_DECISION
 * runs are state-parked, not process-bound, and stay resumable untouched.
 */
export function recoverOrphanedRuns(
  docs: DocumentRepository,
  events: EventStore,
): Array<{ runId: string; taskId: string | null }> {
  const recovered: Array<{ runId: string; taskId: string | null }> = [];
  const now = new Date().toISOString();
  for (const run of docs.list<AgentRun>("agent_run")) {
    if (run.status !== "RUNNING" || !run.sessionId) continue;
    const orphaned: AgentRun = { ...run, status: "FAILED", failureReason: "ORPHANED_BY_RESTART", endedAt: now };
    docs.put("agent_run", orphaned.id, orphaned.projectId, orphaned);
    if (run.taskId) {
      const task = docs.get<TaskContract>("task", run.taskId);
      // Only RUNNING tasks are stuck on this run; BLOCKED ones keep their gates.
      if (task && task.status === "RUNNING") {
        docs.put("task", task.id, task.projectId, { ...task, status: "READY", updatedAt: now });
      }
    }
    events.append({
      projectId: run.projectId,
      type: "agent.run_orphaned" as never,
      entityType: "run",
      entityId: run.id,
      actorType: "ENGINE",
      payload: { reason: "daemon restarted while run was in flight", taskId: run.taskId },
    });
    recovered.push({ runId: run.id, taskId: run.taskId });
  }
  return recovered;
}
