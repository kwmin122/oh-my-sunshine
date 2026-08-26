import { useCallback, useEffect, useState } from "react";
import { api } from "../../client/api.js";
import { Chip, Empty, Panel } from "../shared.js";

/**
 * AI Team Composer (spec §31). Role → Runtime → Provider → Model → Effort →
 * Tools → Permissions → Capacity → Fallback. Modes: Auto / Recommended / Manual.
 */
type Effort = "LOW" | "MEDIUM" | "HIGH" | "MAX";

interface ModelOptionDTO {
  providerId: string; model: string; label: string; efforts: Effort[];
  scores: { reasoning: number; planning: number; coding: number; review: number; capacity: number; cost: number; latency: number };
}
interface CatalogEntry {
  id: string; label: string; kind: string; available: boolean;
  capabilities: Record<string, boolean>; models: ModelOptionDTO[]; unavailableReason?: string;
}
interface RoleSpec { roleId: string; label: string; requires: string[] }
interface Binding {
  roleId: string; runtimeId: string; providerId?: string | null; model?: string | null;
  effort?: Effort | null; permissionPreset?: string | null; source: string; reasons: string[];
  fallbacks: Array<{ runtimeId: string; model?: string | null; effort?: Effort | null }>;
}
interface Mismatch { roleId: string; runtimeId: string; required: string[]; missing: string[]; recommendedRuntimes: string[] }
interface Composition {
  bindings: Binding[]; orgDefaults: Binding[]; taskOverrides: unknown[];
  mismatches: Mismatch[]; catalog: CatalogEntry[]; roles: RoleSpec[];
}

const PRESETS = [
  ["quality_first", "Quality First"],
  ["balanced", "Balanced"],
  ["free_cheap", "Free / Cheap"],
  ["my_team", "My Team"],
] as const;

