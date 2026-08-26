import { useEffect, useState } from "react";
import { api, type CapabilityDTO, type ConflictDTO, type CoverageDTO, type DiscoveryDTO, type EvidenceRowDTO, type EventDTO } from "../../client/api.js";
import { Chip, Empty, Panel, StatusDot, timeAgo } from "../shared.js";

export function EvidenceCenter({ projectId }: { projectId: string }): JSX.Element {
  const [rows, setRows] = useState<EvidenceRowDTO | null>(null);
  useEffect(() => { void api.get<EvidenceRowDTO>(`/api/projects/${projectId}/evidence`).then(setRows); }, [projectId]);

  const toneFor = (status: string, freshness: string): "good" | "warn" | "bad" =>
    status === "PASS" ? (freshness === "FRESH" ? "good" : "warn") : "bad";

  return (
    <Panel title="Evidence Center">
      {!rows || (rows.evidence.length === 0 && rows.reviews.length === 0) ? (
        <Empty>No evidence yet — verification runs create revision-bound records here.</Empty>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-neutral-500">
            <tr><th className="pb-2">Type</th><th>Result</th><th>Freshness</th><th>Revision</th><th>Method</th><th>When</th></tr>
          </thead>
          <tbody>
            {rows.evidence.map((e) => (
              <tr key={e.id} className="border-t border-neutral-800">
                <td className="py-1.5 mono">{e.type}</td>
                <td><Chip tone={toneFor(e.status, e.freshness)}>{e.status}</Chip></td>
                <td><Chip tone={e.freshness === "FRESH" ? "good" : "warn"}>{e.freshness}</Chip></td>
                <td className="mono text-neutral-500">{e.revision.slice(0, 8)}</td>
                <td className="text-neutral-400">{e.commandOrMethod}</td>
                <td className="text-neutral-600">{timeAgo(e.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && rows.reviews.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-[11px] uppercase tracking-wider text-neutral-500">Reviews</h3>
          {rows.reviews.map((r) => (
            <details key={r.id} className="rounded border border-neutral-800 p-2 text-xs">
              <summary className="flex cursor-pointer items-center gap-2">
                <StatusDot status={r.status} />
                <span className="mono">{r.type}</span>
                <span className="text-neutral-500">score {r.score}</span>
                {r.blockingCount > 0 ? <Chip tone="bad">{r.blockingCount} blocking</Chip> : <Chip tone="good">passed</Chip>}
              </summary>
              <ul className="mt-2 space-y-1.5">
                {r.findings.map((f) => (
                  <li key={f.id} className="rounded bg-neutral-800/60 p-2">
                    <div className="flex gap-2">
                      <Chip tone={f.severity === "BLOCKER" ? "bad" : f.severity === "HIGH" ? "warn" : "neutral"}>{f.severity}</Chip>
                      <span className="mono text-neutral-500">conf {Math.round(f.confidence * 100)}%</span>
                      {f.disposition !== "OPEN" ? <Chip tone="info">{f.disposition}{f.dispositionReason ? `: ${f.dispositionReason}` : ""}</Chip> : null}
                    </div>
                    <p className="mt-1 text-neutral-300">{f.statement}</p>
                  </li>
                ))}
                {r.findings.length === 0 && <li className="text-neutral-500">No findings.</li>}
              </ul>
            </details>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function TimelineView({ projectId }: { projectId: string }): JSX.Element {
  const [events, setEvents] = useState<EventDTO[]>([]);
  const [filter, setFilter] = useState("");
  const load = async (): Promise<void> => {
    const r = await api.get<{ events: EventDTO[] }>(`/api/projects/${projectId}/events`);
    setEvents(r.events);
  };
  useEffect(() => { void load(); }, [projectId]);
  const shown = events.filter((e) => filter === "" || e.type.includes(filter));
  return (
    <Panel title={`Timeline (${events.length} events)`} right={
      <input className="input max-w-48 py-1 text-xs" placeholder="filter type…" value={filter} onChange={(e) => setFilter(e.target.value)} />
    }>
      {shown.length === 0 ? <Empty>No events match.</Empty> : (
        <ol className="relative space-y-1.5 border-l border-neutral-800 pl-4 mono text-[11px]">
          {shown.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full border border-neutral-600 bg-neutral-900" />
              <span className="text-neutral-600">{e.timestamp.slice(11, 19)}</span>{" "}
              <span className="text-sky-300">{e.type}</span>{" "}
              <span className="text-neutral-500">[{e.actorType.toLowerCase()}]</span>{" "}
              <span className="text-neutral-400">{summarize(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function summarize(e: EventDTO): string {
  const bits = Object.entries(e.payload).slice(0, 3).map(([k, v]) => `${k}=${typeof v === "object" ? "…" : String(v).slice(0, 40)}`);
  return bits.join(" ");
}

export function SystemReadinessView(): JSX.Element {
  const [caps, setCaps] = useState<CapabilityDTO[]>([]);
  const load = (): void => { void api.get<{ capabilities: CapabilityDTO[] }>("/api/readiness").then((r) => setCaps(r.capabilities)); };
  useEffect(load, []);
  return (
    <Panel title="System Readiness" right={<button className="btn text-xs" onClick={load}>Re-check</button>}>
      <ul className="space-y-1.5 text-sm">
        {caps.map((c) => (
          <li key={c.capability} className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2">
            <span className="flex items-center"><StatusDot status={c.status} /><span className="mono">{c.capability}</span></span>
            <span className="text-xs text-neutral-500">{c.version ?? c.diagnostic}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-neutral-600">A task that requires a missing capability is marked BLOCKED with the exact remediation — it will not pretend to run.</p>
    </Panel>
  );
}

export function ConflictCenter({ projectId }: { projectId: string }): JSX.Element {
  const [conflicts, setConflicts] = useState<ConflictDTO[]>([]);
  const load = (): void => { void api.get<{ conflicts: ConflictDTO[] }>(`/api/projects/${projectId}/conflicts`).then((r) => setConflicts(r.conflicts)); };
  useEffect(load, [projectId]);
  return (
    <Panel title="Conflict Center" right={<button className="btn text-xs" onClick={load}>Refresh</button>}>
      {conflicts.length === 0 ? <Empty>No contradictions detected between proposals and canon.</Empty> : (
        <ul className="space-y-3">
          {conflicts.map((c) => (
            <li key={c.id} className="rounded-lg border border-red-900/50 p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="mono text-red-300">{c.type}</span>
                <Chip tone={c.severity === "HIGH" || c.severity === "CRITICAL" ? "bad" : "warn"}>{c.severity}</Chip>
              </div>
              <p className="mt-1.5 text-neutral-300">{c.leftEntity}</p>
              <p className="my-0.5 text-center text-neutral-600">vs</p>
              <p className="text-neutral-300">{c.rightEntity}</p>
              <p className="mt-1.5 text-neutral-500">{c.explanation}</p>
              <div className="mt-2 flex gap-2">
                <button className="btn text-xs" onClick={async () => { await api.post(`/api/conflicts/${c.id}/resolve`, { resolution: "Kept existing decision", acceptAsIs: false }); load(); }}>Keep existing</button>
                <button className="btn text-xs" onClick={async () => { await api.post(`/api/conflicts/${c.id}/resolve`, { resolution: "Accepted new direction deliberately", acceptAsIs: true }); load(); }}>Accept new ADR path</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function DiscoveryHistory({ projectId, discovery }: { projectId: string; discovery: DiscoveryDTO | null }): JSX.Element {
  void projectId;
  return (
    <Panel title="Requirements & Intent">
      {discovery?.intent?.[0] != null && (
        <div className="mb-3 rounded border border-neutral-800 p-2 text-xs">
          <span className="mono text-sky-300">Intent:</span> {discovery.intent[0].type} → {discovery.intent[0].recommendedEntryPoint}
          {discovery.intent[0].hiddenDimensions.length > 0 && (
            <span className="text-neutral-500"> · hidden dimensions: {discovery.intent[0].hiddenDimensions.join(", ")}</span>
          )}
        </div>
      )}
      {!discovery || discovery.requirements.length === 0 ? <Empty>No requirements recorded yet.</Empty> : (
        <ul className="space-y-1 text-xs">
          {discovery.requirements.map((r) => (
            <li key={r.id} className="flex gap-2 rounded border border-neutral-800 px-2 py-1.5">
              <span className="mono shrink-0 text-neutral-500">{r.stableKey}</span>
              <span className="truncate text-neutral-200">{r.statement}</span>
              <span className="ml-auto shrink-0"><Chip>{r.source.toLowerCase()}</Chip></span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
