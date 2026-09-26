/**
 * Following a call (docs/DESIGN.md sections 5.5 and 6.2):
 *
 * - `GET /calls/{id}/events?after=SEQ&wait=25`: the raw log after a cursor, long-polled.
 * - `GET /calls/{id}/stream?after=SEQ`: Server-Sent Events. Every log event after the cursor, in
 *   `seq` order and each exactly once (the backlog from disk, then live events), plus the
 *   ephemeral `partial` (the provisional line, never in the log), `level` and `read` events.
 *   `read` is the app's own rendering of the lines its vocabulary corrects (section 5.4): a
 *   follower that folds the raw events has neither the vocabulary files nor the word lists, so it
 *   shows these texts instead of its own for the lines they name.
 * - `GET /calls/{id}/transcript`: the rendered transcript, names and vocabulary applied, local
 *   wall-clock times only. The JSON form also carries the call's state and, while it is live, the
 *   provisional line (marked `draft`), which is what `akou_read` follows a call with.
 *   `format=export` is the export file's `## Transcript` section, what the window copies.
 */

import { formatWall, formatZone } from "../../../core/log/clock.ts";
import type { LogEvent } from "../../../core/log/events.ts";
import type { Line, View } from "../../../core/log/fold.ts";
import { renderTranscriptSection } from "../../handoff/export.ts";
import { estimateTokens, renderLine } from "../../query/render.ts";
import { HttpError, json, type Query, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { CALL_ID, callId, callOf } from "./common.ts";

/** Longest a long poll waits, seconds. */
export const MAX_WAIT_SECONDS = 30;
/** How often a stream looks at the provisional line and the levels, ms. */
export const STREAM_TICK_MS = 250;
export const KEEPALIVE_MS = 15_000;
/** A steady level is repeated this often. */
export const LEVEL_REPEAT_MS = 1000;

/**
 * Waits for the first event past `after`, the deadline, or the client going away. It listens from
 * the moment it is made, so an event appended while the caller reads the log is not missed: make
 * it, read, then `wait`; `stop` it in every case.
 */
function eventWaiter(
  app: ApiApp,
  id: string,
  after: number,
  signal: AbortSignal,
): { wait(ms: number): Promise<void>; stop(): void } {
  let arrived = false;
  let wake = () => {};
  const stop = app.subscribe(id, (e) => {
    if (e.seq <= after) return;
    arrived = true;
    wake();
  });
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (arrived || signal.aborted) return resolve();
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish);
      wake = finish;
    });
  return { wait, stop };
}

/** Parses a time bound: epoch ms, or an ISO 8601 date-time with its zone. */
function timeParam(query: Query, name: string): number | undefined {
  const raw = query.raw(name);
  if (raw === null || raw === "") return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) {
    throw new HttpError(
      400,
      "bad_param",
      `${name} must be epoch milliseconds or an ISO date-time`,
      {
        param: name,
      },
    );
  }
  return n;
}

/** One line still being spoken, as a follower receives it: never in the log, always a draft. */
export interface PartialLine {
  ch: "mic" | "call";
  part: number;
  spk?: string;
  text: string;
  w0: number;
  time: string;
  draft: true;
}

/** One line as the app renders it: `rev` is the revision the text belongs to. */
export interface ReadLine {
  id: string;
  rev: number;
  text: string;
  /** The raw text, present when a correction changed it. */
  heard?: string;
}

/**
 * The app's rendering of lines. `all`: these are every line a correction changes, and any line
 * not named has none. Otherwise an update for the lines named, the ones that no longer have a
 * correction included (without `heard`).
 */
export interface ReadLines {
  all: boolean;
  lines: ReadLine[];
}

/** What a follower of a call receives, in order: every log event once, and the ephemeral parts. */
export interface FollowSink {
  event(e: LogEvent): void;
  partial(lines: PartialLine[]): void;
  level(l: { mic: number; call: number }): void;
  /** The app's rendering of corrected lines, after the backlog and whenever it changes. */
  read?(r: ReadLines): void;
  /** Every `KEEPALIVE_MS`, so a reader can tell a quiet call from a dead connection. */
  keepalive(): void;
}

