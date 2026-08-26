import type { PolicyEngine } from "@devflow/contracts";
import type { ActionRisk, PermissionDecision } from "@devflow/contracts";

/**
 * Policy engine presets (spec §2.3, §16). Fail-closed: unknown combos deny.
 * DANGEROUS always requires approval regardless of preset — no bypass exists.
 */
export class PresetPolicyEngine implements PolicyEngine {
  evaluate(action: {
    toolId: string;
    operation: string;
    risk: ActionRisk;
    permissionPreset: string;
    reversible: boolean;
    targetPath?: string | null;
  }): { decision: PermissionDecision; reason: string } {
    if (action.risk === "DANGEROUS") {
      return { decision: "REQUIRE_APPROVAL", reason: "dangerous actions always require explicit human approval" };
    }
    switch (action.permissionPreset) {
      case "READ_ONLY":
        return action.risk === "READ_ONLY"
          ? { decision: "ALLOW", reason: "read-only preset allows reads" }
          : { decision: "DENY", reason: `read-only preset denies ${action.risk}` };
      case "WORKSPACE":
        if (action.risk === "READ_ONLY") return { decision: "ALLOW", reason: "reads allowed" };
        if (action.risk === "WORKSPACE_WRITE") {
          return action.reversible
            ? { decision: "ALLOW", reason: "workspace writes allowed for reversible edits" }
            : { decision: "REQUIRE_APPROVAL", reason: "irreversible workspace write needs approval" };
        }
        return { decision: "REQUIRE_APPROVAL", reason: `elevated action '${action.operation}' requires approval in workspace preset` };
      case "ELEVATED_ALLOWED":
        if (action.risk === "READ_ONLY" || action.risk === "WORKSPACE_WRITE") {
          return { decision: "ALLOW", reason: "preset allows workspace-level actions" };
        }
        if (action.risk === "ELEVATED") return { decision: "ALLOW", reason: "elevated allowed by preset" };
        return { decision: "REQUIRE_APPROVAL", reason: "dangerous action requires approval" };
      default:
        return { decision: "DENY", reason: `unknown permission preset '${action.permissionPreset}' — fail closed` };
    }
  }
}
