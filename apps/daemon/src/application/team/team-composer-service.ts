import type {
  CapabilityMismatch,
  EffortLevel,
  ModelOption,
  ResolvedRuntime,
  RoleRuntimeBinding,
  RuntimeCatalogEntry,
  RuntimeFallback,
  TaskRuntimeOverride,
} from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * AI Team Composer (spec §31). Keeps Role ↔ Runtime ↔ Model fully separable:
 * humans pick per-role runtime/provider/model/effort/tools/permissions/fallbacks
 * in Auto / Recommended / Manual modes; the engine resolves the nearest override
 * at run time and degrades along the fallback chain instead of failing.
 */

export interface ComposerRoleSpec {
  roleId: string;
  label: string;
  /** Capability keys the role's runtime must support. */
  requires: Array<keyof RuntimeCatalogEntry["capabilities"]>;
}

const s = (
  reasoning: number, planning: number, coding: number, review: number,
  capacity: number, cost: number, latency: number,
) => ({ reasoning, planning, coding, review, capacity, cost, latency });

/** Deterministic catalog. CLI runtimes are available only when their binary is on PATH. */
export function buildCatalog(cliProbe: (bin: string) => boolean): RuntimeCatalogEntry[] {
  return [
    {
      id: "mock-runtime", label: "DevFlow Mock", kind: "mock", available: true, capabilities: { filesystem: true, shell: true, git: true, tests: true, network: false },
      models: [
        { providerId: "mock", model: "deterministic-mock-v1", label: "Deterministic Mock", efforts: ["LOW"], scores: s(4, 4, 4, 4, 10, 10, 10) },
      ],
    },
    {
      id: "model-api-only", label: "Model API only", kind: "api", available: true, capabilities: { filesystem: false, shell: false, git: false, tests: false, network: true },
      unavailableReason: undefined,
      models: [
        { providerId: "0x", model: "alpha-free", label: "0x Alpha Free", efforts: ["LOW", "MEDIUM"], scores: s(5, 4, 7, 4, 10, 10, 8) },
      ],
    },
    {
      id: "claude-code", label: "Claude Code", kind: "cli",
      available: cliProbe("claude"), capabilities: { filesystem: true, shell: true, git: true, tests: true, network: true },
      unavailableReason: cliProbe("claude") ? undefined : "claude CLI not found on PATH",
      models: [
        { providerId: "anthropic", model: "claude-opus-4-6", label: "Opus", efforts: ["MEDIUM", "HIGH", "MAX"], scores: s(10, 9, 9, 10, 5, 3, 5) },
        { providerId: "anthropic", model: "claude-sonnet-4-5", label: "Sonnet", efforts: ["LOW", "MEDIUM", "HIGH"], scores: s(8, 8, 8, 8, 7, 5, 8) },
      ],
    },
    {
      id: "codex-cli", label: "Codex CLI", kind: "cli",
      available: cliProbe("codex"), capabilities: { filesystem: true, shell: true, git: true, tests: true, network: true },
      unavailableReason: cliProbe("codex") ? undefined : "codex CLI not found on PATH",
      models: [
        { providerId: "openai", model: "gpt-5.x-reasoning", label: "GPT reasoning", efforts: ["MEDIUM", "HIGH", "MAX"], scores: s(9, 10, 8, 9, 9, 6, 6) },
        { providerId: "openai", model: "gpt-5.x", label: "GPT", efforts: ["LOW", "MEDIUM", "HIGH"], scores: s(7, 7, 8, 7, 9, 6, 8) },
      ],
    },
    {
      id: "opencode", label: "OpenCode", kind: "cli",
      available: cliProbe("opencode"), capabilities: { filesystem: true, shell: true, git: true, tests: true, network: false },
      unavailableReason: cliProbe("opencode") ? undefined : "opencode CLI not found on PATH",
      models: [
        { providerId: "0x", model: "alpha-free", label: "0x Alpha Free", efforts: ["LOW", "MEDIUM"], scores: s(5, 4, 7, 4, 10, 10, 8) },
      ],
    },
  ];
}

export const COMPOSER_ROLES: ComposerRoleSpec[] = [
  { roleId: "role_ceo", label: "CEO / Orchestrator", requires: [] },
  { roleId: "role_planner", label: "Planner", requires: [] },
  { roleId: "role_architect", label: "Architect", requires: [] },
  { roleId: "role_backend", label: "Backend Engineer", requires: ["filesystem", "shell", "git", "tests"] },
  { roleId: "role_frontend", label: "Frontend Engineer", requires: ["filesystem", "tests"] },
  { roleId: "role_reviewer", label: "Reviewer", requires: [] },
  { roleId: "role_security", label: "Security", requires: [] },
  { roleId: "role_qa", label: "QA Engineer", requires: ["tests"] },
];

