/**
 * SV-Q5: the queue's ETA counts what the running jobs have left of their audio, and the queue
 * publishes its pace per second of audio (docs/ux/SERVER.md section 5). A per-job mean alone
 * told a client that a box busy with one long file, its queue empty, would be free in seconds,
 * and made a fast box that had just run a few long files look slow.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FusionEngineSpec, ModelSpec } from "../src/main/asr/engine.ts";
import { MODELS } from "../src/main/asr/models.ts";
import { JobService, type JobServiceOptions, queueEta } from "../src/main/server/jobs.ts";
import { ModelStore } from "../src/main/server/model-store.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

describe("SV-Q5: queueEta", () => {
  test("one long file running with an empty queue: its audio left at the per-audio rate", () => {
    const eta = queueEta({
      running: [{ remote: false, done_s: 0, total_s: 6060 }],
      queued: 0,
      concurrency: 1,
      meanS: 2,
      perAudioS: 0.05,
    });
    expect(eta).toBe(303);
    // Half done, half left.
    expect(
      queueEta({
        running: [{ remote: false, done_s: 3030, total_s: 6060 }],
        queued: 0,
        concurrency: 1,
        meanS: 2,
        perAudioS: 0.05,
      }),
    ).toBe(152);
  });

  test("a running job whose length is unknown (it decodes) counts at the mean", () => {
    expect(
      queueEta({
        running: [{ remote: false, done_s: 0, total_s: null }],
        queued: 2,
        concurrency: 1,
        meanS: 10,
        perAudioS: 0.05,
      }),
    ).toBe(30);
    // Before any done job had audio there is no rate: the mean again.
    expect(
      queueEta({
        running: [{ remote: false, done_s: 0, total_s: 600 }],
        queued: 0,
        concurrency: 1,
        meanS: 10,
        perAudioS: null,
      }),
    ).toBe(10);
  });

  test("queued jobs take the first free slot: a long job holds one slot, the short ones share the other", () => {
    expect(
      queueEta({
        running: [
          { remote: false, done_s: 0, total_s: 2000 },
          { remote: false, done_s: 0, total_s: 20 },
        ],
        queued: 3,
        concurrency: 2,
        meanS: 1,
        perAudioS: 0.05,
      }),
    ).toBe(100);
    // Equal jobs in rounds of the slots, as before.
    expect(
      queueEta({
        running: [
          { remote: false, done_s: 0, total_s: null },
          { remote: false, done_s: 0, total_s: null },
        ],
        queued: 1,
        concurrency: 2,
        meanS: 10,
        perAudioS: null,
      }),
    ).toBe(20);
  });

  test("a job out on a remote runs beside the slots, its audio from the remote", () => {
    const o = { queued: 0, concurrency: 1, meanS: 2, perAudioS: 0.05 };
    expect(
      queueEta({
        ...o,
        running: [
          { remote: true, done_s: 0, total_s: 4000 },
          { remote: false, done_s: 0, total_s: 1000 },
        ],
      }),
    ).toBe(200);
    // Waiting in the remote's queue, its length not said yet: the mean.
    expect(queueEta({ ...o, running: [{ remote: true, done_s: 0, total_s: null }] })).toBe(2);
  });

  test("empty is 0; with no job ended there is no ETA", () => {
    expect(
      queueEta({ running: [], queued: 0, concurrency: 1, meanS: null, perAudioS: null }),
    ).toBe(0);
    expect(
      queueEta({ running: [], queued: 1, concurrency: 1, meanS: null, perAudioS: null }),
    ).toBeNull();
  });
});

const QWEN = { kind: "llama-server", engine: "qwen3-asr-1.7b" } as unknown as FusionEngineSpec;
const FINAL_QWEN = { kind: "module", path: "x", model: "x", final: QWEN } as unknown as ModelSpec;
const URL_ = "http://remote.example";

interface RemoteJob {
  status: "running" | "done";
  total_s: number;
  done_s: number;
}

/**
 * A JobService on a fake clock with one fake remote. Jobs routed `remote` go there and do what
 * `jobs` says; a local job decodes `localAudioS` seconds of silence and then waits for the GPU
 * line's turn for good, so it runs with its length known.
 */
