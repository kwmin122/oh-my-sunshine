import { useState } from "react";
import { api, type OverviewDTO } from "../../client/api.js";
import { Chip, Empty, Panel } from "../shared.js";

/** Decision Inbox + Approval Inbox (spec §5.5, §5.6). Answering resumes blocked work automatically. */
export function Inboxes({ overview, onChanged }: { overview: OverviewDTO | null; onChanged: () => void }): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <DecisionInbox decisions={overview?.openDecisions ?? []} onChanged={onChanged} />
      <ApprovalInbox approvals={overview?.openApprovals ?? []} onChanged={onChanged} />
    </div>
  );
}

function DecisionInbox({ decisions, onChanged }: { decisions: OverviewDTO["openDecisions"]; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const resolve = async (id: string, option: string): Promise<void> => {
    setBusy(id);
    try {
      await api.post(`/api/decisions/${id}/resolve`, { chosenOption: option });
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel title={`Decision Inbox (${decisions.length})`}>
      {decisions.length === 0 ? (
        <Empty>No open decisions.</Empty>
      ) : (
        <ul className="space-y-3">
          {decisions.map((d) => (
            <li key={d.id} className="rounded-lg border border-amber-900/60 bg-neutral-900 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="mono text-amber-300">{d.stableKey}</span>
                <Chip tone={d.severity === "HIGH" || d.severity === "CRITICAL" ? "bad" : "warn"}>{d.severity}</Chip>
              </div>
              <p className="mt-1.5 text-sm text-neutral-100">{d.question}</p>
              <p className="mt-1 text-xs text-neutral-500">{d.context}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {d.options.map((o) => (
                  <button key={o.key} disabled={busy === d.id}
                    onClick={() => resolve(d.id, o.label)}
                    className={`btn text-xs ${o.key === d.recommendation ? "border-sky-600" : ""}`}>
                    {o.key}. {o.label}
                    {o.key === d.recommendation ? " ★" : ""}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ApprovalInbox({ approvals, onChanged }: { approvals: OverviewDTO["openApprovals"]; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (id: string, outcome: "ALLOW_ONCE" | "REJECTED"): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await api.post(`/api/approvals/${id}/resolve`, { outcome });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel title={`Approval Inbox (${approvals.length})`}>
      {approvals.length === 0 ? (
        <Empty>No pending approvals — dangerous actions are fail-closed until you allow them.</Empty>
      ) : (
        <ul className="space-y-3">
          {approvals.map((a) => (
            <li key={a.id} className="rounded-lg border border-red-900/60 bg-neutral-900 p-3">
              <div className="flex items-center justify-between">
                <span className="mono text-red-300">{a.requestedActionSummary}</span>
                <Chip tone="bad">{a.severity}</Chip>
              </div>
              <p className="mt-1 text-xs text-neutral-400">{a.reason}</p>
              <p className="mt-0.5 text-[11px] text-neutral-600">requested by {a.requestingAgentRole}</p>
              <div className="mt-2 flex gap-2">
                <button className="btn btn-primary text-xs" disabled={busy === a.id} onClick={() => resolve(a.id, "ALLOW_ONCE")}>Allow once</button>
                <button className="btn btn-danger text-xs" disabled={busy === a.id} onClick={() => resolve(a.id, "REJECTED")}>Reject</button>
              </div>
              {error ? <p className="mt-1 text-xs text-red-400">{error}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
