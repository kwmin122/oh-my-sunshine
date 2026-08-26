import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../infrastructure/db/connection.js";
import { DocumentRepository } from "../infrastructure/db/document-repository.js";
import { SqliteEventStore } from "../infrastructure/db/event-store.js";
import { createLogger } from "../lib/logging.js";

/**
 * Seeds a demo database with scenarios A–H from spec §37 so a reviewer can
 * experience the complete workflow offline (`pnpm demo:seed`, then start daemon
 * with DEVFLOW_DATA_DIR pointing at the same directory).
 */
const log = createLogger("demo-seed");

async function main(): Promise<void> {
  const config = loadConfig({ dataDir: process.env.DEVFLOW_DATA_DIR ?? ".devflow-data" });
  const db = openDatabase(config);
  const docs = new DocumentRepository(db);
  const events = new SqliteEventStore(db);

  if (docs.list<{ id: string }>("project").some((p) => p.id === "proj_demo_medical")) {
    log.info("demo already seeded — skipping");
    return;
  }

  // ---- Scenario A: vague feature ----
  const now = new Date().toISOString();
  docs.put("project", "proj_demo_medical", "proj_demo_medical", {
    id: "proj_demo_medical", name: "Medical Scout (Demo)", description: "Seeded demo project",
    repositoryPath: null, status: "ACTIVE", riskProfile: "NORMAL", createdAt: now, updatedAt: now,
  });
  events.append({ projectId: "proj_demo_medical", type: "project.created", entityType: "project", entityId: "proj_demo_medical", actorType: "USER", payload: { name: "Medical Scout (Demo)" } });
  docs.put("mission", "mission_demo", "proj_demo_medical", { id: "mission_demo", projectId: "proj_demo_medical", rawRequest: "Build a medical-supplies trend scouting dashboard", createdAt: now });
  events.append({ projectId: "proj_demo_medical", type: "mission.created", entityType: "mission", entityId: "mission_demo", actorType: "USER", payload: {} });
  docs.put("intent_record", "intent_demo", "proj_demo_medical", {
    id: "intent_demo", projectId: "proj_demo_medical", taskId: null, type: "GOAL",
    literalRequest: "Build a medical-supplies trend scouting dashboard",
    inferredGoal: "Decision support for sourcing trends in medical supplies",
    confidence: 0.62,
    hiddenDimensions: ["data sources", "refresh cadence", "definition of a trend"],
    recommendedEntryPoint: "DISCOVERY_INTERVIEW", createdAt: now,
  });

  // Deterministic discovery Q&A history
  const qa: Array<[string, string, string]> = [
    ["authentication", "Should unauthenticated users view any part?", "B — public read-only trends, login for alerts"],
    ["authorization", "Do roles differ?", "B — User / Admin"],
    ["external_integrations", "Which external providers at launch?", "Government procurement APIs + supplier feeds"],
    ["failure_behavior", "Degrade or fail loudly when upstream dies?", "A — degrade gracefully with cached data"],
    ["functional_behavior", "Must-have behaviors at launch?", "Trend list, drill-down chart, email alert"],
    ["data_model", "Core persisted entities?", "Supplier, Product, TrendSnapshot, Alert"],
    ["security", "Security requirements at launch?", "B — baseline plus audit logging"],
    ["acceptance_criteria", "What proves it works end to end?", "Alert arrives within 5 minutes of trend detection"],
  ];
  let idx = 1;
  for (const [category, question, answer] of qa) {
    const qid = `dq_demo_${idx}`;
    docs.put("discovery_question", qid, "proj_demo_medical", {
      id: qid, projectId: "proj_demo_medical", category, question, whyItMatters: "Demo seeded question",
      affectsDecision: "scope", options: [], recommendedOption: null, defaultAssumption: null,
      status: "ANSWERED", answer, answeredAt: now, createdAt: now,
    });
    docs.put("requirement", `req_demo_${idx}`, "proj_demo_medical", {
      id: `req_demo_${idx}`, projectId: "proj_demo_medical", goalId: "mission_demo",
      stableKey: `REQ-${String(idx).padStart(3, "0")}`, category, statement: `${question} → ${answer}`,
      rationale: "Seeded demo answer", priority: "MUST", status: "APPROVED", confidence: 0.9,
      source: "USER", assumptions: [], createdAt: now, updatedAt: now,
    });
    events.append({ projectId: "proj_demo_medical", type: "discovery.answer_received", entityType: "discovery_question", entityId: qid, actorType: "USER", payload: {} });
    events.append({ projectId: "proj_demo_medical", type: "requirement.discovered", entityType: "requirement", entityId: `req_demo_${idx}`, actorType: "ENGINE", payload: {} });
    idx++;
  }
  events.append({ projectId: "proj_demo_medical", type: "discovery.ready", entityType: "project", entityId: "proj_demo_medical", actorType: "ENGINE", payload: { score: 0.78 } });

  // Canonical MASTER_SPEC artifact
  const requirements = docs.list<{ stableKey: string; statement: string }>("requirement", "proj_demo_medical");
  docs.put("artifact", `master_spec:proj_demo_medical`, "proj_demo_medical", {
    id: "master_spec:proj_demo_medical", projectId: "proj_demo_medical", type: "MASTER_SPEC",
    canonicalName: "MASTER_SPEC.md", revision: 1, path: null, updatedAt: now,
    content: ["# MASTER SPEC — Medical Scout (Demo)", "", "## Requirements", ...requirements.map((r) => `- [${r.stableKey}] ${r.statement}`)].join("\n"),
  });

  // Task DAG
  const dag: Array<[string, string, string[], string[]]> = [
    ["TASK-001", "Ingest supplier feeds into normalized snapshots", [], ["UNIT_TEST"]],
    ["TASK-002", "Compute rolling trend scores per product", ["TASK-001"], ["UNIT_TEST"]],
    ["TASK-003", "Trend dashboard UI with empty/error states", ["TASK-002"], ["E2E_TEST"]],
    ["TASK-004", "Email alert pipeline on threshold crossing", ["TASK-002"], ["INTEGRATION_TEST", "BUILD"]],
  ];
  const taskIds = new Map<string, string>();
  for (const [key, objective, deps, evidence] of dag) {
    const id = `task_demo_${key}`;
    taskIds.set(key, id);
    docs.put("task", id, "proj_demo_medical", {
      id, projectId: "proj_demo_medical", stableKey: key, parentTaskId: null, objective,
      ownerRole: "role_be", riskTier: "NORMAL", status: "READY",
      dependencyTaskIds: deps.map((d) => taskIds.get(d)!), requirementIds: [`req_demo_005`],
      acceptanceCriteriaIds: [], plannedSteps: ["inspect patterns", "implement", "test"],
      affectedModules: ["ingest"], requiredEvidenceTypes: evidence, requiredReviewTypes: ["SPEC_COMPLIANCE", "CODE_QUALITY"],
      permissionsNeeded: ["READ_ONLY", "WORKSPACE_WRITE"], blockers: [], handoffNotes: null,
      verificationCommands: ["npm test"], createdAt: now, updatedAt: now,
    });
    events.append({ projectId: "proj_demo_medical", type: "task.created", entityType: "task", entityId: id, actorType: "ENGINE", payload: { stableKey: key } });
  }

  // ---- Scenario B: stale evidence blocking completion ----
  docs.put("evidence", "ev_demo_stale", "proj_demo_medical", {
    id: "ev_demo_stale", projectId: "proj_demo_medical", taskId: "task_demo_TASK-001",
    type: "UNIT_TEST", requirementIds: [], acceptanceCriterionIds: [],
    revision: "old-rev-abc123", commandOrMethod: "npm test", status: "PASS", freshness: "STALE",
    outputSummary: "12/12 passed (against old revision)", artifactPath: null, createdAt: now,
  });
  events.append({ projectId: "proj_demo_medical", type: "evidence.stale", entityType: "evidence", entityId: "ev_demo_stale", actorType: "ENGINE", payload: { reason: "code changed after run" } });

  // ---- Scenario C: approval waiting on a dangerous migration ----
  docs.put("action", "act_demo_migration", "proj_demo_medical", {
    id: "act_demo_migration", projectId: "proj_demo_medical", runId: null, toolId: "shell.exec",
    operation: "run shell command", risk: "DANGEROUS", target: null,
    summary: "shell.exec:run shell command (prisma migrate reset --force)",
    reversible: false, requestedPermission: "ALLOW_ONCE", policyDecision: "REQUIRE_APPROVAL",
    approvalId: "apr_demo_migration", inputSummary: { command: "[redacted]" }, resultSummary: null,
    status: "AWAITING_APPROVAL", createdAt: now,
  });
  docs.put("approval", "apr_demo_migration", "proj_demo_medical", {
    id: "apr_demo_migration", actionId: "act_demo_migration", taskId: "task_demo_TASK-001",
    projectId: "proj_demo_medical", severity: "CRITICAL",
    reason: "destructive DB reset requires human approval",
    requestedActionSummary: "prisma migrate reset --force", requestingAgentRole: "Backend Engineer",
    status: "REQUESTED", resolvedBy: null, requestedAt: now, resolvedAt: null,
  });
  events.append({ projectId: "proj_demo_medical", type: "action.approval_requested", entityType: "approval", entityId: "apr_demo_migration", actorType: "ENGINE", payload: {} });

  // ---- Scenario D: repeated failure escalated to Tech Lead ----
  docs.put("decision", "dec_demo_escalation", "proj_demo_medical", {
    id: "dec_demo_escalation", projectId: "proj_demo_medical", taskId: "task_demo_TASK-002",
    stableKey: "DEC-001", kind: "REVIEW_ESCALATION",
    question: "Implementation failed 3 times (flaky feed parser). Choose recovery strategy.",
    context: "Task TASK-002 repeatedly failed against malformed supplier XML.",
    severity: "HIGH",
    options: [
      { key: "A", label: "Replan with smaller scope", consequence: "task is split before retry" },
      { key: "B", label: "Retry once more", consequence: "one additional bounded attempt" },
      { key: "C", label: "Escalate to human", consequence: "work pauses until you decide" },
    ],
    recommendation: "A", status: "OPEN", answer: null, resolvedBy: null,
    impactedEntities: ["TASK-002"], createdAt: now, resolvedAt: null,
  });
  events.append({ projectId: "proj_demo_medical", type: "agent.escalated", entityType: "task", entityId: "task_demo_TASK-002", actorType: "ENGINE", payload: { failures: 3 } });

  // ---- Scenario F: capacity snapshot showing low remaining quota ----
  docs.put("provider_capacity", "cap_demo_claude", null, {
    id: "cap_demo_claude", runtimeId: "runtime_claude_code", provider: "claude", account: "team-plan",
    limitType: "WEEKLY", usedPercentRemaining: 9, unit: "%", resetAt: null,
    contextUsedTokens: null, contextLimitTokens: 200000, costUsd: null, credits: null,
    health: "GOOD", latencyMs: 1800, lastError: null, source: "CLI_REPORTED", confidence: 0.7, refreshedAt: now,
  });
  docs.put("provider_capacity", "cap_demo_codex", null, {
    id: "cap_demo_codex", runtimeId: "runtime_codex_cli", provider: "codex", account: null,
    limitType: "WEEKLY", usedPercentRemaining: 71, unit: "%", resetAt: null,
    contextUsedTokens: null, contextLimitTokens: null, costUsd: null, credits: null,
    health: "GOOD", latencyMs: 2100, lastError: null, source: "CLI_REPORTED", confidence: 0.7, refreshedAt: now,
  });

  // ---- Scenario G groundwork: paired OPERATOR device ----
  docs.put("mobile_device", "dev_demo_phone", null, {
    id: "dev_demo_phone", name: "Reviewer Phone", role: "OPERATOR",
    deviceIdentity: "demo-device-identity-not-a-secret", status: "PENDING_PAIRING",
    pairedAt: null, lastSeenAt: null, revokedAt: null,
  });

  // Export .devflow packet into demo dir for import/export demonstration
  // Write to the repo-root demo/ regardless of the package cwd the seeder runs from.
  const outDir = join(process.cwd(), "apps/daemon") === process.cwd() || process.cwd().endsWith("apps/daemon") ? resolve(process.cwd(), "../../demo") : join(process.cwd(), "demo");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "MASTER_SPEC.md"), docs.get<{ content: string }>("artifact", "master_spec:proj_demo_medical")?.content ?? "");

  log.info("demo seed complete", { project: "proj_demo_medical", tasks: dag.length, events: events.latestSequence("proj_demo_medical") });
}

main().catch((err) => {
  log.error("seed failed", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
