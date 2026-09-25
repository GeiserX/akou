/**
 * Test support for the MCP server: an in-process client over a linked pair of transports, against
 * any `ApiClient`, real (a rig's app) or a stand-in that answers from a function.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { ApiClient, ApiResponse, RequestOptions } from "../src/main/cli/client.ts";
import { createMcpServer } from "../src/main/mcp/server.ts";
import { quoteCallText } from "../src/main/query/render.ts";

/** An `ApiClient` whose every request is answered by `body`: 200 (or `status`) with that JSON. */
export function fakeApi(
  body: (method: string, path: string, o: RequestOptions) => unknown,
  text?: (method: string, path: string, o: RequestOptions) => string | null,
  status: (method: string, path: string) => number = () => 200,
): ApiClient {
  return {
    request: async (method: string, path: string, o: RequestOptions = {}): Promise<ApiResponse> => {
      const b = body(method, path, o) ?? {};
      return {
        status: status(method, path),
        body: b,
        text: text?.(method, path, o) ?? JSON.stringify(b),
        contentType: "application/json",
      };
    },
  } as unknown as ApiClient;
}

/** The status of an app whose provider can answer, so `akou_ask` is listed. */
export const PROVIDER_STATUS = { provider: { state: "available", id: "anthropic" } };

export interface ToolAnswer {
  text: string;
  isError: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: structured results are inspected field by field.
  structured: any;
}

/** An MCP client named `name`, connected in process to a fresh akou MCP server over `api`. */
export async function mcpClient(api: ApiClient, name = "claude-code") {
  const server = createMcpServer({ client: api });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(a);
  // The provider is read from the app's status right after initialize (akou_ask may appear).
  await new Promise((r) => setTimeout(r, 50));
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    return { text, isError: r.isError === true, structured: r.structuredContent };
  };
  return { client, server, call, close: () => client.close() };
}

/** Arguments that make each tool do its usual work, for tests that call every tool. */
export const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  akou_start: { workspace: "work", title: "Sync" },
  akou_stop: {},
  akou_pause: {},
  akou_resume: {},
  akou_mute: {},
  akou_unmute: {},
  akou_restart: {},
  akou_status: {},
  akou_context: { question: "what was decided?" },
  akou_read: {},
  akou_search: { query: "budget" },
  akou_ask: { question: "what was decided?" },
  akou_name_speaker: { speaker: "c2", name: "Ben" },
  akou_merge_speakers: { a: "c3", b: "c2" },
  akou_unmerge_speaker: { speaker: "c3" },
  akou_add_note: { text: "ship it friday" },
  akou_get_notes: {},
  akou_remember: { text: "Ben owns the deploy" },
  akou_forget: { id: "r0001" },
  akou_memo_get: {},
  akou_memo_put: { text: "Deploy moved [15:41]", coversSeq: 4 },
  akou_vocab_add: { term: "Hetzner", heard: ["hetzna"] },
  akou_vocab_propose: { entries: [{ term: "Kubernetes" }] },
  akou_vocab_approve: { terms: ["Kubernetes"] },
  akou_vocab_reject: { terms: ["Kubernetes"] },
  akou_vocab_list: { call: "live" },
  akou_vocab_suggest: { call: "live" },
  akou_vocab_check: { term: "Hetzner" },
  akou_enhance_context: {},
  akou_enhanced_put: { markdown: "- Ship it [#l000001]", coversSeq: 4 },
  akou_enhance: {},
  akou_list_calls: {},
  akou_get_call: { call: "last" },
  akou_export: { call: "last" },
};

/**
 * A stand-in for the app that answers every route a tool uses with a body shaped like the real
 * one, with `n` lines, notes, hits, words and calls where the route returns a list.
 */
