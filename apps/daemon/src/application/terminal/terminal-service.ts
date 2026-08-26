import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TerminalSession, TerminalSessionType } from "@devflow/contracts";
import { isTerminalTransitionLegal } from "@devflow/contracts";

/** Optional full-TTY layer (V4 §5): node-pty when it loads AND can fork;
 * graceful piped-shell fallback otherwise. Detected lazily, never assumed. */
interface PtyLike {
  write(data: string): void;
  kill(): void;
  resize(cols: number, rows: number): void;
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number, signal?: number) => void): void;
}
type PtyModule = {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyLike;
};
let ptyModuleCache: PtyModule | null | undefined;
function loadPty(): PtyModule | null {
  if (ptyModuleCache !== undefined) return ptyModuleCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("node-pty") as PtyModule;
    // Probe: a module that loads but cannot fork must not poison USER terminals.
    const probe = mod.spawn("/bin/bash", [], { name: "xterm", cols: 20, rows: 5, cwd: "/tmp", env: {} });
    probe.onData(() => undefined);
    probe.kill();
    ptyModuleCache = mod;
  } catch {
    ptyModuleCache = null;
  }
  return ptyModuleCache;
}

/**
 * Integrated terminal backend (V4 §5–6 / S10). Each session is a REAL shell
 * process owned by the daemon. Output is streamed to the UI over the daemon's
 * existing WebSocket; a per-session ring buffer serves late subscribers.
 *
 * Security posture (V4 §6) — honest distinction:
 * - USER terminals are the human's own interactive shell in the project
 *   workspace. They are NOT routed through the Action Gateway (a gateway that
 *   approved `pnpm test` cannot gate an interactive session); every lifecycle
 *   event is audit-logged with actorType USER instead.
 * - AGENT/TEST/BUILD terminals are captured execution contexts whose commands
 *   still flow through the Action Gateway when initiated by agents.
 * A gateway-free interactive shell is a documented product decision, not a
 * bypass: it is the user operating their own machine.
 */

export interface TerminalOutputChunk {
  sessionId: string;
  seq: number;
  data: string;
  stream: "stdout" | "stderr";
  at: string;
}

const RING_BUFFER_LIMIT = 2000;

interface ManagedTerminal {
  session: TerminalSession;
  child: ChildProcess | null;
  pty: PtyLike | null;
  ring: TerminalOutputChunk[];
  seq: number;
  cols: number;
  rows: number;
}

export class TerminalService {
  private readonly terminals = new Map<string, ManagedTerminal>();

  constructor(
    private readonly audit: (event: {
      projectId: string;
      type: string;
      entityType: string;
      entityId: string;
      actorType: "USER" | "ENGINE";
      payload: Record<string, unknown>;
    }) => void,
    private readonly broadcast: (message: Record<string, unknown>) => void,
  ) {}

  list(projectId?: string): TerminalSession[] {
    return [...this.terminals.values()]
      .map((t) => t.session)
      .filter((s) => !projectId || s.projectId === projectId);
  }

  get(id: string): TerminalSession | null {
    return this.terminals.get(id)?.session ?? null;
  }

