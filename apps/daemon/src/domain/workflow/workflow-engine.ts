import type {
  RiskTier,
  TaskContract,
  WorkflowDefinition,
  WorkflowEdgeDef,
  WorkflowInstance,
  WorkflowInstanceId,
  WorkflowNodeDef,
  WorkflowNodeId,
} from "@devflow/contracts";
import {
  isWorkflowTransitionLegal,
  newId,
} from "@devflow/contracts";

/** Ports the engine needs. Everything is injected so tests can drive it deterministically. */
export interface WorkflowEnginePorts {
  loadDefinition(id: string): WorkflowDefinition | undefined;
  saveInstance(instance: WorkflowInstance): void;
  getInstance(id: WorkflowInstanceId): WorkflowInstance | undefined;
  appendEvent(projectId: string, type: string, payload: Record<string, unknown>, entityId?: string): void;
}

export interface StepExecutorInput {
  node: WorkflowNodeDef;
  instance: WorkflowInstance;
  context: WorkflowNodeContext;
}

export interface WorkflowNodeContext {
  projectId: string;
  goalId: string | null;
  riskTier: RiskTier;
  task: TaskContract | null;
}

export interface GatePredicateResult {
  passed: boolean;
  reason: string;
  missing: string[];
}

export type GatePredicate = (ctx: WorkflowNodeContext) => GatePredicateResult;

export interface StepOutcome {
  done: boolean;
  detail?: string;
}

/**
 * Deterministic workflow engine.
 * Invariant (spec §44): AI may recommend transitions, but this engine decides whether
 * they are legal. Node outputs that violate schema/state never corrupt the instance.
 */
export class WorkflowEngine {
  private readonly gates = new Map<string, GatePredicate>();
  private readonly stepExecutors = new Map<string, (input: StepExecutorInput) => Promise<StepOutcome>>();

  constructor(private readonly ports: WorkflowEnginePorts) {}

  registerGate(name: string, predicate: GatePredicate): void {
    this.gates.set(name, predicate);
  }

  registerStepExecutor(nodeName: string, executor: (input: StepExecutorInput) => Promise<StepOutcome>): void {
    this.stepExecutors.set(nodeName, executor);
  }

  start(definitionId: string, ctx: Omit<WorkflowNodeContext, "task"> & { task: TaskContract | null }): WorkflowInstance {
    const def = this.ports.loadDefinition(definitionId);
    if (!def) throw new Error(`[workflow-engine/start] unknown workflow definition '${definitionId}'`);
    if (def.nodes.length === 0 || !def.nodes.some((n) => n.id === def.entryNodeId)) {
      throw new Error(`[workflow-engine/start] definition '${definitionId}' has invalid entry node`);
    }
    const now = new Date().toISOString();
    const instance: WorkflowInstance = {
      id: newId("wfinst"),
      projectId: ctx.projectId,
      goalId: ctx.goalId,
      definitionId,
      currentNodeId: def.entryNodeId,
      completedNodeIds: [],
      status: "RUNNING",
      splitSelected: null,
      lastError: null,
      startedAt: now,
      completedAt: null,
    };
    this.ports.saveInstance(instance);
    this.ports.appendEvent(ctx.projectId, "workflow.created", { definitionId }, instance.id);
    return instance;
  }

