/**
 * The Anthropic API with the user's own key as the provider (docs/DESIGN.md section 5.3). One
 * streamed `POST {baseUrl}/v1/messages`; the tokens are the `text_delta`s of
 * `content_block_delta` events. The system prompt is marked for prompt caching, so a stable
 * instruction block is not paid for in full on every question.
 *
 * This is plain `fetch` rather than the Anthropic SDK: the provider is one streamed request, and
 * akou adds no runtime dependency for it. The key is sent only as the `x-api-key` header and never
 * appears in an error message or a log line.
 *
 * Failures map to the provider kinds: 401 and 403 (`authentication_error`, `permission_error`)
 * are `auth`, 429 (`rate_limit_error`) and 402 (`billing_error`) are `exhausted`, anything else,
 * 529 `overloaded_error` included, is `other`. A `refusal` stop is an error, not an answer.
 */

import { serverMessage } from "./openai-compatible.ts";
import {
  type Availability,
  type CompleteRequest,
  type CompleteResult,
  isUnreachable,
  kindOfStatus,
  type Provider,
  ProviderError,
  readSse,
} from "./provider.ts";

export const ANTHROPIC_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
/** Used when `provider.model` is empty. */
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const ERROR_KIND: Record<string, ProviderError["kind"]> = {
  authentication_error: "auth",
  permission_error: "auth",
  rate_limit_error: "exhausted",
  billing_error: "exhausted",
};

export class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;

  constructor(private readonly o: AnthropicOptions) {}

  private get model(): string {
    return this.o.model || ANTHROPIC_DEFAULT_MODEL;
  }

  private get base(): string {
    return (this.o.baseUrl || ANTHROPIC_URL).replace(/\/+$/, "");
  }

  async available(): Promise<Availability> {
    if (this.o.apiKey === "") {
      return { ok: false, kind: "auth", reason: "provider.apiKey is not set" };
    }
    return { ok: true, detail: `${this.model} on the Anthropic API` };
  }

  async complete(
    req: CompleteRequest,
    onToken: (t: string) => void,
    signal: AbortSignal,
  ): Promise<CompleteResult> {
    const avail = await this.available();
    if (!avail.ok) throw new ProviderError(avail.kind, avail.reason);
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.o.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens,
          stream: true,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: req.prompt }],
        }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new ProviderError("cancelled", "cancelled");
      if (isUnreachable(err)) throw new ProviderError("missing", `nothing answers at ${this.base}`);
      throw new ProviderError("other", `the Anthropic API: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      const msg = await serverMessage(res);
      throw new ProviderError(
        kindOfStatus(res.status),
        `the Anthropic API answered ${res.status}${msg ? `: ${msg}` : ""}`,
      );
    }
    let text = "";
    let model = this.model;
    for await (const ev of readSse(res.body)) {
      let data: {
        type?: string;
        message?: { model?: string };
        delta?: { type?: string; text?: string; stop_reason?: string };
        error?: { type?: string; message?: string };
      };
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (data.type === "message_start" && data.message?.model) model = data.message.model;
      if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
        const t = data.delta.text ?? "";
        if (t !== "") {
          text += t;
          onToken(t);
        }
      }
      if (data.type === "message_delta" && data.delta?.stop_reason === "refusal") {
        throw new ProviderError("other", `${model} declined to answer (refusal)`);
      }
      if (data.type === "error") {
        const kind = ERROR_KIND[data.error?.type ?? ""] ?? "other";
        throw new ProviderError(kind, `the Anthropic API: ${data.error?.message ?? "error"}`);
      }
    }
    if (text.trim() === "") throw new ProviderError("other", `${model} gave no answer`);
    return { text, model };
  }
}
