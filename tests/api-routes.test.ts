/**
 * Routes against a fake app, for the orderings a real app cannot be made to hit on cue: an event
 * that lands between a long poll's first read and its wait, an SSE reconnect, and a request that
 * arrives while recovery is still indexing the calls.
 */

import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { type ApiApp, buildRouter, startApiServer } from "../src/main/api/server.ts";
import type { ApiClient, RequestOptions } from "../src/main/cli/client.ts";
import { handoffCommands } from "../src/main/cli/commands/handoff.ts";
import { reviewText, vocab } from "../src/main/cli/commands/vocab.ts";
import type { Ctx } from "../src/main/cli/context.ts";

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

/** A call of 200 `seg` events with 3 `health` among them (seqs 10, 100, 150), ending on a seg. */
function noisyLog(): LogEvent[] {
  const HEALTH = new Set([10, 100, 150]);
  return Array.from(
    { length: 203 },
    (_, i) => ({ seq: i + 1, t: i + 1, type: HEALTH.has(i + 1) ? "health" : "seg" }) as LogEvent,
  );
}

/** Reads a stream until `done(text)` or `ms` pass, then closes it. */
async function readStream(res: Response, done: (text: string) => boolean, ms = 3000) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let text = "";
  const until = performance.now() + ms;
  while (!done(text) && performance.now() < until) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(0, until - performance.now())).then(() => null),
    ]);
    if (next === null || next.done) break;
    text += dec.decode(next.value, { stream: true });
  }
  await reader.cancel();
  return text;
}

/** The SSE records of a stream's text: each with its id, event name and data. */
function records(text: string): { id?: string; event?: string; data?: string }[] {
  return text
    .split("\n\n")
    .filter((r) => r.trim() !== "" && !r.startsWith(":") && !r.startsWith("retry:"))
    .map((r) => {
      const out: { id?: string; event?: string; data?: string } = {};
      for (const line of r.split("\n")) {
        const at = line.indexOf(": ");
        if (at > 0) out[line.slice(0, at) as "id" | "event" | "data"] = line.slice(at + 2);
      }
      return out;
    });
}

describe("[PG-S2] the event stream filtered by type on the server", () => {
  test("types=health over 200 seg and 3 health events delivers exactly the 3; the cursor moves past the rest", async () => {
    const f = fakeApp(noisyLog());
    const ctl = new AbortController();
    const res = await route(f.app, "/calls/c1/stream?after=0&types=health", {
      signal: ctl.signal,
    });
    const text = await readStream(res, (t) => /^id: 203$/m.test(t));
    ctl.abort();
    const recs = records(text);
    const delivered = recs.filter((r) => r.event === "event");
    expect(delivered.map((r) => JSON.parse(r.data as string).seq)).toEqual([10, 100, 150]);
    expect(delivered.every((r) => JSON.parse(r.data as string).type === "health")).toBe(true);
    // The skipped events come as their id alone, which moves Last-Event-ID and delivers nothing:
    // the last id is the last event, so a reconnect from it replays none of the 200.
    expect(recs.at(-1)).toEqual({ id: "203" });
    expect(recs.filter((r) => r.event === undefined && r.data !== undefined)).toEqual([]);

    // A reconnect from that id gets nothing more.
    const ctl2 = new AbortController();
    const again = await route(f.app, "/calls/c1/stream?after=0&types=health", {
      headers: { "last-event-id": "203" },
      signal: ctl2.signal,
    });
    const rest = await readStream(again, () => false, 400);
    ctl2.abort();
    expect(records(rest)).toEqual([]);

    // Positive control: without the filter every one of the 203 is delivered.
    const ctl3 = new AbortController();
    const all = await route(f.app, "/calls/c1/stream?after=0", { signal: ctl3.signal });
    const allText = await readStream(all, (t) => /^id: 203$/m.test(t));
    ctl3.abort();
    expect(records(allText).filter((r) => r.event === "event").length).toBe(203);
  });

  test("ephemeral=none drops the levels; without it they come", async () => {
    const f = fakeApp([EV(1)]);
    // A live call with levels, and a view the follower's `read` can ask, so the stream stays open.
    Object.assign(f.app, {
      levels: () => ({ mic: -20, call: -30, at: 0 }),
      call: async () => ({
        view: {
          call: { tz: "UTC" },
          provisional: { current: () => [] },
          lines: () => [],
          changesSince: () => ({ cursor: 0, all: false, ids: [] }),
        },
      }),
    });
    const level = (t: string) => /^event: level$/m.test(t);
    const ctl = new AbortController();
    const on = await route(f.app, "/calls/c1/stream?after=0", { signal: ctl.signal });
    expect(level(await readStream(on, level, 2000))).toBe(true);
    ctl.abort();
    const ctl2 = new AbortController();
    const off = await route(f.app, "/calls/c1/stream?after=0&ephemeral=none", {
      signal: ctl2.signal,
    });
    const text = await readStream(off, level, 800);
    ctl2.abort();
    expect(level(text)).toBe(false);
    expect(/^id: 1$/m.test(text)).toBe(true);
  });

  test("the long poll keeps the types asked for, moves its cursor past the rest, and waits for a kept one", async () => {
    const f = fakeApp(noisyLog());
    const res = await route(f.app, "/calls/c1/events?after=0&types=health");
    const body = (await res.json()) as { events: LogEvent[]; cursor: number };
    expect(body.events.map((e) => e.seq)).toEqual([10, 100, 150]);
    expect(body.cursor).toBe(203);

    // A seg arrives during the wait and is passed over; the health after it ends the wait.
    setTimeout(() => f.append({ seq: 204, t: 204, type: "seg" } as LogEvent), 100);
    setTimeout(() => f.append({ seq: 205, t: 205, type: "health" } as LogEvent), 300);
    const t0 = performance.now();
    const waited = await route(f.app, "/calls/c1/events?after=203&wait=5&types=health");
    const wb = (await waited.json()) as { events: LogEvent[]; cursor: number };
    expect(wb.events.map((e) => e.seq)).toEqual([205]);
    expect(wb.cursor).toBe(205);
    expect(performance.now() - t0).toBeLessThan(3000);

    // Only skipped events until the wait ends: none kept, and the cursor past them.
    setTimeout(() => f.append({ seq: 206, t: 206, type: "seg" } as LogEvent), 100);
    const quiet = await route(f.app, "/calls/c1/events?after=205&wait=1&types=health");
    expect(await quiet.json()).toEqual({ call: "c1", events: [], cursor: 206 });
  });

  test("an unknown type is refused, not silently matched by nothing", async () => {
    const f = fakeApp(noisyLog());
    for (const path of ["/calls/c1/events?types=health,helth", "/calls/c1/stream?types=helth"]) {
      try {
        await route(f.app, path);
        throw new Error(`${path} was not refused`);
      } catch (err) {
        expect([(err as { status?: number }).status, (err as { code?: string }).code]).toEqual([
          400,
          "bad_param",
        ]);
      }
    }
  });
});

