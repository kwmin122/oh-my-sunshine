import { useEffect, useState } from "react";
import { api, type TaskDTO } from "../../client/api.js";
import { Chip, Empty, Panel, StatusDot } from "../shared.js";

/** Task Contracts + execution controls + computed completion explanation (spec §5.4, Step 19). */
export function TaskBoard({ projectId, onChanged }: { projectId: string; onChanged: () => void }): JSX.Element {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completion, setCompletion] = useState<{ canComplete: boolean; missing: Array<{ check: string; explanation: string }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<Array<{ id: string; label: string; available: boolean }>>([]);
  const [activeRuns, setActiveRuns] = useState<Array<{ id: string; taskId: string | null; status: string; runtime: string }>>([]);
  const [cancelling, setCancelling] = useState(false);
  const [cancelResult, setCancelResult] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const r = await api.get<{ tasks: TaskDTO[] }>(`/api/projects/${projectId}/tasks`);
    setTasks(r.tasks);
    setSelectedId((cur) => cur ?? r.tasks[0]?.id ?? null);
    const runs = await api.get<{ runs: Array<{ id: string; taskId: string | null; status: string; runtime: string }> }>(`/api/projects/${projectId}/runs`).catch(() => ({ runs: [] }));
    setActiveRuns(runs.runs);
  };
  useEffect(() => { void load(); }, [projectId]);
  useEffect(() => {
    void api.get<{ catalog: Array<{ id: string; label: string; available: boolean }> }>("/api/team/catalog")
      .then((r) => setRuntimes(r.catalog))
      .catch(() => setRuntimes([]));
  }, []);

  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId) return;
    void api.get<{ completion: { canComplete: boolean; missing: Array<{ check: string; explanation: string }> } }>(`/api/tasks/${selectedId}/completion`)
      .then((r) => setCompletion(r.completion))
      .catch(() => setCompletion(null));
  }, [selectedId, busy, tasks]);

  const runJob = async (job: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await job();
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: "execute" | "review-complete" | "rerun-verification"): Promise<void> => {
    if (!selectedId) return;
    await runJob(() => api.post(`/api/tasks/${selectedId}/${action}`));
  };

  const activeRunForSelected = activeRuns.find((r) => r.taskId === selectedId) ?? null;

  const cancelRun = async (): Promise<void> => {
    if (!activeRunForSelected || !selectedId) return;
    setCancelling(true);
    setCancelResult(null);
    setError(null);
    try {
      const res = await api.post<{ run: { status: string; failureReason: string | null } }>(`/api/runs/${activeRunForSelected.id}/cancel`, {});
      setCancelResult(`Run ${res.run.status}${res.run.failureReason ? ` (${res.run.failureReason})` : ""} — task returned to READY for re-execution.`);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title={`Task DAG (${tasks.length})`}>
        <ul className="space-y-1.5">
          {tasks.map((t) => (
            <li key={t.id}>
              <button onClick={() => setSelectedId(t.id)}
                className={`w-full rounded border px-2.5 py-2 text-left text-xs ${t.id === selectedId ? "border-sky-600 bg-neutral-800" : "border-neutral-800 hover:bg-neutral-800/50"}`}>
                <div className="flex items-center justify-between">
                  <span className="mono text-neutral-400">{t.stableKey}</span>
                  <Chip tone={t.riskTier === "HIGH" ? "bad" : t.riskTier === "LOW" ? "good" : "info"}>{t.riskTier}</Chip>
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-neutral-200">
                  <StatusDot status={t.status} />{t.objective.slice(0, 60)}
                </div>
              </button>
            </li>
          ))}
          {tasks.length === 0 && <Empty>No tasks — reach Definition of Ready and run planning.</Empty>}
        </ul>
      </Panel>

      <Panel title="Task Contract">
        {!selected ? <Empty>Select a task.</Empty> : (
          <div className="space-y-3 text-xs">
            <p className="text-sm text-neutral-100">{selected.objective}</p>
            <dl className="space-y-1 text-neutral-400">
              <Row k="Status" v={selected.status} />
              <Row k="Requirements" v={selected.requirementIds.length.toString()} />
              <Row k="Dependencies" v={selected.dependencyTaskIds.length ? `${selected.dependencyTaskIds.length} upstream` : "none"} />
              <Row k="Evidence required" v={selected.requiredEvidenceTypes.join(", ") || "—"} />
              <Row k="Verification" v={selected.verificationCommands.join(" · ") || "—"} />
            </dl>
            {selected.blockers.length > 0 && (
              <div className="rounded border border-red-900 bg-red-950/40 p-2 text-red-300">Blockers: {selected.blockers.join("; ")}</div>
            )}
            <details open className="rounded border border-neutral-800 p-2">
              <summary className="cursor-pointer text-neutral-400">Plan</summary>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-neutral-300">
                {selected.plannedSteps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </details>
            <select
              className="input py-0.5 text-xs"
              value=""
              disabled={busy}
              onChange={(e) => {
                const target = e.target.value;
                void runJob(() =>
                  api.put(`/api/tasks/${selected.id}/runtime-override`, target === "__clear__" || !target ? { projectId, runtimeId: null } : { projectId, runtimeId: target, reason: "set from TaskBoard" }),
                );
              }}
            >
              <option value="">switch runtime for next run…</option>
              <option value="__clear__">clear task override → role default</option>
              {runtimes.map((r) => (
                <option key={r.id} value={r.id}>{r.label}{r.available ? "" : " (unavailable → falls back)"}</option>
              ))}
            </select>
            <div className="flex flex-wrap gap-2 pt-1">
              <button className="btn btn-primary" disabled={busy || cancelling || Boolean(activeRunForSelected)} onClick={() => act("execute")}>Execute with agent</button>
              <button className="btn" disabled={busy} onClick={() => act("rerun-verification")}>Rerun verification</button>
              <button className="btn" disabled={busy} onClick={() => act("review-complete")}>Review → complete</button>
              {activeRunForSelected && (
                <button className="btn border-red-800 text-red-300" disabled={cancelling} onClick={() => void cancelRun()}>
                  {cancelling ? "Stopping…" : "■ Stop run"}
                </button>
              )}
            </div>
            {activeRunForSelected && (
              <p className="mono text-amber-300">
                ● running on {activeRunForSelected.runtime} (attempt {activeRunForSelected.status === "RUNNING" ? "active" : activeRunForSelected.status})
              </p>
            )}
            {cancelResult ? <p className="text-emerald-400">{cancelResult}</p> : null}
            {error ? <p className="text-red-400">{error}</p> : null}
          </div>
        )}
      </Panel>

      <Panel title="Proof of Done (computed)">
        {!completion ? <Empty>Select a task to evaluate its completion predicate.</Empty> : completion.canComplete ? (
          <p className="text-sm text-emerald-300">✓ All conditions satisfied — task may complete.</p>
        ) : (
          <ul className="space-y-2 text-xs">
            {completion.missing.map((m) => (
              <li key={m.check} className="rounded border border-red-900/60 bg-red-950/30 p-2">
                <span className="mono text-red-300">✗ {m.check}</span>
                <p className="mt-0.5 text-neutral-300">{m.explanation}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt>{k}</dt>
      <dd className="mono truncate text-neutral-200">{v}</dd>
    </div>
  );
}
