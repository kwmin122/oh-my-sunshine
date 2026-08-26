import type { AgentRuntimeAdapter, NormalizedRuntimeEvent } from "@devflow/contracts";
import { MockAgentRuntimeAdapter } from "./mock-runtime.js";
import { CliAgentRuntimeAdapter, type CliAdapterKind } from "./cli-runtime-adapter.js";

/** Agent runtime registry (spec §14.6). Vendor adapters plug in; core stays neutral. */
export class AgentRuntimeRegistry {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();
  private eventSink: ((event: NormalizedRuntimeEvent) => void) | null = null;

  constructor() {
    this.register(new MockAgentRuntimeAdapter());
  }

  /** Normalized runtime events (V3 §15) flow here — main() wires this to the EventStore. */
  setEventSink(sink: (event: NormalizedRuntimeEvent) => void): void {
    this.eventSink = sink;
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

  /** §33/V3-S1: attach an executable adapter for a CLI discovered on this machine. */
  registerCliIfAvailable(id: string, bin: string, kind: CliAdapterKind, exists: boolean): void {
    if (!exists || this.adapters.has(id)) return;
    this.adapters.set(
      id,
      new CliAgentRuntimeAdapter({ id, bin, kind, onEvent: (e) => this.eventSink?.(e) }),
    );
  }
}
