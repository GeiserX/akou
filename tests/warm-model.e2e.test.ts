/**
 * The model a file job loads, kept between jobs (akou-5an.104, .114, .117, .107): an idle Worker
 * keeps its model for `server.model_idle_minutes` and then lets it go; among queued jobs of one
 * priority, a job on the loaded model goes first, so a switch of preset does not reload it; the
 * queue reports what is loaded; and two jobs on a Metal llama-server take turns instead of
 * stopping each other's server. The engine is the fake llama-server, so every start is a line in
 * its log.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { MODELS } from "../src/main/asr/models.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { JobService, WARM_PASS_LIMIT } from "../src/main/server/jobs.ts";
import { ModelStore } from "../src/main/server/model-store.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";
import { asKey, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const FAKE_MODELS = join(import.meta.dir, "fixtures", "asr-fake.ts");
const NOTE = monoWav(concat(silence(0.3), speak(["hello", "world"]), silence(0.4)));

/** How many times the fake llama-server started: one `{argv}` line per start. */
function starts(log: string): number {
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l && "argv" in JSON.parse(l)).length;
}

interface Warm {
  rig: AppRig;
  key: Key;
  log: string;
  clock: { t: number };
  /** The uploads whose decode started, in that order. */
  order: string[];
  /** Holds every decode until `open()`. */
  hold(): void;
  open(): void;
  done(): Promise<void>;
}

async function warmRig(settings: Record<string, unknown> = {}): Promise<Warm> {
  const t = tempDir("akou-warm-");
  const log = join(t.dir, "llama.log");
  const clock = { t: Date.UTC(2026, 9, 2, 12) };
  const order: string[] = [];
  let held: Promise<void> = Promise.resolve();
  let release = () => {};
  const rig = await appRig({
    settings: {
      ...SERVER,
      "asr.llamaServer": [process.execPath, FAKE_LLAMA, "--fake-log", log],
      ...settings,
    },
    jobs: {
      now: () => clock.t,
      decode: async (path, signal) => {
        order.push(path);
        await held;
        return readUploadAudio(path, { signal });
      },
    },
  });
  const key = await newKey(rig, "archive");
  return {
    rig,
    key,
    log,
    clock,
    order,
    hold: () => {
      held = new Promise<void>((r) => {
        release = r;
      });
    },
    open: () => release(),
    done: async () => {
      release();
      await rig.close();
      t.cleanup();
    },
  };
}

async function ended(w: Warm, id: string): Promise<void> {
  const r = await asKey(w.rig, w.key.key, "GET", `/jobs/${id}?wait=30`);
  expect(`${r.body.status} ${r.body.error?.message ?? ""}`).toBe("done ");
}

async function run(w: Warm, preset: string): Promise<string> {
  const s = await submit(w.rig, w.key.key, NOTE, { preset });
  expect(s.status).toBe(202);
  return s.body.id as string;
}

/** The upload a job reads, so the decode order names the jobs. */
function audioOf(w: Warm, id: string): string {
  return w.rig.app.jobs()?.store.job(id)?.audio as string;
}

