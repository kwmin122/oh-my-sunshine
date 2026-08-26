import { useEffect, useState } from "react";
import { api, type CoverageDTO, type DiscoveryDTO } from "../client/api.js";
import { StoreProvider, useStore } from "./store.js";
import { MissionControl } from "../ui/mission-control/MissionControl.js";
import { DiscoveryPanel } from "../ui/discovery/DiscoveryPanel.js";
import { DevFlowGraph } from "../ui/devflow-graph/DevFlowGraph.js";
import { TaskBoard } from "../ui/tasks/TaskBoard.js";
import { Inboxes } from "../ui/inbox/Inboxes.js";
import { EvidenceCenter, TimelineView, SystemReadinessView, ConflictCenter, DiscoveryHistory } from "../ui/evidence-center/EvidenceCenter.js";
import { AgentOffice } from "../ui/agent-office/AgentOffice.js";
import { TeamComposer } from "../ui/team/TeamComposer.js";
import { WorkflowComposer } from "../ui/workflow/WorkflowComposer.js";
import { DevelopmentWorkspace } from "../ui/workspace/DevelopmentWorkspace.js";
import { PreCodeContract } from "../ui/workspace/PreCodeContract.js";
import { CapacityCenter } from "../ui/capacity/CapacityCenter.js";
import { CanonView } from "../ui/canon/CanonView.js";

const TABS = [
  ["mission", "Mission Control"],
  ["workspace", "Development Workspace"],
  ["discovery", "Discovery & Spec"],
  ["contract", "Implementation Contract"],
  ["graph", "DevFlow Graph"],
  ["tasks", "Tasks"],
  ["agents", "Agent Office"],
  ["team", "AI Team Composer"],
  ["workflow", "Workflow Composer"],
  ["inbox", "Inbox"],
  ["evidence", "Evidence"],
  ["timeline", "Timeline"],
  ["canon", "Canon & Traceability"],
  ["conflicts", "Conflicts"],
  ["capacity", "AI Capacity"],
  ["readiness", "System Readiness"],
] as const;

