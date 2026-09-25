/**
 * The MCP server (docs/DESIGN.md sections 5.5 and 6.4), driven by the official MCP client: in
 * process over a linked pair of transports against a headless app with the fake helper, and once
 * over stdio as `akou mcp`, a child process, the way a harness runs it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { ApiClient, type ApiResponse } from "../src/main/cli/client.ts";
import { askListed, createMcpServer, harnessOf } from "../src/main/mcp/server.ts";
import { CALL_TEXT_CLOSE, CALL_TEXT_OPEN } from "../src/main/query/render.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { CLI } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;

/** The tools DESIGN 6.4 lists, `akou_ask` apart (it is listed only with a provider). */
const DESIGN_TOOLS = [
  "akou_start",
  "akou_stop",
  "akou_pause",
  "akou_resume",
  "akou_mute",
  "akou_unmute",
  "akou_restart",
  "akou_status",
  "akou_context",
  "akou_read",
  "akou_search",
  "akou_name_speaker",
  "akou_merge_speakers",
  "akou_unmerge_speaker",
  "akou_add_note",
  "akou_get_notes",
  "akou_remember",
  "akou_forget",
  "akou_memo_get",
  "akou_memo_put",
  "akou_vocab_add",
  "akou_vocab_propose",
  "akou_vocab_approve",
  "akou_vocab_reject",
  "akou_vocab_list",
  "akou_vocab_suggest",
  "akou_vocab_check",
  "akou_enhance_context",
  "akou_enhanced_put",
  "akou_enhance",
  "akou_list_calls",
  "akou_get_call",
  "akou_export",
];

let rig: AppRig;
let wavDir: { dir: string; cleanup: () => void };

function writeSpeech(dir: string): string {
  const mic = concat(silence(0.3), speak(["hello", "world"]), silence(2.2));
  const call = concat(silence(1.1), speak(["deploy", "to", "hetzner"], { voice: 2 }), silence(0.6));
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
  const path = join(dir, "speech.wav");
  writeFileSync(path, stereoWav(pad(mic), pad(call)));
  return path;
}

beforeAll(async () => {
  wavDir = tempDir();
  rig = await appRig({ helperArgs: ["--wav", writeSpeech(wavDir.dir)] });
});

afterAll(async () => {
  await rig?.close();
  wavDir?.cleanup();
});

/** An MCP client named `name`, connected in process to a fresh akou MCP server. */
async function connect(
  name = "claude-code",
  api: ApiClient = new ApiClient({
    env: { ...process.env, ...rig.env },
    client: "mcp",
    launch: null,
  }),
) {
  const server = createMcpServer({ client: api });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(a);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    return { text, isError: r.isError === true };
  };
  return { client, server, call, close: () => client.close() };
}

/** The JSON inside an answer's call-text block (PG-Z1). */
function quotedJson(text: string) {
  const lines = text.split("\n");
  return JSON.parse(
    lines.slice(lines.indexOf(CALL_TEXT_OPEN) + 1, lines.indexOf(CALL_TEXT_CLOSE)).join("\n"),
  );
}

async function stopAll(): Promise<void> {
  const r = await rig.api("GET", "/calls/live");
  if (r.status === 200) await rig.api("POST", "/calls/live/stop");
}

async function waitForCallLine(id: string): Promise<void> {
  await until(
    async () =>
      (await rig.api("GET", `/calls/${id}/transcript`)).body.lines.some(
        (l: { ch: string }) => l.ch === "call",
      ),
    10_000,
    "a call-channel line",
  );
}