export type TeamComposerPorts = {
  docs: DocumentRepository;
  events: EventStore;
};

export class TeamComposerService {
  constructor(
    private readonly ports: TeamComposerPorts,
    private readonly catalogProvider: () => RuntimeCatalogEntry[],
  ) {}

  catalog(): RuntimeCatalogEntry[] {
    return this.catalogProvider();
  }

  roles(): ComposerRoleSpec[] {
    return COMPOSER_ROLES;
  }

  // ---------- Persistence: org defaults → role bindings → task overrides ----------

  listBindings(projectId: string): RoleRuntimeBinding[] {
    return this.ports.docs.list<RoleRuntimeBinding>("team_binding", projectId);
  }

  getBinding(projectId: string, roleId: string): RoleRuntimeBinding | null {
    return this.ports.docs.get<RoleRuntimeBinding>("team_binding", roleId) ?? null;
  }

  setBinding(projectId: string | null, binding: RoleRuntimeBinding): RoleRuntimeBinding {
    const scope = projectId ?? "*";
    this.ports.docs.put("team_binding", binding.roleId, scope, binding);
    this.emit(scope, "team.binding_set", binding.roleId, { runtimeId: binding.runtimeId, source: binding.source });
    return binding;
  }

  clearBinding(projectId: string, roleId: string): void {
    this.ports.docs.delete("team_binding", roleId);
    this.emit(projectId, "team.binding_cleared", roleId, {});
  }

  orgDefaults(): RoleRuntimeBinding[] {
    return this.ports.docs.list<RoleRuntimeBinding>("team_binding", "*");
  }

  setOrgDefault(binding: RoleRuntimeBinding): RoleRuntimeBinding {
    return this.setBinding(null, binding);
  }

  listTaskOverrides(projectId: string): TaskRuntimeOverride[] {
    return this.ports.docs.list<TaskRuntimeOverride>("team_task_override", projectId);
  }

  setTaskOverride(projectId: string, o: TaskRuntimeOverride): TaskRuntimeOverride {
    this.ports.docs.put("team_task_override", o.taskId, projectId, o);
    this.emit(projectId, "team.task_override_set", o.taskId, { runtimeId: o.runtimeId });
    return o;
  }

  clearTaskOverride(projectId: string, taskId: string): void {
    this.ports.docs.delete("team_task_override", taskId);
  }

  presets(): Record<string, Record<string, { runtimeId: string; model: string; effort: EffortLevel }>> {
    const P = (runtimeId: string, model: string, effort: EffortLevel) => ({ runtimeId, model, effort });
    return {
      quality_first: {
        role_ceo: P("claude-code", "claude-opus-4-6", "HIGH"),
        role_planner: P("codex-cli", "gpt-5.x-reasoning", "HIGH"),
        role_architect: P("claude-code", "claude-opus-4-6", "HIGH"),
        role_backend: P("codex-cli", "gpt-5.x", "HIGH"),
        role_reviewer: P("claude-code", "claude-opus-4-6", "HIGH"),
        role_security: P("claude-code", "claude-sonnet-4-5", "HIGH"),
        role_qa: P("codex-cli", "gpt-5.x", "MEDIUM"),
      },
      balanced: {
        role_ceo: P("claude-code", "claude-opus-4-6", "HIGH"),
        role_planner: P("codex-cli", "gpt-5.x", "MEDIUM"),
        role_architect: P("claude-code", "claude-sonnet-4-5", "MEDIUM"),
        role_backend: P("opencode", "alpha-free", "MEDIUM"),
        role_reviewer: P("codex-cli", "gpt-5.x", "HIGH"),
        role_qa: P("opencode", "alpha-free", "LOW"),
      },
      free_cheap: {
        role_ceo: P("opencode", "alpha-free", "MEDIUM"),
        role_planner: P("opencode", "alpha-free", "MEDIUM"),
        role_backend: P("opencode", "alpha-free", "MEDIUM"),
        role_reviewer: P("mock-runtime", "deterministic-mock-v1", "LOW"),
        role_qa: P("opencode", "alpha-free", "LOW"),
      },
    };
  }

