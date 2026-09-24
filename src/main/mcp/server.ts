/**
 * `akou mcp` (docs/DESIGN.md sections 5.5 and 6.4): a stdio MCP server and a thin client of the
 * local API. It holds no call state; every tool is one or two API requests, so an agent that loses
 * its memory loses nothing, and after a compaction one `akou_context` brings the roster, the memo,
 * earlier questions and the agent's own notes back from the log.
 *
 * Built on the official SDK (`@modelcontextprotocol/server`), which runs under Bun as is.
 *
 * `akou_ask` is listed only when akou has a provider that can answer, and hidden when that provider
 * is the harness the MCP client itself is (Claude Code asking akou to spawn Claude Code): the agent
 * answers from `akou_context` itself instead of spending a second run on the same subscription.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { APP_VERSION } from "../app-info.ts";
import type { ApiClient, ApiResponse, RequestOptions } from "../cli/client.ts";
import { type Body, describeError, wall } from "../cli/context.ts";

const CALL = z
  .string()
  .default("live")
  .describe(
    'Which call: "live" (the one recording now), "last", or a call id. Use the live call unless the user names another one.',
  );

const RULES =
  "Cite wall-clock times as [HH:MM Name]; never present an offset as a time of day; never quote a line marked DRAFT as fact; if the call has ENDED, say so and when.";

/** The harness a client or a provider is, or null. */
export function harnessOf(name: string | undefined | null): "claude-code" | "codex" | null {
  const n = (name ?? "").toLowerCase();
  if (n.includes("claude")) return "claude-code";
  if (n.includes("codex")) return "codex";
  return null;
}

/**
 * Is `akou_ask` offered? Only when a provider is available, and never when that provider is the
 * harness the client already is. `provider` is `status().provider`: `{state, id, harness}`.
 */
export function askListed(provider: Body, clientName: string | undefined): boolean {
  if (provider?.state !== "available") return false;
  if (provider.id === "harness") {
    const mine = harnessOf(clientName);
    if (mine !== null && mine === harnessOf(provider.harness)) return false;
  }
  return true;
}

