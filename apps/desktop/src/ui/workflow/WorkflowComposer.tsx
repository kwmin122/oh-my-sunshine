import { useEffect, useState } from "react";
import { api } from "../../client/api.js";
import { Chip, Empty, Panel } from "../shared.js";

/**
 * Workflow Composer (V3 §18–19): "in what order" — nodes are roles, edges are
 * dependencies. Stored independently of the Team Composer and freely combined.
 * An applied workflow becomes the orchestration source of truth for planning:
 * one task per step, executed in composed dependency order.
 */

interface WfNode { key: string; name?: string; roleId: string; objective?: string }
interface WorkflowDTO {
  id: string;
  name: string;
  version: number;
  entryNodeId: string;
  nodes: Array<{ id: string; type: string; name: string; roleId?: string; objective?: string }>;
  edges: Array<{ fromNodeId: string; toNodeId: string }>;
}
interface RoleOption { id: string; name: string }

const ROLE_OPTIONS = [
  ["role_pm", "Product Manager"], ["role_architect", "Architect"],
  ["role_be", "Backend Engineer"], ["role_fe", "Frontend Engineer"],
  ["role_aiml", "AI/ML Engineer"], ["role_dbeng", "DB Engineer"],
  ["role_security", "Security Engineer"], ["role_qa", "QA Engineer"],
  ["role_codereviewer", "Code Reviewer"], ["role_techlead", "Tech Lead / Orchestrator"],
] as const;

