/** Plugin/provider seams (spec §15). Core domain depends only on these interfaces;
 * concrete adapters live in daemon/plugins.
 */
import type { AgentRunId, TaskId } from "./ids.js";
import type { ActionRisk, PermissionDecision } from "./state-machines.js";
import type { SystemCapability } from "./domain.js";
import type { AgentActionProposal } from "./schemas.js";

export interface ModelRequest {
  purpose: string; // why this call exists — recorded for observability
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  responseSchemaHint: string; // instructs provider to emit JSON matching a zod schema
  maxTokens: number;
}

export interface ModelResponse {
  raw: string;
  tokensIn: number | null;
  tokensOut: number | null;
  degraded: false | "RATE_LIMITED" | "TIMEOUT" | "OUTAGE";
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface RuntimeStartInput {
  runId: AgentRunId;
  taskId: TaskId;
  /** Fully compiled context packet — the runtime never reaches into project state directly. */
  contextPacketMarkdown: string;
  permissionPreset: "READ_ONLY" | "WORKSPACE" | "ELEVATED_ALLOWED";
  workingDirectory: string;
  /** AI Team Composer: model/effort the resolved binding selected for this run. */
  modelHint?: { providerId?: string | null; model?: string | null; effort?: string | null };
}

/** A step-based runtime: each `nextAction` returns one proposed action which the
 * orchestrator validates through the Action Gateway. This keeps every runtime
 * behind the same governed pipeline regardless of vendor. */
export interface AgentRuntimeAdapter {
  readonly id: string;
  capabilities(): Promise<RuntimeCapabilities>;
  start(input: RuntimeStartInput): Promise<RuntimeSessionHandle>;
  nextAction(handle: RuntimeSessionHandle, observation: string): Promise<{ proposal: AgentActionProposal }>;
  stop(handle: RuntimeSessionHandle): Promise<void>;
}

export interface RuntimeCapabilities {
  supportsNativeEvents: boolean;
  supportsResume: boolean;
  streamingOutput: boolean;
}

export interface RuntimeSessionHandle {
  sessionId: string;
}

export interface ToolDefinition {
  id: string;
  operation: string;
  defaultRisk: ActionRisk;
  description: string;
}

export interface ToolContext {
  workspaceRoot: string;
  actorRunId: string | null;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  output: string | null;
}

export interface Tool {
  definition(): ToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface SandboxHandle {
  directory: string;
}

export interface Sandbox {
  prepare(taskDir: string): Promise<SandboxHandle>;
  dispose(handle: SandboxHandle): Promise<void>;
}

export interface GitAdapter {
  isRepository(path: string): Promise<boolean>;
  currentRevision(path: string): Promise<string | null>;
  changedFiles(path: string): Promise<string[]>;
  diffSummary(path: string): Promise<string>;
  listBranches(path: string): Promise<string[]>;
  /** Unified diff of the working tree vs a base (default HEAD) — Diff Viewer. */
  rawDiff(path: string, base?: string | null): Promise<string>;
  /** Commit history touching one file — File Viewer "history" panel. */
  fileLog(path: string, filePath: string, limit?: number): Promise<Array<{ hash: string; subject: string; author: string; date: string }>>;
}

export interface CodebaseSnapshot {
  path: string;
  languages: Array<{ name: string; fileCount: number }>;
  packageManagers: string[];
  frameworks: string[];
  testCommand: string | null;
  buildCommand: string | null;
  topLevelDirs: string[];
  configFiles: string[];
  notes: string[];
}

export interface ProjectRepositoryScanner {
  scan(path: string): Promise<CodebaseSnapshot>;
}

export interface ReadinessProbe {
  readonly capability: string;
  check(): Promise<SystemCapability>;
}

export type GatewayPolicyDecision = {
  decision: PermissionDecision;
  reason: string;
};

export interface PolicyEngine {
  evaluate(action: {
    toolId: string;
    operation: string;
    risk: ActionRisk;
    permissionPreset: string;
    reversible: boolean;
    targetPath?: string | null;
  }): GatewayPolicyDecision;
}
