import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentActionProposal,
  AgentRuntimeAdapter,
  NormalizedRuntimeEvent,
  RuntimeCapabilities,
  RuntimeFailureKind,
  RuntimeSessionHandle,
  RuntimeStartInput,
} from "@devflow/contracts";

/**
 * CLI Execution Adapter (§33 / V3 §12–15). Runs an installed subscription CLI
 * (Claude Code, Codex, OpenCode) headlessly as a Sunshine worker. Credentials
 * stay owned by the CLI; we pass task context + model hints only.
 *
 * Native agent loops are respected (V3 §13): the CLI reasons/edits/verifies on
 * its own; DevFlow collects structured events, tool activity, final output,
 * status and failure taxonomy. Every supported runtime here has a verified
 * machine-readable mode — no unstructured stdout scraping.
 */
const execFileAsync = promisify(execFile);

export type CliAdapterKind = "claude-code" | "codex-cli" | "opencode";

/** V3 §16 taxonomy — shared with contracts.RuntimeFailureKind. */
export type CliFailure = RuntimeFailureKind;

export function classifyCliFailure(err: unknown): CliFailure {
  const e = err as { code?: string | number; killed?: boolean; signal?: string; timedOut?: boolean; stderr?: string; message?: string };
  const text = `${e?.stderr ?? ""} ${e?.message ?? ""}`.toLowerCase();
  if (e?.timedOut) return "TIMEOUT";
  if (text.includes("enoent") || e?.code === "ENOENT") return "RUNTIME_UNAVAILABLE";
  if (text.includes("rate limit") || text.includes("429")) return "RATE_LIMITED";
  if (text.includes("quota") || text.includes("usage limit") || text.includes("credit")) return "QUOTA_EXHAUSTED";
  if (text.includes("not logged in") || text.includes("unauthorized") || text.includes("please login") || text.includes("logged out")) return "AUTH_EXPIRED";
  if (text.includes("model") && (text.includes("not found") || text.includes("unknown"))) return "MODEL_UNAVAILABLE";
  if (e?.killed || e?.signal === "SIGTERM" || e?.signal === "SIGKILL") return "CANCELLED";
  if (e?.code === 124) return "TIMEOUT";
  if (text.includes("permission") && text.includes("denied")) return "POLICY_DENIED";
  return "PROCESS_CRASH";
}

export interface CliAdapterConfig {
  id: string;
  kind: CliAdapterKind;
  bin: string;
  timeoutMs?: number;
  /** Normalized event sink — wired to the EventStore by the registry. */
  onEvent?: (event: NormalizedRuntimeEvent) => void;
}

