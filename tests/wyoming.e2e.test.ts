/**
 * Home Assistant's Wyoming protocol (docs/ux/SERVER.md SV-C2) against a running akou: `describe`,
 * then an utterance as Home Assistant sends it (`transcribe`, `audio-start`, chunks, `audio-stop`),
 * with the fake recognizer. The client writes as the `wyoming` 1.10.2 package does (`version` in the
 * header, data in the block); the `server` CI job runs that package itself against the image (SV-T4).
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { WyomingServer } from "../src/main/server/wyoming.ts";
import { FrameReader, type WyomingEvent } from "../src/main/server/wyoming-frame.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { SERVER } from "./server-helpers.ts";

// Real jobs run through a finalize Worker; a loaded CI box is slow.
setDefaultTimeout(30_000);

const utf8 = new TextEncoder();

/** One event as the Python writer puts it on the wire (wyoming event.py:112-136). */
function wire(type: string, data: Record<string, unknown> = {}, payload?: Uint8Array): Buffer {
  const block = Object.keys(data).length > 0 ? Buffer.from(JSON.stringify(data), "utf8") : null;
  const header: Record<string, unknown> = { type, version: "1.10.2" };
  if (block) header.data_length = block.byteLength;
  if (payload) header.payload_length = payload.byteLength;
  return Buffer.concat([
    Buffer.from(`${JSON.stringify(header)}\n`, "utf8"),
    ...(block ? [block] : []),
    ...(payload ? [Buffer.from(payload)] : []),
  ]);
}

interface Client {
  socket: Socket;
  events: WyomingEvent[];
  closed: Promise<void>;
  isClosed: () => boolean;
  send(type: string, data?: Record<string, unknown>, payload?: Uint8Array): void;
  next(type: string, ms?: number): Promise<WyomingEvent>;
}

async function client(port: number): Promise<Client> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const reader = new FrameReader();
  const events: WyomingEvent[] = [];
  let closed = false;
  socket.on("data", (b: Buffer) => events.push(...reader.push(new Uint8Array(b))));
  const done = new Promise<void>((resolve) =>
    socket.once("close", () => {
      closed = true;
      resolve();
    }),
  );
  return {
    socket,
    events,
    closed: done,
    isClosed: () => closed,
    send: (type, data = {}, payload) => {
      if (!socket.destroyed) socket.write(wire(type, data, payload));
    },
    next: async (type, ms = 20_000) => {
      await until(() => events.some((e) => e.type === type || e.type === "error"), ms, type);
      const e = events.find((x) => x.type === type || x.type === "error") as WyomingEvent;
      if (e.type === "error" && type !== "error") {
        throw new Error(`error event: ${JSON.stringify(e.data)}`);
      }
      return e;
    },
  };
}

/** 16 kHz float samples as 16-bit PCM chunks of 1024 samples, as `wav_to_chunks(w, 1024)` cuts them. */
function pcmChunks(x: Float32Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < x.length; at += 1024) {
    const part = x.subarray(at, at + 1024);
    const b = new Uint8Array(part.length * 2);
    const v = new DataView(b.buffer);
    part.forEach((s, i) => {
      v.setInt16(i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
    });
    out.push(b);
  }
  return out;
}

const FORMAT = { rate: 16000, width: 2, channels: 1 };

/** An utterance as Home Assistant sends one (wyoming/stt.py): no `name`, timestamps null. */
function utterance(c: Client, samples: Float32Array, language = "en"): void {
  c.send("transcribe", { language });
  c.send("audio-start", { ...FORMAT, timestamp: null });
  for (const chunk of pcmChunks(samples))
    c.send("audio-chunk", { ...FORMAT, timestamp: null }, chunk);
  c.send("audio-stop", { timestamp: null });
}

const HELLO = concat(silence(0.4), speak(["hello", "world"]), silence(0.6));

