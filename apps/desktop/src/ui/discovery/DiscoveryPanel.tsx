import { useState } from "react";
import { api, type CoverageDTO, type DiscoveryDTO } from "../../client/api.js";
import { Bar, Chip, Empty, Panel } from "../shared.js";

export function DiscoveryPanel({ projectId, discovery, coverage, onChanged }: {
  projectId: string;
  discovery: DiscoveryDTO | null;
  coverage: CoverageDTO | null;
  onChanged: () => void;
}): JSX.Element {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = discovery?.openQuestion ?? null;

  const submit = async (optionKey?: string): Promise<void> => {
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/projects/${projectId}/questions/${q.id}/answer`, {
        answer: optionKey ? `${optionKey}` : answer,
        optionKey,
      });
      setAnswer("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Requirement Readiness" right={coverage ? <Chip tone={coverage.readyForPlanning ? "good" : "warn"}>{coverage.readyForPlanning ? "READY FOR PLANNING" : "IN DISCOVERY"}</Chip> : undefined}>
        {!coverage ? (
          <Empty>Submit a mission to compute requirement coverage.</Empty>
        ) : (
          <>
            <div className="space-y-2">
              {[...coverage.coverage]
                .sort((a, b) => a.score - b.score)
                .slice(0, 12)
                .map((c) => (
                  <Bar key={c.category} label={c.category.replace(/_/g, " ")} value={c.score} hint={c.state.toLowerCase()} />
                ))}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-neutral-800 pt-3 text-xs text-neutral-400">
              <span>Overall</span>
              <span className="mono text-neutral-200">{Math.round(coverage.overallScore * 100)}%</span>
            </div>
            {coverage.missingForReady.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-red-300">
                {coverage.missingForReady.slice(0, 4).map((m) => (
                  <li key={m}>• {m}</li>
                ))}
              </ul>
            )}
            {coverage.readyForPlanning && coverage.missingForReady.length === 0 && (
              <p className="mt-2 text-xs text-emerald-300">Definition of Ready reached — planning unlocked.</p>
            )}
          </>
        )}
      </Panel>

      <Panel title="Discovery Interview">
        {!q ? (
          <Empty>No open question. {discovery && discovery.questions.length > 0 ? `${discovery.questions.length} answered so far.` : ""}</Empty>
        ) : (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-neutral-500">{q.category.replace(/_/g, " ")}</p>
            <p className="mt-1 text-sm font-medium text-neutral-100">{q.question}</p>
            <p className="mt-2 text-xs text-neutral-400"><span className="text-neutral-500">Why this matters:</span> {q.whyItMatters}</p>
            {q.options.length > 0 ? (
              <div className="mt-3 space-y-2">
                {q.options.map((o) => (
                  <button key={o.key} disabled={busy} onClick={() => submit(o.key)}
                    className={`btn w-full text-left ${o.key === q.recommendedOption ? "border-sky-600" : ""}`}>
                    <span className="mono mr-2 text-neutral-400">{o.key}.</span>
                    {o.label}
                    {o.key === q.recommendedOption ? <Chip tone="info">recommended</Chip> : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <input className="input" placeholder="Your answer…" value={answer} onChange={(e) => setAnswer(e.target.value)} />
                <button className="btn btn-primary" disabled={busy || answer.trim().length === 0} onClick={() => submit()}>Answer</button>
              </div>
            )}
            {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
