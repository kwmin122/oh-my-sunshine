import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReadinessProbe, SystemCapability } from "@devflow/contracts";

const execFileAsync = promisify(execFile);

async function probeCommand(capability: string, command: string, args: string[], versionPrefix: string): Promise<SystemCapability> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 10_000 });
    const version = stdout.trim().split("\n")[0]?.replace(versionPrefix, "").trim() ?? null;
    return {
      capability,
      status: "AVAILABLE",
      version,
      path: command,
      diagnostic: "ok",
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      capability,
      status: "MISSING",
      version: null,
      path: null,
      diagnostic: `${command} not runnable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      checkedAt: new Date().toISOString(),
    };
  }
}

/** System readiness probes (spec §4 Step 0). Capability-based; a task cannot start
 * when a required capability is missing. */
export function builtinProbes(): ReadinessProbe[] {
  return [
    {
      capability: "git",
      async check() {
        return probeCommand("git", "git", ["--version"], "git version");
      },
    },
    {
      capability: "node",
      async check() {
        const cap = await probeCommand("node", process.execPath, ["--version"], "v");
        return { ...cap, path: process.execPath };
      },
    },
    {
      capability: "package_manager",
      check: () => firstAvailable([["pnpm", ["--version"]], ["npm", ["--version"]]] as const),
    },
    {
      capability: "docker",
      check: () => probeCommand("docker", "docker", ["--version"], "Docker version"),
    },
    {
      capability: "python",
      check: () => probeCommand("python", "python3", ["--version"], "Python"),
    },
  ];
}

async function firstAvailable(candidates: ReadonlyArray<readonly [string, string[]]>): Promise<SystemCapability> {
  let lastDiagnostic = "no candidates provided";
  for (const [command, args] of candidates) {
    const result = await probeCommand("package_manager", command, args, "");
    if (result.status === "AVAILABLE") return result;
    lastDiagnostic = result.diagnostic;
  }
  return {
    capability: "package_manager",
    status: "MISSING",
    version: null,
    path: null,
    diagnostic: lastDiagnostic,
    checkedAt: new Date().toISOString(),
  };
}