/** The keys `Info.from_event` requires (wyoming util/dataclasses_json.py:11-34, info.py:63-122). */
function infoProblems(info: Record<string, unknown>): string[] {
  const bad: string[] = [];
  const attribution = (x: unknown, where: string) => {
    const a = x as { name?: unknown; url?: unknown } | undefined;
    if (typeof a?.name !== "string" || typeof a?.url !== "string") bad.push(`${where}.attribution`);
  };
  const asr = info.asr as Record<string, unknown>[] | undefined;
  if (!Array.isArray(asr) || asr.length === 0) return ["asr"];
  asr.forEach((p, i) => {
    const at = `asr[${i}]`;
    if (typeof p.name !== "string") bad.push(`${at}.name`);
    attribution(p.attribution, at);
    if (typeof p.installed !== "boolean") bad.push(`${at}.installed`);
    for (const k of ["description", "version"]) if (!(k in p)) bad.push(`${at}.${k}`);
    for (const k of [
      "supports_transcript_streaming",
      "requires_external_vad",
      "prefers_auto_gain_enabled",
      "prefers_noise_reduction_enabled",
    ]) {
      if (typeof p[k] !== "boolean") bad.push(`${at}.${k}`);
    }
    const models = p.models as Record<string, unknown>[] | undefined;
    if (!Array.isArray(models)) {
      bad.push(`${at}.models`);
      return;
    }
    models.forEach((m, j) => {
      const mt = `${at}.models[${j}]`;
      if (typeof m.name !== "string") bad.push(`${mt}.name`);
      attribution(m.attribution, mt);
      if (typeof m.installed !== "boolean") bad.push(`${mt}.installed`);
      if (!Array.isArray(m.languages)) bad.push(`${mt}.languages`);
    });
  });
  return bad;
}

const uploads = (rig: AppRig): string[] =>
  readdirSync(rig.app.jobs()?.uploadDir as string).filter((f) => f.endsWith(".upload"));
const wyomingJobs = (rig: AppRig) =>
  rig.app.jobs()?.store.list({ key: "wyoming", limit: 100 }) ?? [];

