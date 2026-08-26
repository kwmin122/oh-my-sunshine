import { useCallback, useEffect, useState } from "react";
import { api } from "../../client/api.js";
import { Chip, Empty, Panel } from "../shared.js";

/**
 * Pre-Implementation Contract (V5/S11): the whole-system design contract
 * compiled BEFORE coding. No implementation begins while a blocking gap is open.
 * Questions are ranked by rework-weighted priority — answer top-down.
 */

interface ContractItem { topic: string; status: "CLEAR" | "PARTIAL" | "MISSING" | "N_A"; source: string; confidence: number; blocking: boolean; detail: string }
interface Section { key: string; title: string; items: ContractItem[] }
interface Contract {
  sections: Section[];
  readiness: { criticalMissing: number; ready: boolean; reason: string; highRiskUnknowns: Array<{ section: string; topic: string; reworkCost: number }> };
  openQuestions: Array<{ section: string; topic: string; priority: number; suggestedQuestion: string }>;
  createdAt: string;
}

const STATUS_TONE = { CLEAR: "good", PARTIAL: "info", MISSING: "bad", N_A: "info" } as const;

export function PreCodeContract({ projectId }: { projectId: string }): JSX.Element {
  const [contract, setContract] = useState<Contract | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const r = await api.post<{ contract: Contract }>(`/api/projects/${projectId}/contract/refresh`, {}).catch(() => null);
    if (r) setContract(r.contract);
  }, [projectId]);
  useEffect(() => {
    api.get<{ contract: Contract | null }>(`/api/projects/${projectId}/contract`)
      .then((r) => r.contract ? setContract(r.contract) : void refresh())
      .catch(() => void 0);
  }, [projectId, refresh]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel
        title="IMPLEMENTATION READINESS GATE"
        right={contract ? <Chip tone={contract.readiness.ready ? "good" : "bad"}>{contract.readiness.ready ? "READY" : `${contract.readiness.criticalMissing} blocking`}</Chip> : undefined}
      >
        {!contract ? <Empty>Compile the contract from repo facts + requirements.</Empty> : (
          <div className="space-y-3 text-xs">
            <p className={contract.readiness.ready ? "text-emerald-300" : "text-red-300"}>{contract.readiness.reason}</p>
            <div>
              <h4 className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">High-rework unknowns</h4>
              {contract.readiness.highRiskUnknowns.length === 0 ? (
                <p className="text-neutral-500">None — late redesign risk is low.</p>
              ) : (
                <ul className="space-y-1">
                  {contract.readiness.highRiskUnknowns.map((u, i) => (
                    <li key={i} className="flex items-center justify-between rounded border border-amber-900/50 bg-amber-950/20 px-2 py-1">
                      <span className="truncate text-neutral-300">{u.topic}</span>
                      <span className="mono ml-2 shrink-0 text-[10px] text-amber-400">rework ×{u.reworkCost}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button className="btn btn-primary w-full py-1" disabled={busy} onClick={() => void refresh()}>
              Re-compile contract
            </button>
          </div>
        )}
      </Panel>

      <Panel title={`OPEN QUESTIONS (answer top-down)`}>
        {!contract || contract.openQuestions.length === 0 ? <Empty>No open gaps.</Empty> : (
          <ol className="space-y-1.5">
            {contract.openQuestions.map((q, i) => (
              <li key={i} className="rounded border border-neutral-800 p-2">
                <div className="flex items-center justify-between">
                  <span className="mono text-[9px] uppercase text-sky-400">{q.section}</span>
                  <span className="mono text-[10px] text-neutral-500">priority {q.priority.toFixed(3)}</span>
                </div>
                <p className="mt-0.5 text-xs text-neutral-300">{q.suggestedQuestion}</p>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="CONTRACT SECTIONS (16-axis)">
        {!contract ? <Empty>—</Empty> : (
          <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1">
            {contract.sections.map((s) => (
              <details key={s.key} className="rounded border border-neutral-800 p-2" open={s.items.some((i) => i.status === "MISSING")}>
                <summary className="cursor-pointer text-xs text-neutral-200">{s.title}</summary>
                <ul className="mt-1.5 space-y-1">
                  {s.items.map((it, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <Chip tone={STATUS_TONE[it.status]}>{it.status}</Chip>
                      <span className={it.status === "MISSING" ? "text-red-200" : "text-neutral-400"}>
                        {it.topic}
                        {it.source && <span className="ml-1 text-[9px] uppercase text-neutral-600">· {it.source.toLowerCase()}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
