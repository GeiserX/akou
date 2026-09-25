/**
 * Reading and questioning a call (docs/DESIGN.md sections 5.4, 5.5 and 6.1): `tail`, `context`,
 * `ask`, `search`. Every time printed is local wall-clock time from the API, never an offset.
 */

import { readSse } from "../../llm/provider.ts";
import { bool, duration, int, str } from "../args.ts";
import { EXIT } from "../client.ts";
import { SpeakerColors } from "../color.ts";
import { api, type Body, type Command, type Ctx, callFlag, finish, ref } from "../context.ts";
import { usage } from "./calls.ts";

type Format = "txt" | "md" | "json";

/** One committed line. `colors` is given only for text on a terminal (CLI-20). */
export function lineText(l: Body, format: Format, colors?: SpeakerColors): string {
  if (format === "json") return JSON.stringify(l);
  const text = l.annotated ?? l.text;
  if (format === "md") return `**${l.time} ${l.speaker}:** ${text}`;
  const who = colors ? colors.name(l.spk ?? l.speaker, l.speaker) : l.speaker;
  return `${l.time} ${who}: ${text}`;
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
  usage: "akou tail [-c CALL] [-f] [--since SEQ] [--last 5m] [--format txt|md|json] [--json]",
  flags: {
    call: callFlag("live"),
    follow: { type: "boolean", short: "f", desc: "keep printing until the call ends" },
    since: { type: "string", value: "SEQ", desc: "lines after this cursor" },
    last: { type: "string", value: "5m", desc: "lines from the last 90s, 5m or 1h" },
    format: {
      type: "string",
      value: "F",
      desc: "txt (default), md or json (one row per line)",
    },
  },
  examples: ["akou tail -f --last 2m"],
  run: async (ctx, p) => {
    const format = (ctx.json ? "json" : (str(p, "format") ?? "txt")) as Format;
    if (!["json", "md", "txt"].includes(format)) return usage(ctx, "--format is json, md or txt");
    const colors = format === "txt" && ctx.color ? new SpeakerColors(true) : undefined;
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
    for (const l of first.body.lines) ctx.io.out(lineText(l, format, colors));
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
      for (const l of r.body.lines) ctx.io.out(lineText(l, format, colors));
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
  usage: 'akou context "QUESTION" [-c CALL] [--budget N] [--json]',
  flags: {
    call: callFlag("live"),
    budget: { type: "string", value: "N", desc: "the most tokens the pack may use" },
  },
  examples: ['akou context "what did we decide about the release?" --budget 4000'],
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

/** A question may wait on a model: the provider's own deadline applies first. */
export const ASK_TIMEOUT_MS = 15 * 60_000;

/** Prints an ask reply. An excerpts-only reply goes to stdout, its reason to stderr, exit 69. */
function askDone(ctx: Ctx, q: string, b: Body, streamed: boolean): number {
  if (b.answered) {
    if (streamed) ctx.io.write?.("\n");
    else ctx.io.out(b.text);
    return EXIT.ok;
  }
  ctx.io.out(b.text);
  ctx.io.err(
    `akou: no model answered (${b.reason}); \`akou context "${q}"\` prints what an agent answers from`,
  );
  return EXIT.unavailable;
}

const ask: Command = {
  name: "ask",
  summary: "Answer a question with akou's configured provider (excerpts when it cannot)",
  usage: 'akou ask "QUESTION" [-c CALL] [--json]',
  flags: { call: callFlag("live") },
  examples: ['akou ask "what did we decide about the release?"'],
  run: async (ctx, p) => {
    const q = question(p.positional);
    if (!q) return usage(ctx, "ask needs a question");
    const path = `/calls/${ref(p)}/ask`;
    const write = ctx.io.write;
    if (ctx.json || !write) {
      const r = await api(ctx, "POST", path, {
        body: { question: q },
        timeoutMs: ASK_TIMEOUT_MS,
        signal: ctx.io.signal,
      });
      if (r.status !== 200) return finish(ctx, r, () => "");
      if (ctx.json) {
        ctx.io.out(JSON.stringify(r.body));
        return r.body.answered ? EXIT.ok : EXIT.unavailable;
      }
      return askDone(ctx, q, r.body, false);
    }
    // A terminal: print the answer as it streams.
    const res = await ctx.client.stream("POST", path, {
      body: { question: q, stream: true },
      timeoutMs: ASK_TIMEOUT_MS,
      signal: ctx.io.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      let body: Body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      return finish(ctx, { status: res.status, body, text, contentType: "" }, () => "");
    }
    let streamed = false;
    for await (const ev of readSse(res.body)) {
      const data = JSON.parse(ev.data) as Body;
      if (ev.event === "token") {
        write(data.t);
        streamed = true;
      } else if (ev.event === "answer") {
        return askDone(ctx, q, data, streamed);
      } else if (ev.event === "error") {
        ctx.io.err(`akou: ${data.message}`);
        return EXIT.software;
      }
    }
    ctx.io.err("akou: the answer stream ended early");
    return EXIT.software;
  },
};

const search: Command = {
  name: "search",
  summary: "Exact word hits in a call, with wall times",
  usage: 'akou search "QUERY" [-c CALL] [-k N] [--json]',
  flags: {
    call: callFlag("live"),
    k: { type: "string", short: "k", value: "N", desc: "at most N hits (default 5)" },
  },
  examples: ["akou search migration -k 3"],
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
