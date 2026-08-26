import { useEffect, useState } from "react";
import { api } from "../../client/api.js";
import { Chip, Empty, Panel, StatusDot } from "../shared.js";

/** Agent Office / Org Chart (spec §5.3) + Agent Capacity HUD (§5.18).
 * Shows operational activity only — never chain-of-thought. */
export function AgentOffice({ projectId }: { projectId: string }): JSX.Element {
  const [roles, setRoles] = useState<Array<{ id: string; name: string; responsibility: string; defaultPolicyPreset: string }>>([]);
  const [runs, setRuns] = useState<Array<{ id: string; status: string; attempt: number; summary: string | null; failureReason: string | null; agentRoleId: string; startedAt: string | null }>>([]);
  const [sessions, setSessions] = useState<Array<{ id: string; roleId: string; liveness: string; waitingReason: string | null; lastProgressAt: string }>>([]);

  useEffect(() => {
    void api.get<{ runs: OverviewRuns }>("/api/health").catch(() => undefined);
  }, []);
  useEffect(() => {
    const load = async (): Promise<void> => {
      const ov = await api.get<{ overview?: unknown }>(`/api/projects/${projectId}/overview`).catch(() => null);
      void ov;
      // roles are global
      const r = await api.get<{ providers: string[] }>("/api/providers");
      void r;
    };
    void load();
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [ov, sess] = await Promise.all([
          api.get<{ runs: typeof runs }>(`/api/projects/${projectId}/overview`),
          api.get<{ sessions?: typeof sessions }>(`/api/projects/${projectId}/overview`).catch(() => ({ sessions: [] })),
        ]);
        if (!cancelled) {
          setRuns(ov.runs ?? []);
          setSessions(sess.sessions ?? []);
        }
      } catch {
        if (!cancelled) setRuns([]);
      }
    };
    void load();
    const t = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [projectId]);

  const activeLiveness = new Map(sessions.map((s) => [s.roleId, s]));
  const roleOf = (roleId: string): string => roles.find((r) => r.id === roleId)?.name ?? "agent";

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Agent Runs (disposable sessions)">
        {runs.length === 0 ? <Empty>No runs yet — execute a task to see live activity.</Empty> : (
          <ul className="space-y-1.5 text-xs">
            {[...runs].reverse().slice(0, 12).map((r) => (
              <li key={r.id} className="rounded border border-neutral-800 px-2.5 py-2">
                <div className="flex items-center justify-between">
                  <span><StatusDot status={r.status} /><span className="mono text-neutral-300">run {r.id.slice(-6)}</span></span>
                  <span className="text-neutral-500">{roleOf(r.agentRoleId)} · attempt {r.attempt}</span>
                  <Chip tone={r.status === "SUCCEEDED" ? "good" : r.status === "FAILED" ? "bad" : "warn"}>{r.status.toLowerCase()}</Chip>
                </div>
                {(r.summary ?? r.failureReason) && <p className="mt-1 truncate text-neutral-500">{r.summary ?? r.failureReason}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Session Liveness (watchdog)">
        {sessions.length === 0 ? <Empty>No live sessions.</Empty> : (
          <ul className="space-y-1.5 text-xs">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded border border-neutral-800 px-2.5 py-2">
                <span><StatusDot status={s.liveness} />{roleOf(s.roleId)}</span>
                <span className="text-neutral-500">{s.waitingReason ? `waiting: ${s.waitingReason}` : s.liveness.toLowerCase()}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-neutral-600">Approval/decision waits get extended grace before any stall classification — a legitimate wait is never a stall (spec §3.8).</p>
      </Panel>
    </div>
  );
}

type OverviewRuns = Array<unknown>;
