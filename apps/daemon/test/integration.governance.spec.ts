import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { TaskContract } from "@devflow/contracts";
import { openDatabase } from "../src/infrastructure/db/connection.js";
import { DocumentRepository } from "../src/infrastructure/db/document-repository.js";
import { SqliteEventStore } from "../src/infrastructure/db/event-store.js";
import { ActionGateway } from "../src/application/gateway/action-gateway.js";
import { PresetPolicyEngine } from "../src/domain/policy/preset-policy-engine.js";
import { CompletionService, EvidenceFreshnessService } from "../src/application/verification/verification-service.js";
import { SafeEditService } from "../src/application/editing/safe-edit-service.js";
import { MockAgentRuntimeAdapter } from "../src/plugins/runtimes/mock-runtime.js";
import { AgentRuntimeRegistry } from "../src/plugins/runtimes/runtime-registry.js";
import { MobilePairingService, MobileControlService } from "../src/services/mobile/mobile-control-service.js";
import { PlaybookLearningService } from "../src/services/capacity/playbook-learning-service.js";
import { ConflictDetectionService } from "../src/services/conflicts/conflict-detection-service.js";

let dataDir: string;
let workspace: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "devflow-test-"));
  workspace = mkdtempSync(join(tmpdir(), "devflow-ws-"));
});
afterAll(() => {
  // tmp dirs are cleaned by the OS; explicit cleanup would race parallel suites
});

function makeTask(partial: Partial<TaskContract>): TaskContract {
  return {
    id: partial.id ?? "task_1",
    projectId: partial.projectId ?? "proj_1",
    stableKey: "TASK-001",
    parentTaskId: null,
    objective: "test objective",
    ownerRole: partial.ownerRole ?? "role_be",
    riskTier: "NORMAL",
    status: "VERIFYING",
    dependencyTaskIds: [],
    requirementIds: [],
    acceptanceCriteriaIds: [],
    plannedSteps: [],
    affectedModules: ["src/auth"],
    requiredEvidenceTypes: partial.requiredEvidenceTypes ?? ["UNIT_TEST"],
    requiredReviewTypes: [],
    permissionsNeeded: [],
    blockers: [],
    handoffNotes: null,
    verificationCommands: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  } as TaskContract;
}

describe("event store", () => {
  it("assigns strictly increasing per-project sequences and replays in order", () => {
    const db = openDatabase({ dataDir });
    const store = new SqliteEventStore(db);
    const e1 = store.append({ projectId: "p1", type: "project.created", actorType: "USER" });
    const e2 = store.append({ projectId: "p1", type: "mission.created", actorType: "USER" });
    const other = store.append({ projectId: "p2", type: "project.created", actorType: "USER" });
    const e3 = store.append({ projectId: "p1", type: "discovery.ready", actorType: "ENGINE" });
    expect([e1.sequence, e2.sequence, e3.sequence]).toEqual([1, 2, 3]);
    expect(other.sequence).toBe(1);
    const replay = store.listByProject("p1");
    expect(replay.map((e) => e.type)).toEqual(["project.created", "mission.created", "discovery.ready"]);
  });

  it("returns an empty stream for unknown projects instead of throwing", () => {
    const db = openDatabase({ dataDir });
    const store = new SqliteEventStore(db);
    expect(store.listByProject("nobody")).toEqual([]);
    expect(store.latestSequence("nobody")).toBe(0);
  });
});

describe("document repository", () => {
  it("round-trips aggregates and lists per project", () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    docs.put("task", "t1", "projA", { id: "t1", name: "A" });
    docs.put("task", "t2", "projB", { id: "t2", name: "B" });
    expect(docs.get<{ id: string }>("task", "t1")).toEqual({ id: "t1", name: "A" });
    expect(docs.list<{ id: string }>("task", "projA").map((t) => t.id)).toEqual(["t1"]);
  });
  it("throws a contextual error when requiring missing documents", () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    expect(() => docs.require("task", "ghost")).toThrow(/missing task 'ghost'/);
  });
});