describe("the tool list", () => {
  test("exactly the design's tools; akou_ask is not listed without a provider", async () => {
    const c = await connect();
    // The ask visibility is settled once the server has read the app's status after initialize.
    await new Promise((r) => setTimeout(r, 50));
    const tools = (await c.client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...DESIGN_TOOLS].sort());
    const ctx = tools.find((t) => t.name === "akou_context");
    expect(ctx?.inputSchema.required).toEqual(["question"]);
    expect(ctx?.description).toContain("[HH:MM Name]");
    expect(ctx?.description).toContain("DRAFT");
    await c.close();
  });

  test("with no app running (the harness starts `akou mcp` first), akou_ask is not listed", async () => {
    const home = tempDir();
    const offline = new ApiClient({
      env: { ...process.env, AKOU_HOME: home.dir },
      client: "mcp",
      launch: null,
    });
    const c = await connect("codex-mcp-client", offline);
    await new Promise((r) => setTimeout(r, 50));
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("akou_context");
    expect(names).not.toContain("akou_ask");
    await c.close();
    home.cleanup();
  });

  test("askListed: only with an available provider, never the client's own harness", () => {
    const harness = (h: string) => ({ state: "available", id: "harness", harness: h });
    expect(askListed({ state: "unavailable" }, "claude-code")).toBe(false);
    expect(askListed(undefined, "claude-code")).toBe(false);
    expect(askListed(harness("claude-code/2.1.0"), "claude-code")).toBe(false);
    expect(askListed(harness("codex/0.9"), "codex-mcp-client")).toBe(false);
    expect(askListed(harness("codex/0.9"), "claude-code")).toBe(true);
    expect(askListed(harness("claude-code"), "some-editor")).toBe(true);
    expect(askListed({ state: "available", id: "anthropic" }, "claude-code")).toBe(true);
    expect(harnessOf("Claude Code")).toBe("claude-code");
    expect(harnessOf("cursor")).toBe(null);
  });

  test("with the harness provider, a Claude Code client does not see akou_ask and a Codex client does", async () => {
    // A stand-in for the app's status once a provider exists (none is built yet).
    const fake = {
      request: async (_m: string, path: string): Promise<ApiResponse> => ({
        status: 200,
        body:
          path === "/status"
            ? { provider: { state: "available", id: "harness", harness: "claude-code/2.1" } }
            : {},
        text: "",
        contentType: "application/json",
      }),
    } as unknown as ApiClient;
    const names = async (client: string) => {
      const c = await connect(client, fake);
      await new Promise((r) => setTimeout(r, 50));
      const list = (await c.client.listTools()).tools.map((t) => t.name);
      await c.close();
      return list;
    };
    expect(await names("claude-code")).not.toContain("akou_ask");
    expect(await names("codex-mcp-client")).toContain("akou_ask");
  });
});

