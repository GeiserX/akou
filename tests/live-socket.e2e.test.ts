/**
 * The live door through a whole server (`GET /v1/live`, docs/server.md "A phone or another live
 * client"): a key opens a WebSocket, streams audio, and gets the streaming model's words back with
 * times on the recording's timeline. The server runs the fake recognizer and the fake streaming
 * engine (tests/fixtures/asr-fake.ts); the audio is the fake "hello world" clip, as raw 16-bit
 * samples (`pcm16`) or as the Ogg Opus pages a phone sends (`ogg-opus`,
 * fixtures/live-hello-world.opus). Every refusal has its positive control: the same session where
 * the rule does not apply.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyStore } from "../src/main/api/keys.ts";
import type { ModelSpecEntry } from "../src/main/asr/models.ts";
import { NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { oggCrc, oggPages } from "../src/main/server/ogg.ts";
import { type AppRig, appRig, FAKE_MODELS, rawRequest } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";
import { newKey, SERVER } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const MULTI = "nemotron-3.5-560";
const ENGLISH = "nemotron-en-560";
const PAGES = oggPages(
  new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", "live-hello-world.opus"))),
);
/** The clip the Opus fixture was made from: "hello" at 0.40 s, "world" at 0.77 s. */
const CLIP = concat(silence(0.4), speak(["hello", "world"]), silence(1.6));

const cleanups: (() => void | Promise<void>)[] = [];
let rig: AppRig;

/** A server in server mode with the fake recognizer, and both streaming models on disk. */
async function serverRig(o: {
  streams: boolean;
  /** The fake models' options; with them, the recognizer runs on its own Worker, as in the app. */
  options?: Record<string, unknown>;
}): Promise<{ rig: AppRig; models: string }> {
  const home = tempDir("akou-live-e2e-");
  cleanups.push(home.cleanup);
  const reg = modelRegistry();
  cleanups.push(() => reg.stop());
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    { ...reg.entry(MULTI, ["m.onnx"]), onDemand: true } as ModelSpecEntry,
    { ...reg.entry(ENGLISH, ["e.onnx"]), onDemand: true } as ModelSpecEntry,
  ];
  const dir = join(home.dir, "models");
  mkdirSync(dir, { recursive: true });
  for (const m of catalog.slice(0, o.streams ? 5 : 3)) reg.install(dir, m);
  const r = await appRig({
    modelRegistry: catalog,
    models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: o.options ?? {} },
    ...(o.options ? { asrInThread: false } : {}),
    settings: { ...SERVER, "asr.modelsDir": dir },
  });
  cleanups.push(() => r.close());
  return { rig: r, models: dir };
}

beforeAll(async () => {
  ({ rig } = await serverRig({ streams: true }));
});

afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Session {
  ws: WebSocket;
  // biome-ignore lint/suspicious/noExplicitAny: messages are inspected field by field.
  msgs: any[];
  closed: Promise<{ code: number; reason: string }>;
  /** Resolves with the first message of this type, or fails the test after `ms`. */
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  next(type: string, ms?: number): Promise<any>;
}