  applyPreset(projectId: string, presetName: string): RoleRuntimeBinding[] {
    const presets = this.presets();
    if (presetName === "my_team") {
      const saved = this.ports.docs.list<RoleRuntimeBinding>("team_preset_my_team", projectId);
      if (saved.length === 0) throw new Error(`[team-composer] preset 'my_team' is empty — save a composition first`);
      for (const b of saved) this.setBinding(projectId, { ...b, source: "PRESET", reasons: [`preset my_team`] });
      return this.listBindings(projectId);
    }
    const preset = presets[presetName];
    if (!preset) throw new Error(`[team-composer] unknown preset '${presetName}'`);
    for (const [roleId, sel] of Object.entries(preset)) {
      this.setBinding(projectId, {
        roleId, runtimeId: sel.runtimeId, providerId: null, model: sel.model, effort: sel.effort,
        fallbacks: [], source: "PRESET", reasons: [`preset ${presetName}`], updatedAt: new Date().toISOString(),
      });
    }
    return this.listBindings(projectId);
  }

  saveAsMyTeam(projectId: string): void {
    for (const b of this.listBindings(projectId)) {
      this.ports.docs.put("team_preset_my_team", b.roleId, projectId, b);
    }
  }

  // ---------- Capacity-aware auto composition with human-readable reasons ----------

  autoCompose(projectId: string, mode: "AUTO" | "RECOMMENDED"): RoleRuntimeBinding[] {
    const catalog = this.catalog();
    const available = catalog.filter((r) => r.available);
    const pick = (roleId: string): { entry: RuntimeCatalogEntry; model: ModelOption; reasons: string[] } => {
      const spec = COMPOSER_ROLES.find((r) => r.roleId === roleId)!;
      const capable = available.filter((r) => spec.requires.every((k) => r.capabilities[k]));
      const pool = capable.length > 0 ? capable : available.filter((r) => r.id === "mock-runtime");
      // Weight by what the role actually does.
      const weight = spec.roleId.includes("planner") || spec.roleId.includes("architect")
        ? (m: ModelOption) => m.scores.planning * 2 + m.scores.reasoning
        : spec.roleId.includes("reviewer") || spec.roleId.includes("security")
          ? (m: ModelOption) => m.scores.review * 2 + m.scores.reasoning
          : spec.roleId.includes("ceo")
            ? (m: ModelOption) => m.scores.reasoning + m.scores.planning
            : (m: ModelOption) => m.scores.coding * 2 + m.scores.capacity - (10 - m.scores.cost);
      const firstEntry = pool[0] ?? available[0]!;
      let best = { entry: firstEntry, model: firstEntry.models[0]!, score: -Infinity };
      for (const r of pool) {
        for (const m of r.models) {
          const score = weight(m);
          if (score > best.score) best = { entry: r, model: m, score };
        }
      }
      const reasons: string[] = [];
      if (spec.requires.length > 0 && capable.length > 0) reasons.push(`supports required tools: ${spec.requires.join(", ")}`);
      else if (capable.length === 0) reasons.push("no capable runtime available — mock fallback keeps work unblocked");
      reasons.push(`best ${spec.label} score ${best.score.toFixed(1)} across capacity/quota and skill fit`);
      reasons.push(`capacity ${best.model.scores.capacity}/10 preserves premium quota for high-judgment roles`);
      return { entry: best.entry, model: best.model, reasons };
    };
    const bindings: RoleRuntimeBinding[] = [];
    for (const role of COMPOSER_ROLES) {
      const chosen = pick(role.roleId);
      const fb = available
        .filter((r) => r.id !== chosen.entry.id)
        .slice(0, 2)
        .map<RuntimeFallback>((r) => ({ runtimeId: r.id, providerId: r.models[0]?.providerId ?? null, model: r.models[0]?.model ?? null, effort: r.models[0]?.efforts[0] ?? null }));
      bindings.push({
        roleId: role.roleId, runtimeId: chosen.entry.id, providerId: chosen.model.providerId,
        model: chosen.model.model, effort: chosen.model.efforts[Math.min(1, chosen.model.efforts.length - 1)],
        permissionPreset: role.requires.length > 0 ? "WORKSPACE" : "READ_ONLY",
        fallbacks: fb, source: mode,
        reasons: chosen.reasons, updatedAt: new Date().toISOString(),
      });
    }
    for (const b of bindings) this.setBinding(projectId, b);
    this.emit(projectId, `team.${mode.toLowerCase()}_composed`, projectId, { roles: bindings.length });
    return bindings;
  }

