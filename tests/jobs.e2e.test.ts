/**
 * File jobs (docs/ux/SERVER.md sections 5 and 6), end to end through the real API, in server mode
 * and in the desktop app, which takes them with its one token (akou-5an.119):
 * the submit and its fields (SV-J1), idempotency (SV-J2), states and the long-poll (SV-J3), the
 * result shape (SV-J4), delete and retention (SV-J6), the store across a restart (SV-J9), the
 * per-key feed (SV-E1), the callback-host allowlist at submit (SV-K4), the address rules and a
 * signed delivery to a real receiver (SV-E7, SV-E2, SV-E3), and silence (SV-R5). The recognizer is
 * the fake engine in a real finalize Worker, reading uploads as 16 kHz WAVs.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyStore } from "../src/main/api/keys.ts";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import { modelNameFor } from "../src/main/asr/live-worker.ts";
import { MODELS } from "../src/main/asr/models.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { jobModels } from "../src/main/server/jobs.ts";
import { JOBS_DB } from "../src/main/server/store.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav, RATE, roomNoise } from "./fixtures/audio.ts";
import { Webhook } from "./fixtures/standard-webhooks.ts";
import { tempDir } from "./helpers.ts";
import { RESULT } from "./server-helpers.ts";

// Every case runs real jobs through a finalize Worker, several per case; a loaded CI box is slow.
setDefaultTimeout(30_000);

const SERVER = { "server.enabled": true, "api.bind": "127.0.0.1" };

/** A mono clip of `seconds` with the words spoken near its start. */
function clip(words: string[], seconds: number): Uint8Array {
  const speech = concat(silence(0.4), speak(words));
  return monoWav(concat(speech, silence(Math.max(0, seconds - speech.length / RATE))));
}

const NOTE = clip(["hello", "world"], 3);
const OTHER_NOTE = clip(["ok", "great"], 3);

interface Key {
  id: string;
  key: string;
  secret: string;
}

async function newKey(
  rig: AppRig,
  name: string,
  hosts: string[] = [],
  scope = "jobs",
): Promise<Key> {
  const r = await cli({ ...process.env, ...rig.env }, [
    "keys",
    "create",
    "--name",
    name,
    "--scope",
    scope,
    ...hosts.flatMap((h) => ["--callback-host", h]),
    "--json",
  ]);
  expect(r.code).toBe(0);
  return r.json;
}

interface Answer {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
  body: any;
  text: string;
  headers: Headers;
}

async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text, headers: res.headers };
}

async function submit(
  rig: AppRig,
  key: string,
  file: Uint8Array | null,
  fields: Record<string, string | string[]> = {},
  headers: Record<string, string> = {},
): Promise<Answer> {
  const form = new FormData();
  if (file) form.append("file", new Blob([file], { type: "audio/wav" }), "note.wav");
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) form.append(k, x);
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, ...headers },
    body: form,
  });
  return answer(res);
}

async function call(
  rig: AppRig,
  key: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      // The guard takes a change with a JSON Content-Type only, a DELETE too (DESIGN 6.3).
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
      ...headers,
    },
  });
  return answer(res);
}

/** Submits and waits for the job to end; returns the job and its result. */
async function transcribe(rig: AppRig, key: string, file: Uint8Array, fields = {}) {
  const s = await submit(rig, key, file, fields);
  expect(s.status).toBe(202);
  const j = await call(rig, key, "GET", `/jobs/${s.body.id}?wait=60`);
  expect(j.body.status).toBe("done");
  const r = await call(rig, key, "GET", `/jobs/${s.body.id}/result`);
  expect(r.status).toBe(200);
  return { id: s.body.id as string, job: j.body, result: r.body };
}

/** Holds every upload's decode until `open()`: the job stays `running`, the next ones `queued`. */
function gate() {
  let open = () => {};
  const held = new Promise<void>((r) => {
    open = r;
  });
  return {
    open: () => open(),
    decode: async (path: string, signal: AbortSignal) => {
      await held;
      return readUploadAudio(path, { signal });
    },
  };
}

function audioFiles(rig: AppRig): string[] {
  const dir = join(rig.app.configDir, "jobs", "audio");
  return existsSync(dir) ? readdirSync(dir) : [];
}

let server: AppRig;
let app: AppRig;
let admin: Key;

/** The fake recognizer as sherpa-onnx answers: words timed into the span, with confidences. */
const WITH_WORDS: ModelSpec = {
  kind: "module",
  path: FAKE_MODELS,
  model: "fake-parakeet",
  options: { words: true },
};

beforeAll(async () => {
  server = await appRig({ settings: SERVER, models: WITH_WORDS });
  app = await appRig();
  admin = await newKey(server, "ops", [], "admin");
});

afterAll(async () => {
  await server?.close();
  await app?.close();
});

describe("SV-J1: POST /v1/jobs, multipart", () => {
  test("a voice note submitted with metadata {x: 1} comes back done with the same metadata", async () => {
    const k = await newKey(server, "j1");
    const s = await submit(server, k.key, NOTE, { metadata: '{"x": 1}' });
    expect(s.status).toBe(202);
    expect(Object.keys(s.body)).toEqual(
      expect.arrayContaining(["id", "status", "created_at", "links"]),
    );
    expect(s.body.status).toBe("queued");
    expect(Number.isNaN(Date.parse(s.body.created_at))).toBe(false);
    expect(s.body.links).toEqual({
      self: `/v1/jobs/${s.body.id}`,
      result: `/v1/jobs/${s.body.id}/result`,
      events: "/v1/events",
    });
    const done = await call(server, k.key, "GET", `/jobs/${s.body.id}?wait=60`);
    expect(done.body.status).toBe("done");
    const r = await call(server, k.key, "GET", `/jobs/${s.body.id}/result`);
    expect(r.body.text).toBe("hello world");
    expect(r.body.metadata).toEqual({ x: 1 });
  });

  test("a body with no file gets 422 with the one error shape of PG-A7", async () => {
    const k = await newKey(server, "j1-nofile");
    const r = await submit(server, k.key, null, { preset: "fast" });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "missing_field", field: "file" });
    expect(typeof r.body.message).toBe("string");
    // Nothing was kept for a refused submit.
    expect((await call(server, k.key, "GET", "/jobs")).body.jobs).toEqual([]);
  });

  test("each field is checked: preset, language, keywords (24 at most), diarize, metadata (4 KB)", async () => {
    const k = await newKey(server, "j1-fields");
    const refused = async (fields: Record<string, string | string[]>, field: string) => {
      const r = await submit(server, k.key, NOTE, fields);
      expect(`${r.status} ${r.body.error} ${r.body.field}`).toBe(`422 bad_field ${field}`);
    };
    await refused({ preset: "turbo" }, "preset");
    await refused({ language: "not a tag" }, "language");
    await refused({ "keywords[]": Array.from({ length: 25 }, (_, i) => `term${i}`) }, "keywords[]");
    await refused({ diarize: "maybe" }, "diarize");
    await refused({ metadata: "{not json" }, "metadata");
    await refused({ metadata: JSON.stringify({ pad: "x".repeat(4096) }) }, "metadata");
    // Positive control: the same fields in range are taken.
    const ok = await submit(server, k.key, NOTE, {
      preset: "auto",
      language: "en-US",
      "keywords[]": Array.from({ length: 24 }, (_, i) => `term${i}`),
      diarize: "true",
      metadata: JSON.stringify({ pad: "x".repeat(4000) }),
    });
    expect(ok.status).toBe(202);
    // `auto` is `fast` until hardware detection (SV-R2) exists; the job records what it runs.
    expect(ok.body).toMatchObject({ preset: "fast", language: "en-US", diarize: true });
    await call(server, k.key, "GET", `/jobs/${ok.body.id}?wait=60`);
  });

  test("the job routes exist in both modes; keys and the OpenAI route in server mode only", async () => {
    const routes = (s: AppRig) =>
      (s.app.server?.routes() ?? []).map((r) => `${r.method} ${r.path}`);
    for (const rig of [app, server]) {
      for (const r of [
        "POST /v1/jobs",
        "GET /v1/jobs",
        "GET /v1/jobs/:id/result",
        "GET /v1/events",
      ])
        expect(routes(rig)).toContain(r);
    }
    for (const r of ["GET /v1/keys", "POST /v1/keys", "POST /v1/audio/transcriptions"]) {
      expect(routes(app)).not.toContain(r);
      // Positive control: the server has them.
      expect(routes(server)).toContain(r);
    }
  });
});

