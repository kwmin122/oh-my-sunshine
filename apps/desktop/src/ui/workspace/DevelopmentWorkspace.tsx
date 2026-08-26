import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../client/api.js";
import { Chip, Empty, Panel } from "../shared.js";

/**
 * Development Workspace (V4/S10) — the surface where the human watches AI work
 * on real files, inspects diffs, drives a real terminal, and converses with the
 * Engineering Lead. LEFT: file explorer · CENTER: viewer/diff · RIGHT: Lead
 * conversation · BOTTOM: terminal.
 */

interface Entry { name: string; path: string; type: "file" | "dir"; size: number | null; gitStatus: string | null }
interface FileContent { path: string; content: string; truncated: boolean; revision: string | null }
interface ChatMessage { id: string; role: "USER" | "LEAD" | "SYSTEM"; text: string; classifiedAs: string | null; effects: string[]; createdAt: string }
interface TermSession { id: string; type: string; status: string; pid: number | null }

export function DevelopmentWorkspace({ projectId }: { projectId: string }): JSX.Element {
  // ---- files ----
  const [tree, setTree] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, Entry[]>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [changedFiles, setChangedFiles] = useState<Array<{ path: string; status: string }>>([]);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Entry[] | null>(null);

  const loadTree = useCallback(async (): Promise<void> => {
    try {
      const r = await api.get<{ entries: Entry[] }>(`/api/projects/${projectId}/files`);
      setTree(r.entries);
      const s = await api.get<{ changedFiles: Array<{ path: string; status: string }> }>(`/api/projects/${projectId}/git/status`).catch(() => ({ changedFiles: [] }));
      setChangedFiles(s.changedFiles);
    } catch {
      setTree([]);
    }
  }, [projectId]);
  useEffect(() => { void loadTree(); }, [loadTree]);

  const openDir = async (path: string): Promise<void> => {
    if (expanded[path]) {
      setExpanded(({ [path]: _removed, ...rest }) => rest);
      return;
    }
    const r = await api.get<{ entries: Entry[] }>(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`);
    setExpanded((cur) => ({ ...cur, [path]: r.entries }));
  };

  const openFile = async (path: string): Promise<void> => {
    setSelectedFile(path);
    setDiffText(null);
    setFileContent(await api.get<FileContent>(`/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`).catch(() => null));
  };

  const showDiff = async (): Promise<void> => {
    if (!selectedFile) return;
    const r = await api.get<{ diff: string }>(`/api/projects/${projectId}/git/diff`);
    // Narrow to the selected file's hunks for focus; full diff available via button below.
    const lines = r.diff.split("\n");
    const out: string[] = [];
    let keep = false;
    for (const line of lines) {
      if (line.startsWith("diff --git")) keep = line.includes(` ${selectedFile}`);
      if (keep) out.push(line);
    }
    setDiffText(out.join("\n") || `(no changes in ${selectedFile})`);
  };

  const runSearch = async (): Promise<void> => {
    if (search.trim().length === 0) { setSearchResults(null); return; }
    const r = await api.get<{ results: Entry[] }>(`/api/projects/${projectId}/files/search?q=${encodeURIComponent(search)}`);
    setSearchResults(r.results);
  };

  const renderEntries = (entries: Entry[], depth: number): JSX.Element[] =>
    entries.map((e) => (
      <div key={e.path}>
        <button
          className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-neutral-800/60 ${selectedFile === e.path ? "bg-neutral-800" : ""}`}
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          onClick={() => (e.type === "dir" ? void openDir(e.path) : void openFile(e.path))}
        >
          <span className="text-neutral-500">{e.type === "dir" ? (expanded[e.path] ? "▾" : "▸") : "·"}</span>
          <span className={`truncate text-xs ${changedFiles.some((c) => c.path === e.path) ? "text-amber-300" : "text-neutral-300"}`}>{e.name}</span>
          {e.gitStatus && <span className="mono ml-auto text-[9px] text-amber-400">{e.gitStatus}</span>}
        </button>
        {e.type === "dir" && expanded[e.path] ? renderEntries(expanded[e.path] as Entry[], depth + 1) : null}
      </div>
    ));

  return (
    <div className="space-y-3">
      {/* three-column workspace */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_1fr_320px]">
        {/* LEFT: explorer */}
        <Panel title="FILES">
          <input className="input mb-2 py-0.5 text-xs" placeholder="search files…" value={search}
            onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void runSearch()} />
          {searchResults ? (
            <div className="space-y-0.5">
              <button className="mono w-full rounded px-1 py-0.5 text-left text-[10px] text-sky-400 hover:bg-neutral-800" onClick={() => { setSearchResults(null); setSearch(""); }}>← back to tree</button>
              {searchResults.map((r) => (
                <button key={r.path} className="block w-full truncate rounded px-1.5 py-0.5 text-left text-xs text-neutral-300 hover:bg-neutral-800/60"
                  onClick={() => void openFile(r.path)}>{r.path}</button>
              ))}
              {searchResults.length === 0 && <Empty>No matches.</Empty>}
            </div>
          ) : tree.length > 0 ? renderEntries(tree, 0) : <Empty>No repository attached.</Empty>}
        </Panel>

        {/* CENTER: viewer / diff */}
        <Panel title={selectedFile ?? "VIEWER"} right={selectedFile ? (
          <div className="flex gap-1">
            <button className="btn px-2 py-0.5 text-[10px]" onClick={() => setDiffText(null)}>source</button>
            <button className="btn px-2 py-0.5 text-[10px] border-amber-700 text-amber-300" onClick={() => void showDiff()}>diff</button>
            {fileContent?.truncated && <Chip tone="info">truncated</Chip>}
          </div>
        ) : undefined}>
          {!selectedFile ? <Empty>Select a file to inspect what the agents are changing.</Empty> : diffText !== null ? (
            <pre className="mono max-h-[420px] overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-2 text-[10px] leading-relaxed text-emerald-200">{diffText}</pre>
          ) : fileContent ? (
            <pre className="max-h-[420px] overflow-auto rounded bg-neutral-950 p-2 text-[11px] leading-relaxed text-neutral-200">
              {fileContent.content.split("\n").map((line, i) => (
                <div key={i} className="flex">
                  <span className="mono mr-3 inline-block w-8 shrink-0 select-none text-right text-neutral-600">{i + 1}</span>
                  <span className="whitespace-pre-wrap">{line || " "}</span>
                </div>
              ))}
            </pre>
          ) : <Empty>Could not load file.</Empty>}
          {selectedFile && <FileHistory projectId={projectId} path={selectedFile} />}
        </Panel>

        {/* RIGHT: lead conversation */}
        <LeadConversation projectId={projectId} onChanged={() => void loadTree()} />
      </div>

      {/* BOTTOM: terminal */}
      <TerminalPanel projectId={projectId} />
    </div>
  );
}