interface CliSession {
  input: RuntimeStartInput;
  result: string | null;
  failure: CliFailure | null;
  child: ReturnType<typeof spawn> | null;
  cancelled: boolean;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Argv builders — verified against installed versions' --help output:
//   claude 2.1.241 · codex-cli 0.149.1 · opencode 1.18.23
// ---------------------------------------------------------------------------

export interface CliArgOptions {
  model?: string | null;
  effort?: string | null;
  permissionPreset: "READ_ONLY" | "WORKSPACE" | "ELEVATED_ALLOWED";
  /** codex only: reliable last-message capture file (-o flag). */
  lastMessageFile?: string | null;
}

export function buildArgs(kind: CliAdapterKind, o: CliArgOptions): string[] {
  switch (kind) {
    case "claude-code":
      // stream-json requires --verbose under -p (verified live against 2.1.241).
      // effort has no CLI mapping for Claude Code → unsupported, not silently mapped.
      return [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        o.permissionPreset === "READ_ONLY" ? "plan" : "acceptEdits",
        ...(o.model ? ["--model", o.model] : []),
      ];
    case "codex-cli":
      // exec reads the prompt from stdin when piped (verified live against 0.149.1).
      return [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-s",
        o.permissionPreset === "READ_ONLY" ? "read-only" : "workspace-write",
        ...(o.model ? ["-m", o.model] : []),
        ...(o.effort ? ["-c", `model_reasoning_effort=${o.effort.toLowerCase()}`] : []),
        ...(o.lastMessageFile ? ["-o", o.lastMessageFile] : []),
      ];
    case "opencode":
      // run reads the prompt from stdin when piped (verified live against 1.18.23).
      // Model format is provider/model; catalog models carry providerId separately.
      return [
        "run",
        "--format",
        "json",
        ...(o.model ? ["-m", o.model] : []),
        ...(o.effort ? ["--variant", o.effort.toLowerCase()] : []),
        ...(o.permissionPreset === "READ_ONLY" ? [] : ["--auto"]),
      ];
  }
}

// ---------------------------------------------------------------------------
// Structured stream parsers — one per runtime; each yields normalized events.
// ---------------------------------------------------------------------------

type Emitter = (event: Omit<NormalizedRuntimeEvent, "runId" | "taskId" | "at">) => void;

interface ParsedLine {
  finalText?: string;
  failure?: CliFailure;
  sessionId?: string | null;
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Claude Code `--output-format stream-json` (verified live): JSONL with
 * system/init, assistant messages (tool_use/text blocks) and terminal `result`.
 */
export function parseClaudeStreamLine(line: string, emit: Emitter): ParsedLine {
  let out: ParsedLine = {};
  let evt: {
    type?: string;
    subtype?: string;
    session_id?: string;
    result?: string;
    is_error?: boolean;
    message?: { content?: Array<{ type?: string; name?: string; text?: string }> };
  };
  try {
    evt = JSON.parse(line);
  } catch {
    return out; // non-JSON noise is ignored, never guessed into meaning
  }
  if (evt.type === "system" && evt.subtype === "init") {
    emit({ kind: "RUNNING", text: "session initialized", meta: { sessionId: evt.session_id ?? null } });
    out.sessionId = evt.session_id ?? null;
    return out;
  }
  if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_use") {
        const name = block.name ?? "unknown";
        emit({ kind: "ACTION_STARTED", text: name, tool: { name, phase: "started" } });
      } else if (block.type === "text" && block.text) {
        emit({ kind: "OUTPUT", text: block.text.slice(0, 2000) });
      }
    }
    return out;
  }
  if (evt.type === "user" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_result") {
        emit({ kind: "ACTION_COMPLETED", tool: { name: "tool", phase: "completed" } });
      }
    }
    return out;
  }
  if (evt.type === "result") {
    // Terminal transitions are owned by the adapter; the parser only reports facts.
    if (evt.is_error) {
      out.failure = "INVALID_OUTPUT";
      return out;
    }
    out.finalText = textOf(evt.result);
    if (out.finalText) emit({ kind: "OUTPUT", text: out.finalText.slice(0, 2000) });
  }
  return out;
}

/**
 * Codex `exec --json` (verified live): JSONL thread/turn/item events.
 * item.completed carries agent_message text or command activity; turn.failed errors.
 */
export function parseCodexLine(line: string, emit: Emitter): ParsedLine {
  let out: ParsedLine = {};
  let evt: {
    type?: string;
    thread_id?: string;
    item?: { id?: string; type?: string; text?: string; command?: string; aggregated_output?: string };
    error?: { message?: string };
  };
  try {
    evt = JSON.parse(line);
  } catch {
    return out;
  }
  if (evt.type === "thread.started" && evt.thread_id) {
    emit({ kind: "RUNNING", text: "session initialized", meta: { sessionId: evt.thread_id } });
    out.sessionId = evt.thread_id;
    return out;
  }
  if (evt.type === "item.started" && evt.item) {
    if (evt.item.type?.startsWith("command")) {
      emit({
        kind: "ACTION_STARTED",
        text: evt.item.command ?? "",
        tool: { name: "shell", phase: "started", summary: evt.item.command },
      });
    } else if (evt.item.type === "reasoning") {
      // chain-of-thought is never recorded (§45) — presence only.
      emit({ kind: "OUTPUT", text: "reasoning…" });
    }
    return out;
  }
  if (evt.type === "item.completed" && evt.item) {
    if (evt.item.type === "agent_message") {
      const t = textOf(evt.item.text);
      if (t) {
        out.finalText = t;
        emit({ kind: "OUTPUT", text: t.slice(0, 2000) });
      }
    } else if (evt.item.type?.startsWith("command")) {
      emit({
        kind: "ACTION_COMPLETED",
        tool: { name: "shell", phase: "completed", summary: textOf(evt.item.aggregated_output).slice(0, 300) },
      });
    } else {
      emit({ kind: "ACTION_COMPLETED", tool: { name: evt.item.type ?? "tool", phase: "completed" } });
    }
    return out;
  }
  if (evt.type === "turn.failed") {
    out.failure = "UNKNOWN"; // codex reports an error message but no taxonomy — stays honest
    return out;
  }
  return out;
}

/**
 * OpenCode `run --format json` (verified live): step_start / part events
 * (text/tool parts) / step_finish with usage+cost.
 */
