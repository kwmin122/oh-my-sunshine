import type { Decision, Requirement, TaskContract } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * Decision Inbox service (spec §5.5, §21). A decision blocks a task; answering it
 * records the answer as a requirement, updates the task, and unblocks it.
 */
export class DecisionService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  createDecision(params: {
    projectId: string;
    taskId: string | null;
    kind: Decision["kind"];
    question: string;
    context: string;
    severity: Decision["severity"];
    options: Array<{ key: string; label: string; consequence: string }>;
    recommendation: string | null;
    impactedEntities: string[];
  }): Decision {
    const existing = this.docs.list<Decision>("decision", params.projectId);
    const decision: Decision = {
      id: newId("dec"),
      projectId: params.projectId,
      taskId: params.taskId,
      stableKey: nextKey(existing.map((d) => d.stableKey)),
      kind: params.kind,
      question: params.question,
      context: params.context,
      severity: params.severity,
      options: params.options,
      recommendation: params.recommendation,
      status: "OPEN",
      answer: null,
      resolvedBy: null,
      impactedEntities: params.impactedEntities,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.docs.put("decision", decision.id, params.projectId, decision);
    return decision;
  }

  resolve(decisionId: string, chosenOption: string, note?: string): { decision: Decision; requirement: Requirement; task: TaskContract | null } {
    const decision = this.docs.require<Decision>("decision", decisionId);
    if (decision.status !== "OPEN") {
      throw new Error(`[decision-service/resolve] decision '${decisionId}' is not OPEN (${decision.status})`);
    }
    const now = new Date().toISOString();
    const resolved: Decision = {
      ...decision,
      status: "ANSWERED",
      answer: `${chosenOption}${note ? ` — ${note}` : ""}`,
      resolvedBy: "USER",
      resolvedAt: now,
    };
    this.docs.put("decision", decision.id, decision.projectId, resolved);

    // Answer becomes canonical requirement truth (spec §4 Step 4).
    const requirements = this.docs.list<Requirement>("requirement", decision.projectId);
    const requirement: Requirement = {
      id: newId("req"),
      projectId: decision.projectId,
      goalId: null,
      stableKey: nextReqKey(requirements.map((r) => r.stableKey)),
      category: categoryFromKind(decision.kind),
      statement: `${decision.question} → ${resolved.answer}`,
      rationale: `Resolved via Decision ${decision.stableKey}`,
      priority: "MUST",
      status: "APPROVED",
      confidence: 1.0,
      source: "USER",
      assumptions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.docs.put("requirement", requirement.id, decision.projectId, requirement);

    let task: TaskContract | null = null;
    if (decision.taskId) {
      task = this.docs.get<TaskContract>("task", decision.taskId);
      if (task) {
        const updated: TaskContract = { ...task, status: "QUEUED", blockers: [], updatedAt: now };
        this.docs.put("task", task.id, task.projectId, updated);
        task = updated;
      }
    }

    this.events.append({
      projectId: decision.projectId,
      type: "conflict.resolved",
      entityType: "decision",
      entityId: decision.id,
      actorType: "USER",
      payload: { answer: resolved.answer },
    });
    this.events.append({
      projectId: decision.projectId,
      type: "requirement.discovered",
      entityType: "requirement",
      entityId: requirement.id,
      actorType: "ENGINE",
      payload: { fromDecision: decision.stableKey },
    });
    return { decision: resolved, requirement, task };
  }

  listOpen(projectId: string): Decision[] {
    return this.docs.list<Decision>("decision", projectId).filter((d) => d.status === "OPEN");
  }
}

function nextKey(existing: string[]): string {
  let max = 0;
  for (const key of existing) {
    const m = /^DEC-(\d+)$/.exec(key);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return `DEC-${String(max + 1).padStart(3, "0")}`;
}

function nextReqKey(existing: string[]): string {
  let max = 0;
  for (const key of existing) {
    const m = /^REQ-(\d+)$/.exec(key);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return `REQ-${String(max + 1).padStart(3, "0")}`;
}

function categoryFromKind(kind: Decision["kind"]): Requirement["category"] {
  switch (kind) {
    case "IMPLEMENTATION_AMBIGUITY":
      return "functional_behavior";
    case "CONFLICT_RESOLUTION":
      return "constraints";
    case "REVIEW_ESCALATION":
      return "acceptance_criteria";
    default:
      return "functional_behavior";
  }
}