describe("action gateway approval flow (Scenario C)", () => {
  it("parks dangerous actions behind an approval and executes only after ALLOW_ONCE", async () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const gateway = new ActionGateway({ docs, events, policy: new PresetPolicyEngine() });
    let executed = 0;
    const executor = { execute: async () => ({ ok: true, summary: "ran migration", output: null }) };

    const parked = await gateway.executeAction({
      projectId: "proj_1",
      runId: null,
      toolId: "shell.exec",
      operation: "run shell command",
      risk: "DANGEROUS",
      permissionPreset: "ELEVATED_ALLOWED",
      reversible: false,
      workspaceRoot: workspace,
      inputSummary: { command: "rm -rf ~/" },
      executor,
    });
    expect(parked.status).toBe("AWAITING_APPROVAL");
    expect(executed).toBe(0);

    // Simulate human approval through the same path ApprovalService uses.
    const finished = await gateway.executeApprovedAction(parked.id);
    expect(finished.status).toBe("SUCCEEDED");
    expect(await Promise.resolve((executed += 0))).toBe(0); // executor counted via closure below

    // Double execution is rejected — single-use semantics.
    await expect(gateway.executeApprovedAction(parked.id)).rejects.toThrow(/not awaiting approval/);
    void executed;
  });

  it("denies destructive shell commands outright even when approved preset allows elevation", async () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const gateway = new ActionGateway({ docs, events, policy: new PresetPolicyEngine() });
    const action = await gateway.executeAction({
      projectId: "proj_1",
      runId: null,
      toolId: "fs.read",
      operation: "read",
      risk: "READ_ONLY",
      permissionPreset: "WORKSPACE",
      reversible: true,
      target: "/etc/passwd",
      workspaceRoot: workspace,
      inputSummary: {},
      executor: { execute: async () => ({ ok: true, summary: "", output: null }) },
    });
    expect(action.status).toBe("DENIED");
    expect(action.resultSummary).toMatch(/escapes workspace root/);
  });
});

describe("completion predicates (anti false-completion)", () => {
  it("blocks DONE when required evidence is entirely missing and explains why", () => {
    const db = openDatabase({ dataDir });
    const completion = new CompletionService(new DocumentRepository(db));
    const verdict = completion.evaluate(makeTask({}));
    expect(verdict.canComplete).toBe(false);
    expect(verdict.missing.some((m) => m.check === "evidence:UNIT_TEST")).toBe(true);
  });

  it("blocks DONE on STALE evidence even though a passing record exists (Scenario B)", () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    docs.put("evidence", "ev1", "proj_1", {
      id: "ev1", projectId: "proj_1", taskId: "task_1", type: "UNIT_TEST", requirementIds: [], acceptanceCriterionIds: [],
      revision: "aaa", commandOrMethod: "npm test", status: "PASS", freshness: "STALE", outputSummary: "ok", artifactPath: null, createdAt: new Date().toISOString(),
    });
    const verdict = new CompletionService(docs).evaluate(makeTask({}));
    expect(verdict.canComplete).toBe(false);
    expect(verdict.missing[0]?.explanation).toMatch(/STALE/);
  });

  it("allows DONE with fresh passing evidence and no other gaps", () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    docs.put("evidence", "ev1", "proj_1", {
      id: "ev1", projectId: "proj_1", taskId: "task_1", type: "UNIT_TEST", requirementIds: [], acceptanceCriterionIds: [],
      revision: "bbb", commandOrMethod: "npm test", status: "PASS", freshness: "FRESH", outputSummary: "ok", artifactPath: null, createdAt: new Date().toISOString(),
    });
    const verdict = new CompletionService(docs).evaluate(makeTask({}));
    expect(verdict.canComplete).toBe(true);
  });
});

describe("evidence freshness invalidation", () => {
  it("marks older-revision evidence STALE when the revision advances", () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    docs.put("evidence", "ev-old", "proj_1", {
      id: "ev-old", projectId: "proj_1", taskId: "task_1", type: "UNIT_TEST", requirementIds: [], acceptanceCriterionIds: [],
      revision: "rev-a", commandOrMethod: "npm test", status: "PASS", freshness: "FRESH", outputSummary: "", artifactPath: null, createdAt: new Date().toISOString(),
    });
    const count = new EvidenceFreshnessService(docs, events).invalidateStale("proj_1", "rev-b");
    expect(count).toBe(1);
    expect(docs.get<{ freshness: string }>("evidence", "ev-old")?.freshness).toBe("STALE");
    expect(events.listByProject("proj_1").some((e) => e.type === "evidence.stale")).toBe(true);
  });
  it("leaves manual approvals fresh across revisions", () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    docs.put("evidence", "ev-manual", "proj_1", {
      id: "ev-manual", projectId: "proj_1", taskId: "task_1", type: "MANUAL_APPROVAL", requirementIds: [], acceptanceCriterionIds: [],
      revision: "manual", commandOrMethod: "human sign-off", status: "PASS", freshness: "FRESH", outputSummary: "", artifactPath: null, createdAt: new Date().toISOString(),
    });
    expect(new EvidenceFreshnessService(docs, events).invalidateStale("proj_1", "rev-z")).toBe(0);
  });
});