describe("a request during recovery", () => {
  /** An app whose calls are indexed 50 ms after it starts; a call it finds ends the request. */
  function recovering(): ApiApp {
    let indexed = false;
    return {
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
      configDir: "/nowhere",
      presets: () => [],
      // Reached only once the id resolved.
      call: async () => {
        throw new Error("resolved");
      },
    } as unknown as ApiApp;
  }
  const auth = { authorization: `Bearer ${"t".repeat(64)}` };

  test("approving a call's proposals waits for the calls to be indexed", async () => {
    const server = startApiServer({ app: recovering(), port: 0, token: () => "t".repeat(64) });
    try {
      const res = await fetch(`${server.url}/vocab/approve`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ terms: ["Hetzner"], call: "01JCALL" }),
      });
      const body = (await res.json()) as { message: string };
      // Not 404: the call was found, and the fake stops the request there with a 500.
      expect([res.status, body.message]).toEqual([500, "resolved"]);
    } finally {
      await server.stop();
    }
  });

  test("[PG-F2] the presets filled in for a call wait for the calls to be indexed", async () => {
    const server = startApiServer({ app: recovering(), port: 0, token: () => "t".repeat(64) });
    try {
      const res = await fetch(`${server.url}/presets?call=01JCALL`, { headers: auth });
      const body = (await res.json()) as { message: string };
      // Not 404: the call was found, and the fake stops the request there with a 500.
      expect([res.status, body.message]).toEqual([500, "resolved"]);
    } finally {
      await server.stop();
    }
  });
});

