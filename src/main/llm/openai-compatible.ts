/**
 * An OpenAI-compatible chat server as the provider (docs/DESIGN.md section 5.3): Ollama, LM Studio,
 * a llama.cpp server, vLLM, or OpenAI itself. One streamed `POST {baseUrl}/chat/completions`; the
 * tokens are `choices[0].delta.content` of each Server-Sent Event until `[DONE]`.
 *
 * The key is optional (a local server needs none) and is sent only as the `Authorization` header.
 * It never appears in an error message or a log line.
 */

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

export interface OpenAiCompatibleOptions {
  /** `http://127.0.0.1:11434/v1` for Ollama, `https://api.openai.com/v1` for OpenAI. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

/** The error message a server put in its JSON body, without echoing anything else. */
export async function serverMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const m =
      typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? "");
    return m.slice(0, 300);
  } catch {
    return text.slice(0, 200);
  }
}

export class OpenAiCompatibleProvider implements Provider {
  readonly id = "openai-compatible" as const;

  constructor(private readonly o: OpenAiCompatibleOptions) {}

  async available(): Promise<Availability> {
    if (this.o.baseUrl === "") {
      return {
        ok: false,
        kind: "missing",
        reason: "provider.baseUrl is not set (for Ollama: http://127.0.0.1:11434/v1)",
      };
    }
    if (this.o.model === "") {
      return { ok: false, kind: "missing", reason: "provider.model is not set" };
    }
    return { ok: true, detail: `${this.o.model} at ${this.o.baseUrl}` };
  }

  async complete(
    req: CompleteRequest,
    onToken: (t: string) => void,
    signal: AbortSignal,
  ): Promise<CompleteResult> {
    const avail = await this.available();
    if (!avail.ok) throw new ProviderError(avail.kind, avail.reason);
    const url = `${this.o.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.o.model,
          stream: true,
          max_tokens: req.maxTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new ProviderError("cancelled", "cancelled");
      if (isUnreachable(err)) {
        throw new ProviderError("missing", `nothing answers at ${this.o.baseUrl}`);
      }
      throw new ProviderError("other", `${this.o.baseUrl}: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      const msg = await serverMessage(res);
      throw new ProviderError(
        kindOfStatus(res.status),
        `${this.o.baseUrl} answered ${res.status}${msg ? `: ${msg}` : ""}`,
      );
    }
    let text = "";
    let model = this.o.model;
    for await (const ev of readSse(res.body)) {
      if (ev.data === "[DONE]") break;
      let chunk: {
        model?: string;
        error?: { message?: string };
        choices?: { delta?: { content?: string | null } }[];
      };
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new ProviderError("other", chunk.error.message ?? "the server reported an error");
      }
      if (typeof chunk.model === "string" && chunk.model !== "") model = chunk.model;
      const t = chunk.choices?.[0]?.delta?.content;
      if (typeof t === "string" && t !== "") {
        text += t;
        onToken(t);
      }
    }
    if (text.trim() === "") throw new ProviderError("other", `${model} gave no answer`);
    return { text, model };
  }
}