describe("akou-5an.119: the desktop app takes file jobs with its one token", () => {
  test("akou transcribe --preset best --diarize on the desktop app runs Qwen and labels the speakers", async () => {
    const t = tempDir("akou-desk-best-");
    const rig = await appRig({
      settings: {
        "asr.llamaServer": [
          process.execPath,
          join(import.meta.dir, "fixtures", "fake-llama-server.ts"),
          "--fake-log",
          join(t.dir, "llama.log"),
        ],
      },
    });
    try {
      expect(rig.app.mode()).toBe("app");
      const path = join(t.dir, "two.wav");
      writeFileSync(
        path,
        monoWav(
          concat(
            silence(0.4),
            speak(["hello", "world"], { voice: 1 }),
            silence(1.2),
            speak(["ok", "great"], { voice: 4 }),
            silence(0.6),
          ),
        ),
      );
      const r = await cli({ ...process.env, ...rig.env }, [
        "transcribe",
        path,
        "--preset",
        "best",
        "--language",
        "en",
        "--diarize",
        "--json",
      ]);
      expect(r.code).toBe(0);
      const out = r.json as {
        text: string;
        engine: { models: string[] };
        segments: { speaker: string }[];
      };
      expect(out.text).toBe("hello world ok great");
      expect(out.engine.models[0]).toBe("qwen3-asr-1.7b");
      // Two voices, two labels: a job with no speakers would answer null for both.
      expect(out.segments.map((x) => x.speaker)).toEqual(["s0", "s1"]);
    } finally {
      await rig.close();
      t.cleanup();
    }
  });

  test("a 15-minute file on the desktop app is cut at its pauses and transcribed whole", async () => {
    const minutes = 15;
    const x = concat(
      silence(1),
      speak(["hello", "world"]),
      silence(7 * 60),
      speak(["ok", "great"]),
      silence(7 * 60),
      speak(["yes"], { wordSeconds: 0.4 }),
    );
    const file = monoWav(concat(x, silence(minutes * 60 - x.length / RATE)));
    const s = await submit(app, app.token, file);
    expect(s.status).toBe(202);
    const done = await call(app, app.token, "GET", `/jobs/${s.body.id}?wait=60`);
    expect(done.body.status).toBe("done");
    const r = (await call(app, app.token, "GET", `/jobs/${s.body.id}/result`)).body;
    expect(r.duration_s).toBe(minutes * 60);
    expect(r.text).toBe("hello world ok great yes");
    // Three runs of speech, three pieces, each under 30 s: no piece is the whole file.
    expect(r.segments.length).toBe(3);
    for (const seg of r.segments) expect(seg.e - seg.s).toBeLessThan(30);
  });

  test("a job posted with the local token runs, is listed, and its result reads back", async () => {
    const s = await submit(app, app.token, NOTE, { preset: "fast", metadata: '{"a": 1}' });
    expect(s.status).toBe(202);
    // The one token owns every job, as the key id `app`.
    expect(s.body).toMatchObject({ status: "queued", preset: "fast", key_id: "app" });
    const done = await call(app, app.token, "GET", `/jobs/${s.body.id}?wait=60`);
    expect(done.body.status).toBe("done");
    const r = await call(app, app.token, "GET", `/jobs/${s.body.id}/result`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ text: "hello world", metadata: { a: 1 } });
    const list = await call(app, app.token, "GET", "/jobs");
    expect(list.body.jobs.map((j: { id: string }) => j.id)).toContain(s.body.id);
    // The app's own queue, on its own disk.
    expect(existsSync(join(app.app.configDir, "jobs", JOBS_DB))).toBe(true);
  });

  test("an ak_ key is refused in the app even when its keys file holds it; /v1/keys is 404 there", async () => {
    // A key written into the app's own config folder: the app reads no keys, so it is no token.
    const planted = new KeyStore(app.app.configDir).create({ name: "planted", scope: "admin" });
    expect((await submit(app, planted.key, NOTE)).status).toBe(401);
    expect((await call(app, planted.key, "GET", "/jobs")).status).toBe(401);
    expect((await call(app, app.token, "GET", "/keys")).status).toBe(404);
    expect((await call(app, app.token, "GET", "/keys/me")).body).toMatchObject({ id: "app" });
    // Positive control: the same kind of key works on the server, where keys exist.
    const k = await newKey(server, "app-mode-control");
    expect((await call(server, k.key, "GET", "/jobs")).status).toBe(200);
    expect((await call(server, admin.key, "GET", "/keys")).status).toBe(200);
  });

  test("nothing about the network changes: loopback bind, no callbacks, no remotes, no dictation lane", async () => {
    expect(app.app.server?.hostname).toBe("127.0.0.1");
    const info = await call(app, app.token, "GET", "/server");
    expect(info.body).toMatchObject({ mode: "app", remotes: [], dictation: null });
    expect(info.body.capabilities).toMatchObject({
      jobs: true,
      events: true,
      webhooks: false,
      openai: false,
      interactive: false,
    });
    // A callback needs a key's secret to sign with; the app's token has none.
    const cb = await submit(app, app.token, NOTE, { callback_url: "https://hooks.example/x" });
    expect(cb.status).toBe(422);
    expect(cb.body.error).toBe("callback_not_allowed");
  });

  test("an idle Worker is closed once the queue is empty, so the app holds no job model; a server keeps it warm", async () => {
    await transcribe(app, app.token, NOTE, { preset: "fast" });
    const workers = (rig: AppRig) =>
      // biome-ignore lint/suspicious/noExplicitAny: the slots are private; the test reads them.
      ((rig.app.jobs() as any).slots as { worker: unknown }[]).filter((x) => x.worker).length;
    await until(() => workers(app) === 0, 10_000, "the app's idle Worker closed");
    // Positive control: the server keeps its default model's Worker loaded after a job.
    const k = await newKey(server, "warm-control");
    await transcribe(server, k.key, NOTE, { preset: "fast" });
    expect(workers(server)).toBe(1);
  });
});