describe("POST /calls checks the call scope at the door", () => {
  test("a scope the helper would refuse is a 422 on field call, and nothing starts", async () => {
    const asked: (string | undefined)[] = [];
    const app = {
      manager: { init: async () => [] },
      start: async (req: { call?: string }) => {
        asked.push(req.call);
        return { ok: true, call: "c1", folder: "/f", part: 1, startMs: 5 };
      },
    } as unknown as ApiApp;
    const token = "t".repeat(64);
    const server = startApiServer({ app, port: 0, token: () => token });
    const post = async (body: object) => {
      const res = await fetch(`${server.url}/calls`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const b = (await res.json()) as { error?: string; field?: string; message?: string };
      return [res.status, b.error, b.field, b.message];
    };
    try {
      expect(await post({ call: "zoom" })).toEqual([
        422,
        "bad_field",
        "call",
        'call must be system, none or app:<id>[,<id>], not "zoom"',
      ]);
      expect(await post({ call: "" })).toEqual([
        422,
        "bad_field",
        "call",
        'call must be system, none or app:<id>[,<id>], not ""',
      ]);
      expect(await post({ call: "app:" })).toEqual([
        422,
        "bad_field",
        "call",
        "call app: needs at least one id, as in app:us.zoom.xos",
      ]);
      expect(asked).toEqual([]);
      // Positive control: every shape the helper takes reaches the start unchanged.
      for (const call of ["system", "none", "app:us.zoom.xos,com.microsoft.teams2"]) {
        expect((await post({ call }))[0]).toBe(201);
      }
      expect((await post({}))[0]).toBe(201);
      expect(asked).toEqual(["system", "none", "app:us.zoom.xos,com.microsoft.teams2", undefined]);
    } finally {
      await server.stop();
    }
  });
});

describe("an export queued behind the call's hand-off work", () => {
  test("the route lifts the server's idle timeout before it waits", async () => {
    const seen: string[] = [];
    const app = {
      manager: { resolve: (ref: string) => ({ ok: true, id: ref }) },
      exportCall: async () => {
        seen.push("export");
        return { ok: true, path: "/x.md", written: false, draft: null };
      },
    } as unknown as ApiApp;
    const url = new URL("http://127.0.0.1/v1/calls/c1/export");
    const m = buildRouter().match("POST", "/calls/c1/export");
    if ("status" in m) throw new Error("no export route");
    const req = new Request(url.href, { method: "POST", body: "{}" });
    const res = await m.handler({
      req,
      url,
      params: m.params,
      app,
      by: "agent:test",
      timeout: (seconds) => seen.push(`timeout ${seconds}`),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["timeout 0", "export"]);
  });

  test("`akou export` waits as long as `akou hooks run`, and Ctrl-C still stops it", async () => {
    const asked: Record<string, RequestOptions | undefined> = {};
    const ac = new AbortController();
    const client = {
      request: async (_method: string, path: string, o?: RequestOptions) => {
        asked[path.split("/").at(-1) as string] = o;
        return { status: 200, body: { path: "/x.md", attachments: "/a", runs: [] }, text: "" };
      },
    } as unknown as ApiClient;
    const ctx: Ctx = {
      io: { env: {}, out: () => {}, err: () => {}, signal: ac.signal },
      json: false,
      client,
      version: "0.0.0",
    };
    const cmd = (name: string) =>
      handoffCommands.find((c) => c.name === name) as (typeof handoffCommands)[number];
    await cmd("export").run(ctx, { positional: ["c1"], flags: {} });
    await cmd("hooks").run(ctx, { positional: ["run", "c1"], flags: {} });
    expect(asked.export?.signal).toBe(ac.signal);
    expect(asked.export?.timeoutMs).toBeGreaterThanOrEqual(asked.hooks?.timeoutMs as number);
    // Positive control: the client's default is a minute, shorter than one hook may run.
    expect(asked.hooks?.timeoutMs).toBeGreaterThan(60_000);
  });
});

describe("the vocabulary pass from the CLI", () => {
  test("`akou vocab pass` waits as long as `akou enhance`, and Ctrl-C still stops it", async () => {
    let asked: RequestOptions | undefined;
    const ac = new AbortController();
    const client = {
      request: async (_method: string, _path: string, o?: RequestOptions) => {
        asked = o;
        return { status: 200, body: { corrections: [], proposals: [] }, text: "" };
      },
    } as unknown as ApiClient;
    const ctx: Ctx = {
      io: { env: {}, out: () => {}, err: () => {}, signal: ac.signal },
      json: true,
      client,
      version: "0.0.0",
    };
    await vocab.run(ctx, { positional: ["pass", "c1"], flags: {} });
    expect(asked?.signal).toBe(ac.signal);
    // The pass runs one provider call per batch, one after another: the client's one-minute
    // default gives up while the server is still working.
    expect(asked?.timeoutMs).toBeGreaterThanOrEqual(60 * 60_000);
  });

  test("the words to review say how to reject a proposal of that call, not a bare `reject`", () => {
    const text = reviewText({
      proposals: [{ term: "Hetzner", heard: ["hetzner"], lines: [] }],
      unconfirmed: [],
    });
    // Without a term the CLI refuses; without --call the proposal stays open in the call.
    expect(text).toContain("`akou vocab reject TERM --call ID`");
    expect(text).toContain("`akou vocab approve TERM --call ID`");
  });
});