  /** Continues execution until the instance blocks/waits/completes. Safe to call repeatedly. */
  async advance(instanceId: WorkflowInstanceId, ctx: WorkflowNodeContext): Promise<WorkflowInstance> {
    const loaded = this.ports.getInstance(instanceId);
    if (!loaded) throw new Error(`[workflow-engine/advance] unknown instance '${instanceId}'`);
    let instance = loaded;

    for (let guard = 0; guard < 1000; guard++) {
      const def = this.requireDefinition(instance.definitionId);
      const node = instance.currentNodeId ? def.nodes.find((n) => n.id === instance.currentNodeId) : undefined;
      if (!node) {
        // No current node but not marked complete — repair deterministically instead of drifting.
        instance = this.withStatus(instance, "FAILED", `no current node in status ${instance.status}`);
        break;
      }

      switch (node.type) {
        case "STEP": {
          this.ports.appendEvent(instance.projectId, "workflow.node_entered", { nodeId: node.id, name: node.name });
          const executor = this.stepExecutors.get(node.name);
          if (!executor) {
            instance = this.withStatus(instance, "FAILED", `no executor registered for step '${node.name}'`);
          } else {
            try {
              const outcome = await executor({ node, instance, context: ctx });
              if (outcome.done) {
                instance = this.completeNode(instance, node);
              } else {
                instance = this.withStatus(instance, "WAITING", outcome.detail ?? "step pending");
              }
            } catch (err) {
              instance = this.withStatus(
                instance,
                "FAILED",
                `step '${node.name}' failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          break;
        }
        case "GATE": {
          const predicateName = node.gatePredicate ?? "";
          const predicate = this.gates.get(predicateName);
          if (!predicate) {
            instance = this.withStatus(instance, "FAILED", `no predicate registered for gate '${node.name}'`);
            break;
          }
          const result = predicate(ctx);
          if (result.passed) {
            instance = this.completeNode(instance, node);
          } else {
            this.ports.appendEvent(instance.projectId, "workflow.node_entered", {
              nodeId: node.id,
              name: node.name,
              blocked: true,
              missing: result.missing,
            });
            instance = this.withStatus(instance, "BLOCKED", result.reason);
          }
          break;
        }
        case "SPLITTER": {
          const selected = ctx.riskTier;
          instance.splitSelected = selected;
          this.ports.appendEvent(instance.projectId, "workflow.split_selected", { value: selected, nodeId: node.id });
          instance.completedNodeIds.push(node.id);
          const edge = this.selectEdge(def.edges, node.id, (cond) =>
            cond?.kind === "RISK_TIER_EQUALS" && cond.value === selected ? true : false,
          );
          const fallbackEdge = this.selectEdge(def.edges, node.id, (cond) => cond?.kind === "DEFAULT");
          const chosen = edge ?? fallbackEdge;
          if (!chosen) {
            instance = this.withStatus(instance, "FAILED", `splitter '${node.id}' has no branch for ${selected}`);
          } else {
            instance.currentNodeId = chosen.toNodeId;
            instance.status = "RUNNING";
          }
          break;
        }
        case "DELEGATE": {
          this.ports.appendEvent(instance.projectId, "workflow.delegated", { nodeId: node.id, child: node.childWorkflowId });
          // Delegate semantics: mark this node complete and continue in the same graph at its successor.
          // Child workflows run through their own instances when registered; V1 delivery flow keeps one graph.
          instance.completedNodeIds.push(node.id);
          const next = def.edges.find((e) => e.fromNodeId === node.id && e.condition === undefined);
          if (!next) {
            instance = this.withStatus(instance, "FAILED", `delegate '${node.id}' has no outgoing edge`);
          } else {
            instance.currentNodeId = next.toNodeId;
            instance.status = "RUNNING";
          }
          break;
        }
        case "TERMINAL": {
          this.ports.appendEvent(instance.projectId, "workflow.node_completed", { nodeId: node.id, name: node.name });
          instance.completedNodeIds.push(node.id);
          instance.currentNodeId = null;
          instance.completedAt = new Date().toISOString();
          instance.status = "COMPLETED";
          break;
        }
      }

      this.ports.saveInstance(instance);
      if (instance.status !== "RUNNING") break;
    }
    return instance;
  }

  /** Resume after external unblock (approval granted, decision answered, evidence rerun). */
  async resume(instanceId: WorkflowInstanceId, ctx: WorkflowNodeContext): Promise<WorkflowInstance> {
    const instance = this.ports.getInstance(instanceId);
    if (!instance) throw new Error(`[workflow-engine/resume] unknown instance '${instanceId}'`);
    if (!isWorkflowTransitionLegal(instance.status, "RUNNING")) {
      throw new Error(`[workflow-engine/resume] illegal transition ${instance.status} -> RUNNING`);
    }
    const revived: WorkflowInstance = { ...instance, status: "RUNNING", lastError: null };
    this.ports.saveInstance(revived);
    this.ports.appendEvent(revived.projectId, "workflow.resumed", {}, revived.id);
    return this.advance(instanceId, ctx);
  }

  private requireDefinition(id: string): WorkflowDefinition {
    const def = this.ports.loadDefinition(id);
    if (!def) throw new Error(`[workflow-engine] definition '${id}' disappeared`);
    return def;
  }

  private selectEdge(
    edges: WorkflowEdgeDef[],
    from: WorkflowNodeId,
    match: (condition: WorkflowEdgeDef["condition"]) => boolean,
  ): WorkflowEdgeDef | undefined {
    return edges.find((e) => e.fromNodeId === from && e.condition !== undefined && match(e.condition));
  }

  private completeNode(instance: WorkflowInstance, node: WorkflowNodeDef): WorkflowInstance {
    const def = this.requireDefinition(instance.definitionId);
    this.ports.appendEvent(instance.projectId, "workflow.node_completed", { nodeId: node.id, name: node.name });
    const next: WorkflowInstance = {
      ...instance,
      completedNodeIds: [...instance.completedNodeIds, node.id],
      status: "RUNNING",
    };
    const outEdges = def.edges.filter((e) => e.fromNodeId === node.id && e.condition === undefined);
    if (outEdges.length === 0) {
      next.currentNodeId = null;
      next.status = "COMPLETED";
      next.completedAt = new Date().toISOString();
    } else {
      next.currentNodeId = outEdges[0]!.toNodeId;
    }
    return next;
  }

  private withStatus(instance: WorkflowInstance, status: WorkflowInstance["status"], error?: string): WorkflowInstance {
    const legal = isWorkflowTransitionLegal(instance.status, status);
    if (!legal) {
      // Terminal-ish states (WAITING/BLOCKED) re-entering themselves is tolerated as idempotent;
      // genuinely illegal moves become FAILED with explanation rather than silent drift.
      if (!(instance.status === status)) {
        return { ...instance, status: "FAILED", lastError: `illegal transition ${instance.status}->${status}` };
      }
    }
    return { ...instance, status, lastError: error ?? null };
  }
}
