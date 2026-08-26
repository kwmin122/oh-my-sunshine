import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { AgentActionProposal, AgentRuntimeAdapter, RuntimeCapabilities, RuntimeSessionHandle, RuntimeStartInput } from "@devflow/contracts";

/**
 * CLI Execution Adapter (§33). Runs an installed subscription CLI (Claude Code,
 * Codex, OpenCode) headlessly as a Sunshine worker. Credentials stay owned by
 * the CLI; we pass task context + model hints only.
 *
 * Runtime Execution Contract (normalized):
 *   binary/args ← binding(runtimeId,model,effort) · cwd=workspace · env allowlist
 *   timeout · cancel handle(SIGTERM→SIGKILL) · failure categories below
 */
const execFileAsync = promisify(execFile);
export type CliFailure =
  | "AUTH_EXPIRED" | "RATE_LIMITED" | "QUOTA_EXHAUSTED" | "RUNTIME_NOT_FOUND"
  | "MODEL_UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "PROCESS_CRASH" | "INVALID_OUTPUT" | "TOOL_FAILURE";

export function classifyCliFailure(err: unknown): CliFailure {
  const e = err as { code?: string | number; killed?: boolean; signal?: string; stderr?: string; message?: string };
  const text = `${e?.stderr ?? ""} ${e?.message ?? ""}`.toLowerCase();
  if (text.includes("enoent") || e?.code === "ENOENT") return "RUNTIME_NOT_FOUND";
  if (text.includes("rate limit") || text.includes("429")) return "RATE_LIMITED";
  if (text.includes("quota") || text.includes("usage limit") || text.includes("credit")) return "QUOTA_EXHAUSTED";
  if (text.includes("not logged in") || text.includes("unauthorized") || text.includes("please login")) return "AUTH_EXPIRED";
  if (text.includes("model") && (text.includes("not found") || text.includes("unknown"))) return "MODEL_UNAVAILABLE";
  if (e?.killed || e?.signal === "SIGTERM" || e?.signal === "SIGKILL") return "CANCELLED";
  if (e?.code === 124) return "TIMEOUT";
  return "PROCESS_CRASH";
}

export interface CliAdapterConfig {
  id: string;
  bin: string;
  /** Build argv from the resolved assignment. */
  buildArgs: (opts: { promptFile: string; model?: string | null; effort?: string | null }) => string[];
  envAllowlist?: string[];
  timeoutMs?: number;
}

interface CliSession {
  input: RuntimeStartInput;
  result: string | null;
  failure: CliFailure | null;
  child: ReturnType<typeof spawn> | null;
  cancelled: boolean;
}

export class CliAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id: string;
  private readonly sessions = new Map<string, CliSession>();

  constructor(private readonly cfg: CliAdapterConfig) {
    this.id = cfg.id;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { supportsNativeEvents: false, supportsResume: false, streamingOutput: true };
  }

  async start(input: RuntimeStartInput): Promise<RuntimeSessionHandle> {
    this.sessions.set(input.runId, { input, result: null, failure: null, child: null, cancelled: false });
    return { sessionId: input.runId };
  }

  async nextAction(handle: RuntimeSessionHandle): Promise<{ proposal: AgentActionProposal }> {
    const s = this.sessions.get(handle.sessionId)!;
    if (s.result !== null || s.failure) {
      // Second poll: FINISH with normalized outcome.
      if (s.failure) throw new Error(`[${this.cfg.id}/${s.failure}] ${s.result ?? ""}`);
      return { proposal: { kind: "FINISH", summary: `[${this.cfg.id}] ${s.result!.slice(0, 400)}` } };
    }
    // Single-shot headless execution with the compiled context packet as the brief.
    const modelHint = s.input.modelHint;
    const args = this.cfg.buildArgs({ promptFile: "-", model: modelHint?.model ?? null, effort: modelHint?.effort ?? null });
    const child = spawn(this.cfg.bin, args.filter((a) => a !== "-"), {
      cwd: s.input.workingDirectory,
      env: allowlistEnv(s.input.permissionPreset),
      stdio: ["pipe", "pipe", "pipe"],
    });
    s.child = child;
    child.stdin?.end(s.input.contextPacketMarkdown);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const done = new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    const timer = setTimeout(() => !child.killed && child.kill("SIGTERM"), this.cfg.timeoutMs ?? 600_000);
    await done;
    clearTimeout(timer);
    if (s.cancelled) {
      s.failure = "CANCELLED";
      throw new Error(`[${this.cfg.id}/CANCELLED] run cancelled`);
    }
    if (child.exitCode === 0) {
      s.result = stdout.trim();
    } else {
      s.failure = classifyCliFailure({ code: child.exitCode, stderr });
      throw new Error(`[${this.cfg.id}/${s.failure}] ${stderr.slice(0, 300)}`);
    }
    return { proposal: { kind: "FINISH", summary: `[${this.cfg.id}] ${(stdout || "(empty output)").slice(0, 400)}` } };
  }

  async stop(handle: RuntimeSessionHandle): Promise<void> {
    const s = this.sessions.get(handle.sessionId);
    if (!s) return;
    s.cancelled = true;
    s.child?.kill("SIGTERM"); // grace; hard kill handled by caller escalation
    setTimeout(() => s.child?.kill("SIGKILL"), 5_000);
    this.sessions.delete(handle.sessionId);
  }
}

/** Never forward the whole environment — allowlist only what CLIs legitimately need. */
function allowlistEnv(_preset: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
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
