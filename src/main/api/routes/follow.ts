/**
 * Following a call (docs/DESIGN.md sections 5.5 and 6.2):
 *
 * - `GET /calls/{id}/events?after=SEQ&wait=25`: the raw log after a cursor, long-polled.
 * - `GET /calls/{id}/stream?after=SEQ`: Server-Sent Events. Every log event after the cursor, in
 *   `seq` order and each exactly once (the backlog from disk, then live events), plus the
 *   ephemeral `partial` (the provisional line, never in the log) and `level` events.
 * - `GET /calls/{id}/transcript`: the rendered transcript, names and vocabulary applied, local
 *   wall-clock times only.
 */

import { formatWall, formatZone } from "../../../core/log/clock.ts";
import type { LogEvent } from "../../../core/log/events.ts";
import type { Line, View } from "../../../core/log/fold.ts";
import { estimateTokens, renderLine } from "../../query/render.ts";
import { enumParam, HttpError, intParam, json, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { callId, callOf } from "./common.ts";

/** Longest a long poll waits, seconds. */
export const MAX_WAIT_SECONDS = 30;
/** How often a stream looks at the provisional line and the levels, ms. */
export const STREAM_TICK_MS = 250;
export const KEEPALIVE_MS = 15_000;

/** Resolves on the first event past `after`, at the deadline, or when the client goes away. */
function waitForEvent(
  app: ApiApp,
  id: string,
  after: number,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const unsubscribe = app.subscribe(id, (e) => {
      if (e.seq > after) finish();
    });
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}

/** Parses a time bound: epoch ms, or an ISO 8601 date-time with its zone. */
function timeParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
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

export function followRoutes(r: Router<ApiApp>): void {
  r.add("GET", "/calls/:id/events", async (c) => {
    const id = callId(c);
    const after = intParam(c.url, "after", 0, 0, Number.MAX_SAFE_INTEGER) as number;
    const wait = intParam(c.url, "wait", 0, 0, MAX_WAIT_SECONDS) as number;
    let events = await c.app.events(id, after);
    if (events.length === 0 && wait > 0) {
      await waitForEvent(c.app, id, after, wait * 1000, c.req.signal);
      events = await c.app.events(id, after);
    }
    return json(200, { call: id, events, cursor: events.at(-1)?.seq ?? after });
  });

  r.add("GET", "/calls/:id/stream", async (c) => {
    const id = callId(c);
    const after = intParam(c.url, "after", 0, 0, Number.MAX_SAFE_INTEGER) as number;
    const call = await c.app.call(id);
    const app = c.app;
    const enc = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: async (ctl) => {
        let closed = false;
        const send = (text: string) => {
          if (closed) return;
          try {
            ctl.enqueue(enc.encode(text));
          } catch {
            stop();
          }
        };
        const sendEvent = (e: LogEvent) => {
          if (e.seq <= sent) return;
          sent = e.seq;
          send(`id: ${e.seq}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`);
        };
        let sent = after;
        // Subscribe first and hold live events until the backlog is out, so none is lost or doubled.
        let held: LogEvent[] | null = [];
        const unsubscribe = app.subscribe(id, (e) => {
          if (held) held.push(e);
          else sendEvent(e);
        });
        let lastPartial = "";
        let lastLevel = "";
        const tick = setInterval(() => {
          const now = app.now();
          const p = call.view.provisional.current(now);
          const partial = JSON.stringify(
            p.map((x) => ({
              ch: x.ch,
              part: x.part,
              text: x.text,
              w0: x.w0,
              time: formatWall(x.w0, call.view.call?.tz ?? "UTC"),
              draft: true,
            })),
          );
          if (partial !== lastPartial) {
            lastPartial = partial;
            send(`event: partial\ndata: ${partial}\n\n`);
          }
          const lv = app.levels(id);
          if (lv) {
            const level = JSON.stringify({ mic: lv.mic, call: lv.call });
            if (level !== lastLevel) {
              lastLevel = level;
              send(`event: level\ndata: ${level}\n\n`);
            }
          }
        }, STREAM_TICK_MS);
        const keepalive = setInterval(() => send(": keep-alive\n\n"), KEEPALIVE_MS);
        const stop = () => {
          if (closed) return;
          closed = true;
          clearInterval(tick);
          clearInterval(keepalive);
          unsubscribe();
          c.req.signal.removeEventListener("abort", stop);
          try {
            ctl.close();
          } catch {}
        };
        cleanup = stop;
        c.req.signal.addEventListener("abort", stop);
        send(`retry: 1000\n\n`);
        for (const e of await app.events(id, after)) sendEvent(e);
        const pending = held;
        held = null;
        for (const e of pending) sendEvent(e);
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
  });

  r.add("GET", "/calls/:id/transcript", async (c) => {
    const call = await callOf(c);
    const v = call.view;
    const tz = v.call?.tz ?? "UTC";
    const layer = enumParam<View>(c.url, "layer", ["best", "live", "final"], "best");
    const format = enumParam(c.url, "format", ["json", "md", "txt"] as const, "json");
    const since = intParam(c.url, "since", 0, 0, Number.MAX_SAFE_INTEGER) as number;
    const limitTokens = intParam(c.url, "limitTokens", undefined, 1, 1_000_000);
    const from = timeParam(c.url, "from");
    const to = timeParam(c.url, "to");
    const speaker = c.url.searchParams.get("speaker")?.toLowerCase() ?? null;
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
    return json(200, {
      call: call.id,
      layer,
      tz,
      zone,
      cursor: v.lastSeq,
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
        ...(l.heard !== undefined ? { heard: l.heard } : {}),
        layer: l.layer,
      })),
    });
  });
}
