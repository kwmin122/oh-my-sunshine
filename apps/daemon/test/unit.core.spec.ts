import { describe, expect, it } from "vitest";
import {
  isAgentRunTransitionLegal,
  isTaskTransitionLegal,
  isWorkflowTransitionLegal,
  canPromoteMemory,
} from "@devflow/contracts";
import { assessRisk, signalsFromMission } from "../../apps/daemon/src/domain/risk/risk-engine.js";
import { PresetPolicyEngine } from "../../apps/daemon/src/domain/policy/preset-policy-engine.js";
import { assertPathInsideWorkspace, classifyShellCommand } from "../../apps/daemon/src/lib/path-guard.js";
import { heuristicIntent } from "../../apps/daemon/src/application/intent/intent-gate-service.js";

describe("task state machine", () => {
  it("allows the documented forward path", () => {
    const path: Array<[string, string]> = [
      ["DRAFT", "READY"],
      ["READY", "QUEUED"],
      ["QUEUED", "RUNNING"],
      ["RUNNING", "VERIFYING"],
      ["VERIFYING", "REVIEW"],
      ["REVIEW", "DONE"],
    ];
    for (const [from, to] of path) expect(isTaskTransitionLegal(from as never, to as never)).toBe(true);
  });
  it("permits rework paths from VERIFYING and REVIEW back to RUNNING", () => {
    expect(isTaskTransitionLegal("VERIFYING", "RUNNING")).toBe(true);
    expect(isTaskTransitionLegal("REVIEW", "RUNNING")).toBe(true);
  });
  it("rejects jumping straight from DRAFT to DONE", () => {
    expect(isTaskTransitionLegal("DRAFT", "DONE")).toBe(false);
  });
});

describe("agent run state machine", () => {
  it("models approval wait and resume", () => {
    expect(isAgentRunTransitionLegal("RUNNING", "WAITING_APPROVAL")).toBe(true);
    expect(isAgentRunTransitionLegal("WAITING_APPROVAL", "RUNNING")).toBe(true);
  });
  it("never allows DONE-style skips like QUEUED to SUCCEEDED", () => {
    expect(isAgentRunTransitionLegal("QUEUED", "SUCCEEDED")).toBe(false);
  });
});

describe("workflow instance state machine", () => {
  it("supports WAITING ↔ RUNNING and RUNNING → COMPLETED", () => {
    expect(isWorkflowTransitionLegal("RUNNING", "WAITING")).toBe(true);
    expect(isWorkflowTransitionLegal("WAITING", "RUNNING")).toBe(true);
    expect(isWorkflowTransitionLegal("RUNNING", "COMPLETED")).toBe(true);
  });
  it("blocks illegal COMPLETED → RUNNING resurrection", () => {
    expect(isWorkflowTransitionLegal("COMPLETED", "RUNNING")).toBe(false);
  });
});

describe("memory promotion lifecycle", () => {
  it("only allows single-step promotions", () => {
    expect(canPromoteMemory("OBSERVED", "EXTRACTED")).toBe(true);
    expect(canPromoteMemory("OBSERVED", "CANONICAL")).toBe(false);
    expect(canPromoteMemory("CONFIRMED", "CANONICAL")).toBe(true);
  });
});

describe("risk engine", () => {
  it("classifies auth work as HIGH because security sensitivity stacks", () => {
    const result = assessRisk(signalsFromMission("Add Google OAuth login"));
    expect(result.tier).toBe("HIGH");
    expect(result.reasons.some((r) => r.includes("authentication"))).toBe(true);
  });
  it("classifies copy tweaks as LOW", () => {
    const result = assessRisk(signalsFromMission("Change button label text on settings page"));
    expect(result.tier).toBe("LOW");
  });
  it("treats destructive migrations as HIGH even when short", () => {
    const result = assessRisk(signalsFromMission("drop table users migration"));
    expect(result.tier).toBe("HIGH");
    expect(result.reasons.some((r) => r.includes("destructive"))).toBe(true);
  });
});

describe("policy engine presets", () => {
  const policy = new PresetPolicyEngine();
  it("READ_ONLY preset denies writes outright", () => {
    expect(policy.evaluate({ toolId: "fs.write", operation: "write", risk: "WORKSPACE_WRITE", permissionPreset: "READ_ONLY", reversible: true }).decision).toBe("DENY");
  });
  it("WORKSPACE preset requires approval for elevated commands", () => {
    expect(policy.evaluate({ toolId: "shell.exec", operation: "run", risk: "ELEVATED", permissionPreset: "WORKSPACE", reversible: false }).decision).toBe("REQUIRE_APPROVAL");
  });
  it("DANGEROUS actions always require approval regardless of preset — no bypass", () => {
    for (const preset of ["READ_ONLY", "WORKSPACE", "ELEVATED_ALLOWED"]) {
      expect(policy.evaluate({ toolId: "shell.exec", operation: "run", risk: "DANGEROUS", permissionPreset: preset, reversible: false }).decision).toBe("REQUIRE_APPROVAL");
    }
  });
  it("fails closed on unknown presets", () => {
    expect(policy.evaluate({ toolId: "x", operation: "y", risk: "READ_ONLY", permissionPreset: "SOMETHING_ELSE", reversible: true }).decision).toBe("DENY");
  });
});

describe("path guard", () => {
  const root = "/Users/dev/project";
  it("accepts paths inside the workspace", () => {
    expect(() => assertPathInsideWorkspace(root, `${root}/src/a.ts`)).not.toThrow();
    expect(() => assertPathInsideWorkspace(root, "src/a.ts")).not.toThrow();
  });
  it("rejects absolute escapes outside the workspace", () => {
    expect(() => assertPathInsideWorkspace(root, "/Users/dev/.ssh/id_rsa")).toThrow(/escapes workspace root/);
  });
  it("rejects traversal via dot-dot segments", () => {
    expect(() => assertPathInsideWorkspace(root, "../../../etc/passwd")).toThrow(/escapes workspace root/);
  });
});

describe("shell risk classification", () => {
  it("marks rm -rf ~ as destructive", () => {
    expect(classifyShellCommand("rm -rf ~/").destructive).toBe(true);
  });
  it("marks npm install as elevated but not destructive", () => {
    const cls = classifyShellCommand("npm install left-pad");
    expect(cls.elevated).toBe(true);
    expect(cls.destructive).toBe(false);
  });
  it("marks plain ls as neither", () => {
    const cls = classifyShellCommand("ls -la");
    expect(cls.elevated).toBe(false);
    expect(cls.destructive).toBe(false);
  });
});

describe("intent gate heuristics", () => {
  it("routes vague feature asks into Discovery Interview", () => {
    const intent = heuristicIntent("Add login");
    expect(intent.recommendedEntryPoint).toBe("DISCOVERY_INTERVIEW");
    expect(intent.hiddenDimensions.length).toBeGreaterThan(3);
  });
  it("classifies bug reports toward bug investigation", () => {
    expect(heuristicIntent("the app crashes on save").type).toBe("BUG");
    expect(heuristicIntent("the app crashes on save").recommendedEntryPoint).toBe("BUG_INVESTIGATION");
  });
});
