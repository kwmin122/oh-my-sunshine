import type { Tool, ToolDefinition } from "@devflow/contracts";
import type { DevFlowConfig } from "../../lib/config.js";
import { FileReadTool, FileSearchTool, FileWriteTool, ShellTool } from "./core-tools.js";

/** Tool registry (spec §14.7). Every tool is registered with its default risk so the
 * gateway can classify without trusting callers. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(config: DevFlowConfig) {
    this.register(new FileReadTool(config));
    this.register(new FileSearchTool());
    this.register(new FileWriteTool());
    this.register(new ShellTool(config));
  }

  register(tool: Tool): void {
    this.tools.set(tool.definition().id, tool);
  }

  get(id: string): Tool {
    const found = this.tools.get(id);
    if (!found) throw new Error(`[tool-registry/get] unknown tool '${id}'`);
    return found;
  }

  definition(id: string): ToolDefinition {
    return this.get(id).definition();
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition());
  }
}