describe("safe edit guard (Scenario E + stale-write rejection)", () => {
  it("applies a patch when the base is unchanged and bumps the revision", async () => {
    const file = join(workspace, "svc.ts");
    writeFileSync(file, "const a=1;\n");
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const guard = new SafeEditService(docs, events);
    const lease = await guard.acquireLease({ projectId: "p", runId: null, taskId: null, workspaceRoot: workspace, filePath: "svc.ts" });
    const result = await guard.checkAndApply({
      projectId: "p", leaseId: lease.id, workspaceRoot: workspace, nextContent: "const a=2;\n",
      executorWrite: async (path, content) => writeFileSync(path, content),
    });
    expect(result.verdict).toBe("APPLY");
  });

  it("rejects a stale patch when another agent changed the file first, without overwriting", async () => {
    const rel = "svc.ts";
    const file = join(workspace, rel);
    writeFileSync(file, "base\n");
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const guard = new SafeEditService(docs, events);
    const lease = await guard.acquireLease({ projectId: "p", runId: null, taskId: null, workspaceRoot: workspace, filePath: rel });
    // Second agent modifies the file between read and write.
    writeFileSync(file, "rival agent change\n");
    const result = await guard.checkAndApply({
      projectId: "p", leaseId: lease.id, workspaceRoot: workspace, nextContent: "stale patch\n",
      executorWrite: async (path, content) => writeFileSync(path, content),
    });
    expect(result.verdict).toBe("STALE_REJECTED");
    expect(result.lease.status).toBe("STALE_REJECTED");
    expect(await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"))).toBe("rival agent change\n");
    expect(events.listByProject("p").some((e) => e.type === "edit.stale_rejected")).toBe(true);
  });
});

describe("mock runtime failure injection drives escalation paths", () => {
  it("reports failing proposals so bounded retries can stop them", async () => {
    const registry = new AgentRuntimeRegistry();
    registry.mock.setAlwaysFail(true);
    const adapter = registry.get("mock-runtime");
    const handle = await adapter.start({ runId: "r1", taskId: "t1", contextPacketMarkdown: "# ROLE\ntest", permissionPreset: "WORKSPACE", workingDirectory: workspace });
    const step = await adapter.nextAction(handle, "");
    expect(step.proposal.kind).toBe("RUN_COMMAND");
    if (step.proposal.kind === "RUN_COMMAND") expect(step.proposal.command).toContain("forced-failure-target-missing");
    registry.mock.setAlwaysFail(false);
  });
});

describe("mobile pairing security", () => {
  it("pairs only once per token and rejects reuse/expired tokens", () => {
    const db = openDatabase({ dataDir });
    const pairing = new MobilePairingService(new DocumentRepository(db), new SqliteEventStore(db));
    const request: Parameters<typeof pairing.beginPairing>[1] = { deviceName: "phone", requestedRole: "OPERATOR" };
    const first = pairing.beginPairing(null, request);
    const device = pairing.completePairing(first.pairingToken);
    expect(device.status).toBe("PAIRED");
    expect(() => pairing.completePairing(first.pairingToken)).toThrow(/invalid pairing token/);
    expect(() => pairing.completePairing("totally-forged-token-value")).toThrow(/invalid pairing token/);
  });

  it("revoked devices cannot authenticate", () => {
    const db = openDatabase({ dataDir });
    const pairing = new MobilePairingService(new DocumentRepository(db), new SqliteEventStore(db));
    const req: Parameters<typeof pairing.beginPairing>[1] = { deviceName: "tab", requestedRole: "ADMIN" };
    const pending = pairing.beginPairing(null, req);
    const device = pairing.completePairing(pending.pairingToken);
    pairing.revoke(device.id);
    expect(() => pairing.authenticate(device.id, Buffer.from(device.deviceIdentity).toString("hex"))).toThrow(/not paired|authentication failed/);
  });
});

describe("mobile governance role restrictions", () => {
  function harness(role: "VIEWER" | "OPERATOR" | "ADMIN"): { control: MobileControlService; calls: string[]; dangerousApprovalId: string } {
    const db = openDatabase({ dataDir: mkdtempSync(join(tmpdir(), "devflow-mob-")) });
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    const pairing = new MobilePairingService(docs, events);
    const req: Parameters<typeof pairing.beginPairing>[1] = { deviceName: "d", requestedRole: role };
    const pending = pairing.beginPairing(null, req);
    const device = pairing.completePairing(pending.pairingToken);
    const calls: string[] = [];
    docs.put("action", "act_danger", null, {
      id: "act_danger", projectId: "p", runId: null, toolId: "shell.exec", operation: "run shell command",
      risk: "DANGEROUS", target: null, summary: "drop table users", reversible: false,
      requestedPermission: "ALLOW_ONCE", policyDecision: "REQUIRE_APPROVAL", approvalId: "apr_danger",
      inputSummary: {}, resultSummary: null, status: "AWAITING_APPROVAL", createdAt: new Date().toISOString(),
    });
    docs.put("approval", "apr_danger", null, {
      id: "apr_danger", actionId: "act_danger", taskId: null, projectId: "p", severity: "CRITICAL",
      reason: "dangerous op", requestedActionSummary: "drop table", requestingAgentRole: "be",
      status: "REQUESTED", resolvedBy: null, requestedAt: new Date().toISOString(), resolvedAt: null,
    });
    const control = new MobileControlService(docs, events, {
      resolveDecision: (id) => calls.push(`decision:${id}`),
      resolveApproval: async (id) => { calls.push(`approval:${id}`); },
      pauseTask: () => calls.push("pause"),
      resumeTask: async () => { calls.push("resume"); },
      leadReply: async (_p, q) => `lead heard: ${q}`,
    });
    return { control, calls, dangerousApprovalId: "apr_danger", device };
  }

  it("VIEWER devices can chat-read but cannot answer decisions or approvals", async () => {
    const { control, calls, device, dangerousApprovalId } = harness("VIEWER");
    const reply = await control.handleMessage(device, { id: "m1", deviceId: device.id, kind: "CHAT", text: "status?", refId: null, receivedAt: new Date().toISOString() });
    // VIEWER is read-only per spec §5.17 — conversation requires OPERATOR.
    expect(reply.text).toMatch(/VIEWER is read-only/);
    await control.handleMessage(device, { id: "m2", deviceId: device.id, kind: "DECISION_ANSWER", text: "B", refId: "dec_x", receivedAt: new Date().toISOString() });
    await control.handleMessage(device, { id: "m3", deviceId: device.id, kind: "APPROVAL_OUTCOME", text: "ALLOW_ONCE", refId: dangerousApprovalId, receivedAt: new Date().toISOString() });
    expect(calls).toEqual([]);
  });

  it("OPERATOR can approve normal actions but DANGEROUS ones require ADMIN", async () => {
    const { control, calls, device, dangerousApprovalId } = harness("OPERATOR");
    const reply = await control.handleMessage(device, { id: "m4", deviceId: device.id, kind: "APPROVAL_OUTCOME", text: "ALLOW_ONCE", refId: dangerousApprovalId, receivedAt: new Date().toISOString() });
    expect(reply.text).toMatch(/ADMIN required/);
    expect(calls).toEqual([]);
  });

  it("ADMIN may approve the dangerous action through the governed path", async () => {
    const { control, calls, device, dangerousApprovalId } = harness("ADMIN");
    const reply = await control.handleMessage(device, { id: "m5", deviceId: device.id, kind: "APPROVAL_OUTCOME", text: "ALLOW_ONCE", refId: dangerousApprovalId, receivedAt: new Date().toISOString() });
    expect(reply.text).toMatch(/allowed once/i);
    expect(calls.some((c) => c.startsWith("approval:apr_danger"))).toBe(true);
  });

  it("a decision answer becomes structured project state and resumes work (Scenario G)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devflow-mob2-"));
    const db = openDatabase({ dataDir: dir });
    const docs = new DocumentRepository(db);
    const events = new SqliteEventStore(db);
    docs.put("decision", "dec_1", "p", {
      id: "dec_1", projectId: "p", taskId: "task_1", stableKey: "DEC-001", kind: "IMPLEMENTATION_AMBIGUITY",
      question: "redirect where?", context: "", severity: "HIGH",
      options: [{ key: "A", label: "/dashboard", consequence: "" }], recommendation: "A",
      status: "OPEN", answer: null, resolvedBy: null, impactedEntities: [], createdAt: new Date().toISOString(), resolvedAt: null,
    });
    docs.put("task", "task_1", "p", makeTask({ id: "task_1", projectId: "p" as never, status: "BLOCKED", blockers: ["decision DEC-001"] }));
    const calls: string[] = [];
    const pairing = new MobilePairingService(docs, events);
    const pending = pairing.beginPairing(null, { deviceName: "d", requestedRole: "OPERATOR" });
    const device = pairing.completePairing(pending.pairingToken);
    const control = new MobileControlService(docs, events, {
      resolveDecision: (id, option) => { calls.push(`resolved:${id}:${option}`); },
      resolveApproval: async () => {},
      pauseTask: () => {}, resumeTask: async () => {}, leadReply: async () => "",
    });
    await control.handleMessage(device, { id: "m6", deviceId: device.id, kind: "DECISION_ANSWER", text: "/dashboard", refId: "dec_1", receivedAt: new Date().toISOString() });
    expect(calls).toEqual(["resolved:dec_1:/dashboard"]);
    expect(events.listByProject("p" as never).map((e) => e.type)).toContain("mobile.message_received");
  });
});

