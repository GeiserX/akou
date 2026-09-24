/**
 * Reading and questioning a call (docs/DESIGN.md sections 5.4, 5.5 and 6.1): `tail`, `context`,
 * `ask`, `search`. Every time printed is local wall-clock time from the API, never an offset.
 */

import { bool, duration, int, str } from "../args.ts";
import { EXIT, exitFor } from "../client.ts";
import { api, type Body, type Command, type Ctx, finish, ref } from "../context.ts";
import { usage } from "./calls.ts";

type Format = "txt" | "md" | "json";

function lineText(l: Body, format: Format): string {
  if (format === "json") return JSON.stringify(l);
  const text = l.annotated ?? l.text;
  return format === "md"
    ? `**${l.time} ${l.speaker}:** ${text}`
    : `${l.time} ${l.speaker}: ${text}`;
}

/** Waits for the next events after `cursor` (the API long-polls up to 25 s). */
async function nextEvents(ctx: Ctx, call: string, cursor: number): Promise<Body> {
  const r = await api(ctx, "GET", `/calls/${call}/events`, {
    query: { after: cursor, wait: 25 },
    timeoutMs: 40_000,
    signal: ctx.io.signal,
  });
  if (r.status !== 200) throw Object.assign(new Error("events"), { response: r });
  return r.body;
}

const tail: Command = {
  name: "tail",
  summary: "Committed lines with wall times; -f follows the call until it ends",
  usage:
    "akou tail [--call ID] [--since SEQ] [--last 5m] [-f] [--format json|md|txt] (json prints one line per row)",
  flags: {
    call: { type: "string" },
    since: { type: "string" },
    last: { type: "string" },
    follow: { type: "boolean", short: "f" },
    format: { type: "string" },
  },
  run: async (ctx, p) => {
    const format = (ctx.json ? "json" : (str(p, "format") ?? "txt")) as Format;
    if (!["json", "md", "txt"].includes(format)) return usage(ctx, "--format is json, md or txt");
    const last = duration(p, "last");
    const call = ref(p);
    const query = {
      format: "json",
      since: int(p, "since", 0, Number.MAX_SAFE_INTEGER),
      from: last !== undefined ? Date.now() - last * 1000 : undefined,
    };
    const first = await api(ctx, "GET", `/calls/${call}/transcript`, { query });
    if (first.status !== 200) return finish(ctx, first, () => "");
    const id = first.body.call as string;
    for (const l of first.body.lines) ctx.io.out(lineText(l, format));
    if (!bool(p, "follow")) return EXIT.ok;
    // Follow by id, so `live` cannot move to another call under us. Two cursors: the transcript
    // read can already hold lines committed after the events answer, and must not print them twice.
    let eventCursor = first.body.cursor as number;
    let lineCursor = eventCursor;
    while (!ctx.io.signal?.aborted) {
      let ev: Body;
      try {
        ev = await nextEvents(ctx, id, eventCursor);
      } catch (err) {
        const r = (err as { response?: Body }).response;
        if (r) return finish(ctx, r, () => "");
        if (ctx.io.signal?.aborted) break;
        throw err;
      }
      if (ev.events.length === 0) continue;
      const r = await api(ctx, "GET", `/calls/${id}/transcript`, {
        query: { format: "json", since: lineCursor },
      });
      if (r.status !== 200) return finish(ctx, r, () => "");
      for (const l of r.body.lines) ctx.io.out(lineText(l, format));
      lineCursor = r.body.cursor;
      eventCursor = ev.cursor;
      const ended = (ev.events as Body[]).some(
        (e) => e.type === "call.ended" || e.type === "call.failed",
      );
      if (ended) {
        if (format !== "json") ctx.io.err("akou: the call ended");
        break;
      }
    }
    return EXIT.ok;
  },
};

function question(words: string[]): string | null {
  const q = words.join(" ").trim();
  return q === "" ? null : q;
}

const context: Command = {
  name: "context",
  summary: "Print the context pack an agent answers from (no model is called)",
  usage: 'akou context "QUESTION" [--call ID] [--budget N] [--json]',
  flags: { call: { type: "string" }, budget: { type: "string" } },
  run: async (ctx, p) => {
    const q = question(p.positional);
    if (!q) return usage(ctx, "context needs a question");
    const r = await api(ctx, "POST", `/calls/${ref(p)}/context`, {
      body: { question: q, budget: int(p, "budget", 1, 32_000) },
    });
    return finish(
      ctx,
      r,
      (b) =>
        `${b.pack}\n\ncursor ${b.cursor} · ${b.state}${b.memoStale ? " · memo stale" : ""} · ${b.tokens} tokens`,
    );
  },
};

const ask: Command = {
  name: "ask",
  summary: "Answer a question with akou's configured provider",
  usage: 'akou ask "QUESTION" [--call ID] [--json]',
  flags: { call: { type: "string" } },
  run: async (ctx, p) => {
    const q = question(p.positional);
    if (!q) return usage(ctx, "ask needs a question");
    const r = await api(ctx, "POST", `/calls/${ref(p)}/ask`, { body: { question: q } });
    if (!ctx.json && r.body?.error === "provider_unavailable") {
      ctx.io.err(
        `akou: no provider can answer (${r.body.reason}); \`akou context "${q}"\` prints what an agent answers from`,
      );
      return exitFor(r.status, r.body.error);
    }
    return finish(ctx, r, (b) => b.text ?? b.answer ?? JSON.stringify(b, null, 2));
  },
};

const search: Command = {
  name: "search",
  summary: "Exact word hits in a call, with wall times",
  usage: 'akou search "QUERY" [--call ID] [-k N] [--json]',
  flags: { call: { type: "string" }, k: { type: "string", short: "k" } },
  run: async (ctx, p) => {
    const q = question(p.positional);
    if (!q) return usage(ctx, "search needs a query");
    const r = await api(ctx, "GET", `/calls/${ref(p)}/search`, {
      query: { q, k: int(p, "k", 1, 50) },
    });
    return finish(ctx, r, (b) =>
      (b.hits as Body[]).length === 0
        ? "No hits."
        : (b.hits as Body[])
            .map((h) => [h.citation, ...(h.lines as string[]).map((l) => `  ${l}`)].join("\n"))
            .join("\n"),
    );
  },
};

export const followCommands: Command[] = [tail, context, ask, search];
