import type { AgentRuntimeAdapter } from "@devflow/contracts";
import { MockAgentRuntimeAdapter } from "./mock-runtime.js";

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
}