export function sampleApi(n = 3): ApiClient {
  const say = (i: number) => `we agreed the budget line ${i} moves to Friday after the review`;
  const lines = Array.from({ length: n }, (_, i) => ({
    id: `l${String(i + 1).padStart(6, "0")}`,
    seq: i + 2,
    time: "15:36:20",
    w0: 1_000 + i,
    w1: 2_000 + i,
    part: 1,
    ch: "call",
    spk: "c2",
    speaker: "Ben",
    text: say(i),
    layer: "live",
  }));
  const body = (method: string, path: string, o: RequestOptions): unknown => {
    if (path === "/status") return { app: { port: 1 }, ...PROVIDER_STATUS };
    if (path === "/calls" && method === "POST") {
      return { call: "c1", folder: "/rec/c1", part: 1, firstAudioMs: 12, url: null };
    }
    if (path === "/calls" && method === "GET") {
      return {
        calls: Array.from({ length: n }, (_, i) => ({
          id: `c${i}`,
          createdAt: 1_700_000_000_000 + i,
          endedAt: 1_700_000_600_000 + i,
          workspace: "work",
          title: `Weekly sync number ${i}`,
          state: "ended",
        })),
      };
    }
    if (/^\/calls\/live\/(stop|pause|resume|mute|unmute)$/.test(path)) {
      return { call: "c1", state: "recording" };
    }
    if (path.endsWith("/restart")) return { call: "c1", part: 2 };
    if (path.endsWith("/context")) {
      return {
        call: "c1",
        // The pack arrives quoted already (PG-Z1).
        pack: `Call c1, live.\n${quoteCallText(lines.map((l) => `#${l.id} ${l.time} ${l.speaker}: ${l.text}`).join("\n"))}`,
        state: "LIVE",
        cursor: n + 1,
        memoStale: true,
        provisional: null,
        tokens: 100,
      };
    }
    if (path.endsWith("/transcript")) {
      const offset = Number(o.query?.offset ?? 0);
      return {
        call: "c1",
        state: "recording",
        live: true,
        zone: "Times are local, UTC.",
        cursor: n + 1,
        memoStale: false,
        provisional: [],
        lines: lines.slice(offset),
        total: n,
        omitted: 0,
      };
    }
    if (path.endsWith("/search")) {
      return {
        call: "c1",
        // The route returns at most `k` hits.
        hits: lines.slice(0, Number(o.query?.k ?? 6)).map((l) => ({
          citation: `[15:36 Ben]`,
          ids: [l.id],
          lines: [`#${l.id} ${l.text}`],
        })),
      };
    }
    if (path.endsWith("/ask")) return { answered: true, text: say(0) };
    if (path === "/calls/live/speakers") return { spk: "c2", name: "Ben" };
    if (path.endsWith("/speakers/merge")) return { from: "c3", into: "c2" };
    if (path.endsWith("/speakers/unmerge")) return { ok: true };
    if (path === "/calls/live/notes" && method === "POST") return { note: { id: "n0001" } };
    if (path === "/calls/live/notes") {
      return {
        call: "c1",
        notes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, text: say(i), by: "user" })),
      };
    }
    if (path === "/calls/live/remember") return { remember: { id: "r0001" } };
    if (path.startsWith("/calls/live/remember/")) return { ok: true };
    if (path === "/calls/live/memo" && method === "PUT") return { memo: { coversSeq: 4 } };
    if (path === "/calls/live/memo") {
      return { call: "c1", memo: { body: say(0), rev: 1, coversSeq: 4 }, cursor: n + 1 };
    }
    if (path === "/calls/live/vocab") return { call: "c1", vocab: { id: "v1" } };
    if (/^\/vocab\/(approve|reject)$/.test(path))
      return { ok: true, path: "/v.json", approved: [] };
    if (path === "/vocab/suggest") {
      return {
        call: "c1",
        suggestions: lines.map((l) => ({ term: `Term${l.id}`, lines: [l.text] })),
      };
    }
    if (path === "/vocab/check") return { term: "Hetzner", ok: true };
    if (path === "/vocab" && method === "POST") return { ok: true, path: "/v.json", entry: {} };
    if (path === "/vocab") return { workspace: null, files: [], entries: [] };
    if (path.endsWith("/vocab")) {
      return {
        call: "c1",
        review: [],
        callVocab: [],
        proposals: lines.map((l) => ({ term: `Term${l.id}`, lines: [l.text] })),
      };
    }
    if (path.endsWith("/enhance/context")) {
      return { call: "c1", template: "general", pack: lines.map((l) => l.text).join("\n") };
    }
    if (path === "/calls/last") return { id: "c1" };
    if (path.endsWith("/enhanced")) return { ok: true, rev: 1 };
    if (path.endsWith("/enhance")) {
      return {
        markdown: lines.map((l) => `- ${l.text} [#${l.id}]`).join("\n"),
        rev: 1,
        template: "general",
        model: "fake",
        dropped: [],
      };
    }
    if (path.endsWith("/export")) return { call: "c1", path: "/export/c1.md" };
    return {};
  };
  // A new vocabulary entry answers 201, as the real route does.
  return fakeApi(body, undefined, (m, p) => (m === "POST" && p === "/vocab" ? 201 : 200));
}