describe("SV-D3: an upload streams to disk as it arrives", () => {
  const BOUNDARY = "akouD3boundaryx7";
  const enc = (t: string) => new TextEncoder().encode(t);
  const head = enc(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="note.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  );
  const tail = enc(
    `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"d3": 1}\r\n--${BOUNDARY}--\r\n`,
  );

  /** A body that sends the part head and the whole file, then waits for `finish` or `fail`. */
  function heldBody() {
    let finish = () => {};
    let fail = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(head);
        ctl.enqueue(NOTE);
        finish = () => {
          ctl.enqueue(tail);
          ctl.close();
        };
        fail = () => ctl.error(new Error("the client went away"));
      },
    });
    return { body, finish: () => finish(), fail: () => fail() };
  }

  function post(key: string, body: ReadableStream<Uint8Array>): Promise<Response> {
    return fetch(`http://127.0.0.1:${server.port}/v1/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      body,
      duplex: "half",
    } as RequestInit);
  }

  /** Uploads that were not in the folder before. */
  function fresh(before: string[]): { name: string; size: number }[] {
    const dir = join(server.app.configDir, "jobs", "audio");
    return audioFiles(server)
      .filter((f) => !before.includes(f))
      .map((name) => ({ name, size: statSync(join(dir, name)).size }));
  }

  test("the file is on disk before the body ends, and the job runs from it", async () => {
    const k = await newKey(server, "d3-stream");
    const before = audioFiles(server);
    const held = heldBody();
    const sent = post(k.key, held.body);
    // Positive control of the test itself: nothing arrives whole, so a server that reads the body
    // into memory first holds nothing on disk here, and this wait times out.
    await until(
      () => fresh(before).some((f) => f.size >= NOTE.length - 64),
      10_000,
      "the upload on disk while the body is still arriving",
    );
    held.finish();
    const s = await answer(await sent);
    expect(s.status).toBe(202);
    const done = await call(server, k.key, "GET", `/jobs/${s.body.id}?wait=60`);
    expect(done.body.status).toBe("done");
    const r = await call(server, k.key, "GET", `/jobs/${s.body.id}/result`);
    expect(r.body.text).toBe("hello world");
    expect(r.body.metadata).toEqual({ d3: 1 });
  });

  test("an upload cut off mid-body, or refused after it arrived, leaves no file behind", async () => {
    const k = await newKey(server, "d3-cleanup");
    const before = audioFiles(server);
    const held = heldBody();
    const sent = post(k.key, held.body).catch(() => null);
    await until(() => fresh(before).length > 0, 10_000, "the upload started");
    held.fail();
    await sent;
    await until(() => fresh(before).length === 0, 10_000, "the cut upload deleted");
    const refused = await submit(server, k.key, NOTE, { preset: "nope" });
    expect(refused.status).toBe(422);
    expect(fresh(before)).toEqual([]);
  });
});

describe("SV-J2: Idempotency-Key", () => {
  test("two identical submits make one job and one result; the second answers 200 while the first runs", async () => {
    const g = gate();
    const rig = await appRig({ settings: SERVER, jobs: { decode: g.decode } });
    try {
      const k = await newKey(rig, "archive");
      const idem = { "idempotency-key": "a".repeat(64) };
      const first = await submit(rig, k.key, NOTE, { metadata: '{"row": 1}' }, idem);
      expect(first.status).toBe(202);
      await until(
        async () =>
          (await call(rig, k.key, "GET", `/jobs/${first.body.id}`)).body.status === "running",
        5000,
        "the first job to run",
      );
      // Metadata and priority are not part of the comparison: they never change the transcript.
      const second = await submit(
        rig,
        k.key,
        NOTE,
        { metadata: '{"row": 2}', priority: "5" },
        idem,
      );
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.status).toBe("running");
      g.open();
      await call(rig, k.key, "GET", `/jobs/${first.body.id}?wait=60`);
      const again = await submit(rig, k.key, NOTE, {}, idem);
      expect(`${again.status} ${again.body.id} ${again.body.status}`).toBe(
        `200 ${first.body.id} done`,
      );
      const list = await call(rig, k.key, "GET", "/jobs");
      expect(list.body.jobs.map((j: { id: string }) => j.id)).toEqual([first.body.id]);
      const events = await call(rig, k.key, "GET", "/events");
      expect(events.body.events.length).toBe(1);
      // Every upload but the first was deleted at once.
      expect(audioFiles(rig)).toEqual([]);
    } finally {
      g.open();
      await rig.close();
    }
  });

  test("the same key with another file answers 422 idempotency_conflict", async () => {
    const k = await newKey(server, "j2-conflict");
    const idem = { "idempotency-key": "conflict-1" };
    const first = await submit(server, k.key, NOTE, {}, idem);
    expect(first.status).toBe(202);
    const other = await submit(server, k.key, OTHER_NOTE, {}, idem);
    expect(other.status).toBe(422);
    expect(other.body).toMatchObject({
      error: "idempotency_conflict",
      id: first.body.id,
      fields: ["file"],
    });
    await call(server, k.key, "GET", `/jobs/${first.body.id}?wait=60`);
  });

  test("[akou-5an.98] the same key with other options answers 422 naming them, queued, running or done", async () => {
    const g = gate();
    const rig = await appRig({ settings: SERVER, jobs: { decode: g.decode } });
    try {
      const k = await newKey(rig, "archive");
      const idem = { "idempotency-key": "b".repeat(64) };
      const asked = { preset: "auto", language: "auto", diarize: "false" };
      const first = await submit(rig, k.key, NOTE, asked, idem);
      expect(first.status).toBe(202);
      // The second job waits behind the first, so each state is asked while it holds.
      const queued = await submit(rig, k.key, OTHER_NOTE, asked, { "idempotency-key": "q" });
      await until(
        async () =>
          (await call(rig, k.key, "GET", `/jobs/${first.body.id}`)).body.status === "running",
        5000,
        "the first job to run",
      );
      const differs = async (id: string, file: Uint8Array, key: string, state: string) => {
        const h = { "idempotency-key": key };
        const cases: [Record<string, string | string[]>, string[]][] = [
          [{ ...asked, diarize: "true" }, ["diarize"]],
          [{ ...asked, preset: "fast" }, ["preset"]],
          [{ ...asked, model: "fast" }, ["model"]],
          [{ ...asked, language: "es" }, ["language"]],
          [{ ...asked, "keywords[]": ["akou"] }, ["keywords"]],
          [{ preset: "auto", language: "es", diarize: "true" }, ["language", "diarize"]],
        ];
        for (const [fields, named] of cases) {
          const r = await submit(rig, k.key, file, fields, h);
          expect([state, r.status, r.body.error, r.body.id, r.body.fields]).toEqual([
            state,
            422,
            "idempotency_conflict",
            id,
            named,
          ]);
          expect(r.body.message).toContain(named.join(", "));
        }
        // A plain retry of the same request answers the job, whatever its state.
        const same = await submit(rig, k.key, file, { ...asked, metadata: '{"retry": 1}' }, h);
        expect(`${same.status} ${same.body.id} ${same.body.status}`).toBe(`200 ${id} ${state}`);
      };
      await differs(queued.body.id, OTHER_NOTE, "q", "queued");
      await differs(first.body.id, NOTE, "b".repeat(64), "running");
      g.open();
      for (const j of [first, queued]) await call(rig, k.key, "GET", `/jobs/${j.body.id}?wait=60`);
      await differs(first.body.id, NOTE, "b".repeat(64), "done");
      const list = await call(rig, k.key, "GET", "/jobs");
      expect(list.body.jobs.length).toBe(2);
      const result = await call(rig, k.key, "GET", `/jobs/${first.body.id}/result`);
      expect(result.body.segments.map((x: { speaker: unknown }) => x.speaker)).toEqual([null]);
      expect(audioFiles(rig)).toEqual([]);
    } finally {
      g.open();
      await rig.close();
    }
  });

  test("[akou-5an.98] the options are compared as sent: a changed server default keeps a retry matching", async () => {
    const rig = await appRig({ settings: SERVER });
    try {
      const k = await newKey(rig, "defaults");
      const idem = { "idempotency-key": "defaults-1" };
      const first = await submit(rig, k.key, NOTE, {}, idem);
      expect(first.status).toBe(202);
      await call(rig, k.key, "GET", `/jobs/${first.body.id}?wait=60`);
      await rig.api("PATCH", "/config", {
        "server.default_diarize": true,
        "server.default_language": "es",
      });
      const again = await submit(rig, k.key, NOTE, {}, idem);
      expect(`${again.status} ${again.body.id}`).toBe(`200 ${first.body.id}`);
      // Stating what the default was is a different request: the job was asked with no opinion.
      const stated = await submit(rig, k.key, NOTE, { diarize: "false" }, idem);
      expect([stated.status, stated.body.fields]).toEqual([422, ["diarize"]]);
    } finally {
      await rig.close();
    }
  });

  test("keywords in another order and a language in another case are the same request", async () => {
    const rig = await appRig({ settings: SERVER });
    try {
      const k = await newKey(rig, "normalised");
      const idem = { "idempotency-key": "normalised-1" };
      // The row keeps the options as sent, the way every job before this change stored them.
      const first = await submit(
        rig,
        k.key,
        NOTE,
        { language: "ES", "keywords[]": ["b", "a"] },
        idem,
      );
      expect(first.status).toBe(202);
      const retries = [
        { language: "ES", "keywords[]": ["b", "a"] },
        { language: "es", "keywords[]": ["a", "b"] },
        { language: "Es", "keywords[]": ["a", "b", "a"] },
      ];
      for (const fields of retries) {
        const r = await submit(rig, k.key, NOTE, fields, idem);
        expect(`${r.status} ${r.body.id}`).toBe(`200 ${first.body.id}`);
      }
      // A real change still conflicts.
      const other = await submit(
        rig,
        k.key,
        NOTE,
        { language: "en", "keywords[]": ["a", "c"] },
        idem,
      );
      expect([other.status, other.body.fields]).toEqual([422, ["language", "keywords"]]);
      await call(rig, k.key, "GET", `/jobs/${first.body.id}?wait=60`);
    } finally {
      await rig.close();
    }
  });

  test("[akou-5an.98] the options survive a restart; a job stored before them is compared by file only", async () => {
    const home = tempDir("akou-jobs-idem-");
    const first = await appRig({ settings: SERVER, home: home.dir });
    let second: AppRig | null = null;
    try {
      const k = await newKey(first, "restart-idem");
      const asked = { diarize: "false", language: "auto" };
      const kept = await submit(first, k.key, NOTE, asked, { "idempotency-key": "kept" });
      const old = await submit(first, k.key, NOTE, asked, { "idempotency-key": "old" });
      for (const j of [kept, old]) await call(first, k.key, "GET", `/jobs/${j.body.id}?wait=60`);
      await first.app.quit();
      // A jobs.db from before the options were kept has no request on its rows.
      const { Database } = await import("bun:sqlite");
      const db = new Database(join(first.app.configDir, "jobs", JOBS_DB));
      db.query("UPDATE jobs SET request = NULL WHERE id = ?").run(old.body.id);
      db.close();
      second = await appRig({ settings: SERVER, home: home.dir });
      const s = second;
      const diarized = { ...asked, diarize: "true" };
      const a = await submit(s, k.key, NOTE, diarized, { "idempotency-key": "kept" });
      expect([a.status, a.body.id, a.body.fields]).toEqual([422, kept.body.id, ["diarize"]]);
      const b = await submit(s, k.key, NOTE, asked, { "idempotency-key": "kept" });
      expect(`${b.status} ${b.body.id}`).toBe(`200 ${kept.body.id}`);
      const c = await submit(s, k.key, NOTE, diarized, { "idempotency-key": "old" });
      expect(`${c.status} ${c.body.id}`).toBe(`200 ${old.body.id}`);
      const d = await submit(s, k.key, OTHER_NOTE, asked, { "idempotency-key": "old" });
      expect([d.status, d.body.fields]).toEqual([422, ["file"]]);
    } finally {
      await second?.close();
      home.cleanup();
    }
  });

  test("the key is scoped to the API key: another key with the same header gets its own job", async () => {
    const a = await newKey(server, "j2-a");
    const b = await newKey(server, "j2-b");
    const idem = { "idempotency-key": "shared" };
    const ja = await submit(server, a.key, NOTE, {}, idem);
    const jb = await submit(server, b.key, NOTE, {}, idem);
    expect(`${ja.status} ${jb.status}`).toBe("202 202");
    expect(jb.body.id).not.toBe(ja.body.id);
    // Positive control: no header, no deduplication.
    const plain1 = await submit(server, a.key, NOTE);
    const plain2 = await submit(server, a.key, NOTE);
    expect(plain2.body.id).not.toBe(plain1.body.id);
    for (const [k, id] of [
      [a, ja.body.id],
      [b, jb.body.id],
      [a, plain1.body.id],
      [a, plain2.body.id],
    ] as const) {
      await call(server, k.key, "GET", `/jobs/${id}?wait=60`);
    }
  });
});

describe("SV-J3: states and the long-poll", () => {
  test("a 5 s clip submitted then fetched with wait=60 answers done in one request, each state with a time", async () => {
    const k = await newKey(server, "j3");
    const s = await submit(server, k.key, clip(["hello", "world"], 5));
    const j = await call(server, k.key, "GET", `/jobs/${s.body.id}?wait=60`);
    expect(j.body.status).toBe("done");
    for (const t of ["created_at", "started_at", "finished_at"]) {
      expect(Number.isNaN(Date.parse(j.body[t]))).toBe(false);
    }
  });

  test("wait=1 on a queued job answers queued after one second", async () => {
    const g = gate();
    const rig = await appRig({ settings: SERVER, jobs: { decode: g.decode } });
    try {
      const k = await newKey(rig, "j3-queued");
      await submit(rig, k.key, NOTE);
      const second = await submit(rig, k.key, OTHER_NOTE);
      const t0 = performance.now();
      const r = await call(rig, k.key, "GET", `/jobs/${second.body.id}?wait=1`);
      const ms = performance.now() - t0;
      expect(r.body.status).toBe("queued");
      expect(ms).toBeGreaterThanOrEqual(1000);
      // Positive control: wait=0 answers at once.
      const t1 = performance.now();
      expect((await call(rig, k.key, "GET", `/jobs/${second.body.id}?wait=0`)).body.status).toBe(
        "queued",
      );
      expect(performance.now() - t1).toBeLessThan(1000);
      expect((await call(rig, k.key, "GET", `/jobs/${second.body.id}?wait=61`)).status).toBe(400);
    } finally {
      g.open();
      await rig.close();
    }
  });

  test("GET /v1/jobs lists the key's own jobs by status; an admin sees every key's", async () => {
    const a = await newKey(server, "j3-list-a");
    const b = await newKey(server, "j3-list-b");
    const { id } = await transcribe(server, a.key, NOTE);
    const mine = await call(server, a.key, "GET", "/jobs?status=done");
    expect(mine.body.jobs.map((j: { id: string }) => j.id)).toEqual([id]);
    expect((await call(server, a.key, "GET", "/jobs?status=failed")).body.jobs).toEqual([]);
    expect((await call(server, b.key, "GET", "/jobs")).body.jobs).toEqual([]);
    expect((await call(server, b.key, "GET", `/jobs/${id}`)).status).toBe(404);
    expect((await call(server, b.key, "GET", `/jobs/${id}/result`)).status).toBe(404);
    const all = await call(server, admin.key, "GET", "/jobs?limit=200");
    expect(all.body.jobs.map((j: { id: string }) => j.id)).toContain(id);
    expect((await call(server, a.key, "GET", "/jobs?status=nope")).status).toBe(400);
  });
});

describe("SI-5: wait on POST /v1/jobs", () => {
  /** A submit holding its answer `wait` seconds. */
  async function submitWaiting(rig: AppRig, key: string, file: Uint8Array, wait: number) {
    const form = new FormData();
    form.append("file", new Blob([file], { type: "audio/wav" }), "note.wav");
    const res = await fetch(`http://127.0.0.1:${rig.port}/v1/jobs?wait=${wait}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    return answer(res);
  }

  test("a 5 s clip with wait=55 answers 200, done, with its result in the one answer", async () => {
    const k = await newKey(server, "si5-done");
    const r = await submitWaiting(server, k.key, clip(["hello", "world"], 5), 55);
    expect([r.status, r.body.status]).toEqual([200, "done"]);
    expect(r.body.result.text).toBe("hello world");
    expect(r.body.result.job_id).toBe(r.body.id);
    expect(RESULT.safeParse(r.body.result).success).toBe(true);
    // Positive control: with no wait the same submit is SV-J1's 202, queued, with no result.
    const plain = await submit(server, k.key, clip(["hello", "world"], 5));
    expect(plain.status).toBe(202);
    expect(plain.body.result).toBeUndefined();
  });

  test("wait=1 on a busy queue answers 202 queued after one second; wait=61 is refused", async () => {
    const g = gate();
    const rig = await appRig({ settings: SERVER, jobs: { decode: g.decode } });
    try {
      const k = await newKey(rig, "si5-busy");
      await submit(rig, k.key, NOTE);
      const t0 = performance.now();
      const r = await submitWaiting(rig, k.key, OTHER_NOTE, 1);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(1000);
      expect([r.status, r.body.status]).toEqual([202, "queued"]);
      expect(r.body.result).toBeUndefined();
      expect((await submitWaiting(rig, k.key, OTHER_NOTE, 61)).status).toBe(400);
    } finally {
      g.open();
      await rig.close();
    }
  });
});

