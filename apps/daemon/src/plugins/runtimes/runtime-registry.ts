import type { AgentRuntimeAdapter } from "@devflow/contracts";
import { MockAgentRuntimeAdapter } from "./mock-runtime.js";
import { CliAgentRuntimeAdapter } from "./cli-runtime-adapter.js";

/** Agent runtime registry (spec §14.6). Vendor adapters plug in; core stays neutral. */
export class AgentRuntimeRegistry {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();

  constructor() {
    this.register(new MockAgentRuntimeAdapter());
  }

  register(adapter: AgentRuntimeAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentRuntimeAdapter {
    const found = this.adapters.get(id) ?? this.adapters.get("mock-runtime");
    if (!found) throw new Error("[runtime-registry/get] no adapter registered");
    return found;
  }

  get mock(): MockAgentRuntimeAdapter {
    const found = this.adapters.get("mock-runtime");
    if (!(found instanceof MockAgentRuntimeAdapter)) throw new Error("[runtime-registry/mock] missing");
    return found;
  }

  listIds(): string[] {
    return [...this.adapters.keys()];
  }

  /** §33: attach executable adapters for CLIs discovered on this machine. */
  registerCliIfAvailable(id: string, bin: string, buildArgs: CliArgsBuilder, exists: boolean): void {
    if (!exists || this.adapters.has(id)) return;
    this.adapters.set(id, new CliAgentRuntimeAdapter({ id, bin, buildArgs }));
  }
}

type CliArgsBuilder = (opts: { promptFile: string; model?: string | null; effort?: string | null }) => string[];
