import { readdirSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import type { GitAdapter } from "@devflow/contracts";
import { assertPathInsideWorkspace } from "../../lib/path-guard.js";
import type { ProjectService } from "../project/project-service.js";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";

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
    private readonly docs?: DocumentRepository,
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

  /** V4 §4 provenance: which agent run last touched this file (gateway audit). */
  fileProvenance(projectId: string, filePath: string): { runId: string | null; taskId: string | null; at: string | null; actionSummary: string | null } {
    if (!this.docs) return { runId: null, taskId: null, at: null, actionSummary: null };
    const actions = this.docs
      .list<{ id: string; projectId: string; runId: string | null; target: string | null; toolId: string; summary: string; status: string; createdAt: string }>("action", projectId)
      .filter((a) => a.status === "SUCCEEDED" && (a.target === filePath || a.target?.endsWith(`/${filePath}`)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const last = actions[0];
    if (!last) return { runId: null, taskId: null, at: null, actionSummary: null };
    const run = last.runId ? this.docs.get<{ taskId: string | null }>("agent_run", last.runId) : undefined;
    return { runId: last.runId ?? null, taskId: run?.taskId ?? null, at: last.createdAt, actionSummary: last.summary };
  }

  /** Content search (V4 §2): line-level grep over text files. Budget-capped —
   * this is honest grep, not an index; symbol intelligence is a separate service. */
  searchContents(
    projectId: string,
    query: string,
    opts: { maxResults?: number; maxScanBytes?: number } = {},
  ): Array<{ path: string; line: number; preview: string }> {
    const q = query.toLowerCase();
    if (q.length < 2) return [];
    const maxResults = opts.maxResults ?? 40;
    const maxScanBytes = opts.maxScanBytes ?? 4_000_000;
    let scanned = 0;
    const hits: Array<{ path: string; line: number; preview: string }> = [];
    const { workspaceRoot } = this.resolve(projectId);
    const walk = (absDir: string, depth: number): void => {
      if (hits.length >= maxResults || scanned >= maxScanBytes || depth > 10) return;
      for (const name of readdirSync(absDir)) {
        if (IGNORED_DIRS.has(name)) continue;
        if (hits.length >= maxResults || scanned >= maxScanBytes) return;
        const abs = join(absDir, name);
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(abs, depth + 1);
          continue;
        }
        if (stat.size > MAX_READ_BYTES) continue;
        try {
          const buf = readFileSync(abs);
          scanned += Math.min(buf.length, 4096); // binary sniff budget
          if (buf.subarray(0, 1024).includes(0)) continue; // binary
          const rel = relative(workspaceRoot, abs).split(sep).join("/");
          const lines = buf.toString("utf8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            scanned += lines[i]!.length;
            if (scanned >= maxScanBytes) return;
            if (lines[i]!.toLowerCase().includes(q)) {
              hits.push({ path: rel, line: i + 1, preview: lines[i]!.trim().slice(0, 200) });
              if (hits.length >= maxResults) return;
            }
          }
        } catch {
          continue; // unreadable (permissions/race) — skip honestly
        }
      }
    };
    walk(workspaceRoot, 0);
    return hits;
  }

  /** Realtime fs events (V4 §5): recursive watch → debounced change callbacks.
   * Returns a disposer. macOS/Windows get native recursion; Linux Node ≥20 too. */
  watchProject(
    projectId: string,
    onChange: (event: { type: "file.changed"; path: string | null }) => void,
  ): (() => void) | null {
    let workspaceRoot: string;
    try {
      workspaceRoot = this.resolve(projectId).workspaceRoot;
    } catch {
      return null; // no repo attached — nothing to watch
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingPath: string | null = null;
    let watcher: FSWatcher;
    try {
      watcher = watch(workspaceRoot, { recursive: true }, (_event, filename) => {
        pendingPath = filename ? filename.split(sep).join("/") : pendingPath;
        if (pendingPath && IGNORED_DIRS.has(pendingPath.split("/")[0]!)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          onChange({ type: "file.changed", path: pendingPath });
          pendingPath = null;
        }, 300);
      });
    } catch {
      return null; // platform without recursive support — polling fallback stays
    }
    return () => watcher.close();
  }
}
