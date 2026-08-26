import type { ModelProvider, ModelRequest, ModelResponse } from "@devflow/contracts";
import { DevFlowError } from "../../lib/errors.js";

/** OpenAI-compatible chat-completions adapter. Works with OpenAI and any compatible endpoint. */
export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    readonly id: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: `${request.system}\nRespond with a single JSON object matching this shape:\n${request.responseSchemaHint}` },
            ...request.messages,
          ],
          max_tokens: request.maxTokens,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        return { raw: "", tokensIn: null, tokensOut: null, degraded: "RATE_LIMITED" };
      }
      if (!res.ok) {
        throw new DevFlowError({
          kind: "TRANSIENT_PROVIDER",
          subsystem: `model-provider/${this.id}`,
          action: "generate",
          message: `provider returned HTTP ${res.status}`,
        });
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const raw = body.choices?.[0]?.message?.content ?? "";
      return { raw, tokensIn: body.usage?.prompt_tokens ?? null, tokensOut: body.usage?.completion_tokens ?? null, degraded: false };
    } catch (err) {
      if (controller.signal.aborted) {
        return { raw: "", tokensIn: null, tokensOut: null, degraded: "TIMEOUT" };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Anthropic messages adapter. */
export class AnthropicProvider implements ModelProvider {
  constructor(
    readonly id: string,
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens,
          system: `${request.system}\nRespond with a single JSON object matching this shape:\n${request.responseSchemaHint}`,
          messages: request.messages,
        }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        return { raw: "", tokensIn: null, tokensOut: null, degraded: "RATE_LIMITED" };
      }
      if (!res.ok) {
        throw new DevFlowError({
          kind: "TRANSIENT_PROVIDER",
          subsystem: `model-provider/${this.id}`,
          action: "generate",
          message: `provider returned HTTP ${res.status}`,
        });
      }
      const body = (await res.json()) as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      const raw = body.content?.map((c) => c.text ?? "").join("") ?? "";
      return { raw, tokensIn: body.usage?.input_tokens ?? null, tokensOut: body.usage?.output_tokens ?? null, degraded: false };
    } catch (err) {
      if (controller.signal.aborted) {
        return { raw: "", tokensIn: null, tokensOut: null, degraded: "TIMEOUT" };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