export function WorkflowComposer({ projectId, onChanged }: { projectId: string; onChanged: () => void }): JSX.Element {
  const [workflows, setWorkflows] = useState<WorkflowDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [binding, setBinding] = useState<{ workflowId: string; active: boolean } | null>(null);
  const [name, setName] = useState("");
  const [nodes, setNodes] = useState<Array<WfNode & { dependsOn: string[] }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const list = await api.get<{ workflows: WorkflowDTO[] }>("/api/workflows");
    setWorkflows(list.workflows);
    if (projectId) {
      const b = await api.get<{ binding: { workflowId: string; active: boolean } | null }>(`/api/projects/${projectId}/workflow`).catch(() => ({ binding: null }));
      setBinding(b.binding);
    }
  };
  useEffect(() => { void load(); }, [projectId]);

  const loadEditor = async (wf: WorkflowDTO): Promise<void> => {
    setSelectedId(wf.id);
    setName(wf.name);
    setError(null);
    const byId = new Map(wf.nodes.map((n) => [n.id, n]));
    setNodes(wf.nodes.filter((n) => n.type === "STEP").map((n, i) => ({
      key: n.id,
      name: n.name,
      roleId: (n.roleId ?? ROLE_OPTIONS[0][0]) as string,
      objective: n.objective ?? "",
      // derive deps from incoming edges (previous node when implicit chain)
      dependsOn: wf.edges.filter((e) => e.toNodeId === n.id).map((e) => e.fromNodeId).filter(Boolean).length > 0
        ? wf.edges.filter((e) => e.toNodeId === n.id).map((e) => e.fromNodeId)
        : i === 0 ? [] : [],
      ...(byId.has(n.id) ? {} : {}),
    })));
  };

  const newNode = (): void => {
    let i = nodes.length + 1;
    while (nodes.some((n) => n.key === `n${i}`)) i += 1;
    setNodes([...nodes, { key: `n${i}`, roleId: ROLE_OPTIONS[0][0], objective: "", dependsOn: nodes.length === 0 ? [] : [] }]);
  };

  const save = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const payload = {
        name: name.trim() || "Untitled flow",
        nodes: nodes.map((n) => ({ key: n.key, name: n.name ?? n.key, roleId: n.roleId, objective: n.objective || undefined })),
        edges: nodes.flatMap((n) => n.dependsOn.map((from) => ({ from, to: n.key }))),
      };
      const res = selectedId
        ? await api.put<{ workflow: WorkflowDTO }>(`/api/workflows/${selectedId}`, payload)
        : await api.post<{ workflow: WorkflowDTO }>("/api/workflows", payload);
      setSelectedId(res.workflow.id);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const applyToProject = async (): Promise<void> => {
    if (!selectedId || !projectId) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/projects/${projectId}/workflow/apply`, { workflowId: selectedId });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const clearProjectFlow = async (): Promise<void> => {
    if (!projectId) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/workflow/apply`, { workflowId: null });
      setBinding(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title={`Saved Workflows (${workflows.length})`}>
        <ul className="space-y-1.5">
          {workflows.map((w) => (
            <li key={w.id}>
              <button onClick={() => void loadEditor(w)}
                className={`w-full rounded border px-2.5 py-2 text-left text-xs ${w.id === selectedId ? "border-sky-600 bg-neutral-800" : "border-neutral-800 hover:bg-neutral-800/50"}`}>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-100">{w.name}</span>
                  <span className="mono text-neutral-500">v{w.version}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-neutral-400">
                  <Chip tone="info">{w.nodes.length} steps</Chip>
                  {binding?.workflowId === w.id && binding.active && <Chip tone="good">applied</Chip>}
                </div>
              </button>
            </li>
          ))}
          {workflows.length === 0 && <Empty>No custom workflows yet — compose one.</Empty>}
        </ul>
      </Panel>

      <div className="lg:col-span-2 space-y-4">
        <Panel title={selectedId ? `Edit Flow — ${name}` : "Compose Flow"}>
          <div className="space-y-2 text-xs">
            <input className="input py-1 text-xs" placeholder="flow name (e.g. Fast Build)" value={name} onChange={(e) => setName(e.target.value)} />
            {nodes.map((n, idx) => (
              <div key={n.key} className="rounded border border-neutral-800 p-2">
                <div className="flex items-center gap-2">
                  <span className="mono w-8 text-neutral-500">#{idx + 1}</span>
                  <select className="input py-0.5 text-xs" value={n.roleId}
                    onChange={(e) => setNodes(nodes.map((x) => x.key === n.key ? { ...x, roleId: e.target.value } : x))}>
                    {ROLE_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                  <button className="btn px-2 py-0.5 text-xs" disabled={idx === 0} onClick={() => setNodes(nodes.filter((x) => x.key !== n.key))}>remove</button>
                </div>
                <input className="input mt-1.5 py-0.5 text-xs" placeholder="step objective…" value={n.objective ?? ""}
                  onChange={(e) => setNodes(nodes.map((x) => x.key === n.key ? { ...x, objective: e.target.value } : x))} />
                {nodes.length > 1 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-neutral-500">dependencies ({n.dependsOn.length})</summary>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {nodes.filter((x) => x.key !== n.key).map((x) => (
                        <label key={x.key} className="flex items-center gap-1 text-neutral-400">
                          <input type="checkbox" checked={n.dependsOn.includes(x.key)}
                            onChange={(e) => setNodes(nodes.map((y) => y.key === n.key
                              ? { ...y, dependsOn: e.target.checked ? [...y.dependsOn, x.key] : y.dependsOn.filter((k) => k !== x.key) }
                              : y))} />
                          #{nodes.findIndex((z) => z.key === x.key) + 1} {x.roleId.replace("role_", "")}
                        </label>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
            {nodes.length === 0 && <Empty>Add steps to compose the order of work.</Empty>}
            <div className="flex flex-wrap gap-2 pt-1">
              <button className="btn" disabled={busy} onClick={newNode}>+ Add step</button>
              <button className="btn btn-primary" disabled={busy || nodes.length === 0} onClick={() => void save()}>
                {selectedId ? "Save changes" : "Create workflow"}
              </button>
              {selectedId && projectId && (
                binding?.workflowId === selectedId && binding.active
                  ? <button className="btn" disabled={busy} onClick={() => void clearProjectFlow()}>Unapply from project</button>
                  : <button className="btn" disabled={busy} onClick={() => void applyToProject()}>Apply to project → drives planning</button>
              )}
              {selectedId && (
                <button className="btn" disabled={busy} onClick={() => { setSelectedId(null); setName(""); setNodes([]); }}>New</button>
              )}
            </div>
            {binding?.active && binding.workflowId !== selectedId && <p className="text-neutral-500">A different flow is currently applied to this project.</p>}
            {error ? <p className="text-red-400">{error}</p> : null}
          </div>
        </Panel>

        <Panel title="How it works">
          <p className="text-xs text-neutral-400">
            When a flow is applied to the project, <b className="text-neutral-200">Plan Delivery</b> generates one task per step
            with dependencies exactly as composed here — replacing the heuristic planner's role sequence for that mission.
            The engine enforces the order: a task cannot start until its upstream steps reach DONE.
          </p>
        </Panel>
      </div>
    </div>
  );
}
