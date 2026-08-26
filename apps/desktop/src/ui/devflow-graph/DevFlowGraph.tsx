import { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MarkerType, type Edge, type Node } from "@xyflow/react";
import { api, type TaskDTO } from "../../client/api.js";
import { Chip, Empty, Panel } from "../shared.js";

const STATUS_COLORS: Record<string, string> = {
  DONE: "#38bdf8",
  RUNNING: "#34d399",
  VERIFYING: "#34d399",
  BLOCKED: "#f87171",
  READY: "#7dd3fc",
  QUEUED: "#7dd3fc",
  REVIEW: "#fbbf24",
};

/** DevFlow Graph (spec §5.2): interactive DAG over persisted tasks + delivery workflow stages. */
export function DevFlowGraph({ projectId }: { projectId: string }): JSX.Element {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [selected, setSelected] = useState<TaskDTO | null>(null);

  useEffect(() => {
    void api.get<{ tasks: TaskDTO[] }>(`/api/projects/${projectId}/tasks`).then((r) => setTasks(r.tasks));
  }, [projectId]);

  const { nodes, edges } = useMemo(() => {
    const stages: Array<[string, string]> = [
      ["Mission", "DONE"],
      ["Discovery", "DONE"],
      ["Readiness Gate", "DONE"],
      ["Risk Splitter", "DONE"],
      ["Planning", tasks.length > 0 ? "DONE" : "BLOCKED"],
      ["Execution", tasks.some((t) => t.status === "RUNNING") ? "RUNNING" : tasks.some((t) => t.status === "VERIFYING" || t.status === "REVIEW") ? "REVIEW" : "QUEUED"],
      ["Verification", tasks.every((t) => t.status === "DONE") && tasks.length > 0 ? "DONE" : "QUEUED"],
    ];
    const stageNodes: Node[] = stages.map(([label, status], i) => ({
      id: `stage-${i}`,
      position: { x: (i % 4) * 220, y: Math.floor(i / 4) * 120 },
      data: { label: `${label}\n${status}` },
      style: {
        background: "#171717",
        border: `1px solid ${STATUS_COLORS[status] ?? "#404040"}`,
        borderRadius: 8,
        color: STATUS_COLORS[status] ?? "#a3a3a3",
        fontSize: 11,
        padding: 8,
        whiteSpace: "pre-line" as const,
        width: 160,
      },
    }));
    const stageEdges: Edge[] = stageNodes.slice(0, -1).map((n, i) => ({
      id: `se-${i}`,
      source: n.id,
      target: stageNodes[i + 1]!.id,
      animated: String(stageNodes[i + 1]!.data.label).includes("RUNNING"),
      style: { stroke: "#404040" },
    }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    // Layered layout by dependency depth.
    const depth = (t: TaskDTO, seen = new Set<string>()): number => {
      if (seen.has(t.id) || t.dependencyTaskIds.length === 0) return 0;
      seen.add(t.id);
      return 1 + Math.max(...t.dependencyTaskIds.map((d) => (byId.get(d) ? depth(byId.get(d)!, seen) : 0)));
    };
    const taskNodes: Node[] = tasks.map((t) => {
      const d = depth(t);
      return {
        id: t.id,
        position: { x: d * 240 + 60, y: 320 + (tasks.indexOf(t) % 6) * 90 },
        data: { label: `${t.stableKey}\n${t.objective.slice(0, 46)}\n${t.status}` },
        style: {
          background: "#171717",
          border: `1px solid ${STATUS_COLORS[t.status] ?? "#404040"}`,
          borderRadius: 8,
          color: STATUS_COLORS[t.status] ?? "#a3a3a3",
          fontSize: 11,
          padding: 8,
          whiteSpace: "pre-line" as const,
          width: 190,
        },
      };
    });
    const taskEdges: Edge[] = tasks.flatMap((t) =>
      t.dependencyTaskIds.map((dep) => ({
        id: `${dep}->${t.id}`,
        source: dep,
        target: t.id,
        style: { stroke: "#525252" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#525252" },
      })),
    );
    return { nodes: [...stageNodes, ...taskNodes], edges: [...stageEdges.filter((_, i) => i !== 3), ...taskEdges] };
  }, [tasks]);

  return (
    <div className="grid h-[calc(100vh-8rem)] grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="panel col-span-2 overflow-hidden">
        <div className="border-b border-neutral-800 px-4 py-2 text-[13px] font-semibold uppercase tracking-wider text-neutral-400">DevFlow Graph</div>
        {nodes.length === 0 ? (
          <Empty>No graph yet — submit a mission.</Empty>
        ) : (
          <ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_, node) => setSelected(tasks.find((t) => t.id === node.id) ?? null)} proOptions={{ hideAttribution: true }}>
            <Background color="#262626" gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
      <Panel title="Node Details">
        {!selected ? (
          <Empty>Click a task node to inspect its contract.</Empty>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="mono text-neutral-400">{selected.stableKey}</span>
              <Chip tone={selected.riskTier === "HIGH" ? "bad" : selected.riskTier === "LOW" ? "good" : "info"}>{selected.riskTier}</Chip>
            </div>
            <p className="text-neutral-100">{selected.objective}</p>
            <dl className="space-y-1 text-xs text-neutral-400">
              <div>Status: <span className="text-neutral-200">{selected.status}</span></div>
              <div>Requirements: <span className="mono text-neutral-200">{selected.requirementIds.join(", ") || "—"}</span></div>
              <div>Evidence required: <span className="mono text-neutral-200">{selected.requiredEvidenceTypes.join(", ")}</span></div>
            </dl>
            <details className="text-xs">
              <summary className="cursor-pointer text-neutral-400">Planned steps</summary>
              <ul className="mt-1 list-disc pl-4 text-neutral-300">
                {selected.plannedSteps.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </details>
          </div>
        )}
      </Panel>
    </div>
  );
}