describe("following a call", () => {
  test(
    "start, context with a cursor, read only what is new, search; names land as agent:<client>",
    async () => {
      await stopAll();
      const c = await connect("claude-code");
      const start = await c.call("akou_start", {
        workspace: "work",
        title: "MCP sync",
        vocab: ["Ben"],
      });
      expect(start.isError).toBe(false);
      const id = /Recording call (\S+)/.exec(start.text)?.[1] as string;
      expect(id).toBeTruthy();
      const again = await c.call("akou_start", { title: "Other" });
      expect(again.isError).toBe(true);
      expect(again.text).toContain("already_recording");

      await waitForCallLine(id);
      const ctx = await c.call("akou_context", { question: "what did they say about deploy?" });
      expect(ctx.isError).toBe(false);
      expect(ctx.text.startsWith("LIVE, recording now")).toBe(true);
      const cursor = Number(/cursor: (\d+)/.exec(ctx.text)?.[1]);
      expect(cursor).toBeGreaterThan(0);

      const all = await c.call("akou_read", {});
      expect(all.text).toMatch(/^\[\d\d:\d\d:\d\d Ana\] hello world$/m);
      const fresh = await c.call("akou_read", { since: cursor });
      expect(fresh.text).not.toContain("hello world");
      expect(fresh.text).toMatch(/cursor: \d+$/);

      // The line still being spoken comes with the read, marked as a draft.
      const view = rig.app.manager.controller(id)?.view;
      view?.provisional.update({
        ch: "mic",
        part: 1,
        pseq: 1_000_000,
        text: "and one more thing",
        w0: rig.app.now(),
        at: rig.app.now(),
      });
      const drafted = await c.call("akou_read", { since: cursor });
      expect(drafted.text).toMatch(
        /^DRAFT, still being spoken, may change: \[\d\d:\d\d:\d\d Ana\] and one more thing$/m,
      );

      const s = await c.call("akou_search", { query: "hello" });
      expect(s.text).toContain("hello world");

      const named = await c.call("akou_name_speaker", { speaker: "c2", name: "Ben" });
      expect(named.text).toBe("c2 is Ben");
      const events = (await rig.api("GET", `/calls/${id}/events`)).body.events;
      const e = events.find((x: { type: string }) => x.type === "speaker.name");
      expect(e).toMatchObject({ spk: "c2", name: "Ben", by: "agent:claude-code" });
      await c.close();
    },
    LONG,
  );

  test(
    "[T3.10] Names lost after the agent's context is compacted: a fresh client's first context has them",
    async () => {
      const c = await connect("claude-code");
      await c.call("akou_remember", { text: "Ben runs the deploy on Fridays" });
      await c.close();
      // A new session: nothing carried over but the log.
      const fresh = await connect("claude-code");
      const ctx = await fresh.call("akou_context", { question: "who is on the call?" });
      expect(ctx.text).toContain("c2 = Ben");
      expect(ctx.text).toContain("Ben runs the deploy on Fridays");
      await fresh.close();
    },
    LONG,
  );

  test(
    "a word the user spells goes in for the call at once; an inferred one is only proposed",
    async () => {
      const c = await connect("claude-code");
      const add = await c.call("akou_vocab_add", { term: "Hetzner", heard: ["hetzna"] });
      expect(add.isError).toBe(false);
      const read = await c.call("akou_read", {});
      expect(read.text).toContain('Hetzner (heard: "hetzna")');
      const prop = await c.call("akou_vocab_propose", {
        entries: [{ term: "Kubernetes", heard: ["kubernetis"] }],
        call: "live",
      });
      expect(prop.text).toContain("inactive until approved");
      const list = JSON.parse((await c.call("akou_vocab_list", { workspace: "work" })).text);
      expect(list.entries.find((e: { term: string }) => e.term === "Kubernetes").confirmed).toBe(
        false,
      );
      const approved = JSON.parse(
        (await c.call("akou_vocab_approve", { terms: ["Kubernetes"], call: "live" })).text,
      );
      expect(approved.approved).toContain("Kubernetes");
      const bad = await c.call("akou_vocab_add", { term: "x".repeat(300) });
      expect(bad.isError).toBe(true);
      expect(bad.text).toStartWith("bad_term");
      await c.close();
    },
    LONG,
  );

  test(
    "notes, memory and the memo round-trip",
    async () => {
      const c = await connect("claude-code");
      expect((await c.call("akou_add_note", { text: "ship it friday" })).isError).toBe(false);
      const notes = quotedJson((await c.call("akou_get_notes")).text);
      expect(notes.notes.at(-1)).toMatchObject({ text: "ship it friday", by: "agent:claude-code" });
      const rem = await c.call("akou_remember", { text: "temporary fact" });
      const rid = /\((r\d+)\)/.exec(rem.text)?.[1] as string;
      expect((await c.call("akou_forget", { id: rid })).isError).toBe(false);
      const memoBefore = quotedJson((await c.call("akou_memo_get")).text);
      const put = await c.call("akou_memo_put", {
        text: "Deploy moved to Friday [15:41]",
        coversSeq: memoBefore.cursor,
      });
      expect(put.isError).toBe(false);
      const memo = quotedJson((await c.call("akou_memo_get")).text);
      expect(memo.memo.body).toContain("Deploy moved to Friday");
      await c.close();
    },
    LONG,
  );

  test(
    "[T3.14] after the stop, a live question says nothing is recording and when the last call ended",
    async () => {
      const c = await connect("claude-code");
      expect((await c.call("akou_stop")).isError).toBe(false);
      const ctx = await c.call("akou_context", { question: "what is he saying?" });
      expect(ctx.isError).toBe(true);
      expect(ctx.text).toMatch(
        /^no_live_call: nothing is recording; the last call, "MCP sync", ended at \d\d:\d\d/,
      );
      const last = await c.call("akou_context", { question: "what was decided?", call: "last" });
      expect(last.text).toMatch(/^ENDED at \d\d:\d\d/);
      const read = await c.call("akou_read", { call: "last" });
      expect(read.text).toMatch(/^ENDED/);
      const list = await c.call("akou_list_calls", { limit: 1 });
      expect(list.text).toContain('"MCP sync"');
      const got = await c.call("akou_get_call", { call: "last" });
      expect(got.text).toContain("hello world");
      expect((await c.call("akou_export", { call: "last" })).isError).toBe(true);
      await c.close();
    },
    LONG,
  );
});

describe("over stdio", () => {
  test(
    "`akou mcp` as a child process: initialize, list the tools, call akou_status",
    async () => {
      const env = Object.fromEntries(
        Object.entries({ ...process.env, ...rig.env }).filter(
          (e): e is [string, string] => e[1] !== undefined,
        ),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI, "mcp"],
        env,
        stderr: "pipe",
      });
      const client = new Client({ name: "codex-mcp-client", version: "0.1" });
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({ name: "akou" });
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("akou_context");
      const r = await client.callTool({ name: "akou_status", arguments: {} });
      const status = JSON.parse((r.content as { text: string }[])[0]?.text as string);
      expect(status.app.port).toBe(rig.port);
      await client.close();
    },
    LONG,
  );
});