  /** Spawns a real shell process. cwd is the validated project workspace. */
  create(projectId: string, type: TerminalSessionType, cwd: string): TerminalSession {
    const now = new Date().toISOString();
    const id = `term_${randomUUID().slice(0, 12)}`;
    const shell = process.env.SHELL || "/bin/bash";
    const session: TerminalSession = {
      id,
      projectId,
      type,
      cwd,
      shell,
      pid: null,
      status: "CREATED",
      startedAt: now,
      endedAt: null,
      exitCode: null,
    };
    this.terminals.set(id, { session, child: null, pty: null, ring: [], seq: 0, cols: 80, rows: 24 });
    this.transition(id, "STARTING");

    // Full-TTY path for USER terminals when node-pty can actually fork here;
    // piped shell otherwise (interactive features honestly degraded).
    const pty = type === "USER" ? loadPty() : null;
    if (pty) {
      const term = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: Object.fromEntries(Object.entries(allowlistEnv()).filter(([, v]) => v !== undefined) as Array<[string, string]>),
      });
      const managed0 = this.terminals.get(id)!;
      managed0.pty = term;
      managed0.session.pid = term.pid;
      this.transition(id, "RUNNING");
      term.onData((d) => this.pushOutput(id, d, "stdout"));
      term.onExit((code, signal) => {
        const m = this.terminals.get(id);
        if (!m) return;
        m.session.exitCode = code;
        m.session.endedAt = new Date().toISOString();
        if (["RUNNING", "WAITING"].includes(m.session.status)) {
          this.transition(id, signal ? "CANCELLED" : code === 0 ? "EXITED" : "FAILED");
        }
      });
      this.audit({
        projectId,
        type: "terminal.session_created",
        entityType: "terminal_session",
        entityId: id,
        actorType: "USER",
        payload: { type, cwd, pid: managed0.session.pid, tty: true },
      });
      return { ...managed0.session };
    }

    // Own process group so kill() takes down grandchildren (same as CLI adapter).
    let child: ChildProcess;
    try {
      child = spawn(shell, type === "USER" ? ["-i"] : [], {
        cwd,
        env: allowlistEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      this.transition(id, "FAILED");
      throw new Error(`[terminal] failed to spawn shell: ${err instanceof Error ? err.message : String(err)}`);
    }
    const managed = this.terminals.get(id)!;
    managed.child = child;
    managed.session.pid = child.pid ?? null;
    this.transition(id, "RUNNING");

    child.stdout?.on("data", (d) => this.pushOutput(id, d.toString(), "stdout"));
    child.stderr?.on("data", (d) => this.pushOutput(id, d.toString(), "stderr"));
    child.on("close", (code, signal) => {
      const m = this.terminals.get(id);
      if (!m) return;
      m.session.exitCode = code;
      m.session.endedAt = new Date().toISOString();
      // Signal-killed sessions read as CANCELLED; natural failures FAILED.
      if (m.session.status === "RUNNING" || m.session.status === "WAITING") {
        this.transition(id, signal ? "CANCELLED" : code === 0 ? "EXITED" : "FAILED");
      }
      this.audit({
        projectId: m.session.projectId,
        type: "terminal.session_ended",
        entityType: "terminal_session",
        entityId: id,
        actorType: "ENGINE",
        payload: { exitCode: code, signal: signal ?? null },
      });
    });

    this.audit({
      projectId,
      type: "terminal.session_created",
      entityType: "terminal_session",
      entityId: id,
      actorType: "USER",
      payload: { type, cwd, pid: managed.session.pid },
    });
    return { ...managed.session };
  }

  /** Writes to the terminal. Returns false for non-running sessions. */
  write(id: string, data: string): boolean {
    const m = this.terminals.get(id);
    if (!m || !["RUNNING", "WAITING"].includes(m.session.status)) return false;
    const payload = data.endsWith("\n") ? data : `${data}\n`;
    if (m.pty) {
      m.pty.write(data.endsWith("\r") ? data : `${data.trimEnd()}\r`);
      return true; // real TTY echoes input itself
    }
    if (!m.child?.stdin?.writable) return false;
    m.child.stdin.write(payload);
    if (data.trim().length > 0 && !data.startsWith(" ")) {
      // Echo the command locally so late subscribers see what was typed —
      // piped shells don't echo input themselves.
      this.pushOutput(id, `$ ${data}\n`, "stdout");
    }
    return true;
  }

  /** Full-TTY resize; no-op on the piped fallback (honest capability limit). */
  resize(id: string, cols: number, rows: number): boolean {
    const m = this.terminals.get(id);
    if (!m || !m.pty) return false;
    m.cols = cols;
    m.rows = rows;
    try {
      m.pty.resize(cols, rows);
      return true;
    } catch {
      return false;
    }
  }

  outputSince(id: string, afterSeq: number): { chunks: TerminalOutputChunk[]; latestSeq: number } {
    const m = this.terminals.get(id);
    if (!m) return { chunks: [], latestSeq: 0 };
    return {
      chunks: m.ring.filter((c) => c.seq > afterSeq),
      latestSeq: m.seq,
    };
  }

  /** Kills the process group. Idempotent. */
  /** Kills the process group / pty. Idempotent. */
  kill(id: string): boolean {
    const m = this.terminals.get(id);
    if (!m) return false;
    const pid = m.pty?.pid ?? m.child?.pid;
    if (pid !== undefined) {
      const isAlive = (() => {
        try {
          process.kill(-pid, 0);
          return true;
        } catch {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        }
      })();
      if (isAlive) {
        if (m.pty) {
          try { m.pty.kill(); } catch { /* already gone */ }
        } else if (m.child && m.child.exitCode === null) {
          try {
            process.kill(-pid, "SIGTERM");
            setTimeout(() => {
              try {
                if (m.child!.exitCode === null) process.kill(-pid, "SIGKILL");
              } catch { /* already gone */ }
            }, 3_000);
          } catch { /* already gone */ }
        }
      }
    }
    if (!["EXITED", "FAILED", "CANCELLED"].includes(m.session.status)) {
      this.transition(id, "CANCELLED");
    }
    return true;
  }

  disposeProject(projectId: string): void {
    for (const s of this.list(projectId)) this.kill(s.id);
  }

  private transition(id: string, to: TerminalSession["status"]): void {
    const m = this.terminals.get(id);
    if (!m) return;
    const from = m.session.status;
    if (from === to) return;
    if (!isTerminalTransitionLegal(from, to)) {
      // Illegal transitions are refused, never silently applied.
      throw new Error(`[terminal] illegal transition ${from} → ${to} for '${id}'`);
    }
    m.session.status = to;
    this.broadcast({ type: "terminal.status", sessionId: id, status: to });
  }

  private pushOutput(id: string, data: string, stream: "stdout" | "stderr"): void {
    const m = this.terminals.get(id);
    if (!m) return;
    m.seq += 1;
    const chunk: TerminalOutputChunk = { sessionId: id, seq: m.seq, data, stream, at: new Date().toISOString() };
    m.ring.push(chunk);
    if (m.ring.length > RING_BUFFER_LIMIT) m.ring.shift();
    this.broadcast({ type: "terminal.output", ...chunk });
  }
}

/** Interactive shells legitimately need more of the environment than agent
 * adapters do, but secrets are still not forwarded wholesale (V4 §6). */
function allowlistEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "EDITOR", "PNPM_HOME"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}
