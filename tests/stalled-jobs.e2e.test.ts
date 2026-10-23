/**
 * #407: a job stuck at `running` (a model load starved of disk IO, a hung decode) makes the server
 * say so. `queue.stalled` counts the running jobs past `STALL_BASE_MS` plus `STALL_PER_AUDIO` times
 * their audio, `/healthz` answers 503 with `ok: false` while it is above 0, each stalled job is
 * logged once, `models_ready` keeps its meaning, and a server that sends jobs to remotes sends none
 * to one that reports a stalled job. The job itself is never stopped.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FusionEngineSpec, ModelSpec } from "../src/main/asr/engine.ts";
import { MODELS } from "../src/main/asr/models.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import {
  JobService,
  type JobServiceOptions,
  STALL_BASE_MS,
  STALL_PER_AUDIO,
} from "../src/main/server/jobs.ts";
import { ModelStore } from "../src/main/server/model-store.ts";
import { Remotes } from "../src/main/server/remotes.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";
import { asKey, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const NOTE = monoWav(concat(silence(0.3), speak(["hello", "world"]), silence(0.4)));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Rig {
  rig: AppRig;
  key: Key;
  clock: { t: number };
  /** Decodes started. */
  decodes: number;
  /** Holds every decode until `open()`. */
  hold(): void;
  open(): void;
}

async function rig(llamaArgs: string[] = []): Promise<Rig> {
  const t = tempDir("akou-stall-");
  const clock = { t: Date.UTC(2026, 9, 13, 12) };
  let held: Promise<void> = Promise.resolve();
  let release = () => {};
  const out: Rig = {
    rig: null as unknown as AppRig,
    key: null as unknown as Key,
    clock,
    decodes: 0,
    hold: () => {
      held = new Promise<void>((r) => {
        release = r;
      });
    },
    open: () => release(),
  };
  out.rig = await appRig({
    settings: {
      ...SERVER,
      "asr.llamaServer": [
        process.execPath,
        FAKE_LLAMA,
        "--fake-log",
        join(t.dir, "llama.log"),
        ...llamaArgs,
      ],
    },
    jobs: {
      now: () => clock.t,
      decode: async (path, signal) => {
        out.decodes++;
        await held;
        return readUploadAudio(path, { signal });
      },
    },
  });
  cleanups.push(async () => {
    release();
    await out.rig.close();
    t.cleanup();
  });
  out.key = await newKey(out.rig, "archive");
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: an answer's JSON is read field by field.
type Body = any;

async function health(r: Rig): Promise<{ status: number; body: Body }> {
  const res = await fetch(`http://127.0.0.1:${r.rig.port}/healthz`);
  return { status: res.status, body: await res.json() };
}

const stallLines = (r: Rig) => r.rig.logs.filter((l) => l.msg.startsWith("job.stalled "));

describe("#407: /healthz says so while a job is stuck at running", () => {
  test("a held job: 200 at 100 s, 503 ok:false stalled 1 past 300 s, one warn line, 200 again once it ends", async () => {
    const r = await rig();
    const before = await health(r);
    expect(before.status).toBe(200);
    r.hold();
    const s = await submit(r.rig, r.key.key, NOTE, { preset: "best" });
    expect(s.status).toBe(202);
    const id = s.body.id as string;
    await until(() => r.decodes === 1, 10_000, "the decode to start");
    const started = r.clock.t;

    // Positive control: a job well inside its time is not stalled.
    r.clock.t = started + 100_000;
    const early = await health(r);
    expect(early.status).toBe(200);
    expect(early.body.ok).toBe(true);
    expect(early.body.queue.stalled).toBe(0);
    expect(early.body.queue.running).toBe(1);

    // The audio's length is not known while it decodes: the base alone.
    r.clock.t = started + STALL_BASE_MS + 1_000;
    const late = await health(r);
    expect(late.status).toBe(503);
    expect(late.body.ok).toBe(false);
    expect(late.body.queue.stalled).toBe(1);
    // models_ready keeps its meaning: the models, not the jobs.
    expect(late.body.models_ready).toBe(before.body.models_ready);
    const server = await asKey(r.rig, r.key.key, "GET", "/server");
    expect(server.body.queue.stalled).toBe(1);
    await health(r);
    const lines = stallLines(r);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.msg).toContain(`job.stalled ${id} `);
    expect(lines[0]?.msg).toContain("running 301 s on audio of unknown length, stage decode");

    // The way out: the job ends, and the server is healthy again. Nothing stopped it.
    r.open();
    const end = await asKey(r.rig, r.key.key, "GET", `/jobs/${id}?wait=30`);
    expect(`${end.body.status} ${end.body.error?.message ?? ""}`).toBe("done ");
    const after = await health(r);
    expect(after.status).toBe(200);
    expect(after.body.ok).toBe(true);
    expect(after.body.queue.stalled).toBe(0);
  });

  test("the budget grows by 5 times the audio once its length is known", async () => {
    // llama-server never answers: the job sits at its transcribe stage with its length known.
    const r = await rig(["--fake-hang"]);
    const s = await submit(r.rig, r.key.key, NOTE, { preset: "best" });
    expect(s.status).toBe(202);
    const id = s.body.id as string;
    let progress: { stage: string; total_s: number | null } | undefined;
    await until(
      async () => {
        const j = await asKey(r.rig, r.key.key, "GET", `/jobs/${id}`);
        progress = j.body.progress;
        return progress !== undefined && progress.stage !== "decode" && progress.total_s !== null;
      },
      20_000,
      "the job to reach its transcribe stage",
    );
    const total = progress?.total_s as number;
    expect(total).toBeGreaterThan(0.5);
    const startedAt = Date.parse(
      (await asKey(r.rig, r.key.key, "GET", `/jobs/${id}`)).body.started_at as string,
    );
    const budget = STALL_BASE_MS + STALL_PER_AUDIO * total * 1000;
    // Positive control: past the base alone, inside base plus 5 times the audio.
    r.clock.t = startedAt + budget - 1_000;
    expect(r.clock.t - startedAt).toBeGreaterThan(STALL_BASE_MS);
    expect((await health(r)).body.queue.stalled).toBe(0);
    r.clock.t = startedAt + budget + 1_000;
    const late = await health(r);
    expect(late.status).toBe(503);
    expect(late.body.queue.stalled).toBe(1);
    expect(stallLines(r)[0]?.msg).toContain(`on ${total} s of audio, stage ${progress?.stage}`);
  });
});

