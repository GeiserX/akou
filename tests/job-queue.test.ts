/**
 * The job queue under a large backlog (docs/ux/SERVER.md section 5, SV-Q1 to SV-Q4): how many
 * jobs run at once (`server.concurrency`), which queued job runs next (`priority`, then submit
 * order, kept across a restart), how deep the queue may grow (`server.queue_max` and
 * `server.queue_max_per_key`), and the numbers a client paces itself by (throughput and ETA).
 *
 * The decode seam holds each job until the test ends it, so a job's place in the queue and its
 * running time are the test's to set; an ended job fails at once, with no Worker built.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import { MODELS } from "../src/main/asr/models.ts";
import { JobService, type JobService as JobServiceT } from "../src/main/server/jobs.ts";
import { ModelStore } from "../src/main/server/model-store.ts";
import { JOBS_DB, type Job, JobStore } from "../src/main/server/store.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

interface Rig {
  svc: JobServiceT;
  dir: string;
  /** The uploads whose decode started, in that order: the order the jobs ran. */
  started: string[];
  /** Ends the job reading this upload: it fails at once, and its slot frees. */
  end(audio: string): void;
  clock: { t: number };
}

interface RigOptions {
  concurrency?: number;
  queueMax?: number;
  queueMaxPerKey?: number;
  dir?: string;
}