/** `X-Akou-Client` from the MCP client's name: `claude-code` stays, odd names become `mcp`. */
export function clientTag(name: string | undefined): string {
  const n = (name ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(n) ? n : "mcp";
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function asResult(r: ApiResponse, ok: (b: Body) => string): ToolResult {
  if (r.status >= 200 && r.status < 300) return text(ok(r.body));
  const code = typeof r.body?.error === "string" ? r.body.error : `http_${r.status}`;
  return text(`${code}: ${describeError(r)}`, true);
}

const compact = (b: Body) => JSON.stringify(b);

function lineOf(l: Body): string {
  return `[${l.time} ${l.speaker}] ${l.annotated ?? l.text}`;
}

export interface McpOptions {
  client: ApiClient;
  version?: string;
}

export function createMcpServer(o: McpOptions): McpServer {
  const server = new McpServer(
    { name: "akou", version: o.version ?? APP_VERSION },
    {
      instructions:
        "akou records the user's calls locally and answers questions about them. Start with akou_start; answer questions with akou_context; follow new lines with akou_read and its cursor. " +
        RULES,
    },
  );
  const tag = () => clientTag(server.server.getClientVersion()?.name);
  const call = async (method: string, path: string, ro: RequestOptions = {}) => {
    try {
      return await o.client.request(method, path, ro);
    } catch (err) {
      return {
        status: 503,
        body: { error: "unavailable", message: (err as Error).message },
        text: (err as Error).message,
        contentType: "",
      } satisfies ApiResponse;
    }
  };
  // Every request names the client, so writes carry `by: agent:<client>`.
  const req = (method: string, path: string, ro: RequestOptions = {}) =>
    call(method, path, { ...ro, client: tag() });
  const id = (c: string) => encodeURIComponent(c);

  // --- starting and controlling -----------------------------------------------------------------

  server.registerTool(
    "akou_start",
    {
      description:
        "Start recording a call now. Make this the first call when the user wants a call recorded: no status check first. Returns once audio is being written. `vocab` takes call-scoped words known before the call (attendee names, title terms). If a call is already recording, says which.",
      inputSchema: z.object({
        workspace: z.string().optional(),
        title: z.string().optional(),
        template: z.string().optional(),
        call: z
          .string()
          .optional()
          .describe('What to capture as the call side: "system", "app:ID" or "none"'),
        vocab: z.array(z.string()).optional(),
      }),
    },
    async (a) => {
      const r = await req("POST", "/calls", { body: a });
      void refreshAsk();
      return asResult(
        r,
        (b) =>
          `Recording call ${b.call} (audio after ${b.firstAudioMs} ms). folder: ${b.folder} url: ${b.url}`,
      );
    },
  );

  for (const name of ["stop", "pause", "resume", "mute", "unmute"] as const) {
    server.registerTool(
      `akou_${name}`,
      {
        description: `${name[0]?.toUpperCase()}${name.slice(1)} the live call${name.endsWith("mute") ? "'s microphone" : ""}.`,
        inputSchema: z.object({}),
      },
      async () => {
        const r = await req("POST", `/calls/live/${name}`);
        return asResult(r, (b) => `${b.call}: ${b.state}`);
      },
    );
  }

  server.registerTool(
    "akou_restart",
    {
      description:
        "Start a new part in the latest call (after a stop, or to rebuild capture). `force` is needed when its last audio is over an hour old.",
      inputSchema: z.object({ force: z.boolean().optional() }),
    },
    async (a) => {
      const r = await req("POST", "/calls/last/restart", { body: { force: a.force } });
      return asResult(r, (b) => `${b.call}: recording part ${b.part}`);
    },
  );

  server.registerTool(
    "akou_status",
    {
      description:
        "Whether a call is recording, its health and recognizer lag, the models and provider in use, and sharing. Read models and provider from here, never from memory. Not needed before akou_start.",
      inputSchema: z.object({}),
    },
    async () => {
      const r = await req("GET", "/status");
      if (r.status === 200) applyProvider(r.body.provider);
      return asResult(r, compact);
    },
  );

  // --- questions and following ------------------------------------------------------------------

  server.registerTool(
    "akou_context",
    {
      description: `The main tool for answering any question about a call: pass the user's question verbatim and answer from the pack it returns (a few thousand tokens, never the whole transcript). Also returns a cursor for akou_read, the call state and memoStale. ${RULES} If the answer is not in the pack, say so and name the time range to fetch.`,
      inputSchema: z.object({
        question: z.string().min(1),
        call: CALL,
        budget: z.number().int().min(500).max(32000).default(6000),
      }),
    },
    async (a) => {
      const r = await req("POST", `/calls/${id(a.call)}/context`, {
        body: { question: a.question, budget: a.budget },
      });
      return asResult(
        r,
        (b) =>
          `${b.pack}\n---\ncall: ${b.call} · state: ${b.state} · cursor: ${b.cursor} · memoStale: ${b.memoStale}`,
      );
    },
  );

  server.registerTool(
    "akou_read",
    {
      description: `New committed lines since a cursor (from akou_context or an earlier akou_read), plus the line still being spoken and the next cursor. Use it to follow a call instead of re-reading. ${RULES}`,
      inputSchema: z.object({
        call: CALL,
        since: z.number().int().min(0).optional(),
        lastSeconds: z.number().int().min(1).max(86400).optional(),
      }),
    },
    async (a) => {
      const r = await req("GET", `/calls/${id(a.call)}/transcript`, {
        query: {
          format: "json",
          since: a.since,
          from: a.lastSeconds !== undefined ? Date.now() - a.lastSeconds * 1000 : undefined,
        },
      });
      return asResult(r, (b) => {
        const out: string[] = [
          b.live ? "LIVE, recording now" : `ENDED (state: ${b.state}); this call is not live`,
          ...(b.lines as Body[]).map(lineOf),
        ];
        if (b.lines.length === 0) out.push("(no new lines)");
        for (const p of b.provisional ?? []) {
          out.push(`DRAFT, still being spoken, may change: [${p.time} ${p.speaker}] ${p.text}`);
        }
        out.push(`cursor: ${b.cursor}`);
        return out.join("\n");
      });
    },
  );

  server.registerTool(
    "akou_search",
    {
      description: `Exact word hits in a call with wall-time citations, for names, numbers and terms. ${RULES}`,
      inputSchema: z.object({
        query: z.string().min(1),
        call: CALL,
        k: z.number().int().min(1).max(50).default(6),
      }),
    },
    async (a) => {
      const r = await req("GET", `/calls/${id(a.call)}/search`, { query: { q: a.query, k: a.k } });
      return asResult(r, (b) =>
        (b.hits as Body[]).length === 0
          ? "No hits."
          : (b.hits as Body[]).map((h) => [h.citation, ...h.lines].join("\n")).join("\n\n"),
      );
    },
  );

  const ask = server.registerTool(
    "akou_ask",
    {
      description:
        "Answer with akou's own configured provider. Prefer akou_context and answer yourself: akou_ask spawns another agent run on the user's subscription.",
      inputSchema: z.object({ question: z.string().min(1), call: CALL }),
    },
    async (a) => {
      const r = await req("POST", `/calls/${id(a.call)}/ask`, {
        body: { question: a.question },
        timeoutMs: 15 * 60_000,
      });
      // No model answered: the excerpts, labelled, are still the reply.
      return asResult(r, (b) => b.text ?? compact(b));
    },
  );
  ask.disable();

  // --- speakers, notes, memory, memo ------------------------------------------------------------

  server.registerTool(
    "akou_name_speaker",
    {
      description:
        'Name a speaker the moment the user says who a voice is ("Speaker 2 is Ben"). `speaker` is the id from the transcript: you, c2, c3...',
      inputSchema: z.object({ speaker: z.string(), name: z.string().min(1) }),
    },
    async (a) => {
      const r = await req("POST", "/calls/live/speakers", {
        body: { spk: a.speaker, name: a.name },
      });
      return asResult(r, (b) => `${b.spk} is ${b.name}`);
    },
  );

  server.registerTool(
    "akou_merge_speakers",
    {
      description: "Merge speaker `a` into speaker `b` when both are the same person.",
      inputSchema: z.object({ a: z.string(), b: z.string() }),
    },
    async (x) => {
      const r = await req("POST", "/calls/live/speakers/merge", {
        body: { from: x.a, into: x.b },
      });
      return asResult(r, (b) => `${b.from} merged into ${b.into}`);
    },
  );

  server.registerTool(
    "akou_unmerge_speaker",
    {
      description: "Undo a merge: the speaker gets its own label back for later lines.",
      inputSchema: z.object({ speaker: z.string() }),
    },
    async (a) => {
      const r = await req("POST", "/calls/live/speakers/unmerge", { body: { spk: a.speaker } });
      return asResult(r, () => `${a.speaker} unmerged`);
    },
  );

  server.registerTool(
    "akou_add_note",
    {
      description: "Add a line to the live call's notepad, marked as written by you.",
      inputSchema: z.object({ text: z.string().min(1) }),
    },
    async (a) => {
      const r = await req("POST", "/calls/live/notes", { body: { text: a.text } });
      return asResult(r, (b) => `Noted (${b.note.id})`);
    },
  );

  server.registerTool(
    "akou_get_notes",
    {
      description: "The live call's notepad: the user's lines and yours.",
      inputSchema: z.object({}),
    },
    async () => {
      const r = await req("GET", "/calls/live/notes");
      return asResult(r, compact);
    },
  );

  server.registerTool(
    "akou_remember",
    {
      description:
        "Keep a fact you will need in later turns (it comes back in every akou_context pack, even after your context is compacted).",
      inputSchema: z.object({ text: z.string().min(1) }),
    },
    async (a) => {
      const r = await req("POST", "/calls/live/remember", { body: { text: a.text } });
      return asResult(r, (b) => `Remembered (${b.remember.id})`);
    },
  );

  server.registerTool(
    "akou_forget",
    {
      description: "Retract a line kept with akou_remember, by its id.",
      inputSchema: z.object({ id: z.string() }),
    },
    async (a) => {
      const r = await req("DELETE", `/calls/live/remember/${id(a.id)}`);
      return asResult(r, () => `Forgot ${a.id}`);
    },
  );

  server.registerTool(
    "akou_memo_get",
    {
      description: "The live call's rolling memo and the seq it covers.",
      inputSchema: z.object({}),
    },
    async () => {
      const r = await req("GET", "/calls/live/memo");
      return asResult(r, compact);
    },
  );

  server.registerTool(
    "akou_memo_put",
    {
      description:
        "Write the rolling memo when akou_context reports memoStale and no provider writes it: topics, decisions, actions with owner, open questions, people, each with [HH:MM]. `coversSeq` is the cursor the memo covers up to.",
      inputSchema: z.object({ text: z.string().min(1), coversSeq: z.number().int().min(0) }),
    },
    async (a) => {
      const r = await req("PUT", "/calls/live/memo", { body: a });
      return asResult(r, (b) => `Memo saved (covers seq ${b.memo.coversSeq ?? a.coversSeq})`);
    },
  );

  // --- vocabulary -------------------------------------------------------------------------------

  server.registerTool(
    "akou_vocab_add",
    {
      description:
        'Add a word the user stated ("it\'s Vercel, not versal"): with scope "call" it applies to the live call at once, forward to recognition and backward to every earlier line; "workspace" or "global" keeps it in the vocabulary file. Never add a word you inferred; propose it with akou_vocab_propose.',
      inputSchema: z.object({
        term: z.string().min(1),
        heard: z.array(z.string()).optional(),
        scope: z.enum(["call", "workspace", "global"]).default("call"),
        workspace: z.string().optional(),
        decode: z.boolean().optional(),
        note: z.string().optional(),
      }),
    },
    async (a) => {
      if (a.scope === "call") {
        const r = await req("POST", "/calls/live/vocab", {
          body: { term: a.term, heard: a.heard, decode: a.decode },
        });
        return asResult(r, (b) => `Added ${a.term} to call ${b.call} (${b.vocab.id})`);
      }
      if (a.scope === "workspace" && !a.workspace) {
        return text('bad_field: scope "workspace" needs `workspace`', true);
      }
      const r = await req("POST", "/vocab", {
        body: {
          term: a.term,
          heard: a.heard,
          workspace: a.scope === "workspace" ? a.workspace : undefined,
          decode: a.decode,
          note: a.note,
        },
      });
      return asResult(r, (b) => `Added ${a.term} to ${b.path}`);
    },
  );

  server.registerTool(
    "akou_vocab_propose",
    {
      description:
        "Propose words you inferred (from an invite, a document, a correction you noticed). A proposal does nothing until the user approves it with akou_vocab_approve. With `call`, they go to that call's workspace.",
      inputSchema: z.object({
        entries: z
          .array(
            z.object({
              term: z.string().min(1),
              heard: z.array(z.string()).optional(),
              note: z.string().optional(),
            }),
          )
          .min(1),
        call: z.string().optional(),
      }),
    },
    async (a) => {
      let workspace: string | undefined;
      if (a.call) {
        const c = await req("GET", `/calls/${id(a.call)}`);
        if (c.status !== 200) return asResult(c, compact);
        workspace = c.body.workspace;
      }
      const done: string[] = [];
      for (const e of a.entries) {
        const r = await req("POST", "/vocab", {
          body: { term: e.term, heard: e.heard, note: e.note, workspace, confirmed: false },
        });
        if (r.status !== 201) {
          return asResult(r, compact);
        }
        done.push(e.term);
      }
      return text(`Proposed (inactive until approved): ${done.join(", ")}`);
    },
  );

  for (const action of ["approve", "reject"] as const) {
    server.registerTool(
      `akou_vocab_${action}`,
      {
        description:
          action === "approve"
            ? "Approve proposed words once the user says yes; they become confirmed entries in the workspace file."
            : "Reject proposed words; they are not proposed again.",
        inputSchema: z.object({ terms: z.array(z.string()).min(1), call: z.string().optional() }),
      },
      async (a) => {
        const r = await req("POST", `/vocab/${action}`, { body: a });
        return asResult(r, compact);
      },
    );
  }

  server.registerTool(
    "akou_vocab_list",
    {
      description:
        "The vocabulary in force: a call's own words and proposals (with `call`), or the files for a workspace.",
      inputSchema: z.object({
        workspace: z.string().optional(),
        call: z.string().optional(),
        unconfirmed: z.boolean().optional(),
      }),
    },
    async (a) => {
      const r = a.call
        ? await req("GET", `/calls/${id(a.call)}/vocab`)
        : await req("GET", "/vocab", {
            query: { workspace: a.workspace, unconfirmed: a.unconfirmed || undefined },
          });
      return asResult(r, compact);
    },
  );

  server.registerTool(
    "akou_vocab_suggest",
    {
      description: "Ranked candidate words from a call or a text, to propose to the user.",
      inputSchema: z.object({
        text: z.string().optional(),
        call: z.string().optional(),
        k: z.number().int().min(1).max(200).default(20),
      }),
    },
    async (a) => {
      const r = await req("POST", "/vocab/suggest", { body: a });
      return asResult(r, compact);
    },
  );

  server.registerTool(
    "akou_vocab_check",
    {
      description: "Whether a word is safe to bias recognition with.",
      inputSchema: z.object({ term: z.string().min(1) }),
    },
    async (a) => {
      const r = await req("POST", "/vocab/check", { body: a });
      return asResult(r, compact);
    },
  );

  // --- after the call ---------------------------------------------------------------------------

  server.registerTool(
    "akou_enhance_context",
    {
      description:
        "What you need to write enhanced notes for the latest call yourself: the template and a pack.",
      inputSchema: z.object({ template: z.string().optional() }),
    },
    async (a) => {
      const r = await req("GET", "/calls/last/enhance/context", {
        query: { template: a.template },
      });
      return asResult(r, compact);
    },
  );

  server.registerTool(
    "akou_enhanced_put",
    {
      description:
        "Save the enhanced notes you wrote for the latest call. Every bullet must end with the segment ids it rests on, like [#l000031]; a bullet without a real citation is dropped. Place the user's own notes by id (`- {n0004}`); they are kept word for word.",
      inputSchema: z.object({ markdown: z.string().min(1), coversSeq: z.number().int().min(0) }),
    },
    async (a) => {
      const last = await req("GET", "/calls/last");
      if (last.status !== 200) return asResult(last, compact);
      const r = await req("PUT", `/calls/${id(last.body.id)}/enhanced`, { body: a });
      return asResult(r, compact);
    },
  );

  server.registerTool(
    "akou_enhance",
    {
      description:
        "Ask akou's own provider to write the enhanced notes for the latest call. Prefer akou_enhance_context and write them yourself.",
      inputSchema: z.object({ template: z.string().optional() }),
    },
    async (a) => {
      const r = await req("POST", "/calls/last/enhance", { body: a, timeoutMs: 60 * 60_000 });
      return asResult(
        r,
        (b) =>
          `${b.markdown}\n\n(rev ${b.rev}, template ${b.template}, by ${b.model}; ${b.dropped.length} uncited lines dropped)`,
      );
    },
  );

  // --- past calls -------------------------------------------------------------------------------

  server.registerTool(
    "akou_list_calls",
    {
      description:
        "Past calls by date, title and state (no content search). History beyond a named call lives in the user's own notes.",
      inputSchema: z.object({
        workspace: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(20),
        failed: z.boolean().optional(),
      }),
    },
    async (a) => {
      const r = await req("GET", "/calls", {
        query: { workspace: a.workspace, limit: a.limit, failed: a.failed || undefined },
      });
      return asResult(r, (b) =>
        (b.calls as Body[]).length === 0
          ? "No calls."
          : (b.calls as Body[])
              .map(
                (c) =>
                  `${c.id}  ${new Date(c.createdAt).toLocaleDateString("en-CA")} ${wall(c.createdAt)}  ${c.workspace}  "${c.title}"  ${c.state}${c.endedAt ? `, ended ${wall(c.endedAt)}` : ""}`,
              )
              .join("\n"),
      );
    },
  );

  server.registerTool(
    "akou_get_call",
    {
      description: `A call the user named: its transcript (the newest 12k tokens at most; use akou_search or akou_context with \`call\` for the rest). ${RULES}`,
      inputSchema: z.object({
        call: z.string(),
        layer: z.enum(["best", "live", "final"]).default("best"),
      }),
    },
    async (a) => {
      const r = await req("GET", `/calls/${id(a.call)}/transcript`, {
        query: { layer: a.layer, format: "md", limitTokens: 12000 },
      });
      if (r.status === 200) return text(r.text);
      return asResult(r, compact);
    },
  );

  server.registerTool(
    "akou_export",
    {
      description: "Hand a finished call off to the export folder.",
      inputSchema: z.object({ call: z.string() }),
    },
    async (a) => {
      const r = await req("POST", `/calls/${id(a.call)}/export`);
      return asResult(r, compact);
    },
  );

  // --- akou_ask visibility ----------------------------------------------------------------------

  const applyProvider = (provider: Body) => {
    const want = askListed(provider, server.server.getClientVersion()?.name);
    if (want !== ask.enabled) {
      if (want) ask.enable();
      else ask.disable();
    }
  };
  /** Reads the provider from a running app; never launches one just to list tools. */
  const refreshAsk = async () => {
    try {
      const r = await o.client.request("GET", "/status", { launch: false });
      if (r.status === 200) applyProvider(r.body.provider);
    } catch {}
  };
  server.server.oninitialized = () => void refreshAsk();

  return server;
}

/** Serves MCP on stdin and stdout until the client closes stdin. */
export async function runMcpStdio(o: McpOptions): Promise<void> {
  const server = createMcpServer(o);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport());
  await closed;
}
