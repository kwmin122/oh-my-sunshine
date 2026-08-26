import { useEffect, useState } from "react";
import { api, type OverviewDTO, type TaskDTO } from "../../client/api.js";
import { Chip, Empty, Panel, StatusDot, timeAgo } from "../shared.js";

/** Mission Control (spec §5.1): health, agents, needs-you, risks, latest events. */
export function MissionControl({ projectId, overview, onChanged, onNavigate }: {
  projectId: string;
  overview: OverviewDTO | null;
  onChanged: () => void;
  onNavigate: (tab: string) => void;
}): JSX.Element {
  const [coverage, setCoverage] = useState<{ readiness: { overallScore: number; readyForPlanning: boolean } | null } | null>(null);
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [events, setEvents] = useState<Array<{ sequence: number; type: string; timestamp: string; actorType: string }>>([]);
  const [capabilities, setCapabilities] = useState<Array<{ capability: string; status: string; version?: string | null }>>([]);

  useEffect(() => {
    void api.get<{ readiness: { overallScore: number; readyForPlanning: boolean } | null }>(`/api/projects/${projectId}/readiness`).then((r) => setCoverage(r)).catch(() => setCoverage(null));    void api.get<{ tasks: TaskDTO[] }>(`/api/projects/${projectId}/tasks`).then((r) => setTasks(r.tasks));
    void api.get<{ events: Array<{ sequence: number; type: string; timestamp: string; actorType: string }> }>(`/api/projects/${projectId}/events`).then((r) => setEvents(r.events.slice(-8).reverse()));
    void api.get<{ capabilities: Array<{ capability: string; status: string; version?: string | null }> }>("/api/readiness").then((r) => setCapabilities(r.capabilities));
  }, [projectId, onChanged]);

  const done = tasks.filter((t) => t.status === "DONE").length;
  const implementation = tasks.length > 0 ? done / tasks.length : 0;
  const needsYou = (overview?.openDecisions.length ?? 0) + (overview?.openApprovals.length ?? 0);
  const highRisk = [...tasks].filter((t) => t.riskTier === "HIGH" && t.status !== "DONE").length;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <Panel title="Project Health">
        <div className="space-y-2.5">
          <HealthBar label="Requirements" value={coverage?.readiness ? Math.min(1, coverage.readiness.overallScore + 0.05) : 0} />
          <HealthBar label="Implementation" value={implementation} />
          <HealthBar label="Verification" value={tasks.length > 0 ? done / tasks.length : 0} />
          <HealthBar label="Release Readiness" value={needsYou === 0 && highRisk === 0 && tasks.every((t) => t.status === "DONE") && tasks.length > 0 ? 1 : implementation * 0.7} />
        </div>
      </Panel>

      <Panel title="Needs You" right={needsYou > 0 ? <Chip tone="bad">{needsYou} pending</Chip> : <Chip tone="good">clear</Chip>}>
        {(overview?.openDecisions.length ?? 0) === 0 && (overview?.openApprovals.length ?? 0) === 0 ? (
          <Empty>Nothing requires your judgment right now.</Empty>
        ) : (
          <div className="space-y-2">
            {overview!.openDecisions.map((d) => (
              <button key={d.id} onClick={() => onNavigate("inbox")} className="btn w-full text-left text-xs">
                <span className="mono mr-1 text-amber-300">DEC</span>{d.question.slice(0, 80)}
              </button>
            ))}
            {overview!.openApprovals.map((a) => (
              <button key={a.id} onClick={() => onNavigate("inbox")} className="btn btn-danger w-full text-left text-xs">
                APPROVAL · {a.requestedActionSummary}
              </button>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="System Readiness" right={<button className="text-xs text-sky-400 hover:underline" onClick={() => onNavigate("readiness")}>details →</button>}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          {capabilities.map((c) => (
            <div key={c.capability} className="flex items-center">
              <StatusDot status={c.status} />
              <span className="text-neutral-300">{c.capability}</span>
              <span className="mono ml-auto text-neutral-600">{c.version ?? ""}</span>
            </div>
          ))}
          {capabilities.length === 0 && <Empty>No probes run yet.</Empty>}
        </div>
      </Panel>

      <Panel title="Agents / Runs" right={<button className="text-xs text-sky-400 hover:underline" onClick={() => onNavigate("agents")}>office →</button>}>
        {(overview?.runs.length ?? 0) === 0 ? (
          <Empty>No agent runs yet.</Empty>
        ) : (
          <ul className="space-y-1.5 text-xs">
            {overview!.runs.slice(-5).reverse().map((r) => (
              <li key={r.id} className="flex items-center justify-between rounded border border-neutral-800 px-2 py-1.5">
                <span><StatusDot status={r.status} />attempt {r.attempt}</span>
                <span className="text-neutral-400">{r.summary ?? r.failureReason ?? r.status}</span>
                <Chip tone={r.status === "SUCCEEDED" ? "good" : r.status === "FAILED" ? "bad" : "warn"}>{r.status.toLowerCase()}</Chip>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Recommendations">
        {(overview?.recommendations.length ?? 0) === 0 ? (
          <Empty>No recommendations.</Empty>
        ) : (
          <ul className="space-y-1.5 text-xs">
            {overview!.recommendations.map((rec) => (
              <li key={rec.id} className="rounded border border-neutral-800 px-2 py-1.5">
                <span className="mono mr-1 text-sky-300">{rec.actionType}</span>
                <span className="text-neutral-300">{rec.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Latest Events" right={<button className="text-xs text-sky-400 hover:underline" onClick={() => onNavigate("timeline")}>timeline →</button>}>
        <ul className="space-y-1 font-mono text-[11px] text-neutral-400">
          {events.map((e) => (
            <li key={e.sequence} className="flex justify-between gap-2">
              <span className="truncate">{e.type}</span>
              <span className="shrink-0 text-neutral-600">{timeAgo(e.timestamp)}</span>
            </li>
          ))}
          {events.length === 0 && <Empty>No events yet.</Empty>}
        </ul>
      </Panel>
    </div>
  );
}

function HealthBar({ label, value }: { label: string; value: number }): JSX.Element {
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? "bg-emerald-500" : pct >= 50 ? "bg-sky-500" : pct >= 25 ? "bg-amber-500" : "bg-red-500";
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-neutral-400">{label}</span>
        <span className="mono text-neutral-200">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-neutral-800">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