describe("SV-J4: the result shape", () => {
  for (const preset of ["fast", "auto"]) {
    test(`the result of the ${preset} preset matches the schema`, async () => {
      const k = await newKey(server, `j4-${preset}`);
      const { result } = await transcribe(server, k.key, NOTE, { preset, metadata: '{"m": [1]}' });
      expect(RESULT.safeParse(result).error?.issues ?? []).toEqual([]);
      expect(result.engine.preset).toBe("fast");
      expect(result.segments.length).toBeGreaterThan(0);
      for (const s of result.segments) expect(s.speaker).toBeNull();
      // Positive control: the schema refuses a renamed field.
      const { text, ...renamed } = result;
      expect(RESULT.safeParse({ ...renamed, txt: text }).success).toBe(false);
    });
  }

  test("[akou-5an.24.1] fast: every word is timed, in order, inside its file, with a confidence", async () => {
    const k = await newKey(server, "j4-words");
    const x = monoWav(
      concat(silence(0.4), speak(["hello", "world"]), silence(1.5), speak(["ok", "great"])),
    );
    const { result } = await transcribe(server, k.key, x, { preset: "fast" });
    expect(result.words.map((w: { w: string }) => w.w)).toEqual(["hello", "world", "ok", "great"]);
    let last = 0;
    for (const w of result.words) {
      expect(w.s).toBeGreaterThanOrEqual(last);
      expect(w.e).toBeGreaterThan(w.s);
      last = w.e;
    }
    // Times are into the file, not into the piece: "ok" comes after the 1.5 s pause.
    expect(result.words[2].s).toBeGreaterThan(1.9);
    expect(last).toBeLessThanOrEqual(result.duration_s);
    expect(result.confidence).toBe(0.9);
    expect(result.speakers).toEqual({ asked: false, labelled: false, error: null });
    expect(result.warnings).toEqual([]);
    expect(result.skipped).toEqual([]);
    // Positive control: the schema refuses a word confidence above 1.
    const bad = { ...result, words: [{ ...result.words[0], c: 1.5 }] };
    expect(RESULT.safeParse(bad).success).toBe(false);
  });

  test("[akou-5an.24.1] a span the engine refuses is listed in skipped, with its reason", async () => {
    const rig = await appRig({
      settings: SERVER,
      models: { ...WITH_WORDS, options: { words: true, refuseOver: 0.4 } },
    });
    try {
      const k = await newKey(rig, "j4-skipped");
      const { result } = await transcribe(rig, k.key, NOTE);
      expect(RESULT.safeParse(result).error?.issues ?? []).toEqual([]);
      expect(result.skipped.length).toBeGreaterThan(0);
      for (const x of result.skipped) {
        expect(x.reason).toBe("span too long for the fake engine");
        expect(x.e).toBeGreaterThan(x.s);
      }
    } finally {
      await rig.close();
    }
  });

  test("[akou-5an.109] speaker labels that fail: speakers says so, a warning, no speaker model named", async () => {
    const rig = await appRig({
      settings: SERVER,
      models: { ...WITH_WORDS, options: { diarizeFails: "no akou-diarize command" } },
    });
    try {
      const k = await newKey(rig, "j4-lost-labels");
      const { result } = await transcribe(rig, k.key, NOTE, { diarize: "true" });
      expect(RESULT.safeParse(result).error?.issues ?? []).toEqual([]);
      expect(result.text).toBe("hello world");
      expect(result.speakers).toEqual({
        asked: true,
        labelled: false,
        error: "no akou-diarize command",
      });
      expect(result.warnings).toEqual([expect.stringContaining("no akou-diarize command")]);
      expect(result.engine.models).toEqual(["fake-parakeet", "silero-vad"]);
      // Positive control: the same job on a working speaker model names it and warns of nothing.
      const ok = await transcribe(server, (await newKey(server, "j4-labels")).key, NOTE, {
        diarize: "true",
      });
      expect(ok.result.speakers).toEqual({ asked: true, labelled: true, error: null });
      expect(ok.result.warnings).toEqual([]);
      expect(ok.result.engine.models.length).toBeGreaterThan(2);
    } finally {
      await rig.close();
    }
  });

  for (const preset of ["lite"]) {
    test(`the ${preset} preset is not built: 409 preset_unavailable, and nothing is queued`, async () => {
      const k = await newKey(server, `j4-${preset}`);
      const r = await submit(server, k.key, NOTE, { preset });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: "preset_unavailable", preset });
      expect((await call(server, k.key, "GET", "/jobs")).body.jobs).toEqual([]);
    });
  }

  test("engine.models names model ids the engine registry knows, for the real recognizer", () => {
    const spec: ModelSpec = { kind: "sherpa", dir: "/models", cacheDir: "/cache" };
    const ids = new Set(MODELS.map((m) => m.id));
    for (const diarize of [false, true]) {
      for (const diarizer of ["nemotron", "embeddings"] as const) {
        for (const id of jobModels(modelNameFor(spec), diarize, diarizer))
          expect(ids.has(id)).toBe(true);
      }
    }
    // Positive control: a name outside the registry is caught.
    expect(ids.has(jobModels("fake-parakeet", false, "nemotron")[0] as string)).toBe(false);
  });

  test("with diarize, segments carry speaker labels, never `you`", async () => {
    const k = await newKey(server, "j4-diarize");
    const two = monoWav(
      concat(
        silence(0.4),
        speak(["hello", "world"]),
        silence(0.8),
        speak(["ok", "great"], { voice: 2 }),
        silence(0.6),
      ),
    );
    const { result } = await transcribe(server, k.key, two, { diarize: "true" });
    const speakers = new Set(result.segments.map((s: { speaker: string | null }) => s.speaker));
    expect(speakers.size).toBe(2);
    expect(speakers.has(null)).toBe(false);
    expect(speakers.has("you")).toBe(false);
  });
});