export function TeamComposer({ projectId, onChanged }: { projectId: string; onChanged: () => void }): JSX.Element {
  const [data, setData] = useState<Composition | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleResp, setNewRoleResp] = useState("");
  const [newRolePreset, setNewRolePreset] = useState("READ_ONLY");
  const [newRoleCaps, setNewRoleCaps] = useState<string[]>([]);

  const load = useCallback(async (): Promise<void> => {
    setData(await api.get<Composition>(`/api/team/composition/${projectId}`));
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<void>, okMsg: string): Promise<void> => {
    setBusy(true); setNotice(null);
    try { await fn(); await load(); onChanged(); setNotice(okMsg); }
    catch (err) { setNotice(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const compose = (mode: "AUTO" | "RECOMMENDED"): Promise<void> =>
    act(async () => { await api.post(`/api/team/auto-compose/${projectId}?mode=${mode}`, {}); }, mode === "AUTO" ? "Auto team composed." : "Recommended team loaded — adjust and save.");
  const applyPreset = (preset: string): Promise<void> =>
    act(async () => { await api.post("/api/team/preset/apply", { projectId, preset }); }, `Preset "${preset}" applied.`);
  const saveMyTeam = (): Promise<void> => act(async () => { await api.post("/api/team/preset/save-my-team", { projectId }); }, "Saved as My Team.");

  const saveRole = async (roleId: string, patch: Partial<Binding>): Promise<void> => {
    const prev = data?.bindings.find((b) => b.roleId === roleId);
    const entry = data?.catalog.find((c) => c.id === (patch.runtimeId ?? prev?.runtimeId));
    const model = patch.model ?? prev?.model ?? entry?.models[0]?.model ?? null;
    const providerId = entry?.models.find((m) => m.model === model)?.providerId ?? null;
    const effort = patch.effort ?? prev?.effort ?? entry?.models.find((m) => m.model === model)?.efforts[0] ?? null;
    await api.put("/api/team/role", {
      projectId, roleId, runtimeId: patch.runtimeId ?? prev?.runtimeId ?? entry?.id,
      providerId, model, effort,
      permissionPreset: patch.permissionPreset ?? prev?.permissionPreset ?? undefined,
      fallbacks: prev?.fallbacks ?? [],
    });
    await load(); onChanged();
  };

  return (
    <div className="space-y-4">
      <Panel title="AI Team Composer" right={notice ? <Chip tone="info">{notice}</Chip> : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={busy} onClick={() => void compose("AUTO")}>Auto — compose for me</button>
          <button className="btn" disabled={busy} onClick={() => void compose("RECOMMENDED")}>Recommended — editable</button>
          <span className="mx-2 text-neutral-600">|</span>
          {PRESETS.map(([key, label]) => (
            <button key={key} className="btn text-xs" disabled={busy} onClick={() => void applyPreset(key)}>{label}</button>
          ))}
          <button className="btn text-xs" disabled={busy} onClick={() => void saveMyTeam()}>Save as My Team</button>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Mode 3 · Manual: pick Runtime / Model / Effort per role below. Nearest override wins: org → role → task → run.
        </p>
      </Panel>

      {(data?.mismatches.length ?? 0) > 0 && (
        <Panel title="⚠ INCOMPATIBLE RUNTIME">
          <ul className="space-y-2">
            {data!.mismatches.map((m) => (
              <li key={m.roleId} className="rounded border border-amber-900/60 bg-amber-950/20 p-3 text-xs">
                <span className="mono text-amber-300">{m.roleId}</span> on <span className="mono">{m.runtimeId}</span>
                {m.missing.includes("available") ? <p className="mt-1 text-red-300">runtime unavailable</p> : null}
                <p className="mt-1">missing: {m.missing.filter((x) => x !== "available").join(", ") || "—"}</p>
                <p className="text-neutral-400">required: {m.required.join(", ")}</p>
                {m.recommendedRuntimes.length > 0 && <p className="mt-1 text-emerald-300">recommended: {m.recommendedRuntimes.join(", ")}</p>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="AI TEAM SETUP">
        {!data ? <Empty>Loading composition…</Empty> : (
          <table className="w-full text-left text-xs">
            <thead><tr className="text-neutral-500"><th className="py-1">Role</th><th>Runtime</th><th>Model</th><th>Effort</th><th>Fallbacks</th></tr></thead>
            <tbody>
              {data.roles.map((role) => {
                const b = data.bindings.find((x) => x.roleId === role.roleId) ?? data.orgDefaults.find((x) => x.roleId === role.roleId);
                const rt = data.catalog.find((c) => c.id === b?.runtimeId);
                return (
                  <tr key={role.roleId} className="border-t border-neutral-800">
                    <td className="py-1.5 pr-2">
                      {role.label}
                      {b && <Chip tone={b.source === "AUTO" || b.source === "PRESET" ? "info" : "good"}>{b.source.toLowerCase()}</Chip>}
                    </td>
                    <td>
                      <select className="input py-0.5 text-xs" value={b?.runtimeId ?? ""} disabled={busy}
                        onChange={(e) => void saveRole(role.roleId, { runtimeId: e.target.value })}>
                        {data.catalog.map((c) => (
                          <option key={c.id} value={c.id}>{c.label}{c.available ? "" : " (unavailable)"}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className="input py-0.5 text-xs" value={b?.model ?? ""} disabled={busy || !rt}
                        onChange={(e) => void saveRole(role.roleId, { model: e.target.value })}>
                        {(rt?.models ?? []).map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <select className="input py-0.5 text-xs" value={b?.effort ?? ""} disabled={busy || !rt}
                        onChange={(e) => void saveRole(role.roleId, { effort: e.target.value as Effort })}>
                        {(rt?.models.find((m) => m.model === b?.model)?.efforts ?? []).map((ef) => <option key={ef} value={ef}>{ef}</option>)}
                      </select>
                    </td>
                    <td className="mono text-[10px] text-neutral-500">
                      {(b?.fallbacks ?? []).map((f) => f.runtimeId).join(" → ") || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data?.bindings.some((b) => b.reasons.length > 0) && (
          <details className="mt-3 rounded border border-neutral-800 p-2 text-xs text-neutral-400">
            <summary className="cursor-pointer">Selection rationale</summary>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {data.bindings.flatMap((b) => b.reasons.map((r, i) => (
                <li key={`${b.roleId}-${i}`}><span className="mono text-neutral-300">{b.roleId}</span> — {r}</li>
              )))}
            </ul>
          </details>
        )}
      </Panel>

      <Panel title="CUSTOM ROLES" right={<Chip tone="info">V3 §20</Chip>}>
        <div className="space-y-2 text-xs">
          {data && (
            <div className="flex flex-wrap gap-1.5">
              {data.roles.filter((r) => r.roleId.startsWith("role_custom_")).map((r) => (
                <Chip key={r.roleId} tone="info">{r.label}</Chip>
              ))}
              {data.roles.every((r) => !r.roleId.startsWith("role_custom_")) && <span className="text-neutral-500">No custom roles yet.</span>}
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <input className="input py-1 text-xs" placeholder="role name (e.g. Performance Reviewer)" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} />
            <input className="input py-1 text-xs" placeholder="responsibility (one line)" value={newRoleResp} onChange={(e) => setNewRoleResp(e.target.value)} />
            <select className="input py-1 text-xs" value={newRolePreset} onChange={(e) => setNewRolePreset(e.target.value)}>
              <option value="READ_ONLY">READ_ONLY</option>
              <option value="WORKSPACE">WORKSPACE</option>
              <option value="ELEVATED_ALLOWED">ELEVATED_ALLOWED</option>
            </select>
            <div className="flex items-center gap-2">
              {["filesystem", "shell", "git", "tests", "network"].map((cap) => (
                <label key={cap} className="flex items-center gap-1 text-neutral-400">
                  <input type="checkbox" checked={newRoleCaps.includes(cap)}
                    onChange={(e) => setNewRoleCaps(e.target.checked ? [...newRoleCaps, cap] : newRoleCaps.filter((c) => c !== cap))} />
                  {cap}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" disabled={busy || !newRoleName.trim() || !newRoleResp.trim()}
            onClick={() => void act(async () => {
              await api.post("/api/team/custom-roles", {
                name: newRoleName.trim(), responsibility: newRoleResp.trim(),
                permissionPreset: newRolePreset,
                requiredCapabilities: newRoleCaps,
              });
              setNewRoleName(""); setNewRoleResp(""); setNewRoleCaps([]);
            }, "Custom role created — assign a runtime above.")}>
            Create role
          </button>
        </div>
      </Panel>
    </div>
  );
}
