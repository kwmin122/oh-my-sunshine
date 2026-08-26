import type { ActionGateway } from "../gateway/action-gateway.js";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { AgentRun, Approval } from "@devflow/contracts";

export type ApprovalOutcome = "ALLOW_ONCE" | "APPROVED" | "REJECTED" | "CANCELLED";

/**
 * Human approval flow (spec §5.6, §14 Step 14). Approving resumes execution;
 * rejecting fails the action and unblocks the requesting run with an explicit
 * rejection observation so it can replan instead of hanging.
 */
export class ApprovalService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly gateway: ActionGateway,
    private readonly onRunUnblocked: (runId: string, observation: string) => void,
  ) {}

  async resolve(approvalId: string, outcome: ApprovalOutcome, note?: string): Promise<Approval> {
    const approval = this.docs.require<Approval>("approval", approvalId);
    if (approval.status !== "REQUESTED") {
      throw new Error(`[approval-service/resolve] approval '${approvalId}' already resolved (${approval.status})`);
    }
    const now = new Date().toISOString();
    const resolvedStatus: Approval["status"] =
      outcome === "REJECTED"
        ? "REJECTED"
        : outcome === "CANCELLED"
          ? "CANCELLED"
          : outcome === "ALLOW_ONCE"
            ? "ALLOWED_ONCE"
            : "APPROVED";
    const resolved: Approval = {
      ...approval,
      status: resolvedStatus,
      resolvedBy: "USER",
      resolvedAt: now,
    };
    this.docs.put("approval", approval.id, approval.projectId, resolved);

    if (outcome === "ALLOW_ONCE" || outcome === "APPROVED") {
      this.events.append({
        projectId: approval.projectId,
        type: "action.approved",
        entityType: "approval",
        entityId: approval.id,
        actorType: "USER",
        payload: { outcome, note: note ?? null },
      });
      if (resolved.actionId) {
        const finished = await this.gateway.executeApprovedAction(resolved.actionId);
        if (finished.status === "SUCCEEDED" && finished.runId) {
          this.onRunUnblocked(finished.runId, `approved action executed: ${finished.resultSummary}`);
        }
        // Rejected/failed approved executions still unblock the run so it can react.
        if (finished.status !== "SUCCEEDED" && finished.runId) {
          this.onRunUnblocked(finished.runId, `approved action failed: ${finished.resultSummary}`);
        }
      }
    } else {
      this.events.append({
        projectId: approval.projectId,
        type: "action.denied",
        entityType: "approval",
        entityId: approval.id,
        actorType: "USER",
        payload: { outcome, note: note ?? null },
      });
      if (resolved.actionId) {
        const action = this.docs.get<{ id: string; projectId: string; status: string; resultSummary: string | null; runId: string | null }>(
          "action",
          resolved.actionId,
        );
        if (action) {
          this.docs.put("action", action.id, action.projectId, {
            ...action,
            status: "DENIED",
            resultSummary: `rejected by user${note ? `: ${note}` : ""}`,
          });
          if (action.runId) {
            this.onRunUnblocked(action.runId, `action rejected by user: ${action.resultSummary}`);
          }
        }
      }
    }
    return resolved;
  }

  listOpen(projectId: string): Approval[] {
    return this.docs
      .list<Approval>("approval", projectId)
      .filter((a) => a.status === "REQUESTED");
  }

  /** Runs parked on WAITING_APPROVAL for a resolved approval are re-queued by the orchestrator callback. */
  resumeWaitingRuns(projectId: string, approvalActionId: string, observation: string): void {
    const runs = this.docs.list<AgentRun>("agent_run", projectId);
    void approvalActionId;
    for (const run of runs) {
      if (run.status === "WAITING_APPROVAL") {
        this.onRunUnblocked(run.id, observation);
      }
    }
  }
}