describe("SV-J5: ?format on the result route", () => {
  /** 30 s: one 47-character run of speech, then two short ones ten seconds apart. */
  const LONG = monoWav(
    concat(
      silence(0.4),
      speak(["hello", "world", "we", "should", "move", "the", "build", "to", "new", "box"], {
        gapSeconds: 0.05,
      }),
      silence(10),
      speak(["ok", "great"]),
      silence(10),
      speak(["yes"], { wordSeconds: 0.4 }),
      silence(6),
    ),
  );

  test("srt: cues of at most 42 characters from the words, which ffmpeg reads as subtitles", async () => {
    const k = await newKey(server, "j5-srt");
    const { id, result } = await transcribe(server, k.key, LONG);
    expect(result.duration_s).toBeGreaterThanOrEqual(30);
    expect(result.segments.length).toBe(3);
    const r = await call(server, k.key, "GET", `/jobs/${id}/result?format=srt`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toStartWith("text/plain");
    const cues = r.text.trim().split("\n\n");
    // The 47-character run is two cues; the segments alone would make it one.
    expect(cues.length).toBe(4);
    for (const c of cues) {
      const [n, times, ...lines] = c.split("\n");
      expect(Number(n)).toBeGreaterThan(0);
      expect(times).toMatch(/^\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}$/);
      expect(lines.join(" ").length).toBeLessThanOrEqual(42);
    }
    expect(cues.map((c) => c.split("\n").slice(2).join(" ")).join(" ")).toBe(result.text);
  });

  const ffmpeg = Bun.which("ffmpeg");
  test.skipIf(!ffmpeg)(
    "the srt of a 30 s clip opens in ffmpeg with the right count of cues (skipped when ffmpeg is not installed)",
    async () => {
      const k = await newKey(server, "j5-ffmpeg");
      const { id } = await transcribe(server, k.key, LONG);
      const r = await call(server, k.key, "GET", `/jobs/${id}/result?format=srt`);
      const t = tempDir("akou-srt-");
      try {
        const path = join(t.dir, "cues.srt");
        writeFileSync(path, r.text);
        const out = Bun.spawnSync([
          ffmpeg as string,
          "-v",
          "error",
          "-i",
          path,
          "-f",
          "webvtt",
          "-",
        ]);
        expect(out.stderr.toString()).toBe("");
        expect(out.exitCode).toBe(0);
        expect(out.stdout.toString().match(/ --> /g)?.length).toBe(4);
      } finally {
        t.cleanup();
      }
    },
  );

  test("vtt starts with WEBVTT; text, verbose_json and json answer their shapes; another format is 400", async () => {
    const k = await newKey(server, "j5-formats");
    const { id, result } = await transcribe(server, k.key, NOTE);
    const v = await call(server, k.key, "GET", `/jobs/${id}/result?format=vtt`);
    expect(v.text.startsWith("WEBVTT\n")).toBe(true);
    expect(v.text).toContain("hello world");
    const t = await call(server, k.key, "GET", `/jobs/${id}/result?format=text`);
    expect(t.text).toBe("hello world\n");
    const vj = await call(server, k.key, "GET", `/jobs/${id}/result?format=verbose_json`);
    expect(vj.body).toMatchObject({ text: "hello world", duration: result.duration_s });
    expect(vj.body.segments[0]).toMatchObject({ id: 0, start: result.segments[0].s });
    const j = await call(server, k.key, "GET", `/jobs/${id}/result?format=json`);
    expect(j.body).toEqual(result);
    const bad = await call(server, k.key, "GET", `/jobs/${id}/result?format=docx`);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: "bad_param", param: "format" });
  });
});

