import { useEffect, useState } from "react";
import { api } from "../../client/api.js";
import { Chip, Empty, Panel, StatusDot } from "../shared.js";

/** Provider Capacity Center (spec §5.16). Unknown quota stays unknown — never fabricated. */
export function CapacityCenter(): JSX.Element {
  const [caps, setCaps] = useState<Array<{ id: string; provider: string; limitType: string; usedPercentRemaining: number | null; health: string; source: string; confidence: number; refreshedAt: string; contextUsedTokens: number | null; contextLimitTokens: number | null }>>([]);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const r = await api.get<{ capacities: typeof caps }>("/api/capacity");
    setCaps(r.capacities);
  };
  useEffect(() => { void load(); }, []);

  return (
    <Panel title="AI Capacity" right={
      <button className="btn text-xs" disabled={busy} onClick={async () => { setBusy(true); try { await api.post("/api/capacity/refresh"); await load(); } finally { setBusy(false); } }}>Refresh</button>
    }>
      {caps.length === 0 ? <Empty>No capacity data — refresh to probe adapters.</Empty> : (
        <ul className="space-y-2">
          {[...caps].reverse().slice(0, 8).map((c) => (
            <li key={c.id} className="rounded border border-neutral-800 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="mono text-neutral-100">{c.provider}</span>
                <span className="flex items-center gap-2">
                  <StatusDot status={c.health} />
                  <span className={`text-xs ${c.health === "GOOD" ? "text-emerald-300" : c.health === "DEGRADED" ? "text-amber-300" : "text-neutral-400"}`}>{c.health}</span>
                </span>
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-500 md:grid-cols-4">
                <span>limit: <span className="mono text-neutral-300">{c.limitType.toLowerCase()}</span></span>
                <span>remaining: <span className="mono text-neutral-300">{c.usedPercentRemaining === null ? "unknown" : `${Math.round(c.usedPercentRemaining)}%`}</span></span>
                <span>context: <span className="mono text-neutral-300">{c.contextUsedTokens === null ? "unknown" : `${(c.contextUsedTokens / 1000).toFixed(0)}K${c.contextLimitTokens ? ` / ${(c.contextLimitTokens / 1000).toFixed(0)}K` : ""}`}</span></span>
                <span>source: <Chip>{c.source.toLowerCase()} {Math.round(c.confidence * 100)}%</Chip></span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-neutral-600">Providers expose different quota semantics. Fields the adapter cannot read are shown as unknown rather than a fabricated unified value (spec §5.16).</p>
    </Panel>
  );
}
