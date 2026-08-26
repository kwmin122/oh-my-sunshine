import type { GatewayAction, Approval, AgentRunId, ProjectId } from "@devflow/contracts";
import { newId, type PolicyEngine } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import { assertPathInsideWorkspace } from "../../lib/path-guard.js";

export interface ToolExecutor {
  execute(input: Record<string, unknown>, ctx: { workspaceRoot: string }): Promise<{ ok: boolean; summary: string; output: string | null }>;
}

export interface GatewayPorts {
  docs: DocumentRepository;
  events: EventStore;
  policy: PolicyEngine;
}

export interface ExecuteActionInput {
  projectId: ProjectId;
  runId: AgentRunId | null;
  toolId: string;
  operation: string;
  risk: GatewayAction["risk"];
  permissionPreset: string;
  reversible: boolean;
  target?: string | null;
  workspaceRoot: string;
  inputSummary: Record<string, unknown>;
  approvalSeverity?: Approval["severity"];
  executor: ToolExecutor;
}

/**
 * Action Gateway (spec §14 Step 14, §16). Every meaningful tool action flows through
 * here — no bypass path exists. Fail-closed: missing approval blocks execution.
 * Pipeline: validate → policy → approval gate → execute → validate → record.
 */
export class ActionGateway {
  /** Executors for actions awaiting approval. Daemon-local by design: after a restart
   * unresolved approvals are expired rather than silently executed later. */
  private readonly pendingExecutors = new Map<string, { executor: ToolExecutor; projectId: ProjectId }>();

  constructor(private readonly ports: GatewayPorts) {}

  /** Expire stale approvals at boot so no zombie action can execute after restart. */
  expireUnresolvedApprovals(): void {
    const approvals = this.ports.docs.list<Approval>("approval");
    for (const approval of approvals) {
      if (approval.status === "REQUESTED") {
        const expired: Approval = { ...approval, status: "EXPIRED", resolvedAt: new Date().toISOString() };
        this.ports.docs.put("approval", expired.id, expired.projectId, expired);
      }
    }
  }

  async executeAction(input: ExecuteActionInput): Promise<GatewayAction> {
    // 1) Validate + confine paths before anything else runs.
    if (input.target) {
      try {
        assertPathInsideWorkspace(input.workspaceRoot, input.target);
      } catch (err) {
        return this.recordDenied(input, err instanceof Error ? err.message : String(err));
      }
    }

    const actionId = newId("act");
    // 2) Policy check
    const verdict = this.ports.policy.evaluate({
      toolId: input.toolId,
      operation: input.operation,
      risk: input.risk,
      permissionPreset: input.permissionPreset,
      reversible: input.reversible,
      targetPath: input.target ?? null,
    });

    let action: GatewayAction = {
      id: actionId,
      projectId: input.projectId,
      runId: input.runId,
      toolId: input.toolId,
      operation: input.operation,
      risk: input.risk,
      target: input.target ?? null,
      summary: `${input.toolId}:${input.operation}${input.target ? ` ${input.target}` : ""}`,
      reversible: input.reversible,
      requestedPermission: "ALLOW",
      policyDecision: verdict.decision,
      approvalId: null,
      inputSummary: redactSecrets(input.inputSummary),
      resultSummary: null,
      status: "POLICY_CHECK",
      createdAt: new Date().toISOString(),
    };

    this.ports.events.append({
      projectId: input.projectId,
      type: "action.policy_checked",
      entityType: "action",
      entityId: action.id,
      actorType: "ENGINE",
      payload: { decision: verdict.decision, reason: verdict.reason, risk: input.risk },
    });

    // 3) Approval gate — fail closed while unresolved.
    if (verdict.decision === "REQUIRE_APPROVAL") {
      const approval: Approval = {
        id: newId("apr"),
        actionId: action.id,
        taskId: null,
        projectId: input.projectId,
        severity: input.approvalSeverity ?? (input.risk === "DANGEROUS" ? "CRITICAL" : "HIGH"),
        reason: verdict.reason,
        requestedActionSummary: action.summary,
        requestingAgentRole: input.runId ?? "system",
        status: "REQUESTED",
        resolvedBy: null,
        requestedAt: new Date().toISOString(),
        resolvedAt: null,
      };
      this.ports.docs.put("approval", approval.id, input.projectId, approval);
      action = { ...action, status: "AWAITING_APPROVAL", approvalId: approval.id, requestedPermission: "ALLOW_ONCE" };
      this.ports.docs.put("action", action.id, input.projectId, action);
      this.pendingExecutors.set(action.id, { executor: input.executor, projectId: input.projectId });
      this.ports.events.append({
        projectId: input.projectId,
        type: "action.approval_requested",
        entityType: "approval",
        entityId: approval.id,
        actorType: "ENGINE",
        payload: { actionId: action.id, reason: verdict.reason },
      });
      return action;
    }

    if (verdict.decision === "DENY") {
      return this.recordDenied(input, verdict.reason, action);
    }

    // 4) Execute with result validation and event recording.
    try {
      action = { ...action, status: "EXECUTING" };
      this.ports.docs.put("action", action.id, input.projectId, action);
      const result = await input.executor.execute(input.inputSummary, { workspaceRoot: input.workspaceRoot });
      action = {
        ...action,
        status: result.ok ? "SUCCEEDED" : "FAILED",
        resultSummary: result.summary,
      };
      this.ports.docs.put("action", action.id, input.projectId, action);
      this.ports.events.append({
        projectId: input.projectId,
        type: result.ok ? "action.executed" : "action.failed",
        entityType: "action",
        entityId: action.id,
        actorType: "AGENT",
        payload: { toolId: input.toolId, operation: input.operation, summary: result.summary },
      });
      return action;
    } catch (err) {
      const message = `[${input.toolId}/${input.operation}] execution failed: ${err instanceof Error ? err.message : String(err)}`;
      action = { ...action, status: "FAILED", resultSummary: message };
      this.ports.docs.put("action", action.id, input.projectId, action);
      this.ports.events.append({
        projectId: input.projectId,
        type: "action.failed",
        entityType: "action",
        entityId: action.id,
        actorType: "AGENT",
        payload: { error: message },
      });
      return action;
    }
  }