function service(localAudioS: number) {
  const t = tempDir("akou-eta-");
  cleanups.push(t.cleanup);
  const keyFile = join(t.dir, "worker.key");
  writeFileSync(keyFile, "ak_x\n", { mode: 0o600 });
  const clock = { t: Date.UTC(2026, 9, 28, 22) };
  const jobs = new Map<string, RemoteJob>();
  const pending: RemoteJob[] = [];
  let polls = 0;
  let turns = 0;
  const remoteFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    if (u.endsWith("/v1/server")) {
      return Response.json({
        name: "akou",
        presets: [{ name: "fast", available: true }],
        engines: [],
        capabilities: { jobs: true },
        queue: { stalled: 0 },
      });
    }
    if (u.endsWith("/v1/keys/me")) return Response.json({ id: "k1" });
    if (u.endsWith("/v1/jobs") && init?.method === "POST") {
      const id = `r${jobs.size + 1}`;
      jobs.set(id, pending.shift() ?? { status: "running", total_s: 1, done_s: 0 });
      return Response.json({ id });
    }
    const id = /\/v1\/jobs\/(r\d+)/.exec(u)?.[1];
    const j = id ? jobs.get(id) : undefined;
    if (id && j) {
      if (u.endsWith("/result")) {
        return Response.json({ job_id: id, status: "done", text: "", duration_s: j.total_s });
      }
      await new Promise((r) => setTimeout(r, 10));
      polls++;
      return Response.json({
        id,
        status: j.status,
        progress: { stage: "transcribe", total_s: j.total_s, done_s: j.done_s },
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as unknown as typeof fetch;
  const o: JobServiceOptions = {
    dir: t.dir,
    version: "0.0.0",
    models: () => FINAL_QWEN,
    decode: async () => new Float32Array(localAudioS * 16_000),
    gpuTurn: () => {
      turns++;
      return new Promise(() => {});
    },
    shelf: new ModelStore({
      dir: () => join(t.dir, "models"),
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
    concurrency: () => 1,
    queueMax: () => 0,
    queueMaxPerKey: () => 0,
    remotes: () => [`${URL_} ${keyFile} fast`],
    remoteProbeMs: 60_000,
    remoteFetch,
    now: () => clock.t,
    log: () => {},
  };
  const svc = new JobService(o);
  cleanups.push(() => svc.close());
  svc.start();
  const add = (route: "remote" | "local", remote?: RemoteJob) => {
    if (remote) pending.push(remote);
    const audio = join(svc.uploadDir, `${crypto.randomUUID()}.upload`);
    writeFileSync(audio, "audio");
    const r = svc.submit({
      key_id: "key_a",
      preset: "fast",
      route,
      language: "en",
      keywords: [],
      diarize: false,
      callback_url: null,
      metadata: null,
      idempotency_key: null,
      file_sha256: "0".repeat(64),
      audio,
    });
    if (!("job" in r)) throw new Error(JSON.stringify(r));
    return r.job;
  };
  return { svc, clock, jobs, add, polls: () => polls, turns: () => turns };
}

/** Runs one remote job of `audioS` seconds to its end in `runS` seconds on the fake clock. */
async function runOne(s: ReturnType<typeof service>, audioS: number, runS: number): Promise<void> {
  const ended = s.svc.queueStats().jobs_last_hour;
  const j: RemoteJob = { status: "running", total_s: audioS, done_s: 0 };
  s.add("remote", j);
  const seen = s.polls();
  await until(() => s.polls() >= seen + 2, 4_000, "the remote to run the job");
  s.clock.t += runS * 1000;
  j.status = "done";
  await until(() => s.svc.queueStats().jobs_last_hour === ended + 1, 4_000, "the job to end");
}

describe("SV-Q5: the queue's numbers on a live service", () => {
  test("one long file running with an empty queue: eta_seconds is its audio left, not one mean", async () => {
    const s = service(300);
    // A short job ran: 10 s of audio in 2 s.
    await runOne(s, 10, 2);
    expect(s.svc.queueStats()).toMatchObject({
      mean_job_seconds: 2,
      seconds_per_audio_second: 0.2,
      eta_seconds: 0,
    });
    // A 300 s file runs here, nothing queued behind it: 300 s at 0.2 is 60 s, not the 2 s mean.
    s.add("local");
    await until(() => s.turns() === 1, 4_000, "the local job to know its length");
    expect(s.svc.queueStats()).toMatchObject({ queued: 0, running: 1, eta_seconds: 60 });
  });

  test("a job out on a remote: what it has left, from the remote's progress, beside the local slot", async () => {
    const s = service(300);
    await runOne(s, 10, 2);
    s.add("local");
    await until(() => s.turns() === 1, 4_000, "the local job to know its length");
    const far: RemoteJob = { status: "running", total_s: 1000, done_s: 0 };
    s.add("remote", far);
    await until(
      () => s.svc.queueStats().eta_seconds === 200,
      4_000,
      "the remote's 1000 s at 0.2 to be the ETA",
    );
    // Most of it done on the remote: the local 60 s is what is left of the queue.
    far.done_s = 900;
    await until(() => s.svc.queueStats().eta_seconds === 60, 4_000, "the remote's progress");
  });

  test("short and long jobs mixed: the per-audio rate holds while the per-job mean swings", async () => {
    const s = service(300);
    // Ten short notes, 10 s of audio in 1 s each.
    for (let i = 0; i < 10; i++) await runOne(s, 10, 1);
    const short = s.svc.queueStats();
    expect(short).toMatchObject({ mean_job_seconds: 1, seconds_per_audio_second: 0.1 });
    // Four long files on the same box, at the same pace: 6000 s of audio in 600 s each.
    for (let i = 0; i < 4; i++) await runOne(s, 6000, 600);
    const mixed = s.svc.queueStats();
    // The mean went from 1 s to over 170 s; the box's pace did not move.
    expect(mixed.mean_job_seconds as number).toBeGreaterThan(170);
    expect(mixed.seconds_per_audio_second).toBe(0.1);
  });
});