function Shell(): JSX.Element {
  const { projects, activeId, setActiveId, overview, reload, connected } = useStore();
  const [tab, setTab] = useState<string>("mission");
  const [discovery, setDiscovery] = useState<DiscoveryDTO | null>(null);
  const [coverage, setCoverage] = useState<CoverageDTO | null>(null);
  const [missionText, setMissionText] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const projectId = activeId;
  useEffect(() => {
    if (!projectId) return;
    void api.get<DiscoveryDTO>(`/api/projects/${projectId}/discovery`).then(setDiscovery).catch(() => setDiscovery(null));
    void api.get<{ readiness: CoverageDTO["coverage"] extends never ? never : CoverageDTO["coverage"] }>(`/api/projects/${projectId}/readiness`)
      .then((r) => {
        // readiness endpoint returns the coverage snapshot under `readiness`
        const cov = (r as unknown as { readiness: CoverageDTO }).readiness ?? null;
        setCoverage(cov && typeof cov === "object" && "readyForPlanning" in cov ? cov : null);
      })
      .catch(() => setCoverage(null));
  }, [projectId, overview]);

  const createProject = async (): Promise<void> => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await api.post("/api/projects", { name: newName.trim() });
      setNewName("");
      await reload();
      setNotice("Project created. Submit a mission to begin discovery.");
    } finally {
      setBusy(false);
    }
  };

  const submitMission = async (): Promise<void> => {
    if (!projectId || missionText.trim().length < 3) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.post(`/api/projects/${projectId}/mission`, { rawRequest: missionText.trim() });
      setMissionText("");
      await reload();
      setTab("discovery");
      setNotice("Mission accepted — Intent Gate classified it and discovery is ready.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runPlanningPipeline = async (): Promise<void> => {
    if (!projectId) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.post(`/api/projects/${projectId}/finalize-spec`);
      await api.post(`/api/projects/${projectId}/review-council`);
      await api.post(`/api/projects/${projectId}/architecture`);
      await api.post(`/api/projects/${projectId}/plan`, {});
      await reload();
      setNotice("Spec generated, review council passed, architecture mapped, task DAG created.");
      setTab("tasks");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
        <div className="border-b border-neutral-800 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="DevFlow OS" className="h-8 w-8 rounded-lg" />
            <div>
              <h1 className="text-sm font-bold tracking-wide text-neutral-100">DEVFLOW OS</h1>
              <p className="text-[10px] uppercase tracking-wider text-neutral-600">AI Engineering Control Plane</p>
            </div>
          </div>
        </div>
        <div className="border-b border-neutral-800 px-3 py-2">
          <select className="input py-1 text-xs" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)}>
            {projects.length === 0 && <option value="">no projects</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="input mt-1.5 py-1 text-xs" placeholder="new project name…" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createProject()} />
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {TABS.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`block w-full rounded px-2.5 py-1.5 text-left text-xs ${tab === id ? "bg-sky-950/60 text-sky-200" : "text-neutral-400 hover:bg-neutral-900"}`}>
              {label}
              {id === "inbox" && ((overview?.openDecisions.length ?? 0) + (overview?.openApprovals.length ?? 0) > 0) && (
                <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
              )}
            </button>
          ))}
        </nav>
        <div className="border-t border-neutral-800 px-3 py-2 text-[10px] text-neutral-600">
          <span className={`inline-block mr-1 h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`} />
          daemon {connected ? "connected" : "polling"}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-4">
        {!projectId ? (
          <div className="panel mx-auto mt-24 max-w-md p-6 text-center">
            <img src="/logo.png" alt="DevFlow OS" className="mx-auto h-20 w-20 rounded-2xl" />
            <h2 className="mt-4 text-lg font-semibold">Welcome to DevFlow OS</h2>
            <p className="mt-2 text-sm text-neutral-400">Create a project in the sidebar, then submit a mission as vague as “Add Google login.” The system will interview you one question at a time before any code is written.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="panel flex items-center gap-3 px-4 py-2.5">
              <input
                className="input flex-1"
                placeholder='Mission: e.g. "Add Google login with OAuth"'
                value={missionText}
                onChange={(e) => setMissionText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitMission()}
              />
              <button className="btn btn-primary" disabled={busy || missionText.trim().length < 3} onClick={submitMission}>Submit Mission</button>
              {coverage?.readyForPlanning && (
                <button className="btn" disabled={busy} onClick={runPlanningPipeline}>Plan Delivery →</button>
              )}
            </div>
            {notice ? <div className="rounded border border-sky-900 bg-sky-950/40 px-3 py-2 text-xs text-sky-200">{notice}</div> : null}

            {tab === "mission" && <MissionControl projectId={projectId} overview={overview} onChanged={() => void reload()} onNavigate={setTab} />}
            {tab === "workspace" && <DevelopmentWorkspace projectId={projectId} />}
            {tab === "contract" && <PreCodeContract projectId={projectId} />}
            {tab === "discovery" && (
              <div className="space-y-4">
                <DiscoveryPanel projectId={projectId} discovery={discovery} coverage={coverage} onChanged={() => void reload()} />
                <DiscoveryHistory projectId={projectId} discovery={discovery} />
              </div>
            )}
            {tab === "graph" && <DevFlowGraph projectId={projectId} />}
            {tab === "tasks" && <TaskBoard projectId={projectId} onChanged={() => void reload()} />}
            {tab === "agents" && <AgentOffice projectId={projectId} />}
            {tab === "team" && <TeamComposer projectId={projectId} onChanged={() => void reload()} />}
            {tab === "workflow" && <WorkflowComposer projectId={projectId} onChanged={() => void reload()} />}
            {tab === "inbox" && <Inboxes overview={overview} onChanged={() => void reload()} />}
            {tab === "evidence" && <EvidenceCenter projectId={projectId} />}
            {tab === "timeline" && <TimelineView projectId={projectId} />}
            {tab === "canon" && <CanonView projectId={projectId} project={overview?.project ?? null} discovery={discovery} />}
            {tab === "conflicts" && <ConflictCenter projectId={projectId} />}
            {tab === "capacity" && <CapacityCenter />}
            {tab === "readiness" && <SystemReadinessView />}
          </div>
        )}
      </main>
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