export function parseOpencodeLine(line: string, emit: Emitter): ParsedLine {
  let out: ParsedLine = {};
  let evt: {
    sessionID?: string;
    part?: { type?: string; text?: string; tool?: string; state?: { status?: string }; reason?: string };
  };
  try {
    evt = JSON.parse(line);
  } catch {
    return out;
  }
  if (evt.sessionID) {
    out.sessionId = evt.sessionID;
    emit({ kind: "RUNNING", text: "session active", meta: { sessionId: evt.sessionID } });
  }
  if (evt.part?.type === "text" && evt.part.text) {
    out.finalText = evt.part.text;
    emit({ kind: "OUTPUT", text: evt.part.text.slice(0, 2000) });
    return out;
  }
  if (evt.part?.tool) {
    const completed = evt.part.state?.status === "completed";
    emit({
      kind: completed ? "ACTION_COMPLETED" : "ACTION_STARTED",
      tool: { name: evt.part.tool, phase: completed ? "completed" : "started" },
    });
  }
  return out;
}

export interface StreamParseResult {
  finalText: string | null;
  failure: CliFailure | null;
  sessionId: string | null;
}

function makeStreamParser(kind: CliAdapterKind): (line: string, emit: Emitter) => ParsedLine {
  switch (kind) {
    case "claude-code":
      return parseClaudeStreamLine;
    case "codex-cli":
      return parseCodexLine;
    case "opencode":
      return parseOpencodeLine;
  }
}

/** Parses a complete stdout buffer line by line, tracking outcome fields. */
export function parseStream(kind: CliAdapterKind, buffer: string, emit: Emitter): StreamParseResult {
  const parseLine = makeStreamParser(kind);
  const result: StreamParseResult = { finalText: null, failure: null, sessionId: null };
  for (const rawLine of buffer.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseLine(line, emit);
    if (parsed.sessionId !== undefined && parsed.sessionId !== null) result.sessionId = parsed.sessionId;
    if (parsed.finalText) result.finalText = parsed.finalText;
    if (parsed.failure) result.failure = parsed.failure;
  }
  return result;
}

export const parseClaudeStream = (buffer: string, emit: Emitter) => parseStream("claude-code", buffer, emit);
export const parseCodex = (buffer: string, emit: Emitter) => parseStream("codex-cli", buffer, emit);
export const parseOpencode = (buffer: string, emit: Emitter) => parseStream("opencode", buffer, emit);

