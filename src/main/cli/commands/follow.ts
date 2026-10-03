/**
 * Reading and questioning a call (docs/DESIGN.md sections 5.4, 5.5 and 6.1): `tail`, `context`,
 * `ask`, `search`, and `presets`, the ask box's questions. Every time printed is local wall-clock
 * time from the API, never an offset.
 */

import { type LearnedItem, learnedNote } from "../../../core/vocab/learned.ts";
import { readSse } from "../../llm/provider.ts";
import type { Parsed } from "../args.ts";
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

/** What fixes taught akou since the cursor: a sentence each, or `{"learned": …}` rows in json. */
function learnedText(b: Body, format: Format): string[] {
  const items = (b.learned as LearnedItem[] | undefined) ?? [];
  return items.map((x) => (format === "json" ? JSON.stringify({ learned: x }) : learnedNote(x)));
}

/** Waits for the next events after `cursor` (the API long-polls up to 25 s). */
async function nextEvents(
  ctx: Ctx,
  call: string,
  cursor: number,
  o: { types?: string; launch?: boolean; wait?: number } = {},
): Promise<Body> {
  const r = await api(ctx, "GET", `/calls/${call}/events`, {
    query: { after: cursor, wait: o.wait ?? 25, types: o.types },
    timeoutMs: 40_000,
    signal: ctx.io.signal,
    ...(o.launch === false ? { launch: false } : {}),
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
    json: { type: "boolean", desc: "same as --format json" },
  },
  examples: ["akou tail -f --last 2m"],
  run: async (ctx, p) => {
    const format = (ctx.json ? "json" : (str(p, "format") ?? "txt")) as Format;
    if (!["json", "md", "txt"].includes(format)) return usage(ctx, "--format is json, md or txt");
    const colors = format === "txt" && ctx.color ? new SpeakerColors(true) : undefined;
    const last = duration(p, "last");
    const call = ref(p);
    const follow = bool(p, "follow");
    const query = {
      format: "json",
      since: int(p, "since", 0, Number.MAX_SAFE_INTEGER),
      // clock: `--last` counts back from the moment the command runs.
      from: last !== undefined ? Date.now() - last * 1000 : undefined,
      // A one-off read gets the second pass's text first; a follower does not wait on each event.
      review: follow ? "skip" : undefined,
    };
    const first = await api(ctx, "GET", `/calls/${call}/transcript`, { query });
    if (first.status !== 200) return finish(ctx, first, () => "");
    const id = first.body.call as string;
    for (const l of first.body.lines) ctx.io.out(lineText(l, format, colors));
    for (const x of learnedText(first.body, format)) ctx.io.out(x);
    if (!follow) {
      const n = Number(first.body.unreviewed ?? 0);
      if (n > 0 && format !== "json")
        ctx.io.err(`akou: ${n} line${n === 1 ? " is" : "s are"} still waiting for the second pass`);
      return EXIT.ok;
    }
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
        query: { format: "json", since: lineCursor, review: "skip" },
      });
      if (r.status !== 200) return finish(ctx, r, () => "");
      for (const l of r.body.lines) ctx.io.out(lineText(l, format, colors));
      for (const x of learnedText(r.body, format)) ctx.io.out(x);
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

/** The events that end a call: `events -f` stops after them. */
const ENDS = ["call.ended", "call.failed"];

const events: Command = {
  name: "events",
  summary: "The call's log events as JSON lines, one object per line; -f follows until it ends",
  usage: "akou events [-c CALL] [-f] [--type T,…] [--since SEQ]",
  flags: {
    call: callFlag("live"),
    follow: { type: "boolean", short: "f", desc: "keep printing until the call ends" },
    type: { type: "string", value: "T,…", desc: "only these event types: health,seg,answer" },
    since: { type: "string", value: "SEQ", desc: "events after this cursor (default: all)" },
    json: { type: "boolean", desc: "accepted; the output is always JSON lines" },
  },
  examples: ["akou events -f --type health,answer", "akou events -c last --since 120"],
  run: async (ctx, p) => {
    if (p.positional.length > 0) return usage(ctx, "events takes no words; name the call with -c");
    const want = str(p, "type")
      ?.split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    const kept = want && want.length > 0 ? new Set(want) : null;
    // A follower asks for the ends too, to know when to stop; it prints only what was asked for.
    const follow = bool(p, "follow");
    const types = kept ? [...new Set([...kept, ...(follow ? ENDS : [])])].join(",") : undefined;
    // Never launches the app: a stream of a call that is not running has nothing to say (PG-S3).
    let r: Body;
    try {
      // A one-off read answers at once; a follower may wait for the first event.
      r = await nextEvents(ctx, ref(p), int(p, "since", 0, Number.MAX_SAFE_INTEGER) ?? 0, {
        types,
        launch: false,
        wait: follow ? 25 : 0,
      });
    } catch (err) {
      const res = (err as { response?: Body }).response;
      if (res) return finish(ctx, res, () => "");
      throw err;
    }
    // Follow by id, so `live` cannot move to another call under us.
    const id = r.call as string;
    let cursor = r.cursor as number;
    for (;;) {
      let ended = false;
      for (const e of r.events as Body[]) {
        if (!kept || kept.has(e.type)) ctx.io.out(JSON.stringify(e));
        if (ENDS.includes(e.type)) ended = true;
      }
      if (!follow || ended || ctx.io.signal?.aborted) return EXIT.ok;
      try {
        r = await nextEvents(ctx, id, cursor, { types, launch: false });
      } catch (err) {
        const res = (err as { response?: Body }).response;
        if (res) return finish(ctx, res, () => "");
        if (ctx.io.signal?.aborted) return EXIT.ok;
        throw err;
      }
      cursor = r.cursor as number;
    }
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
        `${b.pack}\n\ncursor ${b.cursor} · ${b.state}${b.memoStale ? " · memo stale" : ""} · ${b.tokens} tokens${b.unreviewed ? ` · ${b.unreviewed} lines still waiting for the second pass` : ""}`,
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
  usage: 'akou ask "QUESTION" | akou ask --preset NAME [--speaker NAME]   [-c CALL] [--json]',
  flags: {
    call: callFlag("live"),
    preset: {
      type: "string",
      value: "NAME",
      desc: "ask a preset's question instead (`akou presets list` names them)",
    },
    speaker: {
      type: "string",
      value: "NAME",
      desc: "with --preset: the speaker a per-speaker preset asks about",
    },
  },
  examples: [
    'akou ask "what did we decide about the release?"',
    "akou ask --preset decisions",
    "akou ask --preset speaker --speaker Ben",
  ],
  run: async (ctx, p) => {
    const preset = str(p, "preset");
    if (preset === undefined && str(p, "speaker") !== undefined)
      return usage(ctx, "--speaker goes with --preset");
    if (preset !== undefined && p.positional.length > 0)
      return usage(ctx, "ask takes a question or --preset, not both");
    let q = question(p.positional);
    if (preset !== undefined) {
      const picked = await presetQuestion(ctx, p, preset);
      if (typeof picked === "number") return picked;
      q = picked;
    }
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

/** The question `--preset NAME` asks of the call, filled in for it, or the exit code. */
async function presetQuestion(ctx: Ctx, p: Parsed, name: string): Promise<string | number> {
  const speaker = str(p, "speaker");
  const r = await api(ctx, "GET", "/presets", {
    query: { call: str(p, "call") ?? "live", speaker },
  });
  if (r.status !== 200) return finish(ctx, r, () => "");
  const all = r.body.presets as Body[];
  const mine = all.filter((x) => x.name === name);
  if (mine.length === 1) return String(mine[0].question);
  if (mine.length > 1) {
    const who = mine.map((x) => x.speaker).join(", ");
    return usage(ctx, `preset ${name} asks about one speaker: add --speaker (${who})`);
  }
  const raw = await api(ctx, "GET", "/presets");
  const known = ((raw.body?.presets ?? []) as Body[]).find((x) => x.name === name);
  if (known?.usesSpeaker) {
    return usage(
      ctx,
      `preset ${name} asks about a speaker, and this call names none: add --speaker`,
    );
  }
  return usage(ctx, `no preset ${name}; \`akou presets list\` names them`);
}

const presets: Command = {
  name: "presets",
  summary: "List the ask presets: the shipped questions and your own files",
  usage: "akou presets list [--json]",
  examples: ["akou presets list"],
  run: async (ctx, p) => {
    if (p.positional.length !== 1 || p.positional[0] !== "list")
      return usage(ctx, "presets needs list");
    const r = await api(ctx, "GET", "/presets");
    return finish(ctx, r, (b) =>
      [
        ...(b.presets as Body[]).map((x) => `${x.name}  ${x.label}${x.bundled ? "" : "  (yours)"}`),
        `Your own go in ${b.dir} as NAME.md; ask one with akou ask --preset NAME.`,
      ].join("\n"),
    );
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

export const followCommands: Command[] = [tail, events, context, ask, presets, search];