function FileHistory({ projectId, path }: { projectId: string; path: string }): JSX.Element | null {
  const [history, setHistory] = useState<Array<{ hash: string; subject: string; author: string; date: string }> | null>(null);
  useEffect(() => {
    api.get<{ history: Array<{ hash: string; subject: string; author: string; date: string }> }>(`/api/projects/${projectId}/git/log?path=${encodeURIComponent(path)}`)
      .then((r) => setHistory(r.history))
      .catch(() => setHistory([]));
  }, [projectId, path]);
  if (!history || history.length === 0) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[10px] text-neutral-500">history ({history.length})</summary>
      <ul className="mt-1 space-y-0.5">
        {history.map((h) => (
          <li key={h.hash} className="mono truncate text-[10px] text-neutral-400">
            <span className="text-sky-400">{h.hash}</span> {h.subject}
          </li>
        ))}
      </ul>
    </details>
  );
}

function LeadConversation({ projectId, onChanged }: { projectId: string; onChanged: () => void }): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const r = await api.get<{ messages: ChatMessage[] }>(`/api/projects/${projectId}/conversation`).catch(() => ({ messages: [] }));
    setMessages(r.messages);
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  const send = async (): Promise<void> => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/conversation`, { text: draft.trim() });
      setDraft("");
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="ENGINEERING LEAD">
      <div className="flex h-[420px] flex-col">
        <div className="flex-1 space-y-2 overflow-y-auto pr-1">
          {messages.length === 0 && <Empty>Talk to your Engineering Lead anytime — instructions reach active tasks, requirement changes trigger impact analysis.</Empty>}
          {messages.map((m) => (
            <div key={m.id} className={`rounded p-2 text-xs ${m.role === "USER" ? "bg-sky-950/40 text-sky-100" : m.role === "LEAD" ? "bg-neutral-800/70 text-neutral-200" : "bg-neutral-900 text-neutral-400"}`}>
              <div className="mb-0.5 flex items-center gap-1.5">
                <span className="mono text-[9px] uppercase text-neutral-500">{m.role}</span>
                {m.classifiedAs && <Chip tone={m.classifiedAs === "REQUIREMENT_CHANGE" || m.classifiedAs === "SCOPE_CHANGE" ? "bad" : m.classifiedAs === "GENERAL_CHAT" || m.classifiedAs === "QUESTION" ? "info" : "good"}>{m.classifiedAs}</Chip>}
              </div>
              <p className="whitespace-pre-wrap">{m.text}</p>
              {m.effects.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-emerald-300">
                  {m.effects.map((ef, i) => <li key={i}>{ef}</li>)}
                </ul>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="mt-2 flex gap-1.5">
          <input className="input flex-1 py-1 text-xs" placeholder='e.g. "여기 방식 바꿔줘" or "회원가입 없애자"'
            value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void send()} disabled={busy} />
          <button className="btn btn-primary px-3 py-1 text-xs" disabled={busy || !draft.trim()} onClick={() => void send()}>Send</button>
        </div>
      </div>
    </Panel>
  );
}

function TerminalPanel({ projectId }: { projectId: string }): JSX.Element {
  const [session, setSession] = useState<TermSession | null>(null);
  const [output, setOutput] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const latestSeq = useRef(0);
  const outRef = useRef<HTMLPreElement | null>(null);

  const poll = useCallback(async (id: string): Promise<void> => {
    const r = await api.get<{ session: { status: string }; chunks: Array<{ seq: number; data: string }>; latestSeq: number }>(
      `/api/terminal/${id}/output?afterSeq=${latestSeq.current}`,
    ).catch(() => null);
    if (!r) return;
    if (r.chunks.length > 0) {
      latestSeq.current = r.latestSeq;
      setOutput((cur) => (cur + r.chunks.map((c) => c.data).join("")).slice(-100_000));
      setTimeout(() => { outRef.current?.scrollTo(0, outRef.current.scrollHeight); }, 30);
    }
    setSession((cur) => (cur ? { ...cur, status: r.session.status } : cur));
  }, []);

  useEffect(() => {
    if (!session || ["EXITED", "FAILED", "CANCELLED"].includes(session.status)) return;
    const t = setInterval(() => void poll(session.id), 500);
    return () => clearInterval(t);
  }, [session?.id, session?.status, poll]);

  const start = async (): Promise<void> => {
    setError(null);
    try {
      const r = await api.post<{ session: TermSession }>(`/api/projects/${projectId}/terminal`, { type: "USER" });
      latestSeq.current = 0;
      setOutput("");
      setSession(r.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const sendCommand = async (): Promise<void> => {
    if (!session || !command.trim()) return;
    await api.post(`/api/terminal/${session.id}/input`, { data: command }).catch(() => setError("terminal not running"));
    setCommand("");
  };

  const alive = session && ["RUNNING", "WAITING"].includes(session.status);

  return (
    <Panel
      title="TERMINAL"
      right={
        <div className="flex items-center gap-2">
          {session && <Chip tone={alive ? "good" : "info"}>{session.status.toLowerCase()}</Chip>}
          {!session || !alive ? (
            <button className="btn px-2 py-0.5 text-[10px]" onClick={() => void start()}>open shell</button>
          ) : (
            <button className="btn px-2 py-0.5 text-[10px] border-red-800 text-red-300" onClick={() => void api.post(`/api/terminal/${session.id}/kill`, {}).then(() => void poll(session.id))}>kill</button>
          )}
        </div>
      }
    >
      <pre ref={outRef} className="mono h-44 overflow-y-auto whitespace-pre-wrap rounded bg-black p-2 text-[11px] leading-snug text-emerald-200">
        {output || (session ? "" : "Open a shell to run build/test commands in the project workspace.\nUser terminals run with YOUR authority and are audit-logged.")}
      </pre>
      <div className="mt-2 flex gap-1.5">
        <span className="mono select-none pt-1 text-xs text-neutral-600">$</span>
        <input className="input mono flex-1 py-1 text-xs" placeholder={alive ? "command…" : "open a shell first"}
          value={command} onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void sendCommand()} disabled={!alive} />
      </div>
      {error ? <p className="mt-1 text-xs text-red-400">{error}</p> : null}
    </Panel>
  );
}