/** `Last-Event-ID` as a cursor, or 0 when absent or not a sequence number. */
export function lastEventId(req: Request): number {
  const last = (req.headers.get("last-event-id") ?? "").trim();
  return /^\d{1,15}$/.test(last) ? Number(last) : 0;
}

/**
 * Follows a call from a cursor: every log event after `after`, in `seq` order and each exactly
 * once (the backlog from disk, then live events), plus the provisional line and the levels when
 * they change. The window's RPC, the page server and the SSE route all follow a call through this
 * one function. Returns the function that stops it.
 */
export async function openFollow(
  app: ApiApp,
  id: string,
  after: number,
  sink: FollowSink,
): Promise<() => void> {
  const call = await app.call(id);
  let sent = after;
  let stopped = false;
  const sendEvent = (e: LogEvent) => {
    if (stopped || e.seq <= sent) return;
    sent = e.seq;
    sink.event(e);
  };
  // Subscribe first and hold live events until the backlog is out, so none is lost or doubled.
  let held: LogEvent[] | null = [];
  const unsubscribe = app.subscribe(id, (e) => {
    if (held) held.push(e);
    else sendEvent(e);
  });
  let lastPartial = "";
  let lastLevel = "";
  let levelSentAt = 0;
  // The view's change feed, read once the backlog is out: which lines may render differently.
  let feed: number | null = null;
  const corrected = new Set<string>();
  const readLine = (l: Line): ReadLine => ({
    id: l.id,
    rev: l.rev,
    text: l.text,
    ...(l.heard !== undefined ? { heard: l.heard } : {}),
  });
  const sendAll = () => {
    corrected.clear();
    const lines = call.view
      .lines("best")
      .filter((l) => l.heard !== undefined)
      .map(readLine);
    for (const l of lines) corrected.add(l.id);
    sink.read?.({ all: true, lines });
  };
  const sendRead = () => {
    if (!sink.read || feed === null) return;
    const ch = call.view.changesSince(feed);
    feed = ch.cursor;
    if (ch.all) return sendAll();
    const lines: ReadLine[] = [];
    for (const id of ch.ids) {
      const l = call.view.resolve(id);
      if (!l) continue;
      if (l.heard !== undefined) corrected.add(id);
      else if (!corrected.delete(id)) continue;
      lines.push(readLine(l));
    }
    if (lines.length > 0) sink.read({ all: false, lines });
  };
  const tick = setInterval(() => {
    sendRead();
    const tz = call.view.call?.tz ?? "UTC";
    const lines: PartialLine[] = call.view.provisional.current(app.now()).map((x) => ({
      ch: x.ch,
      part: x.part,
      ...(x.spk ? { spk: x.spk } : {}),
      text: x.text,
      w0: x.w0,
      time: formatWall(x.w0, tz),
      draft: true,
    }));
    const partial = JSON.stringify(lines);
    if (partial !== lastPartial) {
      lastPartial = partial;
      sink.partial(lines);
    }
    const lv = app.levels(id);
    if (lv) {
      // A level that has not changed is sent again once a second while packets still arrive, so a
      // reader can tell a steady (or silent) channel from a capture that stopped sending.
      const level = JSON.stringify({ mic: lv.mic, call: lv.call });
      const now = app.now();
      const fresh = now - lv.at < LEVEL_REPEAT_MS * 2;
      if (level !== lastLevel || (fresh && now - levelSentAt >= LEVEL_REPEAT_MS)) {
        lastLevel = level;
        levelSentAt = now;
        sink.level({ mic: lv.mic, call: lv.call });
      }
    }
  }, STREAM_TICK_MS);
  const keepalive = setInterval(() => {
    if (!stopped) sink.keepalive();
  }, KEEPALIVE_MS);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(tick);
    clearInterval(keepalive);
    unsubscribe();
  };
  try {
    for (const e of await app.events(id, after)) sendEvent(e);
  } catch (err) {
    stop();
    throw err;
  }
  const pending = held;
  held = null;
  for (const e of pending) sendEvent(e);
  // Every corrected line once, then only what changes.
  if (sink.read) {
    feed = call.view.changesSince(0).cursor;
    sendAll();
  }
  return stop;
}

