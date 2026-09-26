/**
 * File jobs in server mode (docs/ux/SERVER.md sections 5 and 6), end to end through the real API:
 * the submit and its fields (SV-J1), idempotency (SV-J2), states and the long-poll (SV-J3), the
 * result shape (SV-J4), delete and retention (SV-J6), the store across a restart (SV-J9), the
 * per-key feed (SV-E1), the callback-host allowlist at submit (SV-K4), the address rules and a
 * signed delivery to a real receiver (SV-E7, SV-E2, SV-E3), and silence (SV-R5). The recognizer is
 * the fake engine in a real finalize Worker, reading uploads as 16 kHz WAVs.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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

beforeAll(async () => {
  server = await appRig({ settings: SERVER });
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

  test("the job routes exist in server mode only: the desktop app answers 404", async () => {
    const routes = (s: AppRig) =>
      (s.app.server?.routes() ?? []).map((r) => `${r.method} ${r.path}`);
    expect(routes(app)).not.toContain("POST /v1/jobs");
    expect((await call(app, app.token, "GET", "/jobs")).status).toBe(404);
    // Positive control: the server has it.
    expect(routes(server)).toContain("POST /v1/jobs");
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
      // Metadata and options are not part of the comparison, only the file.
      const second = await submit(
        rig,
        k.key,
        NOTE,
        { metadata: '{"row": 2}', preset: "fast" },
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
    expect(other.body).toMatchObject({ error: "idempotency_conflict", id: first.body.id });
    await call(server, k.key, "GET", `/jobs/${first.body.id}?wait=60`);
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

/** The result of SV-J4, as a schema: no field missing, none extra. */
const RESULT = z
  .object({
    job_id: z.string().startsWith("job_"),
    status: z.literal("done"),
    text: z.string(),
    language: z.string().nullable(),
    language_confidence: z.number().nullable(),
    duration_s: z.number().nonnegative(),
    words: z.array(
      z.object({ w: z.string(), s: z.number(), e: z.number(), c: z.number() }).strict(),
    ),
    segments: z.array(
      z
        .object({ s: z.number(), e: z.number(), text: z.string(), speaker: z.string().nullable() })
        .strict(),
    ),
    engine: z
      .object({
        name: z.literal("akou"),
        version: z.string(),
        preset: z.string(),
        models: z.array(z.string()).min(1),
      })
      .strict(),
    confidence: z.number().nullable(),
    metadata: z.unknown(),
  })
  .strict();

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

  for (const preset of ["lite", "best", "fusion"]) {
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

describe("SV-J6: delete and retention", () => {
  test("after delete the result route answers 404, the upload is gone and the feed keeps the id and final state", async () => {
    const k = await newKey(server, "j6");
    const { id } = await transcribe(server, k.key, NOTE, { metadata: '{"secret": "x"}' });
    const del = await call(server, k.key, "DELETE", `/jobs/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ id, status: "done", deleted: true });
    expect((await call(server, k.key, "GET", `/jobs/${id}/result`)).status).toBe(404);
    expect((await call(server, k.key, "GET", `/jobs/${id}`)).status).toBe(404);
    expect(audioFiles(server).length).toBe(0);
    const feed = await call(server, k.key, "GET", "/events");
    expect(feed.body.events.map((e: { data: unknown }) => e.data)).toEqual([
      { job_id: id, status: "done", deleted: true },
    ]);
    expect((await call(server, k.key, "DELETE", `/jobs/${id}`)).status).toBe(404);
  });

  test("a queued job is dropped with its upload, and its feed says cancelled", async () => {
    const g = gate();
    const rig = await appRig({ settings: SERVER, jobs: { decode: g.decode } });
    try {
      const k = await newKey(rig, "j6-queued");
      await submit(rig, k.key, NOTE);
      const q = await submit(rig, k.key, OTHER_NOTE);
      expect(audioFiles(rig).length).toBe(2);
      const del = await call(rig, k.key, "DELETE", `/jobs/${q.body.id}`);
      expect(del.body).toMatchObject({ id: q.body.id, status: "cancelled" });
      expect(audioFiles(rig).length).toBe(1);
      const feed = await call(rig, k.key, "GET", "/events");
      expect(feed.body.events.map((e: { type: string }) => e.type)).toEqual([
        "transcription.cancelled",
      ]);
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
      expect((await call(rig, k.key, "GET", `/jobs/${id}/result`)).status).toBe(404);
      const feed = await call(rig, k.key, "GET", "/events");
      expect(feed.body.events.map((e: { data: unknown }) => e.data)).toEqual([
        { job_id: id, status: "done", deleted: true },
      ]);
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
    expect(none.body).toEqual({ events: [], cursor: all.body.cursor, has_more: false });
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
      expect((await server.api("GET", `/jobs/${id}`)).status).toBe(404);
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
        "best",
      ]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("not built");
    } finally {
      f.cleanup();
    }
  });

  test("the desktop app has no file jobs: exit 69, naming the setting", async () => {
    const f = noteFile();
    try {
      const r = await cli({ ...process.env, ...app.env }, ["transcribe", f.path]);
      expect(r.code).toBe(69);
      expect(r.err).toContain("server.enabled");
    } finally {
      f.cleanup();
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
