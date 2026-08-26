import type { AgentRun, GitAdapter, HandoffPacket, RuntimeFailureKind, TaskContract } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * Handoff service (V3 §17 / sprint S2). Builds the durable packet a previous
 * runtime leaves behind so the next runtime resumes with facts — never chat
 * memory. Only fields that can actually be observed are populated; unknown
 * stays null instead of being guessed.
 */

const FAILURE_KINDS: RuntimeFailureKind[] = [
  "AUTH_EXPIRED", "RATE_LIMITED", "QUOTA_EXHAUSTED", "MODEL_UNAVAILABLE", "RUNTIME_UNAVAILABLE",
  "TIMEOUT", "CANCELLED", "PROCESS_CRASH", "INVALID_OUTPUT", "TOOL_FAILURE",
  "POLICY_DENIED", "STALE_EDIT", "CONFLICT", "UNKNOWN",
];

/** Extracts the taxonomy kind from a failureReason like `[claude-code/TIMEOUT] …`. */
export function failureKindFromReason(reason: string | null): RuntimeFailureKind | null {
  if (!reason) return null;
  const match = reason.match(/\[[\w.-]+\/([A-Z_]+)\]/);
  if (match && (FAILURE_KINDS as string[]).includes(match[1]!)) return match[1] as RuntimeFailureKind;
  return null;
}

export interface HandoffPorts {
  docs: DocumentRepository;
  events: EventStore;
  git?: Pick<GitAdapter, "changedFiles" | "diffSummary" | "currentRevision">;
}

export class HandoffService {
  constructor(private readonly ports: HandoffPorts) {}

  /**
   * Builds a packet from the most recent FAILED attempt of the task. Returns
   * null when there is nothing to hand off (first attempt or no failed run).
   */
  async buildForRetry(task: TaskContract, nextRuntimeId: string, workspaceRoot: string, handoffReason: string): Promise<HandoffPacket | null> {
    const priorRuns = this.ports.docs
      .list<AgentRun>("agent_run", task.projectId)
      .filter((r) => r.taskId === task.id && r.status === "FAILED")
      .sort((a, b) => b.attempt - a.attempt);
    const prior = priorRuns[0];
    if (!prior) return null;

    const [changedFiles, diffSummary, revision, evidence] = await Promise.all([
      this.ports.git?.changedFiles(workspaceRoot).catch(() => []) ?? [],
      this.ports.git?.diffSummary(workspaceRoot).catch(() => null) ?? null,
      this.ports.git?.currentRevision(workspaceRoot).catch(() => null) ?? null,
      Promise.resolve(
        this.ports.docs.list<{ id: string; taskId: string; status: string }>("evidence", task.projectId)
          .filter((ev) => ev.taskId === task.id)
          .map((ev) => `${ev.id}(${ev.status})`),
      ),
    ]);

    const packet: HandoffPacket = {
      projectId: task.projectId,
      taskId: task.id,
      objective: task.objective,
      acceptanceCriteriaIds: [...task.acceptanceCriteriaIds],
      currentPlan: [...task.plannedSteps],
      completedWorkSummary: prior.summary,
      changedFiles,
      diffSummary,
      lastFailureReason: prior.failureReason,
      lastFailureKind: failureKindFromReason(prior.failureReason),
      evidenceReferences: evidence,
      currentRevision: revision,
      remainingWork: [], // engine cannot observe unfinished agent work — stays honest/empty
      previousRuntimeId: prior.runtimeConfigId.replace(/^runtime_/, ""),
      nextRuntimeId,
      handoffReason,
      createdAt: new Date().toISOString(),
    };
    this.ports.docs.put("handoff_packet", `handoff_${task.id}_${Date.now().toString(36)}`, task.projectId, packet);
    return packet;
  }

  /** Renders the packet into the context-packet markdown section for the next runtime. */
  renderMarkdown(packet: HandoffPacket): string {
    const lines = [
      "# Handoff Packet",
      "",
      `Task objective: ${packet.objective}`,
      packet.acceptanceCriteriaIds.length > 0 ? `Acceptance criteria: ${packet.acceptanceCriteriaIds.join(", ")}` : "",
      packet.currentPlan.length > 0 ? `Plan:\n${packet.currentPlan.map((p) => `- ${p}`).join("\n")}` : "",
      packet.completedWorkSummary ? `Previous runtime summary: ${packet.completedWorkSummary}` : "",
      packet.changedFiles.length > 0 ? `Changed files: ${packet.changedFiles.join(", ")}` : "",
      packet.diffSummary ? `Diff summary:\n${packet.diffSummary.slice(0, 4000)}` : "",
      packet.lastFailureReason ? `Last failure (${packet.lastFailureKind ?? "UNKNOWN"}): ${packet.lastFailureReason}` : "",
      packet.evidenceReferences.length > 0 ? `Evidence references: ${packet.evidenceReferences.join(", ")}` : "",
      packet.currentRevision ? `Current revision: ${packet.currentRevision}` : "",
      `Handing off from ${packet.previousRuntimeId ?? "(none)"} to ${packet.nextRuntimeId}: ${packet.handoffReason}`,
      "",
      "Continue from this durable state. Do not redo completed work.",
    ];
    return lines.filter((l) => l !== "").join("\n");
  }
}