describe("SV-J6: delete and retention", () => {
  test("after delete the job answers 410, the upload is gone and the feed keeps the id and final state", async () => {
    const k = await newKey(server, "j6");
    const { id } = await transcribe(server, k.key, NOTE, { metadata: '{"secret": "x"}' });
    const del = await call(server, k.key, "DELETE", `/jobs/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ id, status: "done", deleted: true });
    expect((await call(server, k.key, "GET", `/jobs/${id}/result`)).status).toBe(410);
    expect((await call(server, k.key, "GET", `/jobs/${id}`)).status).toBe(410);
    expect(audioFiles(server).length).toBe(0);
    const feed = await call(server, k.key, "GET", "/events");
    expect(feed.body.events.map((e: { data: unknown }) => e.data)).toEqual([
      { job_id: id, status: "done", deleted: true },
    ]);
    expect((await call(server, k.key, "DELETE", `/jobs/${id}`)).status).toBe(410);
    // Another key never had it: 404, as for an id that never was.
    const other = await newKey(server, "j6-other");
    expect((await call(server, other.key, "GET", `/jobs/${id}`)).status).toBe(404);
  });

  test("a queued job is dropped with its upload, and its feed says cancelled", async () => {
    const g = gate();
    const rig = await appRig({ settings: SERVER, jobs: { decode: g.decode } });
    try {
      const k = await newKey(rig, "j6-queued");
      await submit(rig, k.key, NOTE);
      const q = await submit(rig, k.key, OTHER_NOTE, { metadata: '{"content_hash": "abc"}' });
      expect(audioFiles(rig).length).toBe(2);
      const del = await call(rig, k.key, "DELETE", `/jobs/${q.body.id}`);
      expect(del.body).toMatchObject({ id: q.body.id, status: "cancelled" });
      expect(audioFiles(rig).length).toBe(1);
      const feed = await call(rig, k.key, "GET", "/events");
      expect(feed.body.events.map((e: { type: string }) => e.type)).toEqual([
        "transcription.cancelled",
      ]);
      // SV-E3: it carries the job's metadata, as a failed event does, so the client can match it;
      // it never carried a result, so it is not marked deleted.
      expect(feed.body.events[0].data).toEqual({
        job_id: q.body.id,
        status: "cancelled",
        metadata: { content_hash: "abc" },
      });
    } finally {
      g.open();
      await rig.close();
    }
  });

  test("a delete during a run makes a pending long-poll answer cancelled within two seconds", async () => {
    // Every decode busy-waits 20 s, so the job is stuck inside the Worker when the delete comes.
    const slow: ModelSpec = {
      kind: "module",
      path: FAKE_MODELS,
      model: "fake-parakeet",
      options: { slowMs: 20_000 },
    };
    const rig = await appRig({ settings: SERVER, models: slow });
    try {
      const k = await newKey(rig, "j6-running");
      const s = await submit(rig, k.key, NOTE);
      await until(
        async () => (await call(rig, k.key, "GET", `/jobs/${s.body.id}`)).body.status === "running",
        5000,
        "the job to run",
      );
      // Past the decode of the upload: the Worker has the samples and is decoding.
      await Bun.sleep(500);
      const poll = call(rig, k.key, "GET", `/jobs/${s.body.id}?wait=60`);
      await Bun.sleep(100);
      const t0 = performance.now();
      const del = await call(rig, k.key, "DELETE", `/jobs/${s.body.id}`);
      expect(del.body.status).toBe("cancelled");
      const answered = await poll;
      expect(answered.body.status).toBe("cancelled");
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(audioFiles(rig)).toEqual([]);
      // The Worker was terminated, not left decoding: the next job (digital silence, which needs
      // no decode) runs at once in a fresh Worker instead of finding it busy.
      const next = await submit(rig, k.key, monoWav(silence(2)));
      const after = await call(rig, k.key, "GET", `/jobs/${next.body.id}?wait=60`);
      expect(`${after.body.status} ${after.body.error?.message ?? ""}`).toBe("done ");
      expect(performance.now() - t0).toBeLessThan(4000);
    } finally {
      await rig.close();
    }
  });

  test("after the retention timer the same holds for an untouched job", async () => {
    let now = Date.now();
    const rig = await appRig({
      settings: { ...SERVER, "server.retain_days": 7 },
      jobs: { now: () => now },
    });
    try {
      const k = await newKey(rig, "j6-retain");
      const { id } = await transcribe(rig, k.key, NOTE);
      const jobs = rig.app.jobs();
      if (!jobs) throw new Error("no job service");
      now += 6 * 86_400_000;
      expect(jobs.sweep()).toBe(0);
      expect((await call(rig, k.key, "GET", `/jobs/${id}/result`)).status).toBe(200);
      now += 86_400_000 + 1;
      expect(jobs.sweep()).toBe(1);
      // Expired: 410 with the window named, on the job and its result; a typo stays 404.
      for (const path of [`/jobs/${id}`, `/jobs/${id}/result`]) {
        const gone = await call(rig, k.key, "GET", path);
        expect(gone.status).toBe(410);
        expect(gone.body).toMatchObject({ error: "gone", id, retain_days: 7 });
        expect(gone.body.message).toContain("7 days");
      }
      const typo = await call(rig, k.key, "GET", `/jobs/${id}x`);
      expect(typo.status).toBe(404);
      expect(typo.body.error).toBe("not_found");
      const feed = await call(rig, k.key, "GET", "/events");
      expect(feed.body.events.map((e: { data: unknown }) => e.data)).toEqual([
        { job_id: id, status: "done", deleted: true },
      ]);
    } finally {
      await rig.close();
    }
  });
  test("retention strips a cancelled event's metadata once the event is older than the timer", async () => {
    let now = Date.now();
    const g = gate();
    const rig = await appRig({
      settings: { ...SERVER, "server.retain_days": 7 },
      jobs: { decode: g.decode, now: () => now },
    });
    try {
      const k = await newKey(rig, "j6-scrub");
      const first = await submit(rig, k.key, NOTE);
      const q = await submit(rig, k.key, OTHER_NOTE, { metadata: '{"content_hash": "abc"}' });
      await call(rig, k.key, "DELETE", `/jobs/${q.body.id}`);
      g.open();
      const done = await call(rig, k.key, "GET", `/jobs/${first.body.id}?wait=60`);
      expect(done.body.status).toBe("done");
      await call(rig, k.key, "DELETE", `/jobs/${first.body.id}`);
      const jobs = rig.app.jobs();
      if (!jobs) throw new Error("no job service");
      const cancelled = async () =>
        (await call(rig, k.key, "GET", "/events")).body.events.find(
          (e: { type: string }) => e.type === "transcription.cancelled",
        ).data;
      now += 6 * 86_400_000;
      expect(jobs.sweep()).toBe(0);
      expect(await cancelled()).toEqual({
        job_id: q.body.id,
        status: "cancelled",
        metadata: { content_hash: "abc" },
      });
      now += 86_400_000 + 1;
      expect(jobs.sweep()).toBe(0);
      expect(await cancelled()).toEqual({ job_id: q.body.id, status: "cancelled", deleted: true });
    } finally {
      g.open();
      await rig.close();
    }
  });
});

describe("akou-5an.116 and .115: a running job says where it is, a done one how long each stage took", () => {
  test("polling a diarized job shows the stage and the seconds done moving, then the stage times", async () => {
    // Every decode busy-waits, so the transcribe stage lasts long enough to be seen moving.
    const slow: ModelSpec = {
      kind: "module",
      path: FAKE_MODELS,
      model: "fake-parakeet",
      options: { slowMs: 400 },
    };
    const rig = await appRig({ settings: SERVER, models: slow });
    try {
      const k = await newKey(rig, "progress");
      const clip = monoWav(
        concat(
          silence(0.3),
          speak(["hello", "world"]),
          silence(1.5),
          speak(["ok", "great"]),
          silence(1.5),
          speak(["thanks"]),
          silence(1.5),
          speak(["deploy"]),
          silence(0.3),
        ),
      );
      const s = await submit(rig, k.key, clip, { diarize: "true" });
      expect(s.status).toBe(202);
      const seen: { stage: string; done_s: number; total_s: number | null }[] = [];
      let job = s.body;
      while (job.status === "queued" || job.status === "running") {
        if (job.progress) seen.push(job.progress);
        await Bun.sleep(25);
        job = (await call(rig, k.key, "GET", `/jobs/${s.body.id}`)).body;
      }
      expect(`${job.status} ${job.error?.message ?? ""}`).toBe("done ");
      const done = seen.filter((p) => p.stage === "transcribe").map((p) => p.done_s);
      expect(new Set(done).size).toBeGreaterThan(1);
      expect(Math.max(...done)).toBeGreaterThan(Math.min(...done));
      for (const p of seen) expect(["decode", "diarize", "transcribe"]).toContain(p.stage);
      // Done: no progress any more, and the stage times on the job and in the result.
      expect(job.progress).toBeUndefined();
      expect(job.timings).toMatchObject({
        decode_s: expect.any(Number),
        diarize_s: expect.any(Number),
      });
      expect(job.timings.transcribe_s).toBeGreaterThan(1);
      const r = await call(rig, k.key, "GET", `/jobs/${s.body.id}/result`);
      expect(r.body.timings).toEqual(job.timings);
    } finally {
      await rig.close();
    }
  });
});

describe("SV-J9: the job store", () => {
  test("a server restarted mid-queue resumes the queued jobs in order and loses no event", async () => {
    const home = tempDir("akou-jobs-restart-");
    const g = gate();
    const first = await appRig({ settings: SERVER, home: home.dir, jobs: { decode: g.decode } });
    let second: AppRig | null = null;
    try {
      const k = await newKey(first, "restart");
      const ids: string[] = [];
      for (const f of [NOTE, OTHER_NOTE, NOTE]) ids.push((await submit(first, k.key, f)).body.id);
      await until(
        async () => (await call(first, k.key, "GET", `/jobs/${ids[0]}`)).body.status === "running",
        5000,
        "the first job to run",
      );
      await first.app.quit();
      second = await appRig({ settings: SERVER, home: home.dir });
      const s = second;
      for (const id of ids)
        expect((await call(s, k.key, "GET", `/jobs/${id}?wait=60`)).body.status).toBe("done");
      const listed = (await call(s, k.key, "GET", "/jobs")).body.jobs as {
        id: string;
        started_at: string;
      }[];
      const started = [...listed].sort(
        (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
      );
      expect(started.map((j) => j.id)).toEqual(ids);
      const feed = await call(s, k.key, "GET", "/events");
      expect(feed.body.events.map((e: { job_id: string }) => e.job_id)).toEqual(ids);
      // The store holds the three tables and nothing else, and no call folder was made.
      const { Database } = await import("bun:sqlite");
      const db = new Database(join(s.app.configDir, "jobs", JOBS_DB), { readonly: true });
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      db.close();
      expect(tables.map((t) => t.name)).toEqual(["events", "jobs", "outbox"]);
      expect((await s.api("GET", "/calls")).body.calls).toEqual([]);
    } finally {
      g.open();
      await second?.close();
      home.cleanup();
    }
  });
});

describe("SV-E1: the per-key event feed", () => {
  test("a client that missed a day reads every outcome since its cursor in one call, oldest first", async () => {
    const k = await newKey(server, "e1");
    const other = await newKey(server, "e1-other");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await transcribe(server, k.key, NOTE)).id);
    await transcribe(server, other.key, NOTE);
    const all = await call(server, k.key, "GET", "/events?after=0");
    expect(all.body.events.map((e: { job_id: string }) => e.job_id)).toEqual(ids);
    expect(
      all.body.events.every((e: { type: string }) => e.type === "transcription.completed"),
    ).toBe(true);
    expect(all.body.events[0].data.text).toBe("hello world");
    expect(all.body.has_more).toBe(false);
    // A page that ends before the key's last event says so.
    const two = await call(server, k.key, "GET", "/events?after=0&limit=2");
    expect(two.body.events.map((e: { job_id: string }) => e.job_id)).toEqual(ids.slice(0, 2));
    expect(two.body.has_more).toBe(true);
    const cursor = all.body.events[0].cursor;
    const later = await call(server, k.key, "GET", `/events?after=${cursor}`);
    expect(later.body.events.map((e: { job_id: string }) => e.job_id)).toEqual(ids.slice(1));
    expect(later.body.cursor).toBe(all.body.cursor);
    // Nothing new: the same cursor comes back.
    const none = await call(server, k.key, "GET", `/events?after=${all.body.cursor}`);
    expect(none.body).toEqual({
      events: [],
      cursor: all.body.cursor,
      has_more: false,
      feed_id: all.body.feed_id,
    });
  });

  test("the page names its feed: the same across a restart, a new one once jobs.db is reset", async () => {
    const home = tempDir("akou-feed-id-");
    let rig: AppRig | null = await appRig({ settings: SERVER, home: home.dir });
    try {
      const k = await newKey(rig, "e1-feed-id");
      await transcribe(rig, k.key, NOTE);
      const first = (await call(rig, k.key, "GET", "/events")).body;
      expect(first.feed_id).toMatch(/^feed_[0-9a-f]{8}$/);
      expect(first.cursor).toBeGreaterThan(0);
      const db = join(rig.app.configDir, "jobs", JOBS_DB);
      await rig.app.quit();
      rig = null;
      rig = await appRig({ settings: SERVER, home: home.dir });
      expect((await call(rig, k.key, "GET", "/events")).body.feed_id).toBe(first.feed_id);
      await rig.app.quit();
      rig = null;
      for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
      rig = await appRig({ settings: SERVER, home: home.dir });
      // The reset feed starts again at 0: a client holding the old cursor sees the id change.
      const reset = (await call(rig, k.key, "GET", `/events?after=${first.cursor}`)).body;
      expect(reset.feed_id).toMatch(/^feed_[0-9a-f]{8}$/);
      expect(reset.feed_id).not.toBe(first.feed_id);
    } finally {
      await rig?.close();
      home.cleanup();
    }
  });

  test("wait holds the request until the key's next outcome", async () => {
    const k = await newKey(server, "e1-wait");
    const start = await call(server, k.key, "GET", "/events");
    const pending = call(server, k.key, "GET", `/events?after=${start.body.cursor}&wait=30`);
    const { id } = await transcribe(server, k.key, NOTE);
    const got = await pending;
    expect(got.body.events.map((e: { job_id: string }) => e.job_id)).toEqual([id]);
  });

  test("Accept: text/event-stream gives the same feed as SSE, resumable with Last-Event-ID", async () => {
    const k = await newKey(server, "e1-sse");
    const ids = [
      (await transcribe(server, k.key, NOTE)).id,
      (await transcribe(server, k.key, NOTE)).id,
    ];
    const read = async (headers: Record<string, string>, want: number) => {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/events`, {
        headers: { authorization: `Bearer ${k.key}`, accept: "text/event-stream", ...headers },
        signal: ac.signal,
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let text = "";
      const events: { id: string; job_id: string }[] = [];
      while (events.length < want) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        const frames = text.split("\n\n");
        text = frames.pop() ?? "";
        for (const f of frames) {
          const id = /^id: (.+)$/m.exec(f)?.[1];
          const data = /^data: (.+)$/m.exec(f)?.[1];
          if (id && data) events.push({ id, job_id: JSON.parse(data).job_id });
        }
      }
      ac.abort();
      return events;
    };
    const both = await read({}, 2);
    expect(both.map((e) => e.job_id)).toEqual(ids);
    const third = (await transcribe(server, k.key, NOTE)).id;
    const resumed = await read({ "last-event-id": both[1]?.id as string }, 1);
    expect(resumed.map((e) => e.job_id)).toEqual([third]);
  });
});

