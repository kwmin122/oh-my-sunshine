import type { ModelProvider, ModelRequest, ModelResponse } from "@devflow/contracts";
import type { DevFlowConfig } from "../../lib/config.js";
import { MockModelProvider } from "./mock-provider.js";
import { AnthropicProvider, OpenAICompatibleProvider } from "./api-providers.js";

/** Registry keeps core domain decoupled from concrete SDKs (spec §2.7, §15). */
export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private defaultId: string;

  constructor(config: DevFlowConfig) {
    const mock = new MockModelProvider();
    this.providers.set(mock.id, mock);
    let chosen: string = mock.id;
    if (config.defaultProvider === "OPENAI_COMPATIBLE" && config.openaiApiKey && config.openaiBaseUrl) {
      const p = new OpenAICompatibleProvider(
        "openai-compatible",
        process.env.DEVFLOW_OPENAI_MODEL ?? "gpt-4o-mini",
        config.openaiBaseUrl,
        config.openaiApiKey,
      );
      this.providers.set(p.id, p);
      chosen = p.id;
    }
    if (config.defaultProvider === "ANTHROPIC" && config.anthropicApiKey) {
      const p = new AnthropicProvider("anthropic", "claude-sonnet-4-5", config.anthropicApiKey);
      this.providers.set(p.id, p);
      chosen = p.id;
    }
    this.defaultId = chosen;
  }

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id?: string): ModelProvider {
    const target = id ?? this.defaultId;
    const found = this.providers.get(target);
    if (!found) throw new Error(`[model-provider-registry/get] unknown provider '${target}'`);
    return found;
  }

  getDefault(): ModelProvider {
    return this.get();
  }

  listIds(): string[] {
    return [...this.providers.keys()];
  }
}