export class CliAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id: string;
  private readonly sessions = new Map<string, CliSession>();

  constructor(private readonly cfg: CliAdapterConfig) {
    this.id = cfg.id;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { supportsNativeEvents: true, supportsResume: false, streamingOutput: true };
  }

  async start(input: RuntimeStartInput): Promise<RuntimeSessionHandle> {
    this.sessions.set(input.runId, { input, result: null, failure: null, child: null, cancelled: false, timedOut: false });
    this.emit(input.runId, input.taskId, { kind: "STARTING", text: `${this.cfg.id} starting`, meta: { unsupportedSettings: this.cfg.kind === "claude-code" && input.modelHint?.effort ? ["effort"] : [] } });
    return { sessionId: input.runId };
  }

  async nextAction(handle: RuntimeSessionHandle): Promise<{ proposal: AgentActionProposal }> {
    const s = this.sessions.get(handle.sessionId)!;
    if (s.result !== null || s.failure) {
      // Repeat poll after completion: FINISH (or the same failure), never a re-run.
      if (s.failure) throw this.failureError(s.failure, s.result ?? "");
      return { proposal: { kind: "FINISH", summary: `[${this.cfg.id}] ${s.result!.slice(0, 4000)}` } };
    }

    const modelHint = s.input.modelHint;
    const lastMessageFile =
      this.cfg.kind === "codex-cli"
        ? join(mkdtempSync(join(tmpdir(), "devflow-codex-")), "last-message.txt")
        : null;
    const args = buildArgs(this.cfg.kind, {
      model: modelHint?.model ?? null,
      effort: modelHint?.effort ?? null,
      permissionPreset: s.input.permissionPreset,
      lastMessageFile,
    });

    const child = spawn(this.cfg.bin, args, {
      cwd: s.input.workingDirectory,
      env: this.childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so cancellation can kill CLI-spawned grandchildren too
      // (e.g. a bash script's `sleep`) — plain child.kill() leaks those orphans.
      detached: process.platform !== "win32",
    });
    if (process.env.DEVFLOW_DEBUG_CLI === "1") {
      console.log(`[dbg-cli] ${this.cfg.bin} ${args.join(" ")} preset=${s.input.permissionPreset} cwd=${s.input.workingDirectory}`);
    }
    s.child = child;
    child.stdin?.end(s.input.contextPacketMarkdown);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));

    const closed = new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });

    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        s.timedOut = true;
        killTree(child);
        setTimeout(() => killTree(child, "SIGKILL"), 5_000);
      }
    }, this.cfg.timeoutMs ?? 600_000);

    await closed;
    clearTimeout(timer);

    if (s.cancelled) {
      s.failure = "CANCELLED";
      this.emit(s.input.runId, s.input.taskId, { kind: "CANCELLED", text: "cancelled by user" });
      throw this.failureError("CANCELLED", "");
    }
    if (s.timedOut) {
      s.failure = "TIMEOUT";
      this.emit(s.input.runId, s.input.taskId, {
        kind: "FAILED",
        text: "timeout exceeded — process terminated",
        meta: { failure: "TIMEOUT" },
      });
      throw this.failureError("TIMEOUT", stderr.slice(0, 300));
    }

    // Authoritative structured parse over the full stream; emits remaining events.
    const outcome = parseStream(this.cfg.kind, stdout, this.emitPartial(s.input));

    if (child.exitCode !== 0) {
      s.failure = classifyCliFailure({ code: child.exitCode, signal: child.signalCode ?? undefined, stderr });
      this.emit(s.input.runId, s.input.taskId, {
        kind: "FAILED",
        text: `${s.failure}: ${stderr.slice(0, 300)}`,
        meta: { failure: s.failure },
      });
      throw this.failureError(s.failure, stderr);
    }
    if (outcome.failure) {
      s.failure = outcome.failure;
      throw this.failureError(outcome.failure, stderr);
    }

    let finalText = outcome.finalText;
    if (this.cfg.kind === "codex-cli" && lastMessageFile) {
      // -o capture is the reliable last-agent-message source for codex.
      const fromFile = readTextFile(lastMessageFile);
      if (fromFile) finalText = fromFile;
    }
    s.result = finalText ?? "(no structured output captured)";
    this.emit(s.input.runId, s.input.taskId, { kind: "FINISHED", text: s.result.slice(0, 2000) });
    return { proposal: { kind: "FINISH", summary: `[${this.cfg.id}] ${s.result.slice(0, 4000)}` } };
  }

  async stop(handle: RuntimeSessionHandle): Promise<void> {
    const s = this.sessions.get(handle.sessionId);
    if (!s) return;
    s.cancelled = true;
    const child = s.child;
    if (child && child.exitCode === null) {
      killTree(child, "SIGTERM"); // grace; escalation below guarantees no orphan group
      setTimeout(() => killTree(child, "SIGKILL"), 5_000);
    }
    this.sessions.delete(handle.sessionId);
  }

  private failureError(failure: CliFailure, detail: string): Error & { providerFatal?: boolean } {
    // Cancelled/auth/runtime-missing failures must not be retried with backoff.
    const fatal = failure === "CANCELLED" || failure === "AUTH_EXPIRED" || failure === "RUNTIME_UNAVAILABLE";
    const err = new Error(`[${this.cfg.id}/${failure}] ${detail}`) as Error & { providerFatal?: boolean };
    err.providerFatal = fatal;
    return err;
  }

  /** Allowlist env (§51): never forward the host environment wholesale. */
  private childEnv(): NodeJS.ProcessEnv {
    const keep = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR"];
    const env: NodeJS.ProcessEnv = {};
    for (const k of keep) if (process.env[k]) env[k] = process.env[k];
    return env;
  }

  private emitPartial(input: RuntimeStartInput): Emitter {
    return (partial) => this.emit(input.runId, input.taskId, partial);
  }

  private emit(runId: string, taskId: string, partial: Omit<NormalizedRuntimeEvent, "runId" | "taskId" | "at">): void {
    this.cfg.onEvent?.({ runId, taskId, at: new Date().toISOString(), ...partial });
  }
}

function readTextFile(file: string): string | null {
  try {
    const txt = readFileSync(file, "utf8").trim();
    return txt.length > 0 ? txt : null;
  } catch {
    return null;
  }
}

/** Kills the child and (on POSIX) its whole process group — no orphaned grandchildren. */
function killTree(child: NonNullable<CliSession["child"]>, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // group already gone — fall through to direct kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
}

/** Probe whether the binary exists (used by registry wiring after discovery). */
export async function cliExists(bin: string): Promise<boolean> {
  try {
    await execFileAsync("which", [bin]);
    return true;
  } catch {
    return false;
  }
}
