/**
 * The two HTTP providers (docs/DESIGN.md section 5.3) against a local stand-in server: an
 * OpenAI-compatible chat server and the Anthropic Messages API. Streaming, failure kinds, and the
 * key never showing up in what akou says.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/main/llm/anthropic.ts";
import { NoneProvider } from "../src/main/llm/none.ts";
import { OpenAiCompatibleProvider } from "../src/main/llm/openai-compatible.ts";
import { type ProviderError, runProvider } from "../src/main/llm/provider.ts";

process.env.NO_PROXY = "127.0.0.1,localhost";

const KEY = "sk-test-0123456789abcdef";

interface Seen {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
const seen: Seen[] = [];
/** What the next request gets: `ok`, a status, or an Anthropic error event. */
let mode: "ok" | "refusal" | "stream-error" | number = "ok";

function sse(events: { event?: string; data: unknown }[]): Response {
  const body = events
    .map(
      (e) =>
        `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`,
    )
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        headers: Object.fromEntries(req.headers),
        body: (await req.json()) as Record<string, unknown>,
      });
      if (typeof mode === "number") {
        return Response.json({ error: { message: "nope", type: "x" } }, { status: mode });
      }
      if (url.pathname === "/v1/chat/completions") {
        return sse([
          { data: { model: "llama3", choices: [{ delta: { role: "assistant" } }] } },
          { data: { model: "llama3", choices: [{ delta: { content: "The build " } }] } },
          { data: { model: "llama3", choices: [{ delta: { content: "moves." } }] } },
          { data: "[DONE]" },
        ]);
      }
      if (url.pathname === "/v1/messages") {
        const start = {
          event: "message_start",
          data: { type: "message_start", message: { model: "claude-opus-5-5" } },
        };
        if (mode === "stream-error") {
          return sse([
            start,
            {
              event: "error",
              data: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
            },
          ]);
        }
        if (mode === "refusal") {
          return sse([
            start,
            {
              event: "message_delta",
              data: { type: "message_delta", delta: { stop_reason: "refusal" } },
            },
          ]);
        }
        return sse([
          start,
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "" },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: "Ben said " },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: "yes [15:41 Ben]." },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]);
      }
      return new Response("no", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const REQ = { system: "SYS", prompt: "PACK", maxTokens: 50 };

describe("openai-compatible", () => {
  test("streams choices[0].delta.content until [DONE]; system and user messages", async () => {
    mode = "ok";
    const p = new OpenAiCompatibleProvider({ baseUrl: `${base}/v1/`, model: "llama3" });
    const tokens: string[] = [];
    const r = await runProvider(p, REQ, (t) => tokens.push(t));
    expect(r).toEqual({ text: "The build moves.", model: "llama3" });
    expect(tokens).toEqual(["The build ", "moves."]);
    const s = seen.at(-1) as Seen;
    expect(s.body).toMatchObject({
      model: "llama3",
      stream: true,
      max_tokens: 50,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "PACK" },
      ],
    });
    // No key configured: no Authorization header.
    expect(s.headers.authorization).toBeUndefined();
  });

  test("401 is auth, 429 is exhausted, and the key never shows up in the message", async () => {
    const p = new OpenAiCompatibleProvider({ baseUrl: `${base}/v1`, model: "m", apiKey: KEY });
    for (const [status, kind] of [
      [401, "auth"],
      [429, "exhausted"],
      [500, "other"],
    ] as const) {
      mode = status;
      const err = (await runProvider(p, REQ, () => {}).catch((e) => e)) as ProviderError;
      expect(err.kind).toBe(kind);
      expect(err.message).not.toContain(KEY);
    }
    expect((seen.at(-1) as Seen).headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test("nothing listening is missing; an unset model or address is missing before any request", async () => {
    const dead = new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:9/v1", model: "m" });
    const err = (await runProvider(dead, REQ, () => {}).catch((e) => e)) as ProviderError;
    expect(err.kind).toBe("missing");
    const unset = await new OpenAiCompatibleProvider({ baseUrl: "", model: "m" }).available();
    expect(unset).toMatchObject({ ok: false, kind: "missing" });
    const noModel = await new OpenAiCompatibleProvider({ baseUrl: base, model: "" }).available();
    expect(noModel).toMatchObject({ ok: false, kind: "missing" });
  });
});

describe("anthropic", () => {
  test("streams text_delta only, caches the system prompt, sends the key as x-api-key", async () => {
    mode = "ok";
    const p = new AnthropicProvider({ apiKey: KEY, baseUrl: base });
    const tokens: string[] = [];
    const r = await runProvider(p, REQ, (t) => tokens.push(t));
    expect(r).toEqual({ text: "Ben said yes [15:41 Ben].", model: "claude-opus-5-5" });
    expect(tokens).toEqual(["Ben said ", "yes [15:41 Ben]."]);
    const s = seen.at(-1) as Seen;
    expect(s.path).toBe("/v1/messages");
    expect(s.headers["x-api-key"]).toBe(KEY);
    expect(s.headers["anthropic-version"]).toBe("2023-06-01");
    expect(s.body).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      max_tokens: 50,
      system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "PACK" }],
    });
  });

  test("statuses, error events and a refusal map to the failure kinds", async () => {
    const p = new AnthropicProvider({ apiKey: KEY, baseUrl: base, model: "claude-sonnet-5" });
    const kinds: string[] = [];
    for (const m of [401, 403, 429, 529, "stream-error", "refusal"] as const) {
      mode = m;
      const err = (await runProvider(p, REQ, () => {}).catch((e) => e)) as ProviderError;
      expect(err.message).not.toContain(KEY);
      kinds.push(err.kind);
    }
    expect(kinds).toEqual(["auth", "auth", "exhausted", "other", "exhausted", "other"]);
  });

  test("no key: auth, before any request", async () => {
    const before = seen.length;
    const err = (await runProvider(new AnthropicProvider({ apiKey: "" }), REQ, () => {}).catch(
      (e) => e,
    )) as ProviderError;
    expect(err.kind).toBe("auth");
    expect(seen.length).toBe(before);
  });
});

test("none answers nothing and says so", async () => {
  const p = new NoneProvider();
  expect(await p.available()).toMatchObject({ ok: false, kind: "missing" });
  const err = (await runProvider(p, REQ, () => {}).catch((e) => e)) as ProviderError;
  expect(err.kind).toBe("missing");
});