describe("SV-K4 and SV-E7 at submit: the callback host and its address", () => {
  const cb = (rig: AppRig, key: string, url: string) =>
    submit(rig, key, NOTE, { callback_url: url });

  test("a key with --callback-host archive.lan accepts https://archive.lan/api/x and refuses https://other.lan/", async () => {
    const k = await newKey(server, "k4-named", ["archive.lan"]);
    expect((await cb(server, k.key, "https://archive.lan/api/x")).status).toBe(202);
    const other = await cb(server, k.key, "https://other.lan/");
    expect(other.status).toBe(422);
    expect(other.body.error).toBe("callback_not_allowed");
  });

  test("a key with --callback-host '*' accepts both", async () => {
    const k = await newKey(server, "k4-star", ["*"]);
    expect((await cb(server, k.key, "https://archive.lan/api/x")).status).toBe(202);
    expect((await cb(server, k.key, "https://other.lan/")).status).toBe(202);
  });

  test("a key with only * is refused for 10.0.0.5 and 127.0.0.1; the same key with 10.0.0.5 listed is accepted there", async () => {
    const star = await newKey(server, "k4-star-only", ["*"]);
    for (const url of ["http://10.0.0.5/hook", "http://127.0.0.1:9/hook"]) {
      const r = await cb(server, star.key, url);
      expect(`${url} ${r.status} ${r.body.error}`).toBe(`${url} 422 callback_not_allowed`);
    }
    const listed = await newKey(server, "k4-listed", ["*", "10.0.0.5"]);
    expect((await cb(server, listed.key, "http://10.0.0.5/hook")).status).toBe(202);
    expect((await cb(server, listed.key, "http://127.0.0.1:9/hook")).status).toBe(422);
  });

  test("a callback to http://169.254.169.254/ gets 422 at submit, even from a key that lists it", async () => {
    const k = await newKey(server, "e7-metadata", ["*", "169.254.169.254", "fd00:ec2::254"]);
    for (const url of ["http://169.254.169.254/", "http://[fd00:ec2::254]/"]) {
      const r = await cb(server, k.key, url);
      expect(`${url} ${r.status} ${r.body.error}`).toBe(`${url} 422 callback_not_allowed`);
    }
    // Cleartext to a public address is refused too; https to the same host is taken.
    const pub = await newKey(server, "e7-public", ["203.0.113.7"]);
    expect((await cb(server, pub.key, "http://203.0.113.7/hook")).status).toBe(422);
    expect((await cb(server, pub.key, "https://203.0.113.7/hook")).status).toBe(202);
  });
});

describe("SV-E7, SV-E2, SV-E3: a signed delivery to a real receiver", () => {
  test("a callback to http://127.0.0.1:PORT/ from a key that allows that host is delivered, signed, with the text inline", async () => {
    const hits: { headers: Record<string, string>; body: string }[] = [];
    const receiver = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        hits.push({ headers: Object.fromEntries(req.headers), body: await req.text() });
        return new Response(null, { status: 204 });
      },
    });
    try {
      const k = await newKey(server, "e7-loopback", ["127.0.0.1"]);
      const s = await submit(server, k.key, clip(["hello", "world"], 20), {
        callback_url: `http://127.0.0.1:${receiver.port}/api/transcriptions/callback`,
        metadata: '{"content_hash": "abc"}',
      });
      expect(s.status).toBe(202);
      await until(() => hits.length === 1, 10_000, "the delivery");
      const hit = hits[0] as { headers: Record<string, string>; body: string };
      const payload = new Webhook(k.secret).verify(hit.body, hit.headers) as {
        type: string;
        data: { job_id: string; text: string; metadata: unknown };
      };
      expect(payload.type).toBe("transcription.completed");
      expect(payload.data).toMatchObject({
        job_id: s.body.id,
        text: "hello world",
        metadata: { content_hash: "abc" },
      });
      // The webhook-id is the feed event's id, so a receiver can tell a retry from a new event.
      const feed = await call(server, k.key, "GET", "/events");
      expect(feed.body.events[0].id).toBe(hit.headers["webhook-id"]);
      // Positive control: another key's secret does not verify it.
      const other = await newKey(server, "e7-other");
      expect(() => new Webhook(other.secret).verify(hit.body, hit.headers)).toThrow();
    } finally {
      receiver.stop(true);
    }
  });
});

describe("SV-R5: silence through every preset", () => {
  const noise = monoWav(roomNoise(10));

  for (const preset of ["fast", "auto"]) {
    test(`ten seconds of room noise through ${preset} return empty text, done`, async () => {
      const k = await newKey(server, `r5-${preset}`);
      const { job, result } = await transcribe(server, k.key, noise, { preset });
      expect(job.status).toBe("done");
      expect(result.text).toBe("");
      expect(result.segments).toEqual([]);
      expect(result.duration_s).toBe(10);
    });
  }
});

