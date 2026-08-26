import { describe, expect, it } from "vitest";
import {
  classifyCliFailure,
  buildArgs,
  parseClaudeStream,
  parseCodex,
  parseOpencode,
} from "../src/plugins/runtimes/cli-runtime-adapter.js";
import type { NormalizedRuntimeEvent } from "@devflow/contracts";

function collector() {
  const events: Array<Omit<NormalizedRuntimeEvent, "runId" | "taskId" | "at">> = [];
  return { events, emit: (e: Omit<NormalizedRuntimeEvent, "runId" | "taskId" | "at">) => events.push(e) };
}

describe("failure taxonomy (V3 §16)", () => {
  it("classifies transport-level failures without guessing", () => {
    expect(classifyCliFailure({ code: "ENOENT" })).toBe("RUNTIME_UNAVAILABLE");
    expect(classifyCliFailure({ stderr: "rate limit exceeded (429)" })).toBe("RATE_LIMITED");
    expect(classifyCliFailure({ stderr: "usage limit reached" })).toBe("QUOTA_EXHAUSTED");
    expect(classifyCliFailure({ stderr: "not logged in" })).toBe("AUTH_EXPIRED");
    expect(classifyCliFailure({ timedOut: true })).toBe("TIMEOUT");
    expect(classifyCliFailure({ code: 124 })).toBe("TIMEOUT");
    expect(classifyCliFailure({ killed: true, signal: "SIGTERM" })).toBe("CANCELLED");
    expect(classifyCliFailure({ code: 1, stderr: "boom" })).toBe("PROCESS_CRASH");
    expect(classifyCliFailure({ stderr: "permission denied while writing" })).toBe("POLICY_DENIED");
  });
});

describe("argv builders match installed CLI versions", () => {
  it("claude uses stream-json with required --verbose and maps permission presets", () => {
    const args = buildArgs("claude-code", { model: "claude-sonnet-4-5", permissionPreset: "WORKSPACE", effort: "HIGH" });
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose"); // stream-json requires it under -p
    expect(args.join(" ")).toContain("--permission-mode acceptEdits");
    expect(args.join(" ")).toContain("--model claude-sonnet-4-5");
    // Claude Code has no effort flag — must NOT be silently mapped into argv.
    expect(args.join(" ")).not.toContain("effort");
    const readOnly = buildArgs("claude-code", { permissionPreset: "READ_ONLY" });
    expect(readOnly.join(" ")).toContain("--permission-mode plan");
  });

  it("codex maps effort via -c config and sandbox from preset", () => {
    const args = buildArgs("codex-cli", { model: "gpt-5.x", effort: "HIGH", permissionPreset: "ELEVATED_ALLOWED", lastMessageFile: "/tmp/last.txt" });
    expect(args).toEqual(expect.arrayContaining(["exec", "--json", "-m", "gpt-5.x"]));
    expect(args.join(" ")).toContain("model_reasoning_effort=high");
    expect(args.join(" ")).toContain("-s workspace-write");
    expect(args.join(" ")).toContain("-o /tmp/last.txt");
    const ro = buildArgs("codex-cli", { permissionPreset: "READ_ONLY" });
    expect(ro.join(" ")).toContain("-s read-only");
  });

  it("opencode uses json format and variant for effort", () => {
    const args = buildArgs("opencode", { model: "0x/alpha-free", effort: "MEDIUM", permissionPreset: "WORKSPACE" });
    expect(args).toEqual(expect.arrayContaining(["run", "--format", "json", "-m", "0x/alpha-free"]));
    expect(args.join(" ")).toContain("--variant medium");
    expect(args).toContain("--auto");
    const ro = buildArgs("opencode", { permissionPreset: "READ_ONLY" });
    expect(ro).not.toContain("--auto");
  });
});

describe("claude stream-json parser", () => {
  it("maps init/assistant tool_use/text/result onto normalized kinds", () => {
    const { events } = collector();
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-123", tools: ["Bash"] }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "t1" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "did the work" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "final answer text" }),
      "not-json noise line",
    ].join("\n");
    const out = parseClaudeStream(lines, collector().emit);
    void out;
    // re-run with real collector to assert both outcome and events
    const c = collector();
    const parsed = parseClaudeStream(lines, c.emit);
    expect(parsed.finalText).toBe("final answer text");
    expect(parsed.sessionId).toBe("s-123");
    expect(parsed.failure).toBeNull();
    const kinds = c.events.map((e) => e.kind);
    expect(kinds).toContain("RUNNING");
    expect(kinds).toContain("ACTION_STARTED");
    expect(kinds).toContain("ACTION_COMPLETED");
    expect(kinds).toContain("OUTPUT");
    expect(c.events.find((e) => e.tool)?.tool?.name).toBe("Bash");
  });

  it("reports is_error results as INVALID_OUTPUT without inventing success", () => {
    const c = collector();
    const parsed = parseClaudeStream(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "hit max turns" }), c.emit);
    expect(parsed.failure).toBe("INVALID_OUTPUT");
  });
});

describe("codex exec --json parser", () => {
  it("maps thread/item/turn events and captures the agent message", () => {
    const c = collector();
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thr_1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.started", item: { id: "i0", type: "command_execution", command: "ls -la" } }),
      JSON.stringify({ type: "item.completed", item: { id: "i0", type: "command_execution", command: "ls -la", aggregated_output: "file.txt" } }),
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "all done" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } }),
    ].join("\n");
    const parsed = parseCodex(lines, c.emit);
    expect(parsed.sessionId).toBe("thr_1");
    expect(parsed.finalText).toBe("all done");
    expect(c.events.filter((e) => e.kind === "ACTION_STARTED").length).toBe(1);
    expect(c.events.filter((e) => e.kind === "ACTION_COMPLETED").length).toBe(1);
  });

  it("turn.failed yields UNKNOWN failure — never guessed into a specific taxonomy", () => {
    const c = collector();
    const parsed = parseCodex(JSON.stringify({ type: "turn.failed", error: { message: "server exploded" } }), c.emit);
    expect(parsed.failure).toBe("UNKNOWN");
  });
});

describe("opencode run --format json parser", () => {
  it("captures session ids, text parts and tool parts", () => {
    const c = collector();
    const lines = [
      JSON.stringify({ type: "step_start", sessionID: "ses_a", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", sessionID: "ses_a", part: { type: "text", text: "hello from opencode" } }),
      JSON.stringify({ type: "tool", sessionID: "ses_a", part: { tool: "bash", state: { status: "completed" } } }),
    ].join("\n");
    const parsed = parseOpencode(lines, c.emit);
    expect(parsed.sessionId).toBe("ses_a");
    expect(parsed.finalText).toBe("hello from opencode");
    expect(c.events.some((e) => e.kind === "ACTION_COMPLETED")).toBe(true);
  });
});