/** A follower as Server-Sent Events: `event` (id = seq), `partial`, `level`, keep-alive comments. */
export function sseFollow(app: ApiApp, id: string, after: number, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start: async (ctl) => {
      let closed = false;
      let stopFollow = () => {};
      const stop = () => {
        if (closed) return;
        closed = true;
        stopFollow();
        signal.removeEventListener("abort", stop);
        try {
          ctl.close();
        } catch {}
      };
      const send = (text: string) => {
        if (closed) return;
        try {
          ctl.enqueue(enc.encode(text));
        } catch {
          stop();
        }
      };
      cleanup = stop;
      signal.addEventListener("abort", stop);
      send("retry: 1000\n\n");
      try {
        stopFollow = await openFollow(app, id, after, {
          event: (e) => send(`id: ${e.seq}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`),
          partial: (p) => send(`event: partial\ndata: ${JSON.stringify(p)}\n\n`),
          level: (l) => send(`event: level\ndata: ${JSON.stringify(l)}\n\n`),
          read: (r) => send(`event: read\ndata: ${JSON.stringify(r)}\n\n`),
          keepalive: () => send(": keep-alive\n\n"),
        });
      } catch {
        stop();
        return;
      }
      if (closed) stopFollow();
    },
    cancel: () => cleanup(),
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

const AFTER = {
  type: "integer",
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  default: 0,
  doc: "The log cursor: only events after this `seq`.",
} as const;

const WAIT = {
  type: "integer",
  min: 0,
  max: MAX_WAIT_SECONDS,
  default: 0,
  doc: `Seconds to hold the request while nothing is past the cursor, up to ${MAX_WAIT_SECONDS}.`,
} as const;

export function followRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/calls/:id/events",
    {
      id: "calls.events",
      doc: "The call's log events after a cursor, oldest first, each exactly once, with the next cursor. With `wait`, holds the request until an event arrives or the wait ends: a long poll.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      query: { after: AFTER, wait: WAIT },
      ok: 200,
    },
    async (c) => {
      const id = callId(c);
      const after = c.query.int("after") as number;
      const wait = c.query.int("wait") as number;
      const waiter = wait > 0 ? eventWaiter(c.app, id, after, c.req.signal) : null;
      let events: LogEvent[];
      try {
        events = await c.app.events(id, after);
        if (events.length === 0 && waiter) {
          await waiter.wait(wait * 1000);
          events = await c.app.events(id, after);
        }
      } finally {
        waiter?.stop();
      }
      return json(200, { call: id, events, cursor: events.at(-1)?.seq ?? after });
    },
  );

  r.add(
    "GET",
    "/calls/:id/stream",
    {
      id: "calls.stream",
      doc: "The call's log events after a cursor as server-sent events, then every new one as it is written, plus the line being spoken and the levels. A reconnecting client sends `Last-Event-ID` and resumes after it.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      query: { after: AFTER },
      ok: 200,
      type: "sse",
    },
    async (c) => {
      const id = callId(c);
      // A reconnecting client repeats the URL and names the last event it got: resume after that.
      const after = Math.max(c.query.int("after") as number, lastEventId(c.req));
      await c.app.call(id);
      return sseFollow(c.app, id, after, c.req.signal);
    },
  );

  r.add(
    "GET",
    "/calls/:id/transcript",
    {
      id: "calls.transcript",
      doc: "The call's transcript, every line with its local wall-clock time and speaker. `layer` picks the live lines, the final pass, or the best of both; `from`, `to`, `speaker` and `since` narrow it; `limitTokens` keeps the newest lines that fit.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      query: {
        layer: {
          type: "string",
          values: ["best", "live", "final"],
          default: "best",
          doc: "Which transcript: the final pass for the parts it has finished and the live lines for the rest (`best`), or one of the two.",
        },
        format: {
          type: "string",
          values: ["json", "md", "txt", "export"],
          default: "json",
          doc: "JSON lines, Markdown, plain text, or the transcript section of the export.",
        },
        since: {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          default: 0,
          doc: "Only lines written or revised after this log position.",
        },
        limitTokens: {
          type: "integer",
          min: 1,
          max: 1_000_000,
          doc: "Keep the newest lines that fit in this many tokens.",
        },
        from: { type: "string", doc: "Lines ending at or after this time: epoch ms or ISO 8601." },
        to: { type: "string", doc: "Lines starting at or before this time: epoch ms or ISO 8601." },
        speaker: { type: "string", doc: "Only this speaker, by id (`c2`) or by name." },
      },
      ok: 200,
    },
    async (c) => {
      const call = await callOf(c);
      const v = call.view;
      const tz = v.call?.tz ?? "UTC";
      const layer = c.query.oneOf<View>("layer");
      const format = c.query.oneOf<"json" | "md" | "txt" | "export">("format");
      const since = c.query.int("since") as number;
      const limitTokens = c.query.int("limitTokens");
      const from = timeParam(c.query, "from");
      const to = timeParam(c.query, "to");
      const speaker = c.query.raw("speaker")?.toLowerCase() ?? null;
      let lines: Line[] = v.lines(layer).filter((l) => {
        if (since > 0 && (v.segment(l.id)?.lastSeq ?? 0) <= since) return false;
        if (from !== undefined && l.w1 < from) return false;
        if (to !== undefined && l.w0 > to) return false;
        if (
          speaker !== null &&
          l.spk.toLowerCase() !== speaker &&
          l.speaker.toLowerCase() !== speaker
        )
          return false;
        return true;
      });
      const rendered = (l: Line) =>
        format === "txt"
          ? `${formatWall(l.w0, tz)} ${l.speaker}: ${l.annotated}`
          : format === "md"
            ? `**${formatWall(l.w0, tz)} ${l.speaker}:** ${l.annotated}`
            : renderLine(l, { tz });
      if (limitTokens !== undefined) {
        // The newest lines that fit.
        let used = 0;
        let start = lines.length;
        while (start > 0) {
          const t = estimateTokens(rendered(lines[start - 1] as Line)) + 1;
          if (used + t > limitTokens) break;
          used += t;
          start--;
        }
        lines = lines.slice(start);
      }
      if (format === "export") {
        return new Response(`${renderTranscriptSection(lines, tz)}\n`, {
          headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const zone = `Times are local, ${formatZone(tz, v.parts()[0]?.wallStart ?? c.app.now())}.`;
      if (format !== "json") {
        const title = v.call?.title ?? "";
        const head = format === "md" ? [`# ${title}`, "", zone, ""] : [`${title}`, zone, ""];
        const body = format === "md" ? lines.map((l) => `${rendered(l)}\n`) : lines.map(rendered);
        return new Response(`${[...head, ...body].join("\n")}\n`, {
          headers: {
            "content-type": `${format === "md" ? "text/markdown" : "text/plain"}; charset=utf-8`,
            "cache-control": "no-store",
          },
        });
      }
      // The line still being spoken, for a reader following the live call (DESIGN 5.5): never in the
      // log, marked as a draft, and only while it is fresh.
      const provisional = v.live
        ? v.provisional.current(c.app.now()).map((p) => {
            const spk = p.ch === "mic" ? "you" : p.spk;
            return {
              ch: p.ch,
              part: p.part,
              time: formatWall(p.w0, tz),
              w0: p.w0,
              speaker: spk ? v.speakerLabel(spk) : "Call",
              text: p.text,
              draft: true,
            };
          })
        : [];
      return json(200, {
        call: call.id,
        state: v.state,
        live: v.live,
        layer,
        tz,
        zone,
        cursor: v.lastSeq,
        provisional,
        lines: lines.map((l) => ({
          id: l.id,
          seq: l.seq,
          time: formatWall(l.w0, tz),
          w0: l.w0,
          w1: l.w1,
          part: l.part,
          ch: l.ch,
          spk: l.spk,
          speaker: l.speaker,
          text: l.text,
          // With a correction: the raw line, and the line as packs and exports show it,
          // `Hetzner (heard: "hetzna")`.
          ...(l.heard !== undefined ? { heard: l.heard, annotated: l.annotated } : {}),
          layer: l.layer,
        })),
      });
    },
  );
}
