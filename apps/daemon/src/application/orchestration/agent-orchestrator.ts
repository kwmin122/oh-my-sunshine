import type {
  AgentRole,
  AgentRun,
  AgentSession,
  AgentRuntimeAdapter,
  Decision,
  Evidence,
  TaskContract,
  ResolvedRuntime,
  RuntimeStartInput,
} from "@devflow/contracts";
import { isAgentRunTransitionLegal, newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { DevFlowConfig } from "../../lib/config.js";
import { createLogger } from "../../lib/logging.js";
import { classifyShellCommand } from "../../lib/path-guard.js";
import type { ToolRegistry } from "../../plugins/tools/tool-registry.js";
import type { ActionGateway } from "../gateway/action-gateway.js";
import type { ContextCompiler, CompiledContext } from "../context/context-compiler.js";
import type { CompletionService } from "../verification/verification-service.js";
import type { DecisionService } from "../governance/decision-service.js";
import type { HandoffService } from "./handoff-service.js";

const log = createLogger("agent-orchestrator");

export interface OrchestratorPorts {
  docs: DocumentRepository;
  events: EventStore;
  gateway: ActionGateway;
  contextCompiler: ContextCompiler;
  completion: CompletionService;
  decisions: DecisionService;
  /** AI Team Composer (spec §31): resolves role→runtime→model with fallbacks. */
  composer?: {
    resolveForTask(projectId: string, taskId: string, ownerRoleId: string | null, runOverride?: { runtimeId: string }): ResolvedRuntime | null;
    resolveDetailed?(projectId: string, taskId: string, ownerRoleId: string | null, runOverride?: { runtimeId: string }, routingCtx?: { riskTier?: "LOW" | "NORMAL" | "HIGH"; failedAttempts?: number; quotaPct?: number | null }): { runtime: ResolvedRuntime | null; lockedUnavailableRuntimeId?: string; ruleApplied?: { runtimeId: string; rules: unknown[] } };
    listRuntimeIds(): string[];
  };
  tools: ToolRegistry;
  config: Pick<
    DevFlowConfig,
    "maxRunAttempts" | "escalationAfterConsecutiveFailures" | "stallThresholdMs" | "approvalGraceMultiplier" | "providerBackoffInitialMs" | "providerBackoffMaxMs" | "maxConcurrentRuns"
  >;
  /** V3 §17 handoff builder (S2). Optional for backward-compatible test harnesses. */
  handoff?: HandoffService;
  /** V3 §24 circuit breaker seam + §37 concurrency limit. */
  breaker?: { recordSuccess(id: string): void; recordFailure(id: string): void };
  /** §22 capacity feed for quota-aware routing rules (quotaBelowPct). */
  quotaLookup?: (projectId: string, roleId: string) => number | null;
}

export interface RuntimeRegistryPort {
  get(id: string): AgentRuntimeAdapter;
}

/**
 * Goal-directed execution loop (spec §4 Step 15) with liveness + bounded recovery.
 * Invariants enforced here:
 * - every agent action flows through the gateway — no bypass path,
 * - retries are bounded; repeated failure escalates into a Decision instead of looping forever,
 * - provider degradation uses exponential backoff and is distinct from implementation failure,
 * - runs waiting on approval/decision are never classified as stalled.
 */
export class AgentOrchestrator {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly runtimes: RuntimeRegistryPort,
    private readonly roles: { role(roleId: string): AgentRole },
  ) {}

  async startTaskRun(task: TaskContract, runtimeAdapterId: string): Promise<AgentRun> {
    // Resource limit (§37): bound concurrent agent runs — no unbounded fan-out.
    if (this.ports.config.maxConcurrentRuns > 0) {
      const active = this.ports.docs
        .list<AgentRun>("agent_run", task.projectId)
        .filter((r) => r.status === "RUNNING").length;
      if (active >= this.ports.config.maxConcurrentRuns) {
        throw new Error(
          `[orchestrator/start] concurrency limit reached (${active}/${this.ports.config.maxConcurrentRuns} running) — cancel or wait`,
        );
      }
    }
    const priorRuns = this.ports.docs.list<AgentRun>("agent_run", task.projectId).filter((r) => r.taskId === task.id);
    const attempts = priorRuns.length;
    if (attempts >= this.ports.config.maxRunAttempts) {
      throw new Error(
        `[orchestrator/start] task '${task.stableKey}' exhausted ${this.ports.config.maxRunAttempts} run attempts — escalation required`,
      );
    }

    // AI Team Composer: nearest override wins; unavailable runtimes degrade along fallbacks.
    // Run override (nearest wins): an explicit caller-provided runtime beats role/task layers,
    // but LOCKED bindings still veto auto-substitution downstream.
    const runOverride = runtimeAdapterId !== "mock-runtime" ? { runtimeId: runtimeAdapterId } : undefined;
    const routingCtx = {
      riskTier: task.riskTier,
      failedAttempts: priorRuns.filter((r) => r.status === "FAILED").length,
      // §22→§21 feed: known remaining-percent for the role's bound runtime;
      // unknown stays null and never fires a quota rule.
      quotaPct: this.ports.quotaLookup?.(task.projectId, task.ownerRole) ?? null,
    };
    const resolution = this.ports.composer?.resolveDetailed
      ? this.ports.composer.resolveDetailed(task.projectId, task.id, task.ownerRole, runOverride, routingCtx)
      : { runtime: this.ports.composer?.resolveForTask(task.projectId, task.id, task.ownerRole, runOverride) ?? null };
    const resolved = resolution.runtime;
    let effectiveAdapter = runtimeAdapterId;
    let modelHint: RuntimeStartInput["modelHint"] | undefined;
    if (!resolved && resolution.lockedUnavailableRuntimeId) {
      // LOCKED + unavailable (§V3-4): fail closed — no silent mock substitution.
      const now0 = new Date().toISOString();
      this.emit(task.projectId, "team.locked_unavailable", task.id, {
        roleId: task.ownerRole,
        lockedRuntime: resolution.lockedUnavailableRuntimeId,
      });
      const blockedTask: TaskContract = {
        ...task,
        status: "BLOCKED",
        blockers: [`LOCKED runtime '${resolution.lockedUnavailableRuntimeId}' unavailable — keep / switch once / change policy`],
        updatedAt: now0,
      };
      this.ports.docs.put("task", blockedTask.id, blockedTask.projectId, blockedTask);
      throw new Error(
        `[orchestrator/start] LOCKED runtime '${resolution.lockedUnavailableRuntimeId}' is unavailable for role ${task.ownerRole} — refusing auto-substitution`,
      );
    }
    if (resolution.ruleApplied && resolved) {
      // Conditional rule changed the selection (§21/S6) — audit it.
      effectiveAdapter = resolved.runtimeId;
      modelHint = { providerId: resolved.providerId, model: resolved.model, effort: resolved.effort };
      this.emit(task.projectId, "routing.rule_applied", task.id, {
        riskTier: routingCtx.riskTier,
        failedAttempts: routingCtx.failedAttempts,
        selectedRuntime: effectiveAdapter,
        requestedRuntime: resolved.requestedRuntimeId,
        chain: resolved.chain,
      });
    }
    if (resolved) {
      const registered = this.ports.composer?.listRuntimeIds().includes(resolved.runtimeId) ?? false;
      if (!registered && resolved.runtimeId !== "mock-runtime") {
        this.emit(task.projectId, "agent.fallback_used", task.id, {
          requested: resolved.runtimeId,
          reason: "runtime not registered — falling back",
          final: resolved.chain.includes("fallback→mock-runtime") ? "mock-runtime" : resolved.runtimeId,
        });
        effectiveAdapter = "mock-runtime";
      } else {
        effectiveAdapter = resolved.runtimeId;
      }
      modelHint = { providerId: resolved.providerId, model: resolved.model, effort: resolved.effort };
      this.emit(task.projectId, "runtime.selected", task.id, {
        runId: null,
        runtimeId: effectiveAdapter,
        requested: resolved.requestedRuntimeId,
        chain: resolved.chain,
        fallbackUsed: resolved.fallbackUsed,
        model: resolved.model,
        effort: resolved.effort,
      });
    }

    const now = new Date().toISOString();
    const run: AgentRun = {
      id: newId("run"),
      projectId: task.projectId,
      agentRoleId: task.ownerRole,
      // Record the adapter that will ACTUALLY execute (post-composer resolution),
      // so cancellation/resume reach the real runtime — not the caller's default.
      runtimeConfigId: `runtime_${effectiveAdapter}`,
      sessionId: null,
      taskId: task.id,
      status: "RUNNING",
      attempt: attempts + 1,
      startedAt: now,
      endedAt: null,
      summary: null,
      failureReason: null,
      contextSnapshotId: null,
    };
    this.ports.docs.put("agent_run", run.id, run.projectId, run);
    // Handoff Packet (§V3-17 / S2): when a previous attempt failed, carry durable
    // outcome context into the new runtime — objective, plan, diffs, failure
    // taxonomy, revision. Runtime switches are handoffs, not cold restarts.
    let handoffMarkdown: string | undefined;
    const hadPriorFailure = this.ports.docs
      .list<AgentRun>("agent_run", task.projectId)
      .some((r) => r.taskId === task.id && r.status === "FAILED" && r.id !== run.id);
    if (hadPriorFailure && this.ports.handoff) {
      const project = this.ports.docs.get<{ repositoryPath: string | null }>("project", task.projectId);
      const packet = await this.ports.handoff.buildForRetry(
        task,
        effectiveAdapter,
        project?.repositoryPath ?? process.cwd(),
        "retry after failed attempt",
      ).catch(() => null);
      if (packet) {
        this.emit(task.projectId, "agent.handoff_generated", task.id, {
          runId: run.id,
          from: packet.previousRuntimeId,
          to: packet.nextRuntimeId,
          reason: packet.handoffReason,
          failureKind: packet.lastFailureKind,
          changedFiles: packet.changedFiles.length,
        });
        handoffMarkdown = this.ports.handoff.renderMarkdown(packet);
      }
    }
    return this.executeLoop(run, task, effectiveAdapter, undefined, modelHint, {
      handoffConsumed: Boolean(handoffMarkdown),
      handoffMarkdown,
    });
  }

  /**
   * Graceful shutdown drain (§25): stops every active runtime session so no CLI
   * child outlives the daemon. Runs are finalized as SYSTEM_SHUTDOWN and tasks
   * return to READY for restart-safe resumption. Returns stopped run ids.
   */
  async stopAllActive(): Promise<string[]> {
    const active = this.ports.docs
      .list<AgentRun>("agent_run")
      .filter((r) => r.status === "RUNNING" && r.sessionId);
    const stopped: string[] = [];
    for (const run of active) {
      try {
        const runtime = this.runtimes.get(run.runtimeConfigId.replace("runtime_", ""));
        await runtime.stop({ sessionId: run.sessionId! }).catch(() => undefined);
        const now = new Date().toISOString();
        const drained: AgentRun = { ...run, status: "FAILED", failureReason: "SYSTEM_SHUTDOWN", endedAt: now };
        this.ports.docs.put("agent_run", drained.id, drained.projectId, drained);
        if (run.taskId) {
          const task = this.ports.docs.get<TaskContract>("task", run.taskId);
          if (task && task.status === "RUNNING") {
            this.ports.docs.put("task", task.id, task.projectId, { ...task, status: "READY", updatedAt: now });
          }
        }
        this.emit(run.projectId, "agent.run_cancelled", run.taskId, { runId: run.id, reason: "SYSTEM_SHUTDOWN" });
        stopped.push(run.id);
      } catch {
        // keep draining other runs even if one adapter misbehaves
      }
    }
    return stopped;
  }

  /** User cancellation (§39): kill child process, checkpoint-free fail, release claim. */
  async cancelRun(runId: string): Promise<AgentRun> {    const run = this.ports.docs.require<AgentRun>("agent_run", runId);
    if (!["RUNNING", "WAITING_APPROVAL", "WAITING_DECISION"].includes(run.status)) {
      throw new Error(`[orchestrator/cancel] run '${runId}' in status ${run.status} cannot be cancelled`);
    }
    const task = run.taskId ? this.ports.docs.get<TaskContract>("task", run.taskId) : undefined;
    const runtime = this.runtimes.get(run.runtimeConfigId.replace("runtime_", ""));
    if (run.sessionId) await runtime.stop({ sessionId: run.sessionId }).catch(() => undefined);
    const now = new Date().toISOString();
    run.status = "FAILED";
    run.failureReason = "CANCELLED_BY_USER";
    run.endedAt = now;
    this.ports.docs.put("agent_run", run.id, run.projectId, run);
    this.emit(run.projectId, "agent.run_cancelled", task?.id ?? null, { runId });
    if (task) {
      const released: TaskContract = { ...task, status: "READY", updatedAt: now };
      this.ports.docs.put("task", released.id, released.projectId, released);
    }
    return run;
  }

  /** Resumes a run parked on approval/decision/provider backoff after external unblock. */
  async resumeRun(runId: string, observation: string): Promise<void> {
    const run = this.ports.docs.require<AgentRun>("agent_run", runId);
    const task = run.taskId ? this.ports.docs.get<TaskContract>("task", run.taskId) : undefined;
    if (!task) throw new Error(`[orchestrator/resume] run '${runId}' has no resolvable task`);
    if (!isAgentRunTransitionLegal(run.status, "RUNNING")) {
      log.warn(`run ${runId} in status ${run.status} cannot resume — ignored`);
      return;
    }
    const revived: AgentRun = { ...run, status: "RUNNING", failureReason: null };
    this.ports.docs.put("agent_run", revived.id, revived.projectId, revived);
    await this.executeLoop(revived, task, adapterIdFromRuntimeConfig(revived.runtimeConfigId), observation);
  }

  private async executeLoop(initialRun: AgentRun, task: TaskContract, runtimeAdapterId: string, initialObservation?: string, modelHint?: RuntimeStartInput["modelHint"], opts?: { handoffConsumed?: boolean; handoffMarkdown?: string }): Promise<AgentRun> {
    const project = this.ports.docs.require<{ id: string; repositoryPath: string | null }>("project", task.projectId);
    const workspaceRoot = project.repositoryPath ?? process.cwd();
    const role = this.roles.role(task.ownerRole);
    const runtime = this.runtimes.get(runtimeAdapterId);

    // Minimum-sufficient context packet (spec §10) — never the raw transcript.
    const compiled: CompiledContext = this.ports.contextCompiler.compile({ role, task, workspaceRoot });
    // Handoff (V3 §17): the next runtime resumes from durable facts appended to
    // its brief — not from chat memory, not from a cold restart.
    const briefMarkdown = opts?.handoffMarkdown
      ? `${compiled.markdown}\n\n---\n\n${opts.handoffMarkdown}`
      : compiled.markdown;
    this.ports.events.append({
      projectId: task.projectId,
      type: "agent.context_compiled",
      entityType: "task",
      entityId: task.id,
      actorType: "ENGINE",
      payload: { sectionsIncluded: compiled.included.length, approxTokens: compiled.approxTokens },
    });

    let run = initialRun;
    const session: AgentSession = {
      id: newId("sess"),
      projectId: task.projectId,
      roleId: task.ownerRole,
      runtimeConfigId: run.runtimeConfigId,
      goalId: null,
      taskId: task.id,
      sessionClass: "EPHEMERAL",
      liveness: "ACTIVE_PROGRESS",
      waitingReason: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      lastProgressAt: new Date().toISOString(),
      stallThresholdMs: this.ports.config.stallThresholdMs,
    };
    this.ports.docs.put("agent_session", session.id, task.projectId, session);
    this.emit(task.projectId, "session.created", session.id, { class: session.sessionClass });
    this.emit(task.projectId, "agent.run_started", task.id, { runId: run.id, attempt: run.attempt, runtime: runtimeAdapterId });

    const handle = await runtime.start({
      runId: run.id,
      taskId: task.id,
      contextPacketMarkdown: briefMarkdown,
      permissionPreset: role.defaultPolicyPreset,
      workingDirectory: workspaceRoot,
      modelHint,
    });
    // run.sessionId carries the RUNTIME session handle — cancellation must reach
    // the actual child process, not a document id (S1 regression evidence).
    run = { ...run, sessionId: handle.sessionId };
    this.ports.docs.put("agent_run", run.id, run.projectId, run);
    if (opts?.handoffConsumed) {
      this.emit(task.projectId, "agent.handoff_consumed", task.id, { runId: run.id, runtime: runtimeAdapterId });
    }

    let observation = initialObservation ?? "run started";
    let consecutiveProviderFailures = 0;
    let backoffMs = this.ports.config.providerBackoffInitialMs;

    for (let step = 0; step < 50; step++) {
      let proposalResult: Awaited<ReturnType<AgentRuntimeAdapter["nextAction"]>>;
      try {
        proposalResult = await runtime.nextAction(handle, observation);
        backoffMs = this.ports.config.providerBackoffInitialMs;
        consecutiveProviderFailures = 0;
      } catch (err) {
        // Circuit breaker (§24): every observed runtime failure counts.
        this.ports.breaker?.recordFailure(runtimeAdapterId);
        // Fatal provider states (cancel/auth/runtime-missing) are never retried (§16).
        if ((err as { providerFatal?: boolean }).providerFatal) {
          // A concurrent user cancel may have already finalized this run — never overwrite it.
          const current = this.ports.docs.get<AgentRun>("agent_run", run.id);
          if (current && ["FAILED", "SUCCEEDED", "CANCELLED"].includes(current.status)) return current;
          return this.finishFailed(run, session, task, err instanceof Error ? err.message : String(err));
        }
        // Provider-plane failure ≠ implementation failure: backoff, then retry within bounds.
        consecutiveProviderFailures++;
        this.emit(task.projectId, "provider.degraded", session.id, {
          error: err instanceof Error ? err.message : String(err),
          backoffMs,
        });
        session.liveness = "PROVIDER_BACKOFF";
        session.lastProgressAt = new Date().toISOString();
        this.ports.docs.put("agent_session", session.id, task.projectId, session);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, this.ports.config.providerBackoffMaxMs);
        if (consecutiveProviderFailures >= 3) {
          return this.finishFailed(run, session, task, `provider repeatedly degraded after ${consecutiveProviderFailures} attempts`);
        }
        continue;
      }
      const proposal = proposalResult.proposal;

      switch (proposal.kind) {
        case "FINISH": {
          // Circuit breaker (§24): observed success resets the failure streak.
          this.ports.breaker?.recordSuccess(runtimeAdapterId);
          // Review R7: a drained (SYSTEM_SHUTDOWN) run must not be resurrected
          // to SUCCEEDED if its process happened to finish during shutdown.
          const settled = this.ports.docs.get<AgentRun>("agent_run", run.id);
          if (settled && ["FAILED", "SUCCEEDED"].includes(settled.status)) return settled;
          run.summary = proposal.summary;
          return this.finishSuccess(run, session, task);
        }

        case "RAISE_DECISION": {
          // High-impact ambiguity mid-implementation → block + Decision Inbox (spec §21).
          const decision = this.ports.decisions.createDecision({
            projectId: task.projectId,
            taskId: task.id,
            kind: "IMPLEMENTATION_AMBIGUITY",
            question: proposal.question,
            context: proposal.context,
            severity: "HIGH",
            options: proposal.options.map((label, i) => ({
              key: String.fromCharCode(65 + i),
              label,
              consequence: "changes downstream implementation",
            })),
            recommendation: proposal.options[0] ?? null,
            impactedEntities: [task.stableKey],
          });
          run.status = "WAITING_DECISION";
          this.ports.docs.put("agent_run", run.id, run.projectId, run);
          session.liveness = "WAITING_FOR_DECISION";
          session.waitingReason = decision.stableKey;
          this.ports.docs.put("agent_session", session.id, task.projectId, session);
          const blockedTask: TaskContract = { ...task, status: "BLOCKED", blockers: [`decision ${decision.stableKey}`], updatedAt: new Date().toISOString() };
          this.ports.docs.put("task", blockedTask.id, blockedTask.projectId, blockedTask);
          this.emit(task.projectId, "task.blocked", decision.id, { question: proposal.question, task: task.stableKey });
          return run;
        }

        case "WRITE_FILE":
        case "RUN_COMMAND": {
          const isShell = proposal.kind === "RUN_COMMAND";
          const shellClass = isShell ? classifyShellCommand(proposal.command) : { destructive: false, elevated: false, readOnly: false };
          const risk: "DANGEROUS" | "ELEVATED" | "READ_ONLY" | "WORKSPACE_WRITE" =
            !isShell
              ? "WORKSPACE_WRITE"
              : shellClass.destructive
                ? "DANGEROUS"
                : shellClass.readOnly
                  ? "READ_ONLY"
                  : "ELEVATED";

          session.liveness = "ACTIVE_PROGRESS";
          session.lastProgressAt = new Date().toISOString();

          const action = await this.ports.gateway.executeAction({
            projectId: task.projectId,
            runId: run.id,
            toolId: isShell ? "shell.exec" : "fs.write",
            operation: isShell ? "run shell command" : "write file",
            risk,
            permissionPreset: role.defaultPolicyPreset,
            reversible: !isShell,
            target: isShell ? workspaceRoot : proposal.path,
            workspaceRoot,
            inputSummary: isShell ? { command: proposal.command } : { path: proposal.path, contentLength: proposal.content.length },
            executor: {
              execute: (input, ctx) => {
                const tool = this.ports.tools.get(isShell ? "shell.exec" : "fs.write");
                const enrichedInput = isShell
                  ? input
                  : { path: input.path, content: proposal.content };
                return tool.execute(enrichedInput, { workspaceRoot: ctx.workspaceRoot, actorRunId: run.id });
              },
            },
          });

          this.emit(task.projectId, "agent.action_requested", action.id, { summary: action.summary, status: action.status });

          if (action.status === "AWAITING_APPROVAL") {
            run.status = "WAITING_APPROVAL";
            this.ports.docs.put("agent_run", run.id, run.projectId, run);
            session.liveness = "WAITING_FOR_APPROVAL";
            session.waitingReason = action.approvalId ?? "approval";
            this.ports.docs.put("agent_session", session.id, task.projectId, session);
            return run;
          }
          if (action.status === "DENIED") {
            observation = `action denied by policy: ${action.resultSummary}`;
            continue;
          }
          this.emit(task.projectId, "agent.action_completed", action.id, { summary: action.resultSummary });
          observation = action.resultSummary ?? "";
          continue;
        }
      }
    }
    return this.finishFailed(run, session, task, "execution loop exceeded step bound without finishing");
  }

  /**
   * Liveness sweep (spec §3.8 Liveness Watchdog). A process being alive is not progress.
   * Approval/decision/backoff waits get multiplied grace before any stall classification.
   */
  sweepLiveness(): Array<{ sessionId: string; projectId: string; verdict: string }> {
    const verdicts: Array<{ sessionId: string; projectId: string; verdict: string }> = [];
    for (const session of this.ports.docs.list<AgentSession>("agent_session")) {
      if (["CLOSED", "FAILED"].includes(session.liveness)) continue;
      const elapsed = Date.now() - Date.parse(session.lastProgressAt);
      const legitWait = ["WAITING_FOR_APPROVAL", "WAITING_FOR_DECISION", "PROVIDER_BACKOFF"].includes(session.liveness);
      const threshold = legitWait ? session.stallThresholdMs * this.ports.config.approvalGraceMultiplier : session.stallThresholdMs;
      if (elapsed > threshold && session.liveness !== "STALLED") {
        session.liveness = "STALLED";
        this.ports.docs.put("agent_session", session.id, session.projectId, session);
        this.emit(session.projectId, "session.stalled", session.id, { elapsedMs: elapsed, legitWait });
        verdicts.push({ sessionId: session.id, projectId: session.projectId, verdict: "STALLED" });
      }
    }
    return verdicts;
  }

  private finishSuccess(run: AgentRun, session: AgentSession, task: TaskContract): AgentRun {
    const now = new Date().toISOString();
    run.status = "SUCCEEDED";
    run.endedAt = now;
    this.ports.docs.put("agent_run", run.id, run.projectId, run);
    session.liveness = "CLOSED";
    session.endedAt = now;
    this.ports.docs.put("agent_session", session.id, run.projectId, session);
    this.emit(run.projectId, "agent.run_completed", task.id, { runId: run.id, summary: run.summary });
    // Engine moves the task to VERIFYING; completion still requires evidence predicates.
    const updated: TaskContract = { ...task, status: "VERIFYING", updatedAt: now };
    this.ports.docs.put("task", updated.id, updated.projectId, updated);
    return run;
  }

  private finishFailed(run: AgentRun, session: AgentSession, task: TaskContract, reason: string): AgentRun {
    const now = new Date().toISOString();
    run.status = "FAILED";
    run.failureReason = reason;
    run.endedAt = now;
    this.ports.docs.put("agent_run", run.id, run.projectId, run);
    session.liveness = "FAILED";
    session.endedAt = now;
    this.ports.docs.put("agent_session", session.id, run.projectId, session);

    // User cancellation (§39) is never an implementation failure — it must not
    // consume the escalation budget; the task simply returns to READY.
    if (reason.includes("/CANCELLED]") || reason === "CANCELLED_BY_USER") {
      this.emit(run.projectId, "agent.run_cancelled", task.id, { runId: run.id });
      const retryable: TaskContract = { ...task, status: "READY", updatedAt: now };
      this.ports.docs.put("task", retryable.id, retryable.projectId, retryable);
      return run;
    }

    const totalFailures = this.ports.docs
      .list<AgentRun>("agent_run", run.projectId)
      .filter((r) => r.taskId === task.id && r.status === "FAILED").length;

    if (totalFailures >= this.ports.config.escalationAfterConsecutiveFailures) {
      // Bounded retries exhausted → escalate into a human/Tech-Lead decision, never loop forever.
      this.ports.decisions.createDecision({
        projectId: run.projectId,
        taskId: task.id,
        kind: "REVIEW_ESCALATION",
        question: `Implementation failed ${totalFailures} times (${reason}). Choose recovery strategy.`,
        context: `Task ${task.stableKey}: ${task.objective}`,
        severity: "HIGH",
        options: [
          { key: "A", label: "Replan with smaller scope", consequence: "task is split before retry" },
          { key: "B", label: "Retry once more", consequence: "one additional bounded attempt" },
          { key: "C", label: "Escalate to human", consequence: "work pauses until you decide" },
        ],
        recommendation: "A",
        impactedEntities: [task.stableKey],
      });
      this.emit(run.projectId, "agent.escalated", task.id, { failures: totalFailures, reason });
      const blocked: TaskContract = { ...task, status: "BLOCKED", blockers: [`repeated failure: ${reason}`], updatedAt: now };
      this.ports.docs.put("task", blocked.id, blocked.projectId, blocked);
    } else {
      // Attempt budget remains → release the RUNNING claim so the next bounded attempt can start.
      const retryable: TaskContract = { ...task, status: "READY", updatedAt: now };
      this.ports.docs.put("task", retryable.id, retryable.projectId, retryable);
    }
    return run;
  }

  private emit(projectId: string, type: string, entityId: string | null, payload: Record<string, unknown>): void {
    this.ports.events.append({ projectId: projectId as never, type: type as never, entityType: "event", entityId, actorType: "ENGINE", payload });
  }

  evidenceForTask(projectId: string, taskId: string): Evidence[] {
    return this.ports.docs.list<Evidence>("evidence", projectId).filter((e) => e.taskId === taskId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function adapterIdFromRuntimeConfig(runtimeConfigId: string): string {
  return runtimeConfigId.replace(/^runtime_/, "");
}