/** Opens a socket as `key` and resolves once it is open. */
async function open(r: AppRig, key: string): Promise<Session> {
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}/v1/live`, {
    headers: { authorization: `Bearer ${key}` },
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  const msgs: any[] = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket did not open"));
  });
  const next = async (type: string, ms = 10_000) => {
    await until(() => msgs.some((m) => m.type === type), ms, `a ${type} message`);
    return msgs.find((m) => m.type === type);
  };
  return { ws, msgs, closed, next };
}

const hello = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "hello", v: 1, codec: "pcm16", language: "auto", model: "auto", ...o });

/** 16 kHz float samples as pcm16 frames of 200 ms. */
function pcm16Frames(x: Float32Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < x.length; at += 3200) {
    const part = x.subarray(at, at + 3200);
    const b = new Uint8Array(part.length * 2);
    const v = new DataView(b.buffer);
    part.forEach((s, i) => {
      v.setInt16(i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
    });
    out.push(b);
  }
  return out;
}

/** The words a session got, in order, with their times. */
const tokens = (s: Session): { text: string; t: number }[] =>
  s.msgs.filter((m) => m.type === "words").flatMap((m) => m.tokens);

/** Streams frames, then `stop`, and waits for the close. */
async function streamAndStop(s: Session, frames: Uint8Array[]) {
  for (const f of frames) s.ws.send(f);
  s.ws.send(JSON.stringify({ type: "stop" }));
  return s.closed;
}

describe("GET /v1/live: the guard runs before the upgrade", () => {
  const upgrade = {
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };

  test("no key, a wrong key or a revoked key is a 401 answer, never a socket", async () => {
    const k = await newKey(rig, "live-guard");
    // Positive control: with the key valid, the socket opens.
    const ok = await open(rig, k.key);
    ok.ws.close();
    new KeyStore(rig.app.configDir).revoke(k.id);
    const tries: Record<string, string>[] = [
      {},
      { authorization: "Bearer ak_nothing" },
      { authorization: `Bearer ${k.key}` },
    ];
    for (const auth of tries) {
      const r = await rawRequest(rig.port, {
        method: "GET",
        path: "/v1/live",
        headers: { ...upgrade, ...auth },
      });
      expect(r.status).toBe(401);
      expect(JSON.parse(r.body).error).toBe("unauthorized");
    }
  });

  test("a key without Upgrade gets 426 upgrade_required", async () => {
    const k = await newKey(rig, "live-plain");
    const r = await rawRequest(rig.port, {
      method: "GET",
      path: "/v1/live",
      headers: { authorization: `Bearer ${k.key}` },
    });
    expect(r.status).toBe(426);
    expect(JSON.parse(r.body).error).toBe("upgrade_required");
  });
});

describe("GET /v1/live: words while the client records", () => {
  test("pcm16: ready, then hello world at their times, then closed and a 1000 close", async () => {
    const k = await newKey(rig, "live-pcm");
    const s = await open(rig, k.key);
    s.ws.send(hello());
    const ready = await s.next("ready");
    expect(ready).toMatchObject({ type: "ready", engine: MULTI, lang: "auto", tier_ms: 560 });
    expect(typeof ready.load_ms).toBe("number");
    const closed = await streamAndStop(s, pcm16Frames(CLIP));
    expect(closed.code).toBe(1000);
    expect(s.msgs.at(-1)).toEqual({ type: "closed" });
    const got = tokens(s);
    expect(got.map((t) => t.text).join("")).toBe(" hello world");
    expect(got[0]?.t).toBeCloseTo(0.4, 1);
    expect(got[1]?.t).toBeCloseTo(0.77, 1);
  });

  test("ogg-opus: the pages a phone sends give the same words, at the recording's times", async () => {
    const k = await newKey(rig, "live-opus");
    const s = await open(rig, k.key);
    s.ws.send(hello({ codec: "ogg-opus" }));
    await s.next("ready");
    expect((await streamAndStop(s, PAGES)).code).toBe(1000);
    const got = tokens(s);
    expect(got.map((t) => t.text).join("")).toBe(" hello world");
    expect(Math.abs((got[0]?.t ?? 0) - 0.4)).toBeLessThan(0.05);
    expect(Math.abs((got[1]?.t ?? 0) - 0.77)).toBeLessThan(0.05);
  });

  test("a reconnect that starts mid-file gets its words on the file's timeline, not its own", async () => {
    const k = await newKey(rig, "live-reconnect");
    const s = await open(rig, k.key);
    s.ws.send(hello({ codec: "ogg-opus" }));
    await s.next("ready");
    // OpusHead, OpusTags, then from page 5 on (0.59 s into the file): "world" is 0.18 s into the
    // session and 0.77 s into the recording, which is what the words say.
    expect((await streamAndStop(s, [...PAGES.slice(0, 2), ...PAGES.slice(5)])).code).toBe(1000);
    const world = tokens(s).find((t) => t.text === " world");
    expect(world).toBeDefined();
    expect(Math.abs((world?.t ?? 0) - 0.77)).toBeLessThan(0.05);
  });

  test("a corrupted page closes the socket 4400 bad_page; the same pages unbroken do not", async () => {
    const k = await newKey(rig, "live-bad");
    const s = await open(rig, k.key);
    s.ws.send(hello({ codec: "ogg-opus" }));
    await s.next("ready");
    const bad = (PAGES[3] as Uint8Array).slice();
    bad[40] = (bad[40] as number) ^ 0xff;
    for (const p of [...PAGES.slice(0, 3), bad]) s.ws.send(p);
    expect((await s.closed).code).toBe(4400);
    expect(await s.next("error")).toMatchObject({ code: "bad_page" });
    // Positive control: the CRC made right again, the page goes through.
    const fixed = bad.slice();
    new DataView(fixed.buffer).setUint32(22, oggCrc(fixed), true);
    const t = await open(rig, k.key);
    t.ws.send(hello({ codec: "ogg-opus" }));
    await t.next("ready");
    for (const p of [...PAGES.slice(0, 3), fixed]) t.ws.send(p);
    t.ws.send(JSON.stringify({ type: "stop" }));
    expect((await t.closed).code).toBe(1000);
  });

  test("audio before hello, and a hello for another protocol version, close 4400", async () => {
    const k = await newKey(rig, "live-order");
    const a = await open(rig, k.key);
    a.ws.send(PAGES[0] as Uint8Array);
    expect((await a.closed).code).toBe(4400);
    expect(await a.next("error")).toMatchObject({ code: "bad_message" });
    const b = await open(rig, k.key);
    b.ws.send(hello({ v: 2 }));
    expect((await b.closed).code).toBe(4400);
  });
});

describe("GET /v1/live: one streaming engine at a time, and keys that go away", () => {
  test("[4409] a second session on another engine is refused before its stream opens", async () => {
    const k = await newKey(rig, "live-busy");
    const first = await open(rig, k.key);
    first.ws.send(hello({ language: "en" }));
    expect(await first.next("ready")).toMatchObject({ engine: ENGLISH });
    // `auto` with no language resolves to the multilingual model: another engine.
    const other = await open(rig, k.key);
    other.ws.send(hello());
    expect((await other.closed).code).toBe(4409);
    expect(await other.next("error")).toMatchObject({ code: "engine_busy" });
    // Positive control: a session that resolves to the open engine runs beside it.
    const same = await open(rig, k.key);
    same.ws.send(hello({ model: ENGLISH }));
    expect(await same.next("ready")).toMatchObject({ engine: ENGLISH });
    // The first session still works: its engine was never replaced.
    expect((await streamAndStop(first, pcm16Frames(CLIP))).code).toBe(1000);
    expect(
      tokens(first)
        .map((t) => t.text)
        .join(""),
    ).toBe(" hello world");
    same.ws.send(JSON.stringify({ type: "stop" }));
    await same.closed;
    // With both gone, the other engine opens.
    const after = await open(rig, k.key);
    after.ws.send(hello());
    expect(await after.next("ready")).toMatchObject({ engine: MULTI });
    after.ws.close();
  });

  test("[4401] a key revoked mid-session closes the socket at its next message", async () => {
    const store = new KeyStore(rig.app.configDir);
    const k = await newKey(rig, "live-revoke");
    const s = await open(rig, k.key);
    s.ws.send(hello());
    await s.next("ready");
    const frames = pcm16Frames(CLIP);
    s.ws.send(frames[0] as Uint8Array);
    store.revoke(k.id);
    // The check runs at most once a second; the session keeps no key, only its id.
    await Bun.sleep(1100);
    s.ws.send(frames[1] as Uint8Array);
    expect((await s.closed).code).toBe(4401);
    expect(await s.next("error")).toMatchObject({ code: "key_revoked" });
  });
});

describe("GET /v1/live: a quiet revoked key, and a client faster than the engine", () => {
  test("[4401] a key revoked while its client sends nothing is closed within about two seconds", async () => {
    const k = await newKey(rig, "live-quiet");
    const s = await open(rig, k.key);
    s.ws.send(hello());
    await s.next("ready");
    const t0 = performance.now();
    new KeyStore(rig.app.configDir).revoke(k.id);
    expect((await s.closed).code).toBe(4401);
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(await s.next("error")).toMatchObject({ code: "key_revoked" });
    // Positive control: a quiet session whose key stays open for the same time.
    const k2 = await newKey(rig, "live-quiet-kept");
    const t = await open(rig, k2.key);
    t.ws.send(hello());
    await t.next("ready");
    await Bun.sleep(2500);
    expect(t.ws.readyState).toBe(WebSocket.OPEN);
    t.ws.send(JSON.stringify({ type: "stop" }));
    expect((await t.closed).code).toBe(1000);
  });

  test("[too_fast] audio sent far ahead of a slow engine closes 4400; 20 s ahead does not", async () => {
    // Each 200 ms frame takes the engine 20 ms, on its own Worker: a minute sent at once is
    // decoded in about 6 s, so most of it waits in flight.
    const slow = await serverRig({ streams: true, options: { livePushMs: 20 } });
    const k = await newKey(slow.rig, "live-fast");
    const s = await open(slow.rig, k.key);
    s.ws.send(hello());
    await s.next("ready");
    for (const f of pcm16Frames(silence(60))) s.ws.send(f);
    expect((await s.closed).code).toBe(4400);
    expect(await s.next("error")).toMatchObject({ code: "too_fast" });
    // Positive control: 20 s at once stays under the 30 s bound and ends well.
    const t = await open(slow.rig, k.key);
    t.ws.send(hello());
    await t.next("ready");
    expect((await streamAndStop(t, pcm16Frames(concat(CLIP, silence(17))))).code).toBe(1000);
    expect(t.msgs.some((m) => m.type === "error")).toBe(false);
  });
});

describe("GET /v1/server: whether live words work here", () => {
  test("capabilities.live and the engines on disk; false once no streaming model is", async () => {
    const body = (await rig.api("GET", "/server")).body;
    expect(body.capabilities.live).toBe(true);
    expect(body.live).toEqual({ engines: [ENGLISH, MULTI] });
    const bare = await serverRig({ streams: false });
    const none = (await bare.rig.api("GET", "/server")).body;
    expect(none.capabilities.live).toBe(false);
    expect(none.live).toEqual({ engines: [] });
    // And a hello there says why, with 4503.
    const k = await newKey(bare.rig, "live-none");
    const s = await open(bare.rig, k.key);
    s.ws.send(hello());
    expect((await s.closed).code).toBe(4503);
    expect((await s.next("error")).message).toContain("akou models pull");
  });

  test("the desktop app has no live door: no route, and live is null", async () => {
    const app = await appRig();
    cleanups.push(() => app.close());
    const body = (await app.api("GET", "/server")).body;
    expect(body.live).toBeNull();
    expect(body.capabilities.live).toBe(false);
    expect((await app.api("GET", "/live")).status).toBe(404);
  });
});