function rig(o: RigOptions = {}): Rig {
  let dir = o.dir;
  if (!dir) {
    const t = tempDir("akou-queue-");
    cleanups.push(t.cleanup);
    dir = t.dir;
  }
  const started: string[] = [];
  const pending = new Map<string, () => void>();
  const clock = { t: Date.UTC(2026, 8, 26, 12) };
  const svc = new JobService({
    dir,
    version: "0.0.0",
    // A spec, so a job reaches its decode, which holds it until the test ends it.
    models: () => ({}) as ModelSpec,
    decode: (path) =>
      new Promise<Float32Array>((_, reject) => {
        started.push(path);
        pending.set(path, () => reject(new Error("ended by the test")));
      }),
    shelf: new ModelStore({
      dir: () => join(dir as string, "models"),
      machine: () => null,
      catalog: () => MODELS,
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
    concurrency: () => o.concurrency ?? 1,
    queueMax: () => o.queueMax ?? 0,
    queueMaxPerKey: () => o.queueMaxPerKey ?? 0,
    now: () => clock.t,
    log: () => {},
  });
  cleanups.push(() => svc.close());
  svc.start();
  return {
    svc,
    dir,
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

/** Submits one job as `key`, its upload a new file; returns the service's answer. */
function put(
  r: Rig,
  o: { key?: string; priority?: number; idem?: string; sha?: string } = {},
): ReturnType<JobServiceT["submit"]> {
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
    idempotency_key: o.idem ?? null,
    file_sha256: o.sha ?? "0".repeat(64),
    audio,
    ...(o.priority !== undefined ? { priority: o.priority } : {}),
  });
}

function job(a: ReturnType<JobServiceT["submit"]>): Job {
  if (!("job" in a)) throw new Error(`expected a job, got ${JSON.stringify(a)}`);
  return a.job;
}

const status = (r: Rig, j: Job) => r.svc.store.job(j.id)?.status;

describe("SV-Q1: server.concurrency, the jobs run at once", () => {
  test("with concurrency 2, two of three jobs run and the third waits", async () => {
    const r = rig({ concurrency: 2 });
    const [a, b, c] = [job(put(r)), job(put(r)), job(put(r))];
    await until(() => r.started.length === 2, 10_000, "two jobs to start");
    expect([status(r, a), status(r, b), status(r, c)]).toEqual(["running", "running", "queued"]);
    expect(r.svc.queueStats()).toMatchObject({ queued: 1, running: 2, depth: 3, concurrency: 2 });
    // The first to end frees its slot for the third.
    r.end(a.audio as string);
    await until(() => status(r, c) === "running", 10_000, "the third job to start");
    expect(status(r, a)).toBe("failed");
  });

  test("positive control: with concurrency 1, one job runs and two wait", async () => {
    const r = rig({ concurrency: 1 });
    const [a, b, c] = [job(put(r)), job(put(r)), job(put(r))];
    await until(() => r.started.length === 1, 10_000, "one job to start");
    // Give a wrongly started second job the time to show.
    await Bun.sleep(100);
    expect([status(r, a), status(r, b), status(r, c)]).toEqual(["running", "queued", "queued"]);
  });

  test("a running job deleted frees its slot for the next", async () => {
    const r = rig({ concurrency: 1 });
    const [a, b] = [job(put(r)), job(put(r))];
    await until(() => status(r, a) === "running", 10_000, "the first job to start");
    r.svc.remove({ id: "key_a", name: "a", scopes: ["jobs"], callbackHosts: [] }, a.id);
    await until(() => status(r, b) === "running", 10_000, "the second job to start");
    expect(status(r, a)).toBeUndefined();
  });
});

describe("SV-Q2: priority, then submit order, kept across a restart", () => {
  test("a higher priority runs first; equal priorities run in submit order", async () => {
    const r = rig({ concurrency: 1 });
    const a = job(put(r));
    await until(() => r.started.length === 1, 10_000, "the first job to start");
    const b = job(put(r));
    const c = job(put(r, { priority: 5 }));
    const d = job(put(r, { priority: -3 }));
    const e = job(put(r, { priority: 5 }));
    expect(c.priority).toBe(5);
    expect(b.priority).toBe(0);
    for (const n of [2, 3, 4, 5]) {
      r.end(r.started.at(-1) as string);
      await until(() => r.started.length === n, 3000, `job ${n} to start`);
    }
    expect(r.started).toEqual([a, c, e, b, d].map((j) => j.audio as string));
  });

  test("the queue resumes after a restart in the same order", async () => {
    const t = tempDir("akou-queue-restart-");
    cleanups.push(t.cleanup);
    const first = rig({ dir: t.dir, concurrency: 1 });
    const a = job(put(first));
    await until(() => first.started.length === 1, 10_000, "the first job to start");
    const b = job(put(first, { priority: -1 }));
    const c = job(put(first, { priority: 2 }));
    first.svc.close();
    // The job left running goes back to its place: priority 0, before b and after c.
    const second = rig({ dir: t.dir, concurrency: 1 });
    for (const n of [2, 3]) {
      await until(() => second.started.length === n - 1, 3000, `job ${n - 1} to start again`);
      second.end(second.started.at(-1) as string);
    }
    await until(() => second.started.length === 3, 10_000, "the last job to start");
    expect(second.started).toEqual([c, a, b].map((j) => j.audio as string));
  });

  test("a jobs.db from before priority opens, and its jobs run at priority 0", () => {
    const t = tempDir("akou-queue-old-");
    cleanups.push(t.cleanup);
    mkdirSync(join(t.dir, "audio"));
    const path = join(t.dir, JOBS_DB);
    const s = new JobStore(path);
    s.close();
    const raw = new Database(path);
    raw.run("DROP INDEX jobs_queue");
    raw.run("ALTER TABLE jobs DROP COLUMN priority");
    raw.close();
    const again = new JobStore(path);
    cleanups.push(() => again.close());
    const { job: j } = again.submit({
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
    expect(j.priority).toBe(0);
  });
});

describe("SV-Q3: the queue limits, and the refusal a client can wait out", () => {
  test("server.queue_max: past the limit a submit is refused, naming the limit and a retry time", async () => {
    const r = rig({ concurrency: 1, queueMax: 2 });
    job(put(r));
    job(put(r, { key: "key_b" }));
    const refused = put(r, { key: "key_c" });
    expect(refused).toMatchObject({
      full: { limit: "server.queue_max", max: 2, depth: 2, retry_after_s: 30 },
    });
    // Nothing was stored for the refused submit.
    expect(r.svc.queueStats().depth).toBe(2);
  });

  test("positive control: server.queue_max 0 is no limit", () => {
    const r = rig({ concurrency: 1, queueMax: 0 });
    for (let i = 0; i < 5; i++) job(put(r));
    expect(r.svc.queueStats().depth).toBe(5);
  });

  test("server.queue_max_per_key: a key at its limit is refused, another key is not", () => {
    const r = rig({ concurrency: 1, queueMaxPerKey: 2 });
    job(put(r));
    job(put(r));
    expect(put(r)).toMatchObject({ full: { limit: "server.queue_max_per_key", max: 2 } });
    expect(job(put(r, { key: "key_b" })).key_id).toBe("key_b");
  });

  test("a retried submit of a job already stored is answered with that job, even when full", () => {
    const r = rig({ concurrency: 1, queueMax: 1 });
    const a = job(put(r, { idem: "same" }));
    const again = put(r, { idem: "same" });
    expect(again).toMatchObject({ existing: true, job: { id: a.id } });
    expect(r.svc.queueFull("key_a", "same")).toBeNull();
    // Positive control: a new job from the same key is refused.
    expect(r.svc.queueFull("key_a", "other")).toMatchObject({ limit: "server.queue_max" });
  });
});

describe("SV-Q4: throughput and ETA from the jobs that ended", () => {
  test("the mean running time gives the ETA and the retry time; the hour's count ages out", async () => {
    const r = rig({ concurrency: 1, queueMax: 3 });
    const [a] = [job(put(r)), job(put(r)), job(put(r))];
    await until(() => r.started.length === 1, 10_000, "the first job to start");
    // No job has ended yet: no ETA, and the refusal's retry time is the default.
    expect(r.svc.queueStats()).toMatchObject({ jobs_last_hour: 0, eta_seconds: null });
    expect(r.svc.queueFull("key_a", null)?.retry_after_s).toBe(30);
    r.clock.t += 10_000;
    r.end(a.audio as string);
    await until(() => r.started.length === 2, 10_000, "the second job to start");
    const s = r.svc.queueStats();
    expect(s).toMatchObject({
      queued: 1,
      running: 1,
      jobs_last_hour: 1,
      mean_job_seconds: 10,
      // Two jobs left, one at a time, 10 s each.
      eta_seconds: 20,
    });
    job(put(r));
    // One job over the limit of 3, one slot, 10 s a job.
    expect(r.svc.queueFull("key_a", null)).toMatchObject({ depth: 3, retry_after_s: 10 });
    r.clock.t += 2 * 3_600_000;
    expect(r.svc.queueStats()).toMatchObject({ jobs_last_hour: 0, mean_job_seconds: 10 });
  });

  test("with two slots the ETA halves", async () => {
    const r = rig({ concurrency: 2 });
    const [a, b] = [job(put(r)), job(put(r)), job(put(r)), job(put(r)), job(put(r))];
    await until(() => r.started.length === 2, 10_000, "two jobs to start");
    r.clock.t += 10_000;
    r.end(a.audio as string);
    r.end(b.audio as string);
    await until(() => r.started.length === 4, 10_000, "two more jobs to start");
    // Three jobs left, two at a time: two rounds of 10 s.
    expect(r.svc.queueStats()).toMatchObject({ depth: 3, eta_seconds: 20 });
  });
});