describe("SV-D1: transcribing a file is a product feature", () => {
  function noteFile(): { path: string; cleanup: () => void } {
    const t = tempDir("akou-transcribe-");
    const path = join(t.dir, "note.wav");
    writeFileSync(path, NOTE);
    return { path, cleanup: t.cleanup };
  }

  test("akou transcribe FILE against a server prints the transcript and exits 0", async () => {
    const f = noteFile();
    try {
      const r = await cli({ ...process.env, ...server.env }, ["transcribe", f.path]);
      expect(`${r.code} ${r.out}`).toBe("0 hello world");
      const j = await cli({ ...process.env, ...server.env }, ["transcribe", f.path, "--json"]);
      expect(j.code).toBe(0);
      expect(j.json).toMatchObject({
        status: "done",
        text: "hello world",
        engine: { name: "akou" },
      });
    } finally {
      f.cleanup();
    }
  });

  test("the job is deleted once its transcript is printed: the server keeps no copy", async () => {
    const f = noteFile();
    try {
      const j = await cli({ ...process.env, ...server.env }, ["transcribe", f.path, "--json"]);
      expect(j.code).toBe(0);
      const id = (j.json as { job_id: string }).job_id;
      expect(id).toMatch(/^job_/);
      expect((await server.api("GET", `/jobs/${id}`)).status).toBe(410);
    } finally {
      f.cleanup();
    }
  });

  test("no speech prints nothing on stdout, so a pipe saves no placeholder", async () => {
    const t = tempDir("akou-transcribe-silent-");
    try {
      const path = join(t.dir, "silent.wav");
      writeFileSync(path, monoWav(silence(2)));
      const r = await cli({ ...process.env, ...server.env }, ["transcribe", path]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toContain("no speech");
    } finally {
      t.cleanup();
    }
  });

  test("a preset that is not built is refused with the reason", async () => {
    const f = noteFile();
    try {
      const r = await cli({ ...process.env, ...server.env }, [
        "transcribe",
        f.path,
        "--preset",
        "lite",
      ]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("not built");
    } finally {
      f.cleanup();
    }
  });

  test("--keyword, --keywords-file and --priority: the server takes them, and its refusals print as it words them", async () => {
    const f = noteFile();
    const t = tempDir("akou-transcribe-keywords-");
    const env = { ...process.env, ...server.env };
    const terms = (lines: string[]) => {
      const path = join(t.dir, `terms-${lines.length}-${lines[0]?.length}.txt`);
      writeFileSync(path, `${lines.join("\n")}\n`);
      return path;
    };
    try {
      const ok = await cli(env, [
        "transcribe",
        f.path,
        "--keywords-file",
        terms(["Hetzner", "", "Kubernetes"]),
        "--keyword",
        "Terraform",
        "--priority",
        "5",
      ]);
      expect(`${ok.code} ${ok.out}`).toBe("0 hello world");
      // 25 keywords, a keyword of 101 characters, priority 11: each refused by the server (exit
      // 64, nothing on stdout) in the server's words, which the CLI does not repeat on its own.
      const many = Array.from({ length: 25 }, (_, i) => `term${i}`);
      const refusals: [string[], string][] = [
        [["--keywords-file", terms(many)], "at most 24 keywords"],
        [["--keyword", "x".repeat(101)], "a keyword is at most 100 characters"],
        [["--priority", "11"], "priority is a whole number from -10 to 10"],
      ];
      for (const [args, words] of refusals) {
        const r = await cli(env, ["transcribe", f.path, ...args]);
        expect([r.code, r.out, r.err]).toEqual([64, "", `akou: ${words}`]);
      }
      // Positive control: 24 keywords, the most there may be, are taken.
      const most = await cli(env, [
        "transcribe",
        f.path,
        "--keywords-file",
        terms(many.slice(0, 24)),
      ]);
      expect(`${most.code} ${most.out}`).toBe("0 hello world");
      const missing = await cli(env, [
        "transcribe",
        f.path,
        "--keywords-file",
        join(t.dir, "nope"),
      ]);
      expect(missing.code).toBe(64);
    } finally {
      f.cleanup();
      t.cleanup();
    }
  });

  test("--keyword, --keywords-file and --priority send the fields the HTTP door reads: keywords[] and priority", async () => {
    const f = noteFile();
    const t = tempDir("akou-transcribe-form-");
    const sent: { keywords: unknown[]; priority: unknown[] }[] = [];
    // A stand-in for the server that keeps each submitted form; the real route reads these
    // fields in the test above.
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/v1/server") return Response.json({ capabilities: { jobs: true } });
        if (req.method === "POST" && path === "/v1/jobs") {
          const form = await req.formData();
          sent.push({ keywords: form.getAll("keywords[]"), priority: form.getAll("priority") });
          return Response.json({ id: "job_1", status: "done" }, { status: 202 });
        }
        if (path === "/v1/jobs/job_1/result") return Response.json({ text: "hello world" });
        return new Response(null, { status: 204 });
      },
    });
    try {
      const terms = join(t.dir, "terms.txt");
      writeFileSync(terms, "Hetzner\r\n\n  Kubernetes  \n");
      const env = {
        ...process.env,
        AKOU_HOME: t.dir,
        AKOU_URL: `http://127.0.0.1:${fake.port}`,
        AKOU_API_KEY: "ak_transcribe-form-test",
      };
      const r = await cli(env, [
        "transcribe",
        f.path,
        "--keyword",
        "Terraform",
        "--keywords-file",
        terms,
        "--keyword",
        "Ceph",
        "--priority",
        "-3",
      ]);
      expect(`${r.code} ${r.out} ${r.err}`).toBe("0 hello world ");
      expect(sent[0]).toEqual({
        keywords: ["Terraform", "Ceph", "Hetzner", "Kubernetes"],
        priority: ["-3"],
      });
      // Without the flags, neither field is sent, so the server's defaults apply.
      await cli(env, ["transcribe", f.path]);
      expect(sent[1]).toEqual({ keywords: [], priority: [] });
    } finally {
      fake.stop(true);
      f.cleanup();
      t.cleanup();
    }
  });

  test("akou transcribe FILE on the desktop app prints the transcript, and akou jobs list shows it done", async () => {
    const f = noteFile();
    try {
      const r = await cli({ ...process.env, ...app.env }, [
        "transcribe",
        f.path,
        "--preset",
        "fast",
      ]);
      expect(`${r.code} ${r.out}`).toBe("0 hello world");
      const j = await cli({ ...process.env, ...app.env }, ["transcribe", f.path, "--json"]);
      expect(j.code).toBe(0);
      const id = (j.json as { job_id: string }).job_id;
      // The app keeps the job for the list, unlike a server (the test above).
      const list = await cli({ ...process.env, ...app.env }, ["jobs", "list", "--json"]);
      expect(list.code).toBe(0);
      expect((list.json as { jobs: { id: string; status: string }[] }).jobs).toContainEqual(
        expect.objectContaining({ id, status: "done" }),
      );
      const text = await cli({ ...process.env, ...app.env }, ["jobs", "list"]);
      expect(text.out).toContain(`${id}  done`);
      // Nothing points at server mode any more.
      expect(`${r.err}${list.out}${text.out}`).not.toContain("server.enabled");
    } finally {
      f.cleanup();
    }
  });

  test("an akou with no job routes: exit 69, pointing at an update or AKOU_URL, never server.enabled or akou serve", async () => {
    // An akou older than file jobs in the desktop app: its GET /v1/server says jobs: false.
    const old = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname === "/v1/server"
          ? Response.json({ name: "akou", mode: "app", capabilities: { jobs: false } })
          : Response.json({ error: "not_found", message: "no route" }, { status: 404 }),
    });
    const f = noteFile();
    try {
      const env = {
        ...process.env,
        AKOU_URL: `http://127.0.0.1:${old.port}`,
        AKOU_API_KEY: "ak_test_unused",
      };
      const r = await cli(env, ["transcribe", f.path, "--json"]);
      expect(r.code).toBe(69);
      expect(r.json).toMatchObject({ error: "no_jobs" });
      for (const stale of ["server.enabled", "akou serve"]) expect(r.out).not.toContain(stale);
      // Positive control: the desktop app itself takes the same file.
      const ok = await cli({ ...process.env, ...app.env }, ["transcribe", f.path]);
      expect(ok.code).toBe(0);
    } finally {
      f.cleanup();
      old.stop(true);
    }
  });

  test("with nothing running it exits 69, and a missing file is a usage error", async () => {
    const f = noteFile();
    const empty = tempDir("akou-transcribe-none-");
    try {
      const r = await cli({ ...process.env, AKOU_HOME: empty.dir }, ["transcribe", f.path]);
      expect(r.code).toBe(69);
      const missing = await cli({ ...process.env, ...server.env }, [
        "transcribe",
        join(empty.dir, "nope.ogg"),
      ]);
      expect(missing.code).toBe(64);
    } finally {
      f.cleanup();
      empty.cleanup();
    }
  });
});
