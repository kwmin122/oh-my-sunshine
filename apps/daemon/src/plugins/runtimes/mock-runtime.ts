import type { AgentActionProposal, AgentRuntimeAdapter, RuntimeCapabilities, RuntimeSessionHandle, RuntimeStartInput } from "@devflow/contracts";

/**
 * Deterministic mock runtime (spec §28). Behaves like a disciplined implementer:
 * inspects → writes a focused change file → runs a harmless verification command → FINISH.
 * Also supports failure injection so liveness/escalation flows are testable.
 */
export class MockAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "mock-runtime";

  private readonly plans = new Map<string, number>();
  private failEveryRun = false;

  /** Test hook: make every run finish with failure to exercise escalation paths. */
  setAlwaysFail(fail: boolean): void {
    this.failEveryRun = fail;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { supportsNativeEvents: true, supportsResume: true, streamingOutput: false };
  }

  async start(input: RuntimeStartInput): Promise<RuntimeSessionHandle> {
    this.plans.set(input.runId, 0);
    return { sessionId: `mock-session-${input.runId}` };
  }

  async nextAction(handle: RuntimeSessionHandle, _observation: string): Promise<{ proposal: AgentActionProposal }> {
    const runId = handle.sessionId.replace("mock-session-", "");
    const step = this.plans.get(runId) ?? 0;
    if (this.failEveryRun) {
      this.plans.set(runId, step + 1);
      // A failing run keeps proposing the same broken verification — bounded retries must stop it.
      // `ls` on a missing path is READ_ONLY-classified, so the failure surfaces as a FAILED
      // action instead of parking the run in the approval inbox.
      return { proposal: { kind: "RUN_COMMAND", command: "ls .devflow/forced-failure-target-missing", summary: "attempt failing verification" } };
    }
    switch (step) {
      case 0:
        this.plans.set(runId, 1);
        return { proposal: { kind: "RUN_COMMAND", command: "ls", summary: "inspect existing workspace structure" } };
      case 1:
        this.plans.set(runId, 2);
        return {
          proposal: {
            kind: "WRITE_FILE",
            path: ".devflow/mock-implementation.md",
            content: `# Implementation note\n\nMinimal coherent change produced by the mock runtime for task session ${runId}.\n`,
            summary: "write implementation note",
          },
        };
      default:
        return { proposal: { kind: "FINISH", summary: "implementation complete; verification delegated to evidence pipeline" } };
    }
  }

  async stop(handle: RuntimeSessionHandle): Promise<void> {
    this.plans.delete(handle.sessionId.replace("mock-session-", ""));
  }
}