  /** Compatibility check: does each bound runtime actually support the role's tools? */
  validate(projectId: string): CapabilityMismatch[] {
    const catalog = this.catalog();
    const mismatches: CapabilityMismatch[] = [];
    for (const role of COMPOSER_ROLES) {
      const binding = this.getBinding(projectId, role.roleId) ?? this.orgDefaults().find((b) => b.roleId === role.roleId);
      if (!binding) continue;
      const entry = catalog.find((r) => r.id === binding.runtimeId);
      if (!entry) continue;
      const missing = role.requires.filter((k) => !entry.capabilities[k]);
      if (missing.length > 0 || !entry.available) {
        const recommended = catalog
          .filter((r) => r.available && role.requires.every((k) => r.capabilities[k]) && r.id !== binding.runtimeId)
          .map((r) => r.id);
        mismatches.push({ roleId: role.roleId, runtimeId: binding.runtimeId, required: [...role.requires], missing: entry.available ? missing : [...missing, "available"], recommendedRuntimes: recommended });
      }
    }
    return mismatches;
  }

  /**
   * Resolution chain: task override → project role binding → org default →
   * fallbacks of whichever applies. Nearest wins; unavailable runtimes fall back.
   */
  resolveForTask(projectId: string, taskId: string, ownerRoleId: string | null, runOverride?: Partial<TaskRuntimeOverride>): ResolvedRuntime | null {
    const catalog = this.catalog();
    const usable = (id: string): boolean => catalog.find((r) => r.id === id)?.available === true;
    const toResolved = (
      requested: string,
      primary: { runtimeId: string; providerId?: string | null; model?: string | null; effort?: EffortLevel | null },
      preset: ResolvedRuntime["permissionPreset"],
      fallbacks: RuntimeFallback[],
      chainRoot: string,
      mode?: "LOCKED" | "PREFERRED" | "AUTO",
    ): ResolvedRuntime | null => {
      if (usable(primary.runtimeId)) {
        return { runtimeId: primary.runtimeId, providerId: primary.providerId ?? null, model: primary.model ?? null, effort: primary.effort ?? null, permissionPreset: preset, requestedRuntimeId: requested, fallbackUsed: false, chain: [chainRoot] };
      }
      // LOCKED (§V3-Routing): user pinned this runtime — never auto-switch. Fail closed.
      if (mode === "LOCKED") {
        return null;
      }
      for (const fb of fallbacks) {
        if (usable(fb.runtimeId)) {
          return { runtimeId: fb.runtimeId, providerId: fb.providerId ?? null, model: fb.model ?? null, effort: fb.effort ?? null, permissionPreset: preset, requestedRuntimeId: requested, fallbackUsed: true, chain: [chainRoot, `fallback→${fb.runtimeId}`] };
        }
      }
      if (usable("mock-runtime")) {
        return { runtimeId: "mock-runtime", providerId: "mock", model: "deterministic-mock-v1", effort: "LOW", permissionPreset: preset, requestedRuntimeId: requested, fallbackUsed: true, chain: [chainRoot, "fallback→mock-runtime"] };
      }
      return null;
    };

    const stored = this.ports.docs.get<TaskRuntimeOverride>("team_task_override", taskId);
    const effOv = runOverride?.runtimeId ? { ...(stored ?? { taskId, roleId: ownerRoleId, updatedAt: "" }), ...runOverride } as TaskRuntimeOverride : stored;
    const projectBinding = ownerRoleId ? this.listBindings(projectId).find((b) => b.roleId === ownerRoleId) ?? null : null;
    const orgBinding = ownerRoleId ? this.orgDefaults().find((b) => b.roleId === ownerRoleId) ?? null : null;
    const binding = projectBinding ?? orgBinding;
    const preset = binding?.permissionPreset ?? "WORKSPACE";

    if (effOv) {
      return toResolved(effOv.runtimeId, effOv, preset, binding?.fallbacks ?? [], "task-override");
    }
    if (projectBinding) {
      return toResolved(projectBinding.runtimeId, projectBinding, preset, projectBinding.fallbacks, "role-binding", projectBinding.routingMode ?? "AUTO");
    }
    if (orgBinding) {
      return toResolved(orgBinding.runtimeId, orgBinding, orgBinding.permissionPreset ?? "WORKSPACE", orgBinding.fallbacks, "org-default", orgBinding.routingMode ?? "AUTO");
    }
    // Nothing composed — engine default keeps work unblocked.
    return toResolved("mock-runtime", { runtimeId: "mock-runtime" }, preset, [], "engine-default");
  }

  private emit(projectId: string, type: string, entityId: string | null, payload: Record<string, unknown>): void {
    this.ports.events.append({ projectId: projectId as never, type: type as never, entityType: "event", entityId, actorType: "USER", payload });
  }
}
