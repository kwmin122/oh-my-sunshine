import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeCatalogEntry } from "@devflow/contracts";

/**
 * Runtime Discovery (spec §32). Detects AI coding CLIs already on the user's
 * machine — including their subscription/OAuth login state owned by the CLI
 * itself. Sunshine never reads or stores CLI credentials; it only observes
 * availability, version, and auth posture reported by the tool.
 */
const execFileAsync = promisify(execFile);

export interface DiscoveredRuntime {
  id: string;
  binaryPath: string | null;
  version: string | null;
  /** Auth as reported by the CLI itself. "unknown" = probe unsupported/failed. */
  authStatus: "LOGGED_IN" | "NOT_LOGGED_IN" | "UNKNOWN";
  authMethod: string | null;
  accountHint: string | null;
}

const CANDIDATES: Array<{ id: string; bin: string; authProbe?: string[] }> = [
  { id: "claude-code", bin: "claude", authProbe: ["auth", "status"] },
  { id: "codex-cli", bin: "codex", authProbe: ["login", "status"] },
  { id: "opencode", bin: "opencode", authProbe: ["auth", "list"] },
];

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function probeVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 10_000 });
    return stdout.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

/** Runs the CLI's own status probe. Never parses or stores tokens — only posture.
 * Verified live: claude 2.1.241 emits JSON {"loggedIn": true, "email": …};
 * codex 0.149.1 prints "Logged in using ChatGPT"; opencode 1.18.23 `auth list`
 * prints a credentials table with exit 0 when at least one provider is set up. */
export async function probeAuth(bin: string, args?: string[]): Promise<{ authStatus: DiscoveredRuntime["authStatus"]; authMethod: string | null; accountHint: string | null }> {
  if (!args) return { authStatus: "UNKNOWN", authMethod: null, accountHint: null };
  let stdout = "";
  let stderr = "";
  let failed = false;
  try {
    const res = await execFileAsync(bin, args, { timeout: 15_000 });
    stdout = res.stdout;
    stderr = res.stderr ?? "";
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    failed = true;
  }
  const text = `${stdout} ${stderr}`.toLowerCase();
  // Claude Code emits machine-readable JSON — parse it before falling back to text.
  const claudeJson = (() => {
    try { return JSON.parse(stdout) as { loggedIn?: boolean; email?: string; authMethod?: string }; } catch { return null; }
  })();
  const email = claudeJson?.email ?? stdout.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? null;

  let status: DiscoveredRuntime["authStatus"] = "UNKNOWN";
  if (claudeJson && typeof claudeJson.loggedIn === "boolean") {
    status = claudeJson.loggedIn ? "LOGGED_IN" : "NOT_LOGGED_IN";
  } else if (text.includes("not logged in") || text.includes("logged out")) {
    // negations MUST be tested before the generic "logged in" substring match
    status = "NOT_LOGGED_IN";
  } else if (text.includes("logged in") || text.includes('"loggedin": true') || text.includes("logged_in\": true")) {
    status = "LOGGED_IN";
  } else if (!failed && text.includes("credentials") && !text.includes("no credentials")) {
    // opencode `auth list` shows a Credentials table only when something exists.
    status = "LOGGED_IN";
  }

  let method: string | null = null;
  if (claudeJson?.authMethod) method = claudeJson.authMethod;
  else if (text.includes("subscription")) method = "Subscription OAuth";
  else if (text.includes("chatgpt")) method = "ChatGPT subscription";
  else if (text.includes("api key") || text.includes("\"api\"") || text.includes("api")) method = "API key";
  return { authStatus: status, authMethod: method, accountHint: email };
}

export async function discoverRuntimes(): Promise<DiscoveredRuntime[]> {
  return Promise.all(
    CANDIDATES.map(async ({ id, bin, authProbe }) => {
      const binaryPath = await which(bin);
      if (!binaryPath) {
        return { id, binaryPath: null, version: null, authStatus: "UNKNOWN" as const, authMethod: null, accountHint: null };
      }
      const [version, auth] = await Promise.all([
        probeVersion(binaryPath),
        probeAuth(binaryPath, authProbe),
      ]);
      return { id, binaryPath, version, ...auth };
    }),
  );
}

/** Feeds discovery results into the Team Composer catalog availability flags. */
export function applyDiscoveryToCatalog(
  catalog: RuntimeCatalogEntry[],
  discovered: DiscoveredRuntime[],
): RuntimeCatalogEntry[] {
  const byId = new Map(discovered.map((d) => [d.id, d]));
  return catalog.map((entry) => {
    const d = byId.get(entry.id);
    if (!d) return entry;
    if (!d.binaryPath) {
      return { ...entry, available: false, unavailableReason: `${d.id} CLI not found on PATH` };
    }
    if (entry.available === false && entry.unavailableReason?.includes("PATH")) {
      // Binary now exists — flip to available; deeper capability probing is §36.
      return { ...entry, available: true, unavailableReason: undefined };
    }
    return entry;
  });
}
