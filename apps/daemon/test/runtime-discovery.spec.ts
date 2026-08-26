import { describe, expect, it } from "vitest";
import { applyDiscoveryToCatalog, probeVersion, probeAuth } from "../../apps/daemon/src/services/discovery/runtime-discovery.js";
import { buildCatalog } from "../../apps/daemon/src/application/team/team-composer-service.js";

describe("runtime discovery (§32)", () => {
  it("flips catalog availability when a CLI binary is found on PATH", () => {
    const base = buildCatalog(() => false);
    const flipped = applyDiscoveryToCatalog(base, [
      { id: "claude-code", binaryPath: "/opt/homebrew/bin/claude", version: "2.1.0", authStatus: "LOGGED_IN", authMethod: "Subscription OAuth", accountHint: "u@x.com" },
    ]);
    const cc = flipped.find((r) => r.id === "claude-code")!;
    expect(cc.available).toBe(true);
    expect(cc.unavailableReason).toBeUndefined();
    // untouched entries keep their state
    expect(flipped.find((r) => r.id === "codex-cli")?.available).toBe(false);
  });

  it("keeps runtimes unavailable when PATH scan finds nothing", () => {
    const base = buildCatalog(() => false);
    const out = applyDiscoveryToCatalog(base, [
      { id: "codex-cli", binaryPath: null, version: null, authStatus: "UNKNOWN", authMethod: null, accountHint: null },
    ]);
    expect(out.find((r) => r.id === "codex-cli")?.available).toBe(false);
  });

  it("probeVersion returns null for missing binaries instead of throwing", async () => {
    expect(await probeVersion("definitely-not-a-real-binary-xyz")).toBeNull();
  });

  it("auth probe parses each installed CLI's real output shape — never guesses UNKNOWN into READY", async () => {
    // Fake binaries that reproduce the exact live outputs (verified 2026-08):
    // claude emits JSON with camelCase loggedIn; codex prints to STDERR;
    // opencode prints a credentials table; a logged-out CLI says so.
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "probe-auth-"));
    const mkBin = (name: string, body: string): string => {
      const p = join(dir, name);
      writeFileSync(p, `#!/bin/bash\n${body}`);
      chmodSync(p, 0o755);
      return p;
    };

    const claudeJson = mkBin("claude-json", 'echo \'{"loggedIn": true, "authMethod": "claude.ai", "email": "u@x.com"}\'');
    const claudeJsonOut = await probeAuth(claudeJson, ["auth", "status"]);
    expect(claudeJsonOut.authStatus).toBe("LOGGED_IN"); // regression: camelCase JSON was missed
    expect(claudeJsonOut.accountHint).toBe("u@x.com");

    const claudeOut = mkBin("claude-off", 'echo \'{"loggedIn": false}\'');
    expect((await probeAuth(claudeOut, ["auth", "status"])).authStatus).toBe("NOT_LOGGED_IN");

    const codexStderr = mkBin("codex-stderr", 'echo "Logged in using ChatGPT" >&2; exit 0');
    const codexRes = await probeAuth(codexStderr, ["login", "status"]);
    expect(codexRes.authStatus).toBe("LOGGED_IN");
    expect(codexRes.authMethod).toContain("ChatGPT");

    const opencodeTable = mkBin("opencode-table", 'echo "┌ Credentials"; echo "● OpenCode Zen api"; exit 0');
    expect((await probeAuth(opencodeTable, ["auth", "list"])).authStatus).toBe("LOGGED_IN");

    const unknownCli = mkBin("silent-cli", "exit 0");
    expect((await probeAuth(unknownCli, ["auth", "status"])).authStatus).toBe("UNKNOWN");

    const loggedOut = mkBin("logout-cli", 'echo "Not logged in" >&2; exit 1');
    expect((await probeAuth(loggedOut, ["login", "status"])).authStatus).toBe("NOT_LOGGED_IN");
  });
});

function join(...args: string[]): string {
  return args.reduce((a, b) => `${a}/${b}`);
}

