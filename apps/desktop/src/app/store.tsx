import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, type OverviewDTO, type ProjectDTO } from "../client/api.js";
import { useLiveEvents } from "../hooks/useLiveEvents.js";

interface Store {
  projects: ProjectDTO[];
  activeId: string | null;
  setActiveId: (id: string) => void;
  overview: OverviewDTO | null;
  reload: () => Promise<void>;
  refreshTick: number;
  connected: boolean;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function StoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overview, setOverview] = useState<OverviewDTO | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const reload = useCallback(async () => {
    const ps = await api.get<{ projects: ProjectDTO[] }>("/api/projects");
    setProjects(ps.projects);
    setActiveId((current) => current ?? ps.projects[ps.projects.length - 1]?.id ?? null);
    setRefreshTick((t) => t + 1);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!activeId) return;
    void api
      .get<OverviewDTO>(`/api/projects/${activeId}/overview`)
      .then(setOverview)
      .catch(() => setOverview(null));
  }, [activeId, refreshTick]);

  const onEvent = useCallback(() => {
    setRefreshTick((t) => t + 1);
  }, []);
  const connected = useLiveEvents(onEvent);

  // Throttled polling fallback so state stays fresh even without WS.
  useEffect(() => {
    const timer = setInterval(() => setRefreshTick((t) => t + 1), 5000);
    return () => clearInterval(timer);
  }, []);

  const value = useMemo(
    () => ({ projects, activeId: activeId ?? null, setActiveId, overview, reload, refreshTick, connected }),
    [projects, activeId, overview, reload, refreshTick, connected],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
