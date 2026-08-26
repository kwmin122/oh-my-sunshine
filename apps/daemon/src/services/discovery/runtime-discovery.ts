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
  { id: "opencode", bin: "opencode" },
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

/** Runs the CLI's own status probe. Never parses or stores tokens — only posture. */
async function probeAuth(bin: string, args?: string[]): Promise<{ authStatus: DiscoveredRuntime["authStatus"]; authMethod: string | null; accountHint: string | null }> {
  if (!args) return { authStatus: "UNKNOWN", authMethod: null, accountHint: null };
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 15_000 });
    const text = stdout.toLowerCase();
    let status: DiscoveredRuntime["authStatus"] = "UNKNOWN";
    if (text.includes("logged in") || text.includes('"logged_in": true') || text.includes('"loggedin": true')) status = "LOGGED_IN";
    else if (text.includes("not logged in") || text.includes('"logged_in": false') || text.includes("logged out")) status = "NOT_LOGGED_IN";
    const email = stdout.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    const method = text.includes("subscription") ? "Subscription OAuth" : text.includes("api") ? "API key" : null;
    return { authStatus: status, authMethod: method, accountHint: email ? email[0] : null };
  } catch {
    // Non-zero exit usually means not logged in; still honest: unknown.
    return { authStatus: "UNKNOWN", authMethod: null, accountHint: null };
  }
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
