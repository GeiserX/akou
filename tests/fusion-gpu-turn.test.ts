/**
 * Two review findings on the fusion pass. A fused job that holds Qwen waits for the owner's GPU
 * line like a final pass does, so it never decodes beside a call's final pass or another Qwen job.
 * And a queue that fails to start in the desktop app closes without closing the model store it
 * shares with the Models page.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FusionEngineSpec, ModelSpec } from "../src/main/asr/engine.ts";
import { MODELS } from "../src/main/asr/models.ts";
import { JobService, takesGpuTurn } from "../src/main/server/jobs.ts";
import { ModelStore } from "../src/main/server/model-store.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const QWEN = { kind: "llama-server", engine: "qwen3-asr-1.7b" } as unknown as FusionEngineSpec;
const WHISPER = {
  kind: "transcribe-cpp",
  engine: "whisper-large-v3",
} as unknown as FusionEngineSpec;
const PARAKEET = { kind: "recognizer", engine: "parakeet" } as FusionEngineSpec;
const fused = (engines: FusionEngineSpec[]) =>
  ({
    kind: "module",
    path: "/nonexistent.ts",
    model: "x",
    fusion: { fuser: "rover-conf", engines },
  }) as ModelSpec;

function store(dir: string) {
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

function service(spec: ModelSpec, turns: string[]) {
  const t = tempDir("akou-gputurn-");
  cleanups.push(t.cleanup);
  const svc = new JobService({
    dir: t.dir,
    version: "0.0.0",
    models: () => spec,
    decode: async () => new Float32Array(16_000),
    shelf: store(t.dir),
    defaultModel: () => "auto",
    diarizer: () => "embeddings",
    secrets: () => [],
    hostListed: () => false,
    retainDays: () => 7,
    maxAudioMinutes: () => 240,
    concurrency: () => 1,
    queueMax: () => 0,
    queueMaxPerKey: () => 0,
    log: () => {},
    // The turn never comes: the job holds here, before any Worker is built.
    gpuTurn: (id) => {
      turns.push(id);
      return new Promise(() => {});
    },
  });
  cleanups.push(() => svc.close());
  svc.start();
  const audio = join(svc.uploadDir, "u.upload");
  writeFileSync(audio, "audio");
  const r = svc.submit({
    key_id: "key_a",
    preset: "fast",
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
  return { svc, job: r.job };
}

describe("a fused pass that holds Qwen takes the GPU turn", () => {
  test("takesGpuTurn: a final engine, or a llama-server engine among the fused ones", () => {
    expect(takesGpuTurn(fused([PARAKEET, QWEN, WHISPER]))).toBe(true);
    expect(takesGpuTurn(fused([PARAKEET, WHISPER]))).toBe(false);
    expect(takesGpuTurn({ kind: "module", path: "x", model: "x" } as ModelSpec)).toBe(false);
    expect(
      takesGpuTurn({ kind: "module", path: "x", model: "x", final: QWEN } as unknown as ModelSpec),
    ).toBe(true);
  });

  test("a fused job with Qwen asks for the turn before its Worker starts", async () => {
    const turns: string[] = [];
    const { job } = service(fused([PARAKEET, QWEN, WHISPER]), turns);
    await until(() => turns.length === 1, 4_000, "the job to ask for the GPU turn");
    expect(turns).toEqual([job.id]);
  });

  test("positive control: a fused job without Qwen never asks for it", async () => {
    const turns: string[] = [];
    const { svc, job } = service(fused([PARAKEET, WHISPER]), turns);
    await until(
      () =>
        svc.store.job(job.id)?.status !== "queued" && svc.store.job(job.id)?.status !== "running",
      4_000,
      "the job to end",
    );
    expect(turns).toEqual([]);
  });
});

describe("a queue that fails to start keeps the shared model store open", () => {
  test("close({ keepShelf: true }) leaves the store open; close() closes it", () => {
    for (const keep of [true, false]) {
      const t = tempDir("akou-keepshelf-");
      cleanups.push(t.cleanup);
      const shelf = store(t.dir);
      let closed = 0;
      const orig = shelf.close.bind(shelf);
      shelf.close = () => {
        closed++;
        orig();
      };
      const svc = new JobService({
        dir: t.dir,
        version: "0.0.0",
        models: () => null,
        shelf,
        defaultModel: () => "auto",
        diarizer: () => "embeddings",
        secrets: () => [],
        hostListed: () => false,
        retainDays: () => 7,
        maxAudioMinutes: () => 240,
        concurrency: () => 1,
        queueMax: () => 0,
        queueMaxPerKey: () => 0,
        log: () => {},
      });
      svc.close(keep ? { keepShelf: true } : {});
      expect(closed).toBe(keep ? 0 : 1);
      if (keep) shelf.close();
    }
  });
});