describe("akou-5an.104: the model stays loaded between jobs, then lets go", () => {
  let w: Warm;
  beforeAll(async () => {
    w = await warmRig();
  });
  afterAll(async () => w.done());

  test("three best jobs one after another start llama-server once, and the queue reports it loaded", async () => {
    for (let i = 0; i < 3; i++) await ended(w, await run(w, "best"));
    expect(starts(w.log)).toBe(1);
    expect(w.rig.logs.filter((l) => / ready on port /.test(l.msg))).toHaveLength(1);
    const server = await asKey(w.rig, w.key.key, "GET", "/server");
    expect(server.body.queue.loaded).toEqual([QWEN_ASR]);
    // akou-5an.117: /healthz names the loaded model too, so a client can batch its jobs by it.
    const health = await fetch(`http://127.0.0.1:${w.rig.port}/healthz`);
    expect(((await health.json()) as { queue: { loaded: string[] } }).queue.loaded).toEqual([
      QWEN_ASR,
    ]);
  });

  test("after server.model_idle_minutes with no job the Worker and its llama-server go", async () => {
    const line = w.rig.logs.find((l) => / ready on port /.test(l.msg))?.msg as string;
    const pid = Number(/llama-server (\d+) ready/.exec(line)?.[1]);
    expect(pid).toBeGreaterThan(0);
    // Ended: no such pid, or a zombie its terminated Worker never reaped.
    const alive = () => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      if (process.platform === "win32") return true;
      const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
      return !r.stdout.toString().trim().startsWith("Z");
    };
    // Positive control: before the idle period ends, the check keeps it.
    w.clock.t += 59 * 60_000;
    w.rig.app.jobs()?.releaseIdle();
    expect(w.rig.app.jobs()?.loaded()).toEqual([QWEN_ASR]);
    expect(alive()).toBe(true);
    w.clock.t += 2 * 60_000;
    w.rig.app.jobs()?.releaseIdle();
    expect(w.rig.app.jobs()?.loaded()).toEqual([]);
    await until(() => !alive(), 10_000, "llama-server to stop");
    expect(w.rig.logs.some((l) => l.msg.includes(`${QWEN_ASR} unloaded after 60 min`))).toBe(true);
    // The next job loads it again.
    await ended(w, await run(w, "best"));
    expect(starts(w.log)).toBe(2);
  });
});

describe("akou-5an.104: positive control, server.model_idle_minutes 0", () => {
  test("each best job after the queue drains starts llama-server again", async () => {
    const w = await warmRig({ "server.model_idle_minutes": 0 });
    try {
      for (let i = 0; i < 2; i++) await ended(w, await run(w, "best"));
      expect(starts(w.log)).toBe(2);
      expect(w.rig.app.jobs()?.loaded()).toEqual([]);
    } finally {
      await w.done();
    }
  });
});

describe("akou-5an.114: queued jobs of one priority go by the loaded model", () => {
  let w: Warm;
  afterEach(async () => w.done());

  test("best, fast, best queued behind a best job: the second best runs before fast, Qwen loads once", async () => {
    w = await warmRig();
    w.hold();
    const first = await run(w, "best");
    await until(() => w.order.length === 1, 10_000, "the first job to start");
    const fast = await run(w, "fast");
    const best = await run(w, "best");
    const want = [first, best, fast].map((id) => audioOf(w, id));
    w.open();
    for (const id of [first, fast, best]) await ended(w, id);
    expect(w.order).toEqual(want);
    expect(starts(w.log)).toBe(1);
  });

  test(`a job on another model is passed over at most ${WARM_PASS_LIMIT} times`, async () => {
    w = await warmRig();
    w.hold();
    const first = await run(w, "best");
    await until(() => w.order.length === 1, 10_000, "the first job to start");
    const fast = await run(w, "fast");
    const bests: string[] = [];
    for (let i = 0; i < WARM_PASS_LIMIT + 2; i++) bests.push(await run(w, "best"));
    const audio = new Map([first, fast, ...bests].map((id) => [audioOf(w, id), id]));
    w.open();
    for (const id of [first, fast, ...bests]) await ended(w, id);
    const ran = w.order.map((p) => audio.get(p));
    // The first, then WARM_PASS_LIMIT bests on the loaded Qwen, then fast, then the rest.
    expect(ran.indexOf(fast)).toBe(1 + WARM_PASS_LIMIT);
  });
});

/**
 * A JobService on a Metal llama-server spec, with no HTTP server: the fake recognizer under a fake
 * llama-server whose pid file lives in one shared build folder, as every Metal llama-server's does.
 */