describe("[SV-C2] Wyoming in server mode", () => {
  let rig: AppRig;
  let port: number;

  beforeAll(async () => {
    rig = await appRig({
      settings: {
        ...SERVER,
        "server.wyoming": true,
        "server.wyoming_port": 0,
        "server.max_upload_mb": 1,
      },
    });
    port = rig.app.wyomingPort() as number;
  });
  afterAll(async () => {
    await rig?.close();
  });

  test("[SV-C2] describe answers info with one program and the built presets as models", async () => {
    const c = await client(port);
    c.send("describe");
    const e = await c.next("info");
    const asr = (e.data.asr as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(asr.name).toBe("akou");
    expect(asr.version).toBe(rig.app.version);
    const models = asr.models as { name: string; installed: boolean; languages: string[] }[];
    expect(models.map((m) => m.name)).toEqual(["fast", "best", "fusion", "auto"]);
    expect(asr.requires_external_vad).toBe(true);
    expect(asr.supports_transcript_streaming).toBe(false);
    expect(infoProblems(e.data)).toEqual([]);
    // `installed` is `GET /v1/server`'s `available`, preset by preset.
    const server = await rig.api("GET", "/server");
    const available = Object.fromEntries(
      server.body.presets.map((p: { name: string; available: boolean }) => [p.name, p.available]),
    );
    for (const m of models)
      expect({ [m.name]: m.installed }).toEqual({ [m.name]: available[m.name] });
    expect(asr.installed).toBe(true);
    // `fast` is Parakeet's 25 languages; `best` leads with Qwen, which has Cantonese.
    expect(models[0]?.languages).toContain("de");
    expect(models[0]?.languages).not.toContain("yue");
    expect(models[1]?.languages).toContain("yue");
    expect(models[3]?.languages).toEqual(models[0]?.languages as string[]);
    // The other top-level lists are there, empty, as the Python writer sends them.
    for (const k of ["tts", "handle", "intent", "wake", "mic", "snd"])
      expect(e.data[k]).toEqual([]);
    // The connection stays open after info: the client closes it (Home Assistant does, every 30 s).
    c.send("ping", { text: "still there" });
    expect((await c.next("pong")).data).toEqual({ text: "still there" });
    c.socket.end();
    await c.closed;
  });

  test("[SV-C2] red control: an info missing `installed` or a model's languages fails the same check", async () => {
    const c = await client(port);
    c.send("describe");
    const e = await c.next("info");
    c.socket.destroy();
    const broken = structuredClone(e.data) as { asr: { installed?: boolean; models: object[] }[] };
    delete broken.asr[0]?.installed;
    expect(infoProblems(broken)).toEqual(["asr[0].installed"]);
    const noLanguages = structuredClone(e.data) as {
      asr: { models: { languages?: string[] }[] }[];
    };
    delete noLanguages.asr[0]?.models[1]?.languages;
    expect(infoProblems(noLanguages)).toEqual(["asr[0].models[1].languages"]);
  });

  test("[SV-C2] a 16 kHz chunk stream returns the expected text, then the server closes", async () => {
    const c = await client(port);
    utterance(c, HELLO);
    const t = await c.next("transcript");
    expect(t.data.text).toBe("hello world");
    expect(t.data.language).toBe("en");
    await c.closed;
    // Quiet and removed: no job left for the stand-in key, no upload on disk, no feed event.
    await until(() => wyomingJobs(rig).length === 0, 5000, "the job to be removed");
    expect(uploads(rig)).toEqual([]);
    expect(
      rig.app
        .jobs()
        ?.events({ id: "admin", name: "a", scopes: ["admin"], callbackHosts: [] }, 0, 100),
    ).toEqual([]);
  });

  test("[SV-C2] no audio gives an empty transcript, as the reference server answers", async () => {
    const c = await client(port);
    c.send("transcribe", { language: "en" });
    c.send("audio-start", { ...FORMAT, timestamp: null });
    c.send("audio-stop", { timestamp: null });
    expect((await c.next("transcript")).data).toEqual({ text: "" });
    await c.closed;
    expect(uploads(rig)).toEqual([]);
  });

  test("[SV-C2] the client closing mid-stream leaves no job and no file", async () => {
    // Before audio-stop: the half-written upload goes.
    const a = await client(port);
    a.send("transcribe", { language: "en" });
    a.send("audio-start", { ...FORMAT, timestamp: null });
    for (const chunk of pcmChunks(HELLO).slice(0, 5)) a.send("audio-chunk", FORMAT, chunk);
    await until(() => uploads(rig).length === 1, 5000, "the upload to start");
    a.socket.destroy();
    await until(() => uploads(rig).length === 0, 5000, "the upload to be deleted");
    // Right after audio-stop: whether the close lands before the submit or while the job is
    // queued or running, the job goes with its file.
    const b = await client(port);
    utterance(b, HELLO);
    b.socket.destroy();
    // Time for the server to read the stop and the close, in whichever order they land.
    await Bun.sleep(500);
    await until(() => wyomingJobs(rig).length === 0, 5000, "no job left");
    await until(() => uploads(rig).length === 0, 5000, "no upload left");
  });

  test("[SV-C2] a chunk stream past server.max_upload_mb gets error body_too_large and a close", async () => {
    const c = await client(port);
    c.send("transcribe", { language: "en" });
    c.send("audio-start", { ...FORMAT, timestamp: null });
    // 513 chunks of 2048 bytes pass the rig's 1 MiB by one chunk. The client stops there, so the
    // server has read every byte when it closes: unread bytes at a close make some stacks (Windows)
    // answer with a reset that drops the error event before the client reads it.
    for (let i = 0; i < 513; i++) c.send("audio-chunk", FORMAT, new Uint8Array(2048));
    const e = await c.next("error");
    expect(e.data.code).toBe("body_too_large");
    expect(e.data.text).toContain("server.max_upload_mb");
    await c.closed;
    await until(() => uploads(rig).length === 0, 5000, "the upload to be deleted");
    expect(wyomingJobs(rig)).toEqual([]);
  });

  test("[SV-C2] a header claiming a body past server.max_upload_mb gets body_too_large before the body", async () => {
    const c = await client(port);
    c.send("transcribe", { language: "en" });
    c.send("audio-start", { ...FORMAT, timestamp: null });
    // One billion bytes announced and none sent: the answer cannot wait for the body.
    c.socket.write(utf8.encode('{"type":"audio-chunk","payload_length":1000000000}\n'));
    const e = await c.next("error", 5000);
    expect(e.data.code).toBe("body_too_large");
    expect(e.data.text).toContain("server.max_upload_mb");
    await c.closed;
    await until(() => uploads(rig).length === 0, 5000, "the upload to be deleted");
    expect(wyomingJobs(rig)).toEqual([]);
  });

  test("[SV-C2] a client that half-closes after audio-stop still reads its transcript", async () => {
    // The Python client's `write_eof`: the write side ends, the read side stays open.
    const c = await client(port);
    utterance(c, HELLO);
    c.socket.end();
    const t = await c.next("transcript");
    expect(t.data.text).toBe("hello world");
    await c.closed;
    await until(() => wyomingJobs(rig).length === 0, 5000, "the job to be removed");
    expect(uploads(rig)).toEqual([]);
  });

  test("[SV-C2] a half-close with no audio-stop closes the connection and deletes the upload", async () => {
    const c = await client(port);
    c.send("audio-start", { ...FORMAT, timestamp: null });
    for (const chunk of pcmChunks(HELLO).slice(0, 5)) c.send("audio-chunk", FORMAT, chunk);
    await until(() => uploads(rig).length === 1, 5000, "the upload to start");
    c.socket.end();
    await c.closed;
    await until(() => uploads(rig).length === 0, 5000, "the upload to be deleted");
    expect(c.events).toEqual([]);
  });

  test("[SV-C2] audio-start with a sample width, channel count or rate past the range gets bad_field", async () => {
    for (const bad of [{ width: 9 }, { channels: 64 }, { rate: 10_000_000 }]) {
      const c = await client(port);
      c.send("audio-start", { ...FORMAT, ...bad, timestamp: null });
      expect((await c.next("error", 5000)).data).toMatchObject({ code: "bad_field" });
      await c.closed;
    }
    expect(uploads(rig)).toEqual([]);
  });

  test("[SV-C2] an unknown language tag gets error bad_field", async () => {
    const c = await client(port);
    c.send("transcribe", { language: "english please" });
    const e = await c.next("error");
    expect(e.data).toMatchObject({ code: "bad_field" });
    await c.closed;
  });

  test("[SV-C2] a line that is not a Wyoming header closes the connection", async () => {
    const c = await client(port);
    c.socket.write(utf8.encode("GET / HTTP/1.1\r\n\r\n"));
    await c.closed;
    expect(c.events).toEqual([]);
  });

  test("[SV-C2] GET /v1/server reports capabilities.wyoming true and wyoming_port", async () => {
    const r = await rig.api("GET", "/server");
    expect(r.body.capabilities.wyoming).toBe(true);
    expect(r.body.wyoming_port).toBe(port);
    expect(port).toBeGreaterThan(0);
  });

  test("[SV-C2] a connection with no event for the idle time is closed", async () => {
    const jobs = rig.app.jobs();
    if (!jobs) throw new Error("no job service");
    const w = WyomingServer.listen({
      hostname: "127.0.0.1",
      port: 0,
      jobs,
      app: rig.app,
      settings: () => rig.app.config().settings,
      log: () => {},
      idleMs: 300,
    });
    try {
      const c = await client(w.port);
      const t0 = performance.now();
      await c.closed;
      expect(performance.now() - t0).toBeLessThan(5000);
    } finally {
      await w.stop();
    }
  });
});

describe("[SV-C2] Wyoming in the app, and off by default", () => {
  let app: AppRig;
  let off: AppRig;

  beforeAll(async () => {
    // `api.bind` is server mode's; the app binds 127.0.0.1 whatever it says, and Wyoming with it.
    app = await appRig({
      settings: { "api.bind": "0.0.0.0", "server.wyoming": true, "server.wyoming_port": 0 },
    });
    off = await appRig({ settings: { ...SERVER } });
  });
  afterAll(async () => {
    await app?.close();
    await off?.close();
  });

  test("[SV-C2] the app mode rig with server.wyoming on binds 127.0.0.1 and still transcribes", async () => {
    expect(app.app.wyoming?.hostname).toBe("127.0.0.1");
    const port = app.app.wyomingPort() as number;
    expect(port).toBeGreaterThan(0);
    const c = await client(port);
    utterance(c, HELLO);
    expect((await c.next("transcript")).data.text).toBe("hello world");
    await c.closed;
  });

  test("[SV-C2] off by default: no listener without the setting", async () => {
    expect(off.app.config().settings["server.wyoming"]).toBe(false);
    expect(off.app.wyomingPort()).toBeNull();
    const r = await off.api("GET", "/server");
    expect(r.body.capabilities.wyoming).toBe(false);
    expect(r.body.wyoming_port).toBeNull();
  });

  test("[SV-C2] the quit stops the listener with a session open and leaves no upload", async () => {
    const port = app.app.wyomingPort() as number;
    const c = await client(port);
    c.send("audio-start", { ...FORMAT, timestamp: null });
    for (const chunk of pcmChunks(HELLO).slice(0, 5)) c.send("audio-chunk", FORMAT, chunk);
    await until(() => uploads(app).length === 1, 5000, "the upload to start");
    await app.app.quit();
    await c.closed;
    await until(() => uploads(app).length === 0, 5000, "the upload to be deleted");
    expect(app.logs.filter((l) => l.msg.includes("the Wyoming listener"))).toEqual([]);
  });
});

describe("[SV-C2] Wyoming with a slow engine", () => {
  let rig: AppRig;
  let port: number;

  beforeAll(async () => {
    rig = await appRig({
      settings: { ...SERVER, "server.wyoming": true, "server.wyoming_port": 0 },
      // Every decode busy-waits, so a job is still running when its client goes.
      models: {
        kind: "module",
        path: FAKE_MODELS,
        model: "fake-parakeet",
        options: { slowMs: 1500 },
      },
    });
    port = rig.app.wyomingPort() as number;
  });
  afterAll(async () => {
    await rig?.close();
  });

  test("[SV-C2] a disconnect while the job runs lets it finish; the next session still transcribes", async () => {
    const jobs = rig.app.jobs();
    if (!jobs) throw new Error("no job service");
    // How each Wyoming job ended when it was removed: `cancelled` means its Worker was terminated.
    const removed: string[] = [];
    const remove = jobs.remove.bind(jobs);
    jobs.remove = (who, id) => {
      const r = remove(who, id);
      if (r) removed.push(r.status);
      return r;
    };
    try {
      const a = await client(port);
      utterance(a, HELLO);
      await until(
        () => wyomingJobs(rig).some((j) => j.status === "running"),
        10_000,
        "the job to run",
      );
      // Inside the decode, then the client goes. A reset, so the server sees the close at once (a
      // plain FIN is a half-close, which waits for the answer by design).
      await Bun.sleep(300);
      a.socket.resetAndDestroy();
      const b = await client(port);
      utterance(b, HELLO);
      expect((await b.next("transcript")).data.text).toBe("hello world");
      await b.closed;
      await until(() => wyomingJobs(rig).length === 0, 10_000, "no job left");
      expect(uploads(rig)).toEqual([]);
      // Both ran to the end: the gone client's job was not cut off mid-decode.
      expect(removed).toEqual(["done", "done"]);
    } finally {
      jobs.remove = remove;
    }
  });

  test("[SV-C2] a disconnect while the job is queued removes it at once", async () => {
    const jobs = rig.app.jobs();
    if (!jobs) throw new Error("no job service");
    // The first utterance holds the lane; the second queues behind it, then its client goes.
    const a = await client(port);
    utterance(a, HELLO);
    await until(() => wyomingJobs(rig).some((j) => j.status === "running"), 10_000, "a job to run");
    const b = await client(port);
    utterance(b, HELLO);
    await until(
      () => wyomingJobs(rig).some((j) => j.status === "queued"),
      10_000,
      "a job to queue",
    );
    b.socket.resetAndDestroy();
    await until(
      () => !wyomingJobs(rig).some((j) => j.status === "queued"),
      1000,
      "the queued job to be removed before the running one ends",
    );
    expect((await a.next("transcript")).data.text).toBe("hello world");
    await until(() => wyomingJobs(rig).length === 0, 10_000, "no job left");
    expect(uploads(rig)).toEqual([]);
  });
});
