import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodebaseSnapshot, ProjectRepositoryScanner } from "@devflow/contracts";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  c: "C",
  cpp: "C++",
  cs: "C#",
  swift: "Swift",
  sh: "Shell",
  sql: "SQL",
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", ".venv", "__pycache__"]);

/**
 * Heuristic repository scanner (spec §4 Step 3, §25). Produces a codebase snapshot:
 * languages, package managers, frameworks, test/build commands, top-level layout.
 * Facts are OBSERVED memory until confirmed — never silently canonical.
 */
export class HeuristicRepoScanner implements ProjectRepositoryScanner {
  async scan(rootPath: string): Promise<CodebaseSnapshot> {
    const info = await stat(rootPath).catch(() => null);
    if (!info || !info.isDirectory()) {
      throw new Error(`[repo-scanner/scan] '${rootPath}' is not a directory`);
    }
    const languageCounts = new Map<string, number>();
    const configFiles: string[] = [];
    let topLevelDirs: string[] = [];

    topLevelDirs = (await readdir(rootPath, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map((e) => e.name);

    await this.walk(rootPath, 0, async (filePath) => {
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      const lang = LANGUAGE_BY_EXT[ext];
      if (lang) languageCounts.set(lang, (languageCounts.get(lang) ?? 0) + 1);
      const base = filePath.split("/").pop() ?? "";
      if (/^(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|Gemfile|pom\.xml|composer\.json|tsconfig\.json|vite\.config\.[a-z]+|tauri\.conf\.json)$/.test(base)) {
        configFiles.push(filePath.replace(`${rootPath}/`, ""));
      }
    });

    const packageJson = await readJsonSafe(join(rootPath, "package.json"));
    const scripts = (packageJson?.scripts as Record<string, string> | undefined) ?? {};
    const frameworks: string[] = [];
    const deps: Record<string, unknown> = { ...((packageJson?.dependencies as Record<string, unknown>) ?? {}), ...((packageJson?.devDependencies as Record<string, unknown>) ?? {}) };
    for (const fw of ["react", "vue", "svelte", "next", "nuxt", "express", "fastify", "tauri"]) {
      if (deps[fw]) frameworks.push(fw);
    }

    const packageManagers: string[] = [];
    for (const [marker, pm] of [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      ["bun.lockb", "bun"],
      ["Cargo.lock", "cargo"],
      ["poetry.lock", "poetry"],
    ] as const) {
      try {
        await stat(join(rootPath, marker));
        packageManagers.push(pm);
      } catch {
        // marker absent — expected in most cases
      }
    }

    const notes: string[] = [];
    if (topLevelDirs.includes("apps") || topLevelDirs.includes("packages")) notes.push("monorepo-style layout detected");
    if (topLevelDirs.includes("src-tauri")) notes.push("Tauri desktop shell detected");

    return {
      path: rootPath,
      languages: [...languageCounts.entries()]
        .map(([name, fileCount]) => ({ name, fileCount }))
        .sort((a, b) => b.fileCount - a.fileCount)
        .slice(0, 8),
      packageManagers,
      frameworks,
      testCommand: scripts.test ? `npm test` : null,
      buildCommand: scripts.build ? `npm run build` : null,
      topLevelDirs,
      configFiles,
      notes,
    };
  }

  private async walk(dir: string, depth: number, onFile: (path: string) => Promise<void>): Promise<void> {
    if (depth > 4) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 500)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await this.walk(full, depth + 1, onFile);
      } else if (entry.isFile()) {
        await onFile(full);
      }
    }
  }
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}