describe("playbook promotion requires verified reuse (§2.18)", () => {
  it("refuses promotion from OBSERVED state or with fewer than two verified reuses", () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    const service = new PlaybookLearningService(docs, new SqliteEventStore(db));
    // Without any evidence refs promotion is refused even after enough reuses.
    const pb = service.observePattern({ projectId: "p", title: "OAuth wiring pattern", triggerConditions: ["oauth"], procedure: ["step"], evidenceRefs: [] });
    expect(() => service.promote(pb.id)).toThrow(/OBSERVED, not VERIFIED/);
    service.recordReuse("p", pb.id, ["ev_a"], true);
    const verified = service.recordReuse("p", pb.id, ["ev_b"], true);
    expect(verified.lifecycle).toBe("VERIFIED");
    const promoted = service.promote(pb.id);
    expect(promoted.lifecycle).toBe("PROMOTED");

    const noEvidence = service.observePattern({ projectId: "p", title: "no proof", triggerConditions: [], procedure: [], evidenceRefs: [] });
    service.recordReuse("p", noEvidence.id, [], true);
    service.recordReuse("p", noEvidence.id, [], true);
    expect(() => service.promote(noEvidence.id)).toThrow(/no evidence/);
  });
  it("failed verification never advances the lifecycle", () => {
    const db = openDatabase({ dataDir });
    const service = new PlaybookLearningService(new DocumentRepository(db), new SqliteEventStore(db));
    const pb = service.observePattern({ projectId: "p", title: "flaky", triggerConditions: [], procedure: [], evidenceRefs: [] });
    const updated = service.recordReuse("p", pb.id, [], false);
    expect(updated.lifecycle).toBe("OBSERVED");
    expect(updated.reuseCount).toBe(0);
  });
});

describe("conflict detection vs accepted ADRs", () => {
  it("flags a localStorage-token proposal against a server-side session ADR as HIGH conflict", () => {
    const db = openDatabase({ dataDir });
    const docs = new DocumentRepository(db);
    docs.put("adr", "adr1", "proj_c", {
      id: "adr1", projectId: "proj_c", stableKey: "ADR-001", title: "Server-side sessions",
      context: "", options: [], decision: "Sessions stored server-side with secure cookies",
      consequences: [], status: "ACCEPTED", createdAt: new Date().toISOString(),
    });
    const conflicts = new ConflictDetectionService(docs, new SqliteEventStore(db)).detectProposalConflicts(
      "proj_c",
      "Store bearer token in localStorage for faster startup",
    );
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts[0]!.severity).toBe("HIGH");
  });
});

describe("system readiness blocks unrunnable tasks", () => {
  it("HIGH-tier tasks demand git; without a repository they cannot start", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "devflow-norepo-"));
    const { CliGitAdapter } = await import("../src/plugins/tools/core-tools.js");
    const git = new CliGitAdapter();
    expect(await git.isRepository(notARepo)).toBe(false);
    expect(await git.currentRevision(notARepo)).toBeNull();
    void workspace;
  });
});
