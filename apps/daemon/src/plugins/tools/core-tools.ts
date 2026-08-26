import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult, ToolDefinition, ActionRisk, GitAdapter } from "@devflow/contracts";
import { assertPathInsideWorkspace, classifyShellCommand } from "../../lib/path-guard.js";
import type { DevFlowConfig } from "../../lib/config.js";

const execFileAsync = promisify(execFile);

function base(id: string, operation: string, defaultRisk: ActionRisk, description: string): ToolDefinition {
  return { id, operation, defaultRisk, description };
}

/** File read tool — READ_ONLY. */
export class FileReadTool implements Tool {
  constructor(private readonly config: Pick<DevFlowConfig, "commandOutputLimitBytes">) {}
  definition(): ToolDefinition {
    return base("fs.read", "read file", "READ_ONLY", "Read a file inside the workspace");
  }
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(input.path ?? "");
    const safe = assertPathInsideWorkspace(ctx.workspaceRoot, path);
    try {
      const content = await import("node:fs/promises").then((fs) => fs.readFile(safe, "utf8"));
      const truncated =
        content.length > this.config.commandOutputLimitBytes
          ? `${content.slice(0, this.config.commandOutputLimitBytes)}… [truncated]`
          : content;
      return { ok: true, summary: `read ${safe}`, output: truncated };
    } catch (err) {
      return { ok: false, summary: `failed to read ${safe}: ${err instanceof Error ? err.message : String(err)}`, output: null };
    }
  }
}

/** File search tool — READ_ONLY grep-like. */
export class FileSearchTool implements Tool {
  definition(): ToolDefinition {
    return base("fs.search", "search files", "READ_ONLY", "Search for a pattern inside the workspace");
  }
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(input.pattern ?? "");
    if (!pattern) return { ok: false, summary: "empty pattern", output: null };
    const root = ctx.workspaceRoot;
    try {
      const { stdout } = await execFileAsync("grep", ["-rn", "--", pattern, "."], { cwd: root, timeout: 15_000, maxBuffer: 4_000_000 });
      const lines = stdout.split("\n").slice(0, 100).join("\n");
      return { ok: true, summary: `searched '${pattern}'`, output: lines };
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 1) return { ok: true, summary: `no matches for '${pattern}'`, output: "" };
      return { ok: false, summary: `search failed: ${err instanceof Error ? err.message : String(err)}`, output: null };
    }
  }
}

/** File write tool — WORKSPACE_WRITE. Confined to workspace; refuses absolute escapes. */
export class FileWriteTool implements Tool {
  definition(): ToolDefinition {
    return base("fs.write", "write file", "WORKSPACE_WRITE", "Create or overwrite a workspace file");
  }
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const path = String(input.path ?? "");
    const content = typeof input.content === "string" ? input.content : "";
    const safe = assertPathInsideWorkspace(ctx.workspaceRoot, path);
    try {
      await import("node:fs/promises").then(async (fs) => {
        await fs.mkdir(safe.slice(0, safe.lastIndexOf("/")), { recursive: true });
        await fs.writeFile(safe, content, "utf8");
      });
      return { ok: true, summary: `wrote ${safe} (${content.length} chars)`, output: null };
    } catch (err) {
      return { ok: false, summary: `failed to write ${safe}: ${err instanceof Error ? err.message : String(err)}`, output: null };
    }
  }
}

/** Shell tool — risk classified per command; the gateway decides allow/approve/deny.
 * The raw classification is surfaced so the gateway can pick ELEVATED vs DANGEROUS. */
export class ShellTool implements Tool {
  constructor(private readonly config: Pick<DevFlowConfig, "commandTimeoutMs" | "commandOutputLimitBytes">) {}
  definition(): ToolDefinition {
    return base("shell.exec", "run shell command", "ELEVATED", "Execute a shell command in the workspace");
  }
  static classify(command: string): { destructive: boolean; elevated: boolean } {
    return classifyShellCommand(command);
  }
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(input.command ?? "");
    if (!command.trim()) return { ok: false, summary: "empty command", output: null };
    // Defense in depth: even when approved, destructive patterns never run.
    if (classifyShellCommand(command).destructive) {
      return { ok: false, summary: `refused destructive command: ${command}`, output: null };
    }
    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd: ctx.workspaceRoot,
        timeout: this.config.commandTimeoutMs,
        maxBuffer: this.config.commandOutputLimitBytes,
      });
      const out = `${stdout}${stderr ? `\n[stderr] ${stderr}` : ""}`;
      return { ok: true, summary: `$ ${command}`, output: out.length > this.config.commandOutputLimitBytes ? `${out.slice(0, this.config.commandOutputLimitBytes)}…` : out };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, summary: `$ ${command} failed`, output: `${e.stdout ?? ""}${e.stderr ?? ""}\n${e.message ?? ""}`.trim() };
    }
  }
}

/** Git CLI adapter behind the contract (spec §14.5). Read operations only by design;
 * mutating git actions go through ShellTool + gateway approval. */
export class CliGitAdapter implements GitAdapter {
  async isRepository(path: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path, timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }
  async currentRevision(path: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: path, timeout: 10_000 });
      return stdout.trim();
    } catch {
      return null;
    }
  }
  async changedFiles(path: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: path, timeout: 10_000 });
      return stdout
        .split("\n")
        .filter((l) => l.trim().length > 2)
        .map((l) => l.slice(3).trim());
    } catch {
      return [];
    }
  }
  async diffSummary(path: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--stat", "HEAD"], { cwd: path, timeout: 10_000 });
      return stdout.trim();
    } catch {
      return "";
    }
  }
  async listBranches(path: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("git", ["branch", "--list"], { cwd: path, timeout: 10_000 });
      return stdout.split("\n").map((b) => b.replace("*", "").trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  async rawDiff(path: string, base: string | null = null): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["diff", base ?? "HEAD", "--"], { cwd: path, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch {
      return "";
    }
  }
  async fileLog(path: string, filePath: string, limit = 20): Promise<Array<{ hash: string; subject: string; author: string; date: string }>> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", `--max-count=${limit}`, "--pretty=format:%h%x1f%s%x1f%an%x1f%aI", "--", filePath],
        { cwd: path, timeout: 15_000 },
      );
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash = "", subject = "", author = "", date = ""] = line.split("\x1f");
          return { hash, subject, author, date };
        });
    } catch {
      return [];
    }
  }
}
