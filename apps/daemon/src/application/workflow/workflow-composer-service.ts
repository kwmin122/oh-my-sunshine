import type { WorkflowDefinition, WorkflowEdgeDef, WorkflowNodeDef } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * Workflow Composer (V3 §18–19 / sprint S4). "Who works" (Team Composer) and
 * "in what order" (this service) are stored independently and combined freely.
 * A user workflow is the orchestration source of truth for a project when
 * applied: planning generates one task per STEP node, wired by the edges, so
 * execution follows the composed order instead of the heuristic planner.
 */

export interface WorkflowNodeInput {
  key: string;
  name?: string;
  roleId: string;
  objective?: string;
}

export interface WorkflowEdgeInput {
  from: string;
  to: string;
}

export interface ProjectWorkflowBinding {
  id: string;
  projectId: string;
  workflowId: string;
  active: boolean;
  updatedAt: string;
}

export interface WorkflowPorts {
  docs: DocumentRepository;
  events: EventStore;
}

const DELIVERY_DEF_ID = "wf_delivery_v1";

/** Normalizes "be" → "role_be"; passes full ids through. */
export function normalizeRoleId(roleId: string): string {
  return roleId.startsWith("role_") ? roleId : `role_${roleId}`;
}

export class WorkflowComposerService {
  constructor(private readonly ports: WorkflowPorts) {}

  /** Creates a user workflow definition. Throws on structural invalidity — never persists a broken graph. */
  create(name: string, nodes: WorkflowNodeInput[], edges: WorkflowEdgeInput[]): WorkflowDefinition {
    const def = this.build(name, nodes, edges);
    const errors = this.validate(def);
    if (errors.length > 0) throw new Error(`[workflow-composer/create] invalid workflow: ${errors.join("; ")}`);
    this.ports.docs.put("workflow_definition", def.id, null, def);
    this.emit(def.id, { name: def.name, nodes: nodes.length });
    return def;
  }

  list(): WorkflowDefinition[] {
    return this.ports.docs
      .list<WorkflowDefinition>("workflow_definition")
      .filter((d) => d.origin === "user" && !d.archived);
  }

  get(id: string): WorkflowDefinition | null {
    return this.ports.docs.get<WorkflowDefinition>("workflow_definition", id) ?? null;
  }

  update(id: string, name: string, nodes: WorkflowNodeInput[], edges: WorkflowEdgeInput[]): WorkflowDefinition {
    const existing = this.get(id);
    if (!existing) throw new Error(`[workflow-composer/update] unknown workflow '${id}'`);
    const next = this.build(name, nodes, edges);
    const errors = this.validate(next);
    if (errors.length > 0) throw new Error(`[workflow-composer/update] invalid workflow: ${errors.join("; ")}`);
    const updated: WorkflowDefinition = { ...next, id: existing.id as typeof existing.id, version: existing.version + 1 };
    this.ports.docs.put("workflow_definition", updated.id, null, updated);
    return updated;
  }