function shelf(dir: string): ModelStore {
  return new ModelStore({
    dir: () => join(dir, "models"),
    machine: () => null,
    catalog: () => MODELS,
    autoDownload: () => false,
    maxGb: () => 0,
    unusedDays: () => 0,
    log: () => {},
  });
}

/** A bare JobService on a fake clock, its log in `lines`, and a way to submit one job. */
function service(o: Partial<JobServiceOptions>) {
  const t = tempDir("akou-stall-svc-");
  const clock = { t: Date.UTC(2026, 9, 13, 12) };
  const lines: string[] = [];
  const svc = new JobService({
    dir: t.dir,
    version: "0.0.0",
    models: () => null,
    shelf: shelf(t.dir),
    defaultModel: () => "auto",
    diarizer: () => "embeddings",
    secrets: () => [],
    hostListed: () => false,
    retainDays: () => 7,
    maxAudioMinutes: () => 240,
    concurrency: () => 1,
    queueMax: () => 0,
    queueMaxPerKey: () => 0,
    now: () => clock.t,
    log: (_level, msg) => lines.push(msg),
    ...o,
  });
  cleanups.push(() => {
    svc.close();
    t.cleanup();
  });
  svc.start();
  const add = (fields: { preset?: string; route?: "remote" | "local" | null } = {}) => {
    const audio = join(svc.uploadDir, `${crypto.randomUUID()}.upload`);
    writeFileSync(audio, "audio");
    const r = svc.submit({
      key_id: "key_a",
      preset: fields.preset ?? "fast",
      route: fields.route ?? null,
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
  return { svc, clock, lines, add, dir: t.dir };
}

describe("#407: what the stall clock counts", () => {
  const QWEN = { kind: "llama-server", engine: "qwen3-asr-1.7b" } as unknown as FusionEngineSpec;
  const FINAL_QWEN = { kind: "module", path: "x", model: "x", final: QWEN } as unknown as ModelSpec;

  test("in the desktop app, a job waiting for the GPU line's turn is not stalled", async () => {
    const turns: string[] = [];
    const { svc, clock, add } = service({
      models: () => FINAL_QWEN,
      decode: async () => new Float32Array(16_000),
      // A call's final pass holds the line for good.
      gpuTurn: (id) => {
        turns.push(id);
        return new Promise(() => {});
      },
    });
    add();
    await until(() => turns.length === 1, 4_000, "the job to ask for the GPU turn");
    clock.t += 3_600_000;
    expect(svc.queueStats().running).toBe(1);
    expect(svc.queueStats().stalled).toBe(0);
  });

  test("positive control: the same job held before its turn, in its decode, is stalled", async () => {
    let decodes = 0;
    const { svc, clock, add, lines } = service({
      models: () => FINAL_QWEN,
      decode: () => {
        decodes++;
        return new Promise(() => {});
      },
      gpuTurn: () => new Promise(() => {}),
    });
    add();
    await until(() => decodes === 1, 4_000, "the decode to start");
    clock.t += STALL_BASE_MS + 1_000;
    expect(svc.queueStats().stalled).toBe(1);
    expect(lines.filter((l) => l.startsWith("job.stalled "))).toHaveLength(1);
  });

  test("a stalled job is logged by the 30 s check even when nobody reads the queue", async () => {
    let decodes = 0;
    const { clock, add, lines } = service({
      models: () => ({ kind: "module", path: "x", model: "x" }) as unknown as ModelSpec,
      decode: () => {
        decodes++;
        return new Promise(() => {});
      },
      stallCheckMs: 20,
    });
    add();
    await until(() => decodes === 1, 4_000, "the decode to start");
    // Positive control: inside its time, the check runs and logs nothing.
    await new Promise((r) => setTimeout(r, 150));
    expect(lines.filter((l) => l.startsWith("job.stalled "))).toHaveLength(0);
    clock.t += STALL_BASE_MS + 1_000;
    await until(
      () => lines.some((l) => l.startsWith("job.stalled ")),
      4_000,
      "the interval to log the stalled job",
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(lines.filter((l) => l.startsWith("job.stalled "))).toHaveLength(1);
  });

  test("a job sent to a remote: its clock starts when the remote runs it, its audio from the remote", async () => {
    const url = "http://remote.example";
    let remoteStatus = "queued";
    let polls = 0;
    const t = tempDir("akou-stall-key-");
    cleanups.push(t.cleanup);
    const keyFile = join(t.dir, "worker.key");
    writeFileSync(keyFile, "ak_x\n", { mode: 0o600 });
    const { svc, clock, add, lines } = service({
      remotes: () => [`${url} ${keyFile} fast`],
      remoteProbeMs: 60_000,
      remoteFetch: (async (input: string | URL | Request, init?: RequestInit) => {
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
        if (u.endsWith("/v1/jobs") && init?.method === "POST") return Response.json({ id: "r1" });
        if (u.includes("/v1/jobs/r1")) {
          await new Promise((r) => setTimeout(r, 10));
          polls++;
          return Response.json({ id: "r1", status: remoteStatus, progress: { total_s: 60 } });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      }) as unknown as typeof fetch,
    });
    add({ route: "remote" });
    await until(() => polls >= 2, 4_000, "the job to go to the remote");
    // Waiting in the remote's queue is not running.
    clock.t += 3_600_000;
    expect(svc.queueStats().running).toBe(1);
    expect(svc.queueStats().stalled).toBe(0);
    remoteStatus = "running";
    const seen = polls;
    await until(() => polls >= seen + 2, 4_000, "the remote to say it runs the job");
    const from = clock.t;
    const budget = STALL_BASE_MS + STALL_PER_AUDIO * 60 * 1000;
    clock.t = from + budget - 1_000;
    expect(svc.queueStats().stalled).toBe(0);
    clock.t = from + budget + 1_000;
    expect(svc.queueStats().stalled).toBe(1);
    const line = lines.find((l) => l.startsWith("job.stalled "));
    expect(line).toContain(`on 60 s of audio, on ${url}`);
  });
});

describe("#407: a server sends no job to a remote that reports a stalled one", () => {
  test("pick passes over a remote with queue.stalled 1, and takes it again once it reports 0", async () => {
    const url = "http://remote.example";
    const t = tempDir("akou-stall-pick-");
    cleanups.push(t.cleanup);
    const keyFile = join(t.dir, "worker.key");
    writeFileSync(keyFile, "ak_x\n", { mode: 0o600 });
    let stalled = 1;
    let changes = 0;
    const lines: string[] = [];
    const remotes = new Remotes({
      entries: () => [`${url} ${keyFile} fast`],
      fetch: (async (input: string | URL | Request) => {
        const u = String(input);
        if (u.endsWith("/v1/server")) {
          return Response.json({
            name: "akou",
            presets: [{ name: "fast", available: true }],
            engines: [],
            capabilities: { jobs: true },
            queue: { stalled },
          });
        }
        if (u.endsWith("/v1/keys/me")) return Response.json({ id: "k1" });
        return Response.json({ error: "not_found" }, { status: 404 });
      }) as unknown as typeof fetch,
      onChange: () => changes++,
      log: (_level, msg) => lines.push(msg),
    });
    cleanups.push(() => remotes.close());
    await remotes.probeAll();
    expect(remotes.view()[0]?.state).toBe("up");
    expect(remotes.pick(["fast"], true)).toBeNull();
    expect(remotes.pick(["fast"], false)).toBeNull();
    expect(lines.some((l) => l.startsWith(`remote.stalled ${url}: 1 job(s)`))).toBe(true);
    // The way out: at its next probe it reports none, the queue is told, and it is picked again.
    stalled = 0;
    const before = changes;
    await remotes.probeAll();
    expect(changes).toBe(before + 1);
    expect(remotes.pick(["fast"], true)).toBe(url);
    expect(lines.at(-1)).toStartWith(`remote.up ${url}`);
  });
});
