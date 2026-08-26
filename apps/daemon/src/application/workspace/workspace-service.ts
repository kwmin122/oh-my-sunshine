import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { GitAdapter } from "@devflow/contracts";
import { assertPathInsideWorkspace } from "../../lib/path-guard.js";
import type { ProjectService } from "../project/project-service.js";

/**
 * Development Workspace backend (V4 §2–4 / S10). The renderer never touches the
 * filesystem — Desktop → daemon API → this service → fs/git adapters. Every path
 * is validated against the project workspace root before any I/O.
 */

export interface WorkspaceEntry {
  name: string;
  path: string; // relative to workspace root, POSIX separators
  type: "file" | "dir";
  size: number | null;
  /** git status badge: M/A/??/… when the working tree changed this file. */
  gitStatus: string | null;
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
  revision: string | null;
}

const MAX_READ_BYTES = 512_000;
const IGNORED_DIRS = new Set([".git", "node_modules", "target", "dist", ".next", ".venv", "__pycache__"]);

/** Symlink defense (review pass-3): lexical confinement is not enough — a
 * symlink inside the repo pointing outside would escape readFileSync. Resolve
 * the REAL target and re-assert containment. Nonexistent paths pass through
 * (nothing to resolve yet). */
function assertSymlinkSafeWorkspace(root: string, abs: string): string {
  try {
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error("[workspace] path resolves outside the workspace via symlink — blocked");
    }
    return real;
  } catch (err) {
    if (err instanceof Error && err.message.includes("symlink")) throw err;
    return abs; // ENOENT — nothing to resolve
  }
}

export class WorkspaceService {
  constructor(
    private readonly projects: Pick<ProjectService, "getProject">,
    private readonly git: GitAdapter,
  ) {}

  private resolve(projectId: string): { workspaceRoot: string; absolute: (rel: string) => string } {
    const project = this.projects.getProject(projectId);
    const rawRoot = project.repositoryPath;
    if (!rawRoot) throw new Error(`[workspace] project '${projectId}' has no repository attached`);
    // Canonicalize the root once (macOS /var→/private/var etc.) so every
    // relative-path computation stays inside ONE consistent base.
    let workspaceRoot = rawRoot;
    try {
      workspaceRoot = realpathSync(rawRoot);
    } catch { /* missing dir — surface original error at first fs op */ }
    const absolute = (rel: string): string => {
      // assertPathInsideWorkspace returns the validated ABSOLUTE path.
      return assertSymlinkSafeWorkspace(workspaceRoot, assertPathInsideWorkspace(workspaceRoot, rel));
    };
    return { workspaceRoot, absolute };
  }

  async listTree(projectId: string, subpath = ""): Promise<{ path: string; entries: WorkspaceEntry[] }> {
    const { workspaceRoot } = this.resolve(projectId);
    const dirAbs = subpath ? this.resolve(projectId).absolute(subpath) : workspaceRoot;
    let changed = new Set<string>();
    try {
      changed = new Set(await this.git.changedFiles(workspaceRoot));
    } catch {
      // non-git workspace — badges stay null (honest)
    }
    const entries: WorkspaceEntry[] = [];
    for (const name of readdirSync(dirAbs)) {
      if (IGNORED_DIRS.has(name)) continue;
      const abs = join(dirAbs, name);
      let isDir = false;
      let size: number | null = null;
      try {
        isDir = statSync(abs).isDirectory();
        if (!isDir) size = statSync(abs).size;
      } catch {
        continue; // raced deletion — skip silently, next listing will be accurate
      }
      const rel = relative(workspaceRoot, abs).split(sep).join("/");
      entries.push({
        name,
        path: rel,
        type: isDir ? "dir" : "file",
        size,
        gitStatus: changed.has(rel) ? "M" : [...changed].find((c) => c.endsWith("/") && rel.startsWith(c)) ? "M" : null,
      });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { path: subpath, entries };
  }

  async searchFiles(projectId: string, query: string, limit = 50): Promise<WorkspaceEntry[]> {
    if (query.trim().length < 1) return [];
    const { workspaceRoot } = this.resolve(projectId);
    const q = query.toLowerCase();
    const results: WorkspaceEntry[] = [];
    const walk = (absDir: string, depth: number): void => {
      if (results.length >= limit || depth > 8) return;
      for (const name of readdirSync(absDir)) {
        if (IGNORED_DIRS.has(name)) continue;
        const abs = join(absDir, name);
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        const rel = relative(workspaceRoot, abs).split(sep).join("/");
        if (stat.isDirectory()) walk(abs, depth + 1);
        else if (name.toLowerCase().includes(q)) results.push({ name, path: rel, type: "file", size: stat.size, gitStatus: null });
        if (results.length >= limit) return;
      }
    };
    walk(workspaceRoot, 0);
    return results;
  }

  async readFile(projectId: string, filePath: string): Promise<WorkspaceFileContent> {
    const { workspaceRoot, absolute } = this.resolve(projectId);
    const abs = absolute(filePath);
    const stat = statSync(abs);
    if (stat.isDirectory()) throw new Error(`[workspace] '${filePath}' is a directory`);
    const truncated = stat.size > MAX_READ_BYTES;
    const buf = truncated ? readFileSync(abs).subarray(0, MAX_READ_BYTES) : readFileSync(abs);
    const revision = await this.git.currentRevision(workspaceRoot).catch(() => null);
    return { path: filePath, content: buf.toString("utf8"), truncated, sizeBytes: stat.size, revision };
  }

  async diff(projectId: string, base?: string | null): Promise<{ base: string; diff: string }> {
    const { workspaceRoot } = this.resolve(projectId);
    const resolvedBase = base ?? (await this.git.currentRevision(workspaceRoot)) ?? null;
    return { base: resolvedBase ?? "(no git)", diff: await this.git.rawDiff(workspaceRoot, resolvedBase) };
  }

  async statusSummary(projectId: string): Promise<{ revision: string | null; changedFiles: Array<{ path: string; status: string }> }> {
    const { workspaceRoot } = this.resolve(projectId);
    const [revision, porcelain] = await Promise.all([
      this.git.currentRevision(workspaceRoot).catch(() => null),
      this.git.changedFiles(workspaceRoot).catch(() => [] as string[]),
    ]);
    return {
      revision,
      changedFiles: porcelain.map((line) => ({
        path: line.slice(3).trim(),
        status: line.slice(0, 2).trim() || "M",
      })),
    };
  }

  async fileHistory(projectId: string, filePath: string, limit = 20) {
    const { workspaceRoot } = this.resolve(projectId);
    assertPathInsideWorkspace(workspaceRoot, filePath);
    return this.git.fileLog(workspaceRoot, filePath, limit);
  }
}
