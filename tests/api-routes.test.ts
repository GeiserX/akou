/**
 * Routes against a fake app, for the orderings a real app cannot be made to hit on cue: an event
 * that lands between a long poll's first read and its wait, an SSE reconnect, and a request that
 * arrives while recovery is still indexing the calls.
 */

import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { type ApiApp, buildRouter, startApiServer } from "../src/main/api/server.ts";

const EV = (seq: number) => ({ seq, t: seq, type: "note" }) as unknown as LogEvent;

/** A fake app holding one call, `c1`, whose log is `log`; `onRead` runs after each read. */
function fakeApp(log: LogEvent[], onRead: (read: number) => void = () => {}) {
  const listeners = new Set<(e: LogEvent) => void>();
  let reads = 0;
  const app = {
    manager: {
      init: async () => [],
      resolve: (ref: string) => ({ ok: true, id: ref }),
    },
    now: () => 0,
    levels: () => null,
    call: async () => ({ view: { call: { tz: "UTC" }, provisional: { current: () => [] } } }),
    events: async (_id: string, after: number) => {
      const out = log.filter((e) => e.seq > after);
      onRead(++reads);
      return out;
    },
    subscribe: (_id: string, fn: (e: LogEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const append = (e: LogEvent) => {
    log.push(e);
    for (const f of listeners) f(e);
  };
  return { app: app as unknown as ApiApp, append };
}

function route(app: ApiApp, path: string, init: RequestInit = {}) {
  const url = new URL(`http://127.0.0.1/v1${path}`);
  const m = buildRouter().match("GET", url.pathname.slice(3));
  if ("status" in m) throw new Error(`no route ${path}`);
  const req = new Request(url.href, init);
  return m.handler({ req, url, params: m.params, app, by: "agent:test" });
}

describe("following a call", () => {
  test("a long poll sees an event appended between its first read and its wait", async () => {
    const f = fakeApp([EV(1)], (read) => {
      // The read found nothing past the cursor; the event lands before the wait begins.
      if (read === 1) f.append(EV(2));
    });
    const t0 = performance.now();
    const res = await route(f.app, "/calls/c1/events?after=1&wait=3");
    const body = (await res.json()) as { events: LogEvent[] };
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(body.events.map((e: LogEvent) => e.seq)).toEqual([2]);
  });

  test("a long poll whose client is already gone answers at once", async () => {
    const f = fakeApp([EV(1)]);
    const t0 = performance.now();
    const res = await route(f.app, "/calls/c1/events?after=1&wait=3", {
      signal: AbortSignal.abort(),
    });
    expect(res.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  test("a stream reconnecting with Last-Event-ID resumes after it, not from ?after", async () => {
    const f = fakeApp([EV(1), EV(2), EV(3)]);
    const ctl = new AbortController();
    const res = await route(f.app, "/calls/c1/stream?after=0", {
      headers: { "last-event-id": "2" },
      signal: ctl.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let text = "";
    while (!/^id: \d+$/m.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    ctl.abort();
    await reader.cancel();
    expect(/^id: (\d+)$/m.exec(text)?.[1]).toBe("3");
  });

  test("a Last-Event-ID that is not a sequence number is ignored", async () => {
    const f = fakeApp([EV(1), EV(2)]);
    const ctl = new AbortController();
    const res = await route(f.app, "/calls/c1/stream?after=1", {
      headers: { "last-event-id": "x" },
      signal: ctl.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let text = "";
    while (!/^id: \d+$/m.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    ctl.abort();
    await reader.cancel();
    expect(/^id: (\d+)$/m.exec(text)?.[1]).toBe("2");
  });
});

describe("a request during recovery", () => {
  test("approving a call's proposals waits for the calls to be indexed", async () => {
    let indexed = false;
    const app = {
      manager: {
        init: () =>
          new Promise<void>((r) =>
            setTimeout(() => {
              indexed = true;
              r();
            }, 50),
          ),
        resolve: (ref: string) =>
          indexed
            ? { ok: true, id: ref }
            : { ok: false, status: 404, code: "not_found", error: `no call ${ref}` },
      },
      // Reached only once the id resolved.
      call: async () => {
        throw new Error("resolved");
      },
    } as unknown as ApiApp;
    const server = startApiServer({ app, port: 0, token: () => "t".repeat(64) });
    try {
      const res = await fetch(`${server.url}/vocab/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${"t".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify({ terms: ["Hetzner"], call: "01JCALL" }),
      });
      const body = (await res.json()) as { message: string };
      // Not 404: the call was found, and the fake stops the request there with a 500.
      expect([res.status, body.message]).toEqual([500, "resolved"]);
    } finally {
      await server.stop();
    }
  });
});