  /** Called by ApprovalService after a human allows the pending action. */
  async executeApprovedAction(actionId: string): Promise<GatewayAction> {
    const action = this.ports.docs.require<GatewayAction>("action", actionId);
    if (action.status !== "AWAITING_APPROVAL") {
      throw new Error(`[action-gateway/executeApproved] action '${actionId}' is not awaiting approval (status=${action.status})`);
    }
    const pending = this.pendingExecutors.get(actionId);
    if (!pending) {
      const expired: GatewayAction = { ...action, status: "FAILED", resultSummary: "approval executor lost (daemon restarted) — action expired" };
      this.ports.docs.put("action", expired.id, action.projectId, expired);
      return expired;
    }
    try {
      const result = await pending.executor.execute(action.inputSummary, { workspaceRoot: action.target ?? "." });
      const finished: GatewayAction = {
        ...action,
        status: result.ok ? "SUCCEEDED" : "FAILED",
        resultSummary: result.summary,
      };
      this.ports.docs.put("action", finished.id, finished.projectId, finished);
      this.ports.events.append({
        projectId: finished.projectId,
        type: result.ok ? "action.executed" : "action.failed",
        entityType: "action",
        entityId: finished.id,
        actorType: "AGENT",
        payload: { approvedExecution: true, summary: result.summary },
      });
      return finished;
    } catch (err) {
      const message = `[${action.toolId}/${action.operation}] approved execution failed: ${err instanceof Error ? err.message : String(err)}`;
      const failed: GatewayAction = { ...action, status: "FAILED", resultSummary: message };
      this.ports.docs.put("action", failed.id, failed.projectId, failed);
      this.ports.events.append({
        projectId: failed.projectId,
        type: "action.failed",
        entityType: "action",
        entityId: failed.id,
        actorType: "AGENT",
        payload: { error: message },
      });
      return failed;
    } finally {
      this.pendingExecutors.delete(actionId);
    }
  }

  private recordDenied(input: ExecuteActionInput, reason: string, existing?: GatewayAction): GatewayAction {
    const action: GatewayAction = existing
      ? { ...existing, status: "DENIED", resultSummary: `denied: ${reason}` }
      : {
          id: newId("act"),
          projectId: input.projectId,
          runId: input.runId,
          toolId: input.toolId,
          operation: input.operation,
          risk: input.risk,
          target: input.target ?? null,
          summary: `${input.toolId}:${input.operation}`,
          reversible: input.reversible,
          requestedPermission: "ALLOW",
          policyDecision: "DENY",
          approvalId: null,
          inputSummary: {},
          resultSummary: `denied: ${reason}`,
          status: "DENIED",
          createdAt: new Date().toISOString(),
        };
    this.ports.docs.put("action", action.id, input.projectId, action);
    this.ports.events.append({
      projectId: input.projectId,
      type: "action.denied",
      entityType: "action",
      entityId: action.id,
      actorType: "ENGINE",
      payload: { reason },
    });
    return action;
  }
}

/** Never persist raw secrets into action metadata (spec §29). */
function redactSecrets(summary: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (/secret|token|password|api[_-]?key|credential/i.test(key)) {
      out[key] = "[redacted]";
    } else if (typeof value === "string" && value.length > 2000) {
      out[key] = `${value.slice(0, 2000)}… [truncated]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}
