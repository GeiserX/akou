/**
 * The job queue under a large backlog, through the real API (docs/ux/SERVER.md SV-Q1 to SV-Q4):
 * a full queue answers 429 `queue_full` with `Retry-After` on both doors, before the upload is
 * kept; `priority` is a job field; `GET /v1/server` and `GET /healthz` report the queue's settings,
 * depth, throughput and ETA; `server.concurrency` set over `PATCH /v1/config` runs jobs side by
 * side. The recognizer is the fake engine in a real finalize Worker.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { asKey, clip, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(30_000);

const NOTE = clip(["hello", "world"], 3);

/** Holds every upload's decode until `open()`: running jobs stay running, the rest queued. */
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

interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
  body: any;
}

function uploads(rig: AppRig): string[] {
  const dir = join(rig.app.configDir, "jobs", "audio");
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function openai(rig: AppRig, key: string): Promise<Reply> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(NOTE)], { type: "audio/wav" }), "note.wav");
  form.append("model", "whisper-1");
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function open(rig: AppRig, path: string): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${rig.port}${path}`);
  return { status: res.status, body: await res.json() };
}

describe("SV-Q3: a full queue answers 429 queue_full with Retry-After", () => {
  const g = gate();
  let rig: AppRig;
  let k: Key;

  beforeAll(async () => {
    rig = await appRig({
      settings: { ...SERVER, "server.queue_max": 1 },
      jobs: { decode: g.decode },
    });
    k = await newKey(rig, "q3");
  });
  afterAll(async () => {
    g.open();
    await rig?.close();
  });

  test("the submit past the limit is refused with the error shape and a Retry-After the body repeats", async () => {
    const first = await submit(rig, k.key, NOTE, {});
    expect(first.status).toBe(202);
    const full = await submit(rig, k.key, NOTE, {});
    expect(full.status).toBe(429);
    expect(full.body).toMatchObject({
      error: "queue_full",
      limit: "server.queue_max",
      max: 1,
      depth: 1,
    });
    expect(typeof full.body.message).toBe("string");
    expect(full.body.retry_after_s).toBeGreaterThanOrEqual(1);
    expect(full.headers.get("retry-after")).toBe(String(full.body.retry_after_s));
    // Only the queued job's upload is on disk: the refused one was not kept.
    expect(uploads(rig)).toHaveLength(1);
  });

  test("the OpenAI door is refused the same way", async () => {
    const r = await openai(rig, k.key);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("queue_full");
    expect(uploads(rig)).toHaveLength(1);
  });

  test("a retried submit of the stored job is answered with it, full or not", async () => {
    // A fresh key: its first job would be refused, its retry of that job is not.
    const k2 = await newKey(rig, "q3-retry");
    const idem = { "idempotency-key": "abc.0" };
    const refused = await fetchSubmit(rig, k2.key, idem);
    expect(refused.status).toBe(429);
    g.open();
    await until(
      async () => (await asKey(rig, k.key, "GET", "/jobs?status=done")).body.jobs.length === 1,
      20_000,
      "the first job to finish",
    );
    const taken = await fetchSubmit(rig, k2.key, idem);
    expect(taken.status).toBe(202);
    const again = await fetchSubmit(rig, k2.key, idem);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(taken.body.id);
  });
});

async function fetchSubmit(
  rig: AppRig,
  key: string,
  headers: Record<string, string>,
): Promise<Reply> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(NOTE)], { type: "audio/wav" }), "note.wav");
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, ...headers },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

describe("SV-Q1, SV-Q2, SV-Q4: concurrency, priority and the queue's numbers", () => {
  let rig: AppRig;
  let app: AppRig;
  let k: Key;

  beforeAll(async () => {
    rig = await appRig({ settings: { ...SERVER, "server.queue_max_per_key": 50 } });
    app = await appRig();
    k = await newKey(rig, "q4");
  });
  afterAll(async () => {
    await rig?.close();
    await app?.close();
  });

  test("priority is a job field from -10 to 10, 0 when absent", async () => {
    for (const p of ["11", "-11", "1.5", "high"]) {
      const r = await submit(rig, k.key, NOTE, { priority: p });
      expect(`${r.status} ${r.body.error} ${r.body.field}`).toBe("422 bad_field priority");
    }
    const hi = await submit(rig, k.key, NOTE, { priority: "7" });
    expect(hi.status).toBe(202);
    expect(hi.body.priority).toBe(7);
    const plain = await submit(rig, k.key, NOTE, {});
    expect(plain.body.priority).toBe(0);
    for (const id of [hi.body.id, plain.body.id]) {
      expect((await asKey(rig, k.key, "GET", `/jobs/${id}?wait=60`)).body.status).toBe("done");
    }
  });

  test("GET /v1/server and GET /healthz report the queue's settings, depth, throughput and ETA", async () => {
    const s = await open(rig, "/v1/server");
    expect(s.status).toBe(200);
    expect(s.body.queue).toMatchObject({
      concurrency: 1,
      max: 1000,
      max_per_key: 50,
      depth: 0,
      queued: 0,
      running: 0,
      eta_seconds: 0,
    });
    // The jobs of the test before ended here: two, three seconds of audio each.
    expect(s.body.queue.jobs_last_hour).toBeGreaterThanOrEqual(2);
    expect(s.body.queue.audio_seconds_last_hour).toBeGreaterThanOrEqual(5);
    expect(s.body.queue.mean_job_seconds).toBeGreaterThanOrEqual(0);
    const h = await open(rig, "/healthz");
    expect(h.body.queue_depth).toBe(0);
    expect(h.body.queue).toEqual(s.body.queue);
    // The desktop app has no job queue.
    expect((await open(app, "/v1/server")).body.queue).toBeNull();
    expect((await open(app, "/healthz")).body.queue).toBeNull();
  });
});

describe("SV-Q1: server.concurrency over PATCH /v1/config", () => {
  const g = gate();
  let rig: AppRig;
  let k: Key;

  beforeAll(async () => {
    rig = await appRig({ settings: SERVER, jobs: { decode: g.decode } });
    k = await newKey(rig, "q1");
  });
  afterAll(async () => {
    g.open();
    await rig?.close();
  });

  test("set to 2, two of three jobs run at once; the third waits for a slot", async () => {
    const set = await rig.api("PATCH", "/config", { "server.concurrency": 2 });
    expect(set.status).toBe(200);
    expect((await open(rig, "/v1/server")).body.queue.concurrency).toBe(2);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await submit(rig, k.key, NOTE, {})).body.id);
    await until(
      async () => (await open(rig, "/v1/server")).body.queue.running === 2,
      10_000,
      "two jobs to run",
    );
    expect((await open(rig, "/v1/server")).body.queue).toMatchObject({ running: 2, queued: 1 });
    g.open();
    for (const id of ids) {
      expect((await asKey(rig, k.key, "GET", `/jobs/${id}?wait=60`)).body.status).toBe("done");
    }
  });
});