function metalService(o: {
  concurrency?: number;
  dictationSlots?: number;
  modelIdleMinutes?: number;
  decode?: (path: string, signal: AbortSignal) => Promise<Float32Array>;
}) {
  const t = tempDir("akou-metal-");
  const log = join(t.dir, "llama.log");
  const spec: ModelSpec = {
    kind: "module",
    path: FAKE_MODELS,
    model: "fake-parakeet",
    options: {},
    final: {
      kind: "llama-server",
      engine: QWEN_ASR,
      model: join(t.dir, "q.gguf"),
      mmproj: join(t.dir, "p.gguf"),
      accelerator: "metal",
      // Slow to load, as Qwen is, so two jobs overlap.
      command: [process.execPath, FAKE_LLAMA, "--fake-log", log, "--fake-loading-ms", "500"],
      // The build's folder holds the pid file every Metal llama-server reads at its start.
      build: { dir: join(t.dir, "build"), archives: [], platform: "darwin-arm64" },
    },
  };
  const svc = new JobService({
    dir: join(t.dir, "jobs"),
    version: "0.0.0",
    models: () => spec,
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
    concurrency: () => o.concurrency ?? 1,
    ...(o.dictationSlots !== undefined && { dictationSlots: () => o.dictationSlots as number }),
    ...(o.modelIdleMinutes !== undefined && {
      modelIdleMinutes: () => o.modelIdleMinutes as number,
    }),
    ...(o.decode && { decode: o.decode }),
    log: () => {},
  });
  svc.start();
  let n = 0;
  const add = (interactive = false): string => {
    const audio = join(svc.uploadDir, `m${n}.upload`);
    writeFileSync(audio, NOTE);
    const a = svc.submit({
      key_id: "key_a",
      preset: "fast",
      language: "auto",
      keywords: [],
      diarize: false,
      callback_url: null,
      metadata: null,
      idempotency_key: null,
      file_sha256: String(n++ % 10).repeat(64),
      audio,
      ...(interactive && { interactive: true }),
    });
    if (!("job" in a)) throw new Error(JSON.stringify(a));
    return a.job.id;
  };
  const status = (id: string) =>
    `${svc.store.job(id)?.status} ${svc.store.job(id)?.error?.message ?? ""}`;
  const ended = (ids: string[]) =>
    until(
      () => ids.every((id) => ["done", "failed"].includes(svc.store.job(id)?.status ?? "")),
      30_000,
      "the jobs to end",
    );
  return {
    svc,
    log,
    add,
    status,
    ended,
    close: () => {
      svc.close();
      t.cleanup();
    },
  };
}

describe("akou-5an.107: two jobs on a Metal llama-server take turns", () => {
  test("at concurrency 2 two best jobs both end done, and llama-server starts once", async () => {
    const m = metalService({ concurrency: 2 });
    try {
      const ids = [m.add(), m.add()];
      await m.ended(ids);
      expect(ids.map(m.status)).toEqual(["done ", "done "]);
      expect(starts(m.log)).toBe(1);
    } finally {
      m.close();
    }
  });

  test("a dictation on a Metal llama-server waits for the running job, then ends done", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const m = metalService({
      dictationSlots: 1,
      decode: async (path, signal) => {
        if (path.endsWith("m0.upload")) await held;
        return readUploadAudio(path, { signal });
      },
    });
    try {
      const file = m.add();
      await until(() => m.svc.store.job(file)?.status === "running", 10_000, "the file job");
      const dictation = m.add(true);
      // The lane has a free Worker, so only the running Metal job keeps the dictation queued.
      await Bun.sleep(1000);
      expect(m.svc.store.job(dictation)?.status).toBe("queued");
      release();
      await m.ended([file, dictation]);
      expect([file, dictation].map(m.status)).toEqual(["done ", "done "]);
    } finally {
      release();
      m.close();
    }
  });
});

describe("akou-5an.104: the idle timer lets the model go on its own", () => {
  test("with server.model_idle_minutes 0.02 and the real clock, the Worker unloads unasked", async () => {
    const m = metalService({ modelIdleMinutes: 0.02 });
    try {
      const id = m.add();
      await m.ended([id]);
      expect(m.status(id)).toBe("done ");
      // Positive control: the Worker holds the model once the job ends.
      expect(m.svc.loaded()).toHaveLength(1);
      // Nothing calls releaseIdle here: only the timer can unload it, 1.2 s after the job.
      await until(() => m.svc.loaded().length === 0, 10_000, "the idle timer to unload the model");
    } finally {
      m.close();
    }
  });
});
