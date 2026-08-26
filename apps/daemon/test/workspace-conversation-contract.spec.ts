import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@devflow/contracts";
import { openDatabase, closeDatabase } from "../src/infrastructure/db/connection.js";
import { DocumentRepository } from "../src/infrastructure/db/document-repository.js";
import { SqliteEventStore } from "../src/infrastructure/db/event-store.js";
import { WorkspaceService } from "../src/application/workspace/workspace-service.js";
import { TerminalService } from "../src/application/terminal/terminal-service.js";
import { ConversationService, classifyMessage } from "../src/application/conversation/conversation-service.js";
import { PreCodeContractService } from "../src/application/discovery/pre-code-contract-service.js";

/**
 * V4/S10 + V5/S11 backend evidence: real filesystem workspace browsing with
 * traversal protection, REAL terminal processes with lifecycle state machines,
 * conversation classification into structured effects, and the pre-code
 * contract with implementation-readiness gating.
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeGitRepo(): string {
  const dir = makeTempDir("devflow-v4-ws-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), "export const login = () => true;\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });
  // working-tree change for diff/status badges
  writeFileSync(join(dir, "src", "auth.ts"), "export const login = () => 'oauth';\n");
  return dir;
}

describe("V4 §2–4: workspace filesystem + git surfaces", () => {
  it("lists a guarded tree with git badges, reads files, diffs the working tree", async () => {
    const repo = makeGitRepo();
    const db = openDatabase({ dataDir: makeTempDir("v4-db-") } as never);
    const projects = {
      getProject: (_id: string) => ({ repositoryPath: repo }),
    } as never;
    const { CliGitAdapter } = await import("../src/plugins/tools/core-tools.js");
    const ws = new WorkspaceService(projects, new CliGitAdapter());

    // Tree (root)
    const tree = await ws.listTree("proj_x");
    expect(tree.entries.map((e) => e.name)).toContain("src");
    // Nested listing
    const src = await ws.listTree("proj_x", "src");
    const auth = src.entries.find((e) => e.name === "auth.ts")!;
    expect(auth.type).toBe("file");
    expect(auth.gitStatus).toBeTruthy(); // modified after commit

    // File read
    const file = await ws.readFile("proj_x", "src/auth.ts");
    expect(file.content).toContain("oauth");
    expect(file.revision).toBeTruthy();

    // Diff shows the modification
    const diff = await ws.diff("proj_x");
    expect(diff.diff).toContain("oauth");

    // Status summary
    const status = await ws.statusSummary("proj_x");
    expect(status.changedFiles.some((c) => c.path.endsWith("auth.ts"))).toBe(true);

    // File history
    const history = await ws.fileHistory("proj_x", "src/auth.ts");
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]!.subject).toBe("initial");

    closeDatabase(db);
  });

  it("rejects path traversal and outside-root access — renderer never escapes the workspace", async () => {
    const repo = makeGitRepo();
    const projects = { getProject: () => ({ repositoryPath: repo }) } as never;
    const { CliGitAdapter } = await import("../src/plugins/tools/core-tools.js");
    const ws = new WorkspaceService(projects, new CliGitAdapter());
    await expect(ws.readFile("p", "../../etc/passwd")).rejects.toThrow(/escapes workspace root/);
    await expect(ws.listTree("p", "/etc")).rejects.toThrow();
    await expect(ws.readFile("p", ".")).rejects.toThrow(/is a directory/);
  });

  it("blocks symlink escape — a link inside the repo pointing outside cannot be read (review pass-3)", async () => {
    const repo = makeGitRepo();
    const secretDir = makeTempDir("devflow-secret-");
    const secretFile = join(secretDir, "secret.txt");
    writeFileSync(secretFile, "TOP_SECRET");
    symlinkSync(secretFile, join(repo, "innocent-link"));
    const projects = { getProject: () => ({ repositoryPath: repo }) } as never;
    const { CliGitAdapter } = await import("../src/plugins/tools/core-tools.js");
    const ws = new WorkspaceService(projects, new CliGitAdapter());
    await expect(ws.readFile("p", "innocent-link")).rejects.toThrow(/symlink/);
  });

  it("search finds files by name substring", async () => {
    const repo = makeGitRepo();
    const projects = { getProject: () => ({ repositoryPath: repo }) } as never;
    const { CliGitAdapter } = await import("../src/plugins/tools/core-tools.js");
    const ws = new WorkspaceService(projects, new CliGitAdapter());
    const results = await ws.searchFiles("p", "auth");
    expect(results.some((r) => r.path === "src/auth.ts")).toBe(true);
  });
});

describe("V4 §5–6: integrated terminal against REAL processes", () => {
  it("runs a shell command end-to-end, streams output, and enforces lifecycle transitions", async () => {
    const cwd = makeTempDir("devflow-term-");
    const broadcasts: Array<Record<string, unknown>> = [];
    const audits: Array<{ type: string }> = [];
    const svc = new TerminalService(
      (e) => audits.push({ type: e.type }),
      (m) => broadcasts.push(m),
    );

    const session = svc.create("proj_t", "USER", cwd);
    expect(session.status).toBe("RUNNING");
    expect(session.pid).not.toBeNull();

    // Real command execution through the real shell process.
    const marker = `TERM_OK_${Date.now()}`;
    expect(svc.write(session.id, `echo ${marker}`)).toBe(true);
    const deadline = Date.now() + 10_000;
    let seen = false;
    while (Date.now() < deadline && !seen) {
      const { chunks } = svc.outputSince(session.id, 0);
      seen = chunks.some((c) => c.data.includes(marker));
      if (!seen) await new Promise((r) => setTimeout(r, 100));
    }
    expect(seen).toBe(true); // output actually came back from a live process
    expect(broadcasts.some((b) => b.type === "terminal.output")).toBe(true);

    // Illegal transition is refused by the engine, not silently applied.
    expect(() => (svc as unknown as { transition: (id: string, to: string) => void }).transition(session.id, "CREATED")).toThrow(/illegal transition/);

    // Kill → CANCELLED, no orphan process remains.
    expect(svc.kill(session.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(svc.get(session.id)?.status).toBe("CANCELLED");
    if (session.pid) {
      let alive = true;
      try {
        process.kill(-session.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
    expect(audits.some((a) => a.type === "terminal.session_created")).toBe(true);
  }, 30_000);
});

describe("V4 §7–9: continuous conversation → structured effects", () => {
  function makeConversation(provider?: ModelProvider) {
    const dataDir = makeTempDir("devflow-conv-");
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const svc = new ConversationService({ docs, events, provider });
    // Seed one READY task to receive operator instructions.
    const now = new Date().toISOString();
    docs.put("task", "task_c1", "proj_conv", {
      id: "task_c1", projectId: "proj_conv", stableKey: "T-1", parentTaskId: null,
      title: "x", objective: "build login", ownerRole: "role_be", status: "READY",
      riskTier: "NORMAL", dependencyTaskIds: [], requirementIds: [], acceptanceCriteriaIds: [],
      plannedSteps: [], affectedModules: [], requiredEvidenceTypes: ["UNIT_TEST"],
      requiredReviewTypes: [], permissionsNeeded: [], blockers: [], handoffNotes: null,
      verificationCommands: [], createdAt: now, updatedAt: now,
    });
    docs.put("evidence", "ev_1", "proj_conv", { id: "ev_1", taskId: "task_c1", status: "PASS_FRESH" });
    return { svc, docs, events, close: () => closeDatabase(db) };
  }

  it("classifies intents deterministically across EN/KR phrasing", () => {
    expect(classifyMessage("여기 로그인 버튼 너무 별로야. 바꿔줘.")).toBe("TASK_REFINEMENT");
    expect(classifyMessage("생각해보니 회원가입 자체를 없애자")).toBe("REQUIREMENT_CHANGE");
    expect(classifyMessage("codex로 런타임 바꿔줘")).toBe("RUNTIME_CHANGE");
    expect(classifyMessage("지금 진행 상황이 어떻게 돼?")).toBe("QUESTION");
    expect(classifyMessage("pause")).toBe("PAUSE");
    expect(classifyMessage("계속해")).toBe("RESUME");
    expect(classifyMessage("고마워")).toBe("GENERAL_CHAT");
  });

  it("TASK_REFINEMENT lands in the active task's operator notes (agent-visible context)", async () => {
    const { svc, docs, events, close } = makeConversation();
    const { message, reply } = await svc.handleUserMessage("proj_conv", "버튼 방식 바꿔줘");
    expect(message.classifiedAs).toBe("TASK_REFINEMENT");
    expect(message.effects[0]).toContain("T-1");
    const task = docs.get<{ handoffNotes: string | null }>("task", "task_c1")!;
    expect(task.handoffNotes).toContain("버튼 방식 바꿔줘");
    expect(events.listByProject("proj_conv" as never).some((e) => e.type === "task.instruction_appended")).toBe(true);
    expect(reply.text.length).toBeGreaterThan(0);
    close();
  });

  it("REQUIREMENT_CHANGE flags tasks for replan and stales fresh evidence", async () => {
    const { svc, docs, events, close } = makeConversation();
    const { message } = await svc.handleUserMessage("proj_conv", "생각해보니 회원가입 자체를 없애자");
    expect(message.classifiedAs).toBe("REQUIREMENT_CHANGE");
    const task = docs.get<{ status: string; blockers: string[] }>("task", "task_c1")!;
    expect(task.status).toBe("BLOCKED");
    expect(task.blockers.join()).toContain("replan required");
    const evidence = docs.get<{ status: string }>("evidence", "ev_1")!;
    expect(evidence.status).toBe("PASS_STALE");
    expect(events.listByProject("proj_conv" as never).some((e) => e.type === "requirement.change_detected")).toBe(true);
    close();
  });

  it("uses the LLM tier for Lead replies when a real provider is configured", async () => {
    const fakeProvider: ModelProvider = {
      id: "fake",
      model: "fake-1",
      generate: async () => ({ raw: '{"summary":"Plan updated: switching the login button."}', tokensIn: 1, tokensOut: 1, degraded: false }),
    };
    const { svc, close } = makeConversation(fakeProvider);
    const { reply } = await svc.handleUserMessage("proj_conv", "로그인 버튼 별로, 바꿔줘");
    expect(reply.text).toContain("login button");
    close();
  });
});

describe("V5/S11: Pre-Implementation Contract + readiness gate", () => {
  it("compiles sections from repo facts, ranks questions by rework-weighted priority, gates on critical gaps", async () => {
    const repo = makeGitRepo(); // has test-less package? no testCommand file → detection honest
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const dataDir = makeTempDir("devflow-s11-");
    const db = openDatabase({ dataDir } as never);
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const mission = { id: "mis_1", projectId: "proj_s11", rawRequest: "Add Google login", createdAt: new Date().toISOString() };
    docs.put("mission", mission.id, "proj_s11", mission);
    docs.put("project", "proj_s11", null, { id: "proj_s11", name: "S11", repositoryPath: repo });
    const projects = {
      getProject: () => ({ id: "proj_s11", repositoryPath: repo }),
      latestMission: () => mission,
    } as never;
    const svc = new PreCodeContractService({
      docs,
      events,
      projects,
      repoFacts: async () => ({ languages: ["TypeScript"], frameworks: ["react"], testCommand: "vitest run", buildCommand: null }),
    });
    const contract = await svc.refresh("proj_s11");
    expect(contract.sections.length).toBe(12);
    // Permissions/RBAC is honestly MISSING with blocking=true.
    const perms = contract.sections.find((s) => s.key === "permissions")!;
    expect(perms.items.find((i) => i.topic.includes("RBAC"))?.status).toBe("MISSING");
    // Questions ranked descending by priority; high-rework sections rank first.
    expect(contract.openQuestions.length).toBeGreaterThan(0);
    expect(contract.openQuestions[0]!.priority).toBeGreaterThanOrEqual(contract.openQuestions.at(-1)!.priority);
    // Readiness gate: blocking missing > 0 ⇒ not ready.
    expect(contract.readiness.criticalMissing).toBeGreaterThan(0);
    expect(contract.readiness.ready).toBe(false);
    expect(contract.readiness.reason).toContain("blocking gap");
    closeDatabase(db);
  });
});
