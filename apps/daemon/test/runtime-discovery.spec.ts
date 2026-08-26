import { describe, expect, it } from "vitest";
import { applyDiscoveryToCatalog, probeVersion } from "../../apps/daemon/src/services/discovery/runtime-discovery.js";
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
});
