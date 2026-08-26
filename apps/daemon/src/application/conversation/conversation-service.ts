import type { ConversationIntent, ConversationMessage, TaskContract } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { ModelProvider } from "@devflow/contracts";

/**
 * Continuous Engineering Lead conversation (V4 §7–9 / S10). Chat is not raw
 * state: every user message is deterministically classified and, when it
 * affects the project, converted into structured commands/events. The loop:
 *
 *   user message → classify → impact → structured effect → agent sees it.
 */

export interface ConversationPorts {
  docs: DocumentRepository;
  events: EventStore;
  /** Optional LLM tier for Lead replies; falls back to a deterministic answer. */
  provider?: ModelProvider;
  /** V4 §8: RUNTIME_CHANGE messages apply the task override directly. */
  composer?: {
    setTaskOverride(projectId: string, override: { taskId: string; roleId: string | null; runtimeId: string; reason?: string | null; updatedAt: string }): unknown;
    catalog(): Array<{ id: string; label: string }>;
  };
}

/** ASCII alternatives can use \b; CJK has no word boundaries in JS regex —
 * those alternatives must be plain substrings or they never match. */
const INTENT_RULES: Array<{ intent: ConversationIntent; patterns: RegExp[] }> = [
  { intent: "CANCEL", patterns: [/\b(cancel|중단|취소)/i] },
  { intent: "PAUSE", patterns: [/\bpause\b/i, /일시정지|멈춰/], },
  { intent: "RESUME", patterns: [/\b(resume|continue)\b/i, /계속(해|해줘)?|재개/], },
  {
    intent: "REQUIREMENT_CHANGE",
    patterns: [/\b(requirement change|remove .*feature|instead of)\b/i, /요구사항 ?(을|를)? ?(변경|바꾸)|없애자|없애|빼자|대신 .*(하게|하기로)|(회원가입|signup|feature) ?자체를?/],
  },
  { intent: "SCOPE_CHANGE", patterns: [/scope change|범위 변경|전체적으로|아예 새로/] },
  { intent: "NEW_REQUIREMENT", patterns: [/\balso add\b|\bnew requirement\b/i, /추가로 필요|새로운 요구|추가 요건/] },
  {
    intent: "RUNTIME_CHANGE",
    patterns: [/\b(use|switch to|change runtime)\b/i, /런타임 ?(변경|바꿔)|codex로|claude로|opencode로/],
  },
  {
    intent: "TASK_REFINEMENT",
    patterns: [/\brefactor this\b|\bthat button\b/i, /방식 바꿔|여기(를|서)? ?(바꿔|수정)|다시 만들어|버튼.*별로|별로야.*바꿔/],
  },
  { intent: "TASK_INSTRUCTION", patterns: [/\b(please |fix |add |implement )\b/i, /만들어|고쳐|구현해|적용해/], },
  { intent: "DECISION", patterns: [/\bdecide\b/i, /결정할게|내 결정은/] },
  { intent: "APPROVAL", patterns: [/\bapprove\b/i, /승인합니다|허가/] },
];

/** Deterministic heuristic tier — honest about being keyword-based (V4 §8).
 * The optional LLM tier in classifyWithProvider refines ambiguous cases. */
export function classifyMessage(text: string): ConversationIntent {
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.intent;
  }
  if (/[?？]\s*$/.test(text.trim()) || /^(what|why|how|언제|왜|어떻게|뭐)/i.test(text.trim())) return "QUESTION";
  return "GENERAL_CHAT";
}

export class ConversationService {
  constructor(private readonly ports: ConversationPorts) {}

