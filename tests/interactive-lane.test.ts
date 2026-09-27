/**
 * The dictation lane of server mode (docs/ux/DICTATION.md DC-R2): `interactive=true` runs in the
 * reserved Workers of `server.dictation_slots`, which never take a queued job; it is never refused
 * by `server.queue_max` or `server.queue_max_per_key` and never counted in them; dictations are
 * answered in the order they arrived; with no slots the field is ignored, so the same request
 * meets the queue's limits (the positive control). `GET /v1/server` reports the lane.
 *
 * `server.dictation_slots` is read through the JobService's `dictationSlots` option; the rig sets it
 * through the jobs seam until the setting is wired.
 */

import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dictationTrip } from "../scripts/server-roundtrip.ts";
import { laneAsk } from "../src/main/api/routes/jobs.ts";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import { MODELS } from "../src/main/asr/models.ts";
import type { AppOptions } from "../src/main/index.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { JobService } from "../src/main/server/jobs.ts";
import { ModelStore } from "../src/main/server/model-store.ts";
import { JOBS_DB, type Job, JobStore } from "../src/main/server/store.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";
import { clip, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(30_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

// ---------------------------------------------------------------------------
// The service

interface Rig {
  svc: JobService;
  /** The uploads whose decode started, in that order. */
  started: string[];
  end(audio: string): void;
  clock: { t: number };
}

function rig(o: {
  slots: number;
  queueMax?: number;
  queueMaxPerKey?: number;
  engine?: string;
  catalog?: typeof MODELS;
}): Rig {
  const t = tempDir("akou-lane-");
  cleanups.push(t.cleanup);
  const started: string[] = [];
  const pending = new Map<string, () => void>();
  const clock = { t: Date.UTC(2026, 8, 26, 12) };
  const svc = new JobService({
    dir: t.dir,
    version: "0.0.0",
    models: () => ({}) as ModelSpec,
    // Every job holds in its decode until the test ends it.
    decode: (path) =>
      new Promise<Float32Array>((_, reject) => {
        started.push(path);
        pending.set(path, () => reject(new Error("ended by the test")));
      }),
    shelf: new ModelStore({
      dir: () => join(t.dir, "models"),
      machine: () => null,
      catalog: () => o.catalog ?? MODELS,
      autoDownload: () => false,
      maxGb: () => 0,
      unusedDays: () => 0,
      log: () => {},
    }),
    defaultModel: () => "auto",
    diarizer: () => "embeddings",
    secrets: () => [],
    hostListed: () => false,
    retainDays: () => 7,
    maxAudioMinutes: () => 240,
    concurrency: () => 1,
    queueMax: () => o.queueMax ?? 0,
    queueMaxPerKey: () => o.queueMaxPerKey ?? 0,
    dictationSlots: () => o.slots,
    dictationEngine: () => o.engine ?? "fast",
    now: () => clock.t,
    log: () => {},
  });
  cleanups.push(() => svc.close());
  svc.start();
  return {
    svc,
    started,
    clock,
    end: (audio) => {
      const fn = pending.get(audio);
      if (!fn) throw new Error(`no job is decoding ${audio}`);
      pending.delete(audio);
      fn();
    },
  };
}

let uploads = 0;

function put(
  r: Rig,
  o: { interactive?: boolean; priority?: number; key?: string } = {},
): ReturnType<JobService["submit"]> {
  const audio = join(r.svc.uploadDir, `u${++uploads}.upload`);
  writeFileSync(audio, "audio");
  return r.svc.submit({
    key_id: o.key ?? "key_a",
    preset: "fast",
    language: "auto",
    keywords: [],
    diarize: false,
    callback_url: null,
    metadata: null,
    idempotency_key: null,
    file_sha256: "0".repeat(64),
    audio,
    interactive: o.interactive ?? false,
    ...(o.priority !== undefined ? { priority: o.priority } : {}),
  });
}

function job(a: ReturnType<JobService["submit"]>): Job {
  if (!("job" in a)) throw new Error(`expected a job, got ${JSON.stringify(a)}`);
  return a.job;
}

const status = (r: Rig, j: Job) => r.svc.store.job(j.id)?.status;

describe("DC-R2: the dictation lane in the job service", () => {
  test("a dictation runs at once beside a busy queue, past server.queue_max, and is not counted in it", async () => {
    const r = rig({ slots: 1, queueMax: 1 });
    const held = job(put(r));
    await until(() => r.started.length === 1, 2000, "the queued job to start");
    // The queue is at its limit: a plain submit is refused.
    expect(put(r)).toMatchObject({ full: { limit: "server.queue_max" } });
    const d = job(put(r, { interactive: true }));
    expect(d.interactive).toBe(true);
    expect(d.route).toBe("local");
    await until(() => status(r, d) === "running", 2000, "the dictation to start");
    expect(r.started).toEqual([held.audio as string, d.audio as string]);
    // The queue's numbers do not see the lane.
    expect(r.svc.queueStats()).toMatchObject({ depth: 1, running: 1, queued: 0 });
    expect(r.svc.queueFull("key_a", null)).toMatchObject({ depth: 1 });
  });

  test("server.queue_max_per_key does not refuse a dictation either", () => {
    const r = rig({ slots: 1, queueMaxPerKey: 1 });
    job(put(r));
    expect(put(r)).toMatchObject({ full: { limit: "server.queue_max_per_key" } });
    expect("job" in put(r, { interactive: true })).toBe(true);
  });

  test("positive control: with server.dictation_slots 0 the field is ignored and the queue refuses it", async () => {
    const r = rig({ slots: 0, queueMax: 1 });
    job(put(r));
    await until(() => r.started.length === 1, 2000, "the queued job to start");
    expect(put(r, { interactive: true })).toMatchObject({ full: { limit: "server.queue_max" } });
    expect(r.svc.interactive(true)).toBe(false);
    expect(r.svc.dictationStats()).toMatchObject({ slots: 0 });
  });

  test("with no slots an interactive job queues like any other and runs in the queue's Worker", async () => {
    const r = rig({ slots: 0 });
    const d = job(put(r, { interactive: true }));
    expect(d.interactive).toBe(false);
    await until(() => r.started.length === 1, 2000, "the job to start");
    expect(r.svc.queueStats()).toMatchObject({ depth: 1 });
  });

  test("the lane never takes a queued job, even when it is the only free Worker", async () => {
    const r = rig({ slots: 1 });
    const a = job(put(r));
    const b = job(put(r));
    await until(() => r.started.length === 1, 2000, "the first job to start");
    await Bun.sleep(100);
    expect(status(r, a)).toBe("running");
    expect(status(r, b)).toBe("queued");
    expect(r.started).toHaveLength(1);
  });

  test("dictations are answered in the order they arrived, whatever their priority", async () => {
    const r = rig({ slots: 1 });
    const first = job(put(r, { interactive: true }));
    const second = job(put(r, { interactive: true, priority: -5 }));
    const third = job(put(r, { interactive: true, priority: 10 }));
    await until(() => r.started.length === 1, 2000, "the first dictation to start");
    r.end(first.audio as string);
    await until(() => r.started.length === 2, 2000, "the second dictation to start");
    r.end(second.audio as string);
    await until(() => r.started.length === 3, 2000, "the third dictation to start");
    expect(r.started).toEqual([first.audio, second.audio, third.audio] as string[]);
  });

  test("an interactive job that names no model runs server.dictation_engine", () => {
    const r = rig({ slots: 1 });
    expect(laneAsk(r.svc, {})).toEqual({ preset: "fast" });
    expect(laneAsk(r.svc, { preset: "auto" })).toEqual({ preset: "fast" });
    expect(laneAsk(r.svc, { model: "best" })).toEqual({ model: "best" });
    expect(laneAsk(r.svc, { preset: "best" })).toEqual({ preset: "best" });
  });

  test("dictation.engine is the engine the lane will run, not the raw setting", () => {
    expect(rig({ slots: 1, engine: "auto" }).svc.dictationStats().engine).toBe("fast");
    expect(rig({ slots: 1, engine: "fast" }).svc.dictationStats().engine).toBe("fast");
    expect(rig({ slots: 1, engine: "best" }).svc.dictationStats().engine).toBe("best");
    // A recognizer no preset leads with reports its own id, not `custom`.
    const other = { ...(MODELS[0] as (typeof MODELS)[number]), id: "other-asr", serves: ["final"] };
    const catalog = [...MODELS, other] as typeof MODELS;
    expect(rig({ slots: 1, engine: "other-asr", catalog }).svc.dictationStats().engine).toBe(
      "other-asr",
    );
    expect(rig({ slots: 1, engine: "nonsense" }).svc.dictationStats().engine).toBe("nonsense");
  });

  test("a jobs.db from before DC-R2 gains the interactive column, and its jobs count as ordinary ones", () => {
    const t = tempDir("akou-lane-old-");
    cleanups.push(t.cleanup);
    mkdirSync(join(t.dir, "audio"));
    const path = join(t.dir, JOBS_DB);
    const s = new JobStore(path);
    const { job: old } = s.submit({
      key_id: "key_a",
      preset: "fast",
      language: "auto",
      keywords: [],
      diarize: false,
      callback_url: null,
      metadata: null,
      idempotency_key: null,
      file_sha256: "0".repeat(64),
      audio: join(t.dir, "audio", "x.upload"),
    });
    s.close();
    const raw = new Database(path);
    raw.run("ALTER TABLE jobs DROP COLUMN interactive");
    raw.close();
    const again = new JobStore(path);
    cleanups.push(() => again.close());
    const cols = again.db.query("PRAGMA table_info(jobs)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("interactive");
    expect(again.counts(null)).toEqual({ queued: 1, running: 0 });
    expect(again.job(old.id)?.interactive).toBe(false);
  });

  test("served_last_hour counts the lane's dictations for an hour, and the queue's throughput does not", async () => {
    const r = rig({ slots: 1 });
    const d = job(put(r, { interactive: true }));
    await until(() => r.started.length === 1, 2000, "the dictation to start");
    r.end(d.audio as string);
    await until(() => status(r, d) === "failed", 2000, "the dictation to end");
    expect(r.svc.dictationStats()).toEqual({ slots: 1, engine: "fast", served_last_hour: 1 });
    expect(r.svc.queueStats().jobs_last_hour).toBe(0);
    r.clock.t += 3_600_001;
    expect(r.svc.dictationStats().served_last_hour).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Through the API

const NOTE = clip(["hello", "world"], 3);

/** Holds the first upload's decode until `open()`; every later one decodes at once. */
function holdFirst() {
  let open = () => {};
  const held = new Promise<void>((r) => {
    open = r;
  });
  let first = true;
  return {
    open: () => open(),
    decode: async (path: string, signal: AbortSignal) => {
      if (first) {
        first = false;
        await held;
      }
      return readUploadAudio(path, { signal });
    },
  };
}

/** The jobs seam with the dictation lane's size, until `server.dictation_slots` is wired. */
function seams(decode: ReturnType<typeof holdFirst>["decode"], slots: number): AppOptions["jobs"] {
  return { decode, dictationSlots: () => slots } as AppOptions["jobs"];
}

async function transcribe(rig: AppRig, key: string, fields: Record<string, string>) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(NOTE)], { type: "audio/wav" }), "note.wav");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  // biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body, ms: performance.now() - t0 };
}

for (const slots of [1, 0]) {
  describe(`DC-R2 over HTTP, server.dictation_slots ${slots}`, () => {
    const g = holdFirst();
    let rig: AppRig;
    let k: Key;

    beforeAll(async () => {
      rig = await appRig({
        settings: { ...SERVER, "server.queue_max": 1 },
        jobs: seams(g.decode, slots),
      });
      k = await newKey(rig, "lane");
      // One job holds the queue at its limit.
      expect((await submit(rig, k.key, NOTE)).status).toBe(202);
    });
    afterAll(async () => {
      g.open();
      await rig?.close();
    });

    test("a plain submit is refused with 429", async () => {
      expect((await submit(rig, k.key, NOTE)).status).toBe(429);
      expect((await transcribe(rig, k.key, {})).status).toBe(429);
    });

    if (slots > 0) {
      test("an interactive transcription is answered in under 2 s with the transcript", async () => {
        const r = await transcribe(rig, k.key, { interactive: "true" });
        expect(r.status).toBe(200);
        expect(r.body.text).toContain("hello world");
        expect(r.ms).toBeLessThan(2000);
      });

      test("an interactive POST /v1/jobs is accepted, and marked on the job", async () => {
        const r = await submit(rig, k.key, NOTE, { interactive: "true" });
        expect(r.status).toBe(202);
        expect(r.body.interactive).toBe(true);
      });

      test("GET /v1/server reports the lane and the interactive capability", async () => {
        const res = await fetch(`http://127.0.0.1:${rig.port}/v1/server`);
        // biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
        const body: any = await res.json();
        expect(body.capabilities.interactive).toBe(true);
        expect(body.dictation).toMatchObject({ slots: 1, engine: "fast" });
        expect(body.dictation.served_last_hour).toBeGreaterThanOrEqual(1);
      });
    } else {
      test("positive control: the same interactive request gets 429", async () => {
        expect((await transcribe(rig, k.key, { interactive: "true" })).status).toBe(429);
        expect((await submit(rig, k.key, NOTE, { interactive: "true" })).status).toBe(429);
      });

      test("GET /v1/server says there is no interactive lane", async () => {
        const res = await fetch(`http://127.0.0.1:${rig.port}/v1/server`);
        // biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
        const body: any = await res.json();
        expect(body.capabilities.interactive).toBe(false);
        expect(body.dictation).toEqual({ slots: 0, engine: "fast", served_last_hour: 0 });
      });
    }
  });
}

test("an interactive POST /v1/jobs finishes while the queue's job is held", async () => {
  const g = holdFirst();
  const r = await appRig({ settings: { ...SERVER }, jobs: seams(g.decode, 1) });
  try {
    const k = await newKey(r, "lane-job");
    expect((await submit(r, k.key, NOTE)).status).toBe(202);
    const d = await submit(r, k.key, NOTE, { interactive: "true" });
    expect(d.status).toBe(202);
    await until(
      async () => {
        const res = await fetch(`http://127.0.0.1:${r.port}/v1/jobs/${d.body.id}`, {
          headers: { authorization: `Bearer ${k.key}` },
        });
        return ((await res.json()) as { status: string }).status === "done";
      },
      10_000,
      "the dictation job to finish",
    );
  } finally {
    g.open();
    await r.close();
  }
});

// ---------------------------------------------------------------------------
// The server CI job's dictation trip (scripts/server-roundtrip.ts), against the real routes

describe("DC-R2: the server job's dictation trip", () => {
  async function tripRig(slots: number) {
    const r = await appRig({
      settings: { ...SERVER },
      jobs: {
        decode: (path: string, signal: AbortSignal) => readUploadAudio(path, { signal }),
        dictationSlots: () => slots,
      } as AppOptions["jobs"],
    });
    cleanups.push(() => void r.close());
    const t = tempDir("akou-trip-");
    cleanups.push(t.cleanup);
    const note = join(t.dir, "note.wav");
    writeFileSync(note, NOTE);
    const k = await newKey(r, "trip");
    return { base: `http://127.0.0.1:${r.port}`, key: k.key, note, heard: "hello world" };
  }

  test("the app's client dictates through the lane, after its Test, beside a plain request the lane does not count", async () => {
    const lines = await dictationTrip(await tripRig(1));
    expect(lines[0]).toContain("the Test says ok, fast on");
    expect(lines[1]).toMatch(/answered by the lane in \d+ ms: hello world/);
  });

  test("positive control: a server with no dictation slots fails the trip at the Test", async () => {
    await expect(dictationTrip(await tripRig(0))).rejects.toThrow(
      /the Test of the remote says: .*no dictation slots/,
    );
  });

  test("positive control: a dictation sent without interactive=true fails the trip, since the lane did not count it", async () => {
    // A client that drops the field: the request is answered, but by the queue.
    const dropField: typeof fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body;
        if (body instanceof FormData && body.has("interactive")) {
          const form = new FormData();
          for (const [k, v] of body.entries()) if (k !== "interactive") form.append(k, v);
          return fetch(input, { ...init, body: form });
        }
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    await expect(dictationTrip({ ...(await tripRig(1)), fetch: dropField })).rejects.toThrow(
      /the dictation did not run in the lane \(served 0 -> 0, queue jobs 1 -> 2\)/,
    );
  });

  test("positive control: a lane that counts a plain request fails the trip at its control", async () => {
    // Every transcription marked interactive, as a server counting all of them in the lane would.
    const markAll: typeof fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body;
        if (body instanceof FormData && !body.has("interactive")) body.set("interactive", "true");
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    await expect(dictationTrip({ ...(await tripRig(1)), fetch: markAll })).rejects.toThrow(
      /a plain request moved the lane \(served 0 -> 1, queue jobs 0 -> 0\)/,
    );
  });
});
