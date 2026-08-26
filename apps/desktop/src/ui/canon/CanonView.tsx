import { useEffect, useState } from "react";
import { api, type DiscoveryDTO, type ProjectDTO } from "../../client/api.js";
import { Chip, Empty, Panel } from "../shared.js";

/** Canon view (spec §5.12): requirement traceability + canonical doc export. */
export function CanonView({ projectId, project, discovery }: {
  projectId: string;
  project: ProjectDTO | null;
  discovery: DiscoveryDTO | null;
}): JSX.Element {
  const [tasks, setTasks] = useState<Array<{ id: string; stableKey: string; objective: string; requirementIds: string[]; status: string }>>([]);
  const [evidence, setEvidence] = useState<Array<{ id: string; type: string; status: string; freshness: string; taskId: string | null }>>([]);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  useEffect(() => {
    void api.get<{ tasks: typeof tasks }>(`/api/projects/${projectId}/tasks`).then((r) => setTasks(r.tasks));
    void api.get<{ evidence: typeof evidence }>(`/api/projects/${projectId}/evidence`).then((r) => setEvidence(r.evidence));
  }, [projectId]);

  const exportCanon = async (): Promise<void> => {
    const r = await api.post<{ written: string[] }>(`/api/projects/${projectId}/canon/export`);
    setExportMsg(r.written.length > 0 ? `exported ${r.written.length} files → ${project?.repositoryPath ?? "workspace"}/.devflow/` : "no canon artifacts yet");
  };

  const reqById = new Map((discovery?.requirements ?? []).map((r) => [r.id, r]));
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Requirement Traceability" right={<button className="btn text-xs" onClick={exportCanon}>Export .devflow/</button>}>
        {exportMsg ? <p className="mb-2 text-xs text-emerald-300">{exportMsg}</p> : null}
        {(discovery?.requirements.length ?? 0) === 0 ? <Empty>No requirements yet.</Empty> : (
          <ul className="space-y-2 text-xs">
            {discovery!.requirements.map((r) => {
              const linked = tasks.filter((t) => t.requirementIds.includes(r.id));
              const evForReq = evidence.filter((e) => linked.some((l) => l.id === e.taskId));
              return (
                <li key={r.id} className="rounded border border-neutral-800 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="mono text-sky-300">{r.stableKey}</span>
                    <span className="truncate text-neutral-200">{r.statement.slice(0, 70)}</span>
                  </div>
                  <div className="mt-1.5 space-y-1 pl-4 text-neutral-500">
                    {linked.length === 0 ? <p>↳ (no tasks yet)</p> : linked.map((t) => {
                      const tEv = evForReq.filter((e) => e.taskId === t.id);
                      return (
                        <div key={t.id}>
                          ↳ <span className="mono text-neutral-300">{t.stableKey}</span> {t.objective.slice(0, 40)} · {t.status}
                          {tEv.map((e) => (
                            <Chip key={e.id} tone={e.status === "PASS" && e.freshness === "FRESH" ? "good" : e.status === "PASS" ? "warn" : "bad"}>
                              {e.type}:{e.status === "PASS" ? (e.freshness === "FRESH" ? "FRESH" : "STALE") : "FAIL"}
                            </Chip>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-neutral-600">Goal → Requirement → Task → Evidence chains are computed from persisted state — the anti-plan-drift backbone (spec §42).</p>
      </Panel>

      <Panel title="Canonical Documents">
        <ul className="space-y-1.5 text-xs text-neutral-300">
          {["AGENTS.md — engineering constitution", "MASTER_SPEC.md — product truth", "ARCHITECTURE.md — architecture truth", "STATE.md — current state", "tasks/TASK-XXX.md", "decisions/ADR-XXX.md"].map((doc) => (
            <li key={doc} className="mono rounded border border-neutral-800 px-2 py-1.5">{doc}</li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-neutral-600">Export writes the project control packet into the repository so any agent/tool can consume durable truth (spec §36).</p>
      </Panel>
    </div>
  );
}