  history(projectId: string, afterSequence = 0): ConversationMessage[] {
    void afterSequence;
    return this.ports.docs
      .list<ConversationMessage>("conversation_message", projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Handles one user message end-to-end: persist → classify → structured
   * effects → Lead reply. Effects are returned for the UI projection.
   */
  async handleUserMessage(projectId: string, text: string): Promise<{ message: ConversationMessage; reply: ConversationMessage }> {
    const classification = classifyMessage(text);
    const message: ConversationMessage = {
      id: newId("msg"),
      projectId,
      role: "USER",
      text,
      classifiedAs: classification,
      effects: [],
      createdAt: new Date().toISOString(),
    };
    this.ports.docs.put("conversation_message", message.id, projectId, message);

    const effects = await this.applyStructuredEffects(projectId, message);
    message.effects = effects;
    this.ports.docs.put("conversation_message", message.id, projectId, message);

    const replyText = await this.leadReply(projectId, text, classification, effects);
    const reply: ConversationMessage = {
      id: newId("msg"),
      projectId,
      role: "LEAD",
      text: replyText,
      classifiedAs: null,
      effects: [],
      createdAt: new Date().toISOString(),
    };
    this.ports.docs.put("conversation_message", reply.id, projectId, reply);
    return { message, reply };
  }

  /** Converts state-affecting messages into structured project changes. */
  private async applyStructuredEffects(projectId: string, message: ConversationMessage): Promise<string[]> {
    const effects: string[] = [];
    switch (message.classifiedAs) {
      case "TASK_REFINEMENT":
      case "TASK_INSTRUCTION": {
        // Attach to the most recent actionable task so the NEXT run's compiled
        // context includes the operator note (LATEST OPERATOR NOTES section).
        const task = this.latestActionableTask(projectId);
        if (task) {
          const updated: TaskContract = {
            ...task,
            handoffNotes: `${task.handoffNotes ? `${task.handoffNotes}\n` : ""}[operator ${message.createdAt}] ${message.text}`,
            updatedAt: new Date().toISOString(),
          };
          this.ports.docs.put("task", updated.id, updated.projectId, updated);
          this.emit(projectId, "task.instruction_appended", updated.id, { taskId: updated.id, stableKey: updated.stableKey });
          effects.push(`appended to ${updated.stableKey} operator notes`);
        } else {
          effects.push("no active task — instruction recorded on conversation only");
        }
        break;
      }
      case "REQUIREMENT_CHANGE":
      case "SCOPE_CHANGE": {
        // Impact loop (V4 §9): flag affected tasks for replan + stale their
        // evidence + surface a human decision before work continues.
        const tasks = this.ports.docs.list<TaskContract>("task", projectId).filter((t) => !["DONE"].includes(t.status));
        const now = new Date().toISOString();
        for (const t of tasks) {
          if (!t.blockers.includes("requirement change — replan required")) {
            this.ports.docs.put("task", t.id, t.projectId, {
              ...t,
              status: "BLOCKED",
              blockers: [...t.blockers, "requirement change — replan required"],
              updatedAt: now,
            });
          }
        }
        this.ports.docs.list<{ id: string; status: string; taskId: string }>("evidence", projectId)
          .filter((ev) => ev.status === "PASS_FRESH")
          .forEach((ev) => {
            this.ports.docs.put("evidence", ev.id, projectId, { ...ev, status: "PASS_STALE" });
          });
        this.emit(projectId, "requirement.change_detected", null, { messageId: message.id, affectedTasks: tasks.length, text: message.text.slice(0, 300) });
        effects.push(`${tasks.length} task(s) flagged for replan; fresh evidence marked stale`);
        break;
      }
      case "RUNTIME_CHANGE": {
        // Structured runtime switch (V3 §43): "codex로 바꿔줘" pins the active
        // task's next run to that runtime via the standard override mechanism.
        const match = message.text.match(/(claude|codex|opencode)/i);
        const target = match?.[1]?.toLowerCase() === "claude" ? "claude-code" : match?.[1]?.toLowerCase();
        if (target && this.ports.composer) {
          const known = this.ports.composer.catalog().find((c) => c.id.includes(target));
          const task = this.latestActionableTask(projectId);
          if (known && task) {
            this.ports.composer.setTaskOverride(projectId, {
              taskId: task.id, roleId: null, runtimeId: known.id,
              reason: `operator runtime switch: ${message.text.slice(0, 120)}`, updatedAt: new Date().toISOString(),
            });
            this.emit(projectId, "runtime.selected", task.id, { source: "conversation", runtimeId: known.id });
            effects.push(`next run of ${task.stableKey} pinned to ${known.label}`);
          } else if (!task) {
            effects.push("no active task to re-pin — recorded");
          } else {
            effects.push(`runtime '${target}' unknown in catalog — nothing changed`);
          }
        }
        break;
      }
      default:
        break; // QUESTION / GENERAL_CHAT / etc. carry no state mutation
    }
    return effects;
  }

  private latestActionableTask(projectId: string): TaskContract | null {
    const candidates = this.ports.docs
      .list<TaskContract>("task", projectId)
      .filter((t) => ["READY", "RUNNING", "BLOCKED", "VERIFYING"].includes(t.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return candidates[0] ?? null;
  }

  private async leadReply(projectId: string, text: string, intent: ConversationIntent, effects: string[]): Promise<string> {
    if (this.ports.provider?.id !== "mock") {
      try {
        const res = await this.ports.provider!.generate({
          purpose: "lead_reply",
          system: "You are the Engineering Lead of an AI development team. Answer the operator briefly with concrete project state.",
          messages: [{ role: "user", content: text }],
          responseSchemaHint: '{"summary":"..."}',
          maxTokens: 400,
        });
        const parsed = (() => {
          try {
            return (JSON.parse(res.raw) as { summary?: string }).summary;
          } catch {
            return undefined;
          }
        })();
        if (parsed) return parsed;
      } catch {
        // fall through to deterministic reply
      }
    }
    const effectNote = effects.length > 0 ? ` Applied: ${effects.join("; ")}.` : "";
    return `[Lead/${intent}] Noted: "${text.slice(0, 120)}".${effectNote}`;
  }

  private emit(projectId: string, type: string, entityId: string | null, payload: Record<string, unknown>): void {
    this.ports.events.append({ projectId: projectId as never, type: type as never, entityType: "conversation", entityId, actorType: "USER", payload });
  }
}