  archive(id: string): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`[workflow-composer/archive] unknown workflow '${id}'`);
    const archived: WorkflowDefinition = { ...existing, archived: true };
    this.ports.docs.put("workflow_definition", archived.id, null, archived);
    // Deactivate any project bindings pointing at it.
    for (const b of this.ports.docs.list<ProjectWorkflowBinding>("workflow_preset")) {
      if (b.workflowId === id && b.active) {
        this.ports.docs.put("workflow_preset", b.id, b.projectId, { ...b, active: false, updatedAt: new Date().toISOString() });
      }
    }
  }

  /** Structural validation: entry exists, steps have roles, graph is acyclic with a reachable end. */
  validate(def: Pick<WorkflowDefinition, "entryNodeId" | "nodes" | "edges">): string[] {
    const errors: string[] = [];
    if (def.nodes.length === 0) errors.push("no nodes");
    if (!def.nodes.some((n) => n.id === def.entryNodeId)) errors.push("entry node missing");
    for (const n of def.nodes) {
      if (n.type === "STEP" && (!n.roleId || n.roleId.trim() === "" || normalizeRoleId(n.roleId) === "role_")) {
        errors.push(`step '${n.name}' has no role`);
      }
    }
    const ids = new Set(def.nodes.map((n) => n.id));
    for (const e of def.edges) {
      if (!ids.has(e.fromNodeId)) errors.push(`edge from unknown node '${e.fromNodeId}'`);
      if (!ids.has(e.toNodeId)) errors.push(`edge to unknown node '${e.toNodeId}'`);
    }
    // Cycle detection + reachability via DFS from entry.
    const byId = new Map(def.nodes.map((n) => [n.id, n]));
    const visiting = new Set<string>();
    const done = new Set<string>();
    let reachedTerminal = false;
    const visit = (id: string): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) {
        errors.push("dependency cycle detected");
        return;
      }
      visiting.add(id);
      for (const e of def.edges.filter((x) => x.fromNodeId === id)) visit(e.toNodeId);
      visiting.delete(id);
      done.add(id);
      const node = byId.get(id);
      if (node?.type === "TERMINAL") reachedTerminal = true;
    };
    if (def.entryNodeId && ids.has(def.entryNodeId)) visit(def.entryNodeId);
    if (def.nodes.some((n) => n.type === "TERMINAL") && !reachedTerminal) errors.push("terminal not reachable from entry");
    return [...new Set(errors)];
  }

  // ---------- Project binding ----------

  applyToProject(projectId: string, workflowId: string): ProjectWorkflowBinding {
    const def = this.get(workflowId);
    if (!def || def.archived) throw new Error(`[workflow-composer/apply] unknown or archived workflow '${workflowId}'`);
    const errors = this.validate(def);
    if (errors.length > 0) throw new Error(`[workflow-composer/apply] invalid workflow: ${errors.join("; ")}`);
    const binding: ProjectWorkflowBinding = {
      id: `pwf_${projectId}`,
      projectId,
      workflowId,
      active: true,
      updatedAt: new Date().toISOString(),
    };
    this.ports.docs.put("workflow_preset", binding.id, projectId, binding);
    this.ports.events.append({
      projectId: projectId as never,
      type: "workflow.definition_saved" as never,
      entityType: "project",
      entityId: projectId,
      actorType: "USER",
      payload: { workflowId, applied: true },
    });
    return binding;
  }

  clearForProject(projectId: string): void {
    const binding = this.bindingFor(projectId);
    if (binding) this.ports.docs.put("workflow_preset", binding.id, projectId, { ...binding, active: false, updatedAt: new Date().toISOString() });
  }

  bindingFor(projectId: string): ProjectWorkflowBinding | null {
    return this.ports.docs.get<ProjectWorkflowBinding>("workflow_preset", `pwf_${projectId}`);
  }

  activeWorkflowFor(projectId: string): WorkflowDefinition | null {
    const binding = this.bindingFor(projectId);
    if (!binding?.active) return null;
    const def = this.get(binding.workflowId);
    return def && !def.archived ? def : null;
  }

  private build(name: string, nodes: WorkflowNodeInput[], edges: WorkflowEdgeInput[]): WorkflowDefinition {
    const defs: WorkflowNodeDef[] = nodes.map((n, i) => ({
      id: n.key as WorkflowNodeDef["id"],
      type: "STEP",
      name: n.name ?? n.key,
      retryLimit: 2,
      roleId: normalizeRoleId(n.roleId),
      objective: n.objective,
      ...(i === 0 ? {} : {}),
    }));
    const edgeDefs: WorkflowEdgeDef[] = edges.map((e) => ({
      fromNodeId: e.from as WorkflowEdgeDef["fromNodeId"],
      toNodeId: e.to as WorkflowEdgeDef["toNodeId"],
    }));
    // Implicit linear chaining when the user supplied no explicit edges:
    // n1 → n2 → … keeps the composer usable without forcing edge bookkeeping.
    const finalEdges =
      edges.length > 0
        ? edgeDefs
        : defs.slice(1).map((n, i) => ({ fromNodeId: defs[i]!.id, toNodeId: n.id }));
    return {
      id: newId("wf") as WorkflowDefinition["id"],
      name,
      version: 1,
      entryNodeId: (defs[0]?.id ?? "n1") as WorkflowDefinition["entryNodeId"],
      nodes: defs,
      edges: finalEdges,
      origin: "user",
    };
  }

  private emit(entityId: string | null, payload: Record<string, unknown>): void {
    this.ports.events.append({ projectId: "system" as never, type: "workflow.definition_saved" as never, entityType: "workflow_definition", entityId, actorType: "USER", payload });
  }
}

export { DELIVERY_DEF_ID };
