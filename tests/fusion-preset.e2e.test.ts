/**
 * akou-5an.41 and ASR-6: the `fusion` preset on server jobs, end to end. Through the real API with
 * fakes: Qwen is the fake llama-server (`asr.llamaServer`), Whisper the test module's
 * `createEngine`, Parakeet, the VAD and the speaker labels the fake model set, so nothing
 * downloads. Then, when the real models are on disk (`AKOU_MODELS_DIR`, else the app's models
 * folder: Qwen3-ASR and its llama-server build, Whisper large-v3, Parakeet and Silero), the same
 * pass in the real job Worker on `tests/fixtures/two-voices.wav`.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectAccelerator, hostProbe } from "../src/main/asr/accelerator.ts";
import { JobWorker } from "../src/main/asr/finalize-worker.ts";
import { FUSION_DEFAULT, fusionModelId, fusionParts, fusionSpec } from "../src/main/asr/fusion.ts";
import { QWEN_ASR, QWEN_MMPROJ_FILE, QWEN_MODEL_FILE } from "../src/main/asr/llama-catalog.ts";
import { llamaRuntime } from "../src/main/asr/llama-server.ts";
import {
  defaultModelsDir,
  hostPlatform,
  MODELS,
  modelFile,
  NEMOTRON,
  RECOGNIZER,
  WHISPER_LARGE_V3,
} from "../src/main/asr/models.ts";
import { resolveModel } from "../src/main/server/model-store.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";
import { asKey, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");

const DIALOGUE = monoWav(
  concat(
    silence(0.4),
    speak(["hello", "world"], { voice: 1 }),
    silence(1.2),
    speak(["ok", "great"], { voice: 4 }),
    silence(0.6),
  ),
);

const FUSED = fusionModelId("rover-conf", FUSION_DEFAULT);

async function rigWith(options: Record<string, unknown> = {}): Promise<{ rig: AppRig; key: Key }> {
  const rig = await appRig({
    settings: { ...SERVER, "asr.llamaServer": [process.execPath, FAKE_LLAMA] },
    models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options },
  });
  return { rig, key: await newKey(rig, "archive") };
}

async function done(rig: AppRig, key: Key, id: string) {
  const r = await asKey(rig, key.key, "GET", `/jobs/${id}?wait=30`);
  expect(`${r.body.status} ${r.body.error?.message ?? ""}`).toBe("done ");
  return { job: r.body, result: (await asKey(rig, key.key, "GET", `/jobs/${id}/result`)).body };
}

describe("[akou-5an.41] preset fusion through the API, with fakes", () => {
  let rig: AppRig;
  let key: Key;
  beforeAll(async () => {
    ({ rig, key } = await rigWith());
  });
  afterAll(async () => {
    await rig.close();
  });

  test("GET /v1/server lists fusion available, its three engines, Nemotron and rover-conf", async () => {
    const r = await asKey(rig, key.key, "GET", "/server");
    const p = r.body.presets.find((x: { name: string }) => x.name === "fusion");
    expect(p).toMatchObject({
      available: true,
      engines: [QWEN_ASR, WHISPER_LARGE_V3, RECOGNIZER],
      diarizer: NEMOTRON,
      fusion: "rover-conf",
    });
    const fast = r.body.presets.find((x: { name: string }) => x.name === "fast");
    expect(fast).toMatchObject({ fusion: null, diarizer: NEMOTRON });
  });

  test("a job with preset fusion: done, the fused model, every engine named and timed, speakers on the lines", async () => {
    const s = await submit(rig, key.key, DIALOGUE, { preset: "fusion", diarize: "true" });
    expect(s.status).toBe(202);
    const { job, result } = await done(rig, key, s.body.id);
    expect(job).toMatchObject({ model: FUSED, preset: "fusion", model_source: "request" });
    expect(result.text).toBe("hello world ok great");
    expect(result.engine.preset).toBe("fusion");
    expect(result.engine.models).toEqual([...FUSION_DEFAULT, "silero-vad", NEMOTRON]);
    expect(result.engine.fusion.fuser).toBe("rover-conf");
    expect(result.engine.fusion.engines.map((e: { id: string }) => e.id)).toEqual([
      ...FUSION_DEFAULT,
    ]);
    for (const e of result.engine.fusion.engines) expect(e.decode_s).toBeGreaterThanOrEqual(0);
    expect(result.engine.fusion.dropped).toEqual([]);
    expect(result.words.map((w: { w: string }) => w.w).join(" ")).toBe(result.text);
    expect(result.segments.map((x: { speaker: string }) => x.speaker)).toEqual(["s0", "s1"]);
  });

  test("model: rover-conf(qwen, parakeet) runs that list, as a custom choice", async () => {
    const two = fusionModelId("rover-conf", [QWEN_ASR, RECOGNIZER]);
    const s = await submit(rig, key.key, DIALOGUE, { model: two });
    const { job, result } = await done(rig, key, s.body.id);
    expect(job).toMatchObject({ model: two, preset: "custom" });
    expect(result.engine.models).toEqual([QWEN_ASR, RECOGNIZER, "silero-vad"]);
    expect(result.text).toBe("hello world ok great");
    // Refused before anything runs: an unbuilt fuser, an engine the pass cannot run.
    const llm = await submit(rig, key.key, DIALOGUE, { model: `llm-free(${QWEN_ASR})` });
    expect([llm.status, llm.body.error]).toEqual([409, "preset_unavailable"]);
    const bad = await submit(rig, key.key, DIALOGUE, { model: `rover-conf(${QWEN_ASR},nope)` });
    expect([bad.status, bad.body.error]).toEqual([422, "unknown_model"]);
  });

  test("asr.final.engines and asr.fusion change what preset fusion runs, and server.default_model may name fusion", async () => {
    const admin = await newKey(rig, "admin", "admin");
    const set = (body: Record<string, unknown>) => asKey(rig, admin.key, "PATCH", "/config", body);
    expect(
      (await set({ "asr.final.engines": [WHISPER_LARGE_V3, RECOGNIZER], "asr.fusion": "first" }))
        .status,
    ).toBe(200);
    try {
      const listed = (await asKey(rig, key.key, "GET", "/server")).body.presets.find(
        (x: { name: string }) => x.name === "fusion",
      );
      expect(listed).toMatchObject({ engines: [WHISPER_LARGE_V3, RECOGNIZER], fusion: "first" });
      expect((await set({ "server.default_model": "fusion" })).status).toBe(200);
      const s = await submit(rig, key.key, DIALOGUE, { preset: "auto" });
      const { job, result } = await done(rig, key, s.body.id);
      const model = fusionModelId("first", [WHISPER_LARGE_V3, RECOGNIZER]);
      expect(job).toMatchObject({ model, preset: "fusion", model_source: "server_default" });
      expect(result.engine.fusion.fuser).toBe("first");
      // A bad list is refused by the setting itself.
      const refused = await set({ "asr.final.engines": ["whisper-large-v3-turbo"] });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain("cannot run in the final pass");
    } finally {
      await set({
        "asr.final.engines": [],
        "asr.fusion": "rover-conf",
        "server.default_model": "auto",
      });
    }
  });
});

describe("[ASR-6] a failing engine is isolated, through the API", () => {
  test("Whisper will not load: the job is done with Qwen and Parakeet, and the result says why", async () => {
    const { rig, key } = await rigWith({ engineLoadFails: [WHISPER_LARGE_V3] });
    try {
      const s = await submit(rig, key.key, DIALOGUE, { preset: "fusion" });
      const { job, result } = await done(rig, key, s.body.id);
      expect(job.model).toBe(FUSED);
      expect(result.text).toBe("hello world ok great");
      expect(result.engine.models).toEqual([QWEN_ASR, RECOGNIZER, "silero-vad"]);
      expect(result.engine.fusion.dropped).toEqual([
        {
          engine: WHISPER_LARGE_V3,
          reason: `did not load: ${WHISPER_LARGE_V3} would not load`,
          units: null,
        },
      ]);
    } finally {
      await rig.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The real models

const DIR = process.env.AKOU_MODELS_DIR || defaultModelsDir();
const BUILD = llamaRuntime(
  { "asr.accelerator": "auto", "asr.llamaServer": [] },
  hostPlatform(),
  MODELS,
  { detected: detectAccelerator("auto", hostProbe()) },
);

/** Whether every file of these catalog ids is in `DIR` at its pinned size. */
function onDisk(ids: readonly (string | null)[]): boolean {
  return ids.every((id) => {
    const m = MODELS.find((x) => x.id === id);
    return (
      !!m &&
      m.files.every((f) => {
        const p = modelFile(DIR, m.id, f.name);
        return existsSync(p) && statSync(p).size === f.size;
      })
    );
  });
}

/**
 * The llama-server the build unpacked to, run as an own command (`asr.llamaServer`), so the test
 * never takes the build's pid file, and never stops a llama-server the app on this machine runs.
 */
function llamaBinary(): string | null {
  const bin = join(DIR, BUILD ?? "none", "bin");
  if (!existsSync(bin)) return null;
  for (const d of readdirSync(bin)) {
    const p = join(bin, d, process.platform === "win32" ? "llama-server.exe" : "llama-server");
    if (existsSync(p)) return p;
  }
  return null;
}

const LLAMA = llamaBinary();
const REAL = onDisk([...FUSION_DEFAULT, "silero-vad"]) && LLAMA !== null;

/** tests/fixtures/two-voices.wav: 16 kHz mono 16-bit. */
function twoVoices(): Float32Array {
  const bytes = readFileSync(join(import.meta.dir, "fixtures", "two-voices.wav"));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  while (o + 8 <= bytes.length) {
    const size = v.getUint32(o + 4, true);
    if (bytes.subarray(o, o + 4).toString() === "data") {
      const out = new Float32Array(Math.floor(size / 2));
      for (let i = 0; i < out.length; i++) out[i] = v.getInt16(o + 8 + i * 2, true) / 32768;
      return out;
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("two-voices.wav has no data chunk");
}

describe("[ASR-6] preset fusion on the real engines", () => {
  test.skipIf(!REAL)(
    "two-voices.wav through Qwen, Whisper and Parakeet in the job Worker: text, the fused model, timed words (skipped: the fusion models or the unpacked llama-server are not in the models folder)",
    async () => {
      const t = tempDir("akou-fusion-real-");
      const choice = resolveModel({ preset: "fusion" }, { catalog: MODELS, defaultModel: "auto" });
      const fused = fusionParts(choice.model) as { fuser: "rover-conf"; engines: string[] };
      const spec = fusionSpec(
        { kind: "sherpa", dir: DIR, cacheDir: join(t.dir, "cache") },
        fused.fuser,
        fused.engines,
        {
          catalog: MODELS,
          modelsDir: DIR,
          languages: ["en"],
          budgetMb: 0,
          llama: (id) => ({
            kind: "llama-server",
            engine: id,
            model: modelFile(DIR, id, QWEN_MODEL_FILE),
            mmproj: modelFile(DIR, id, QWEN_MMPROJ_FILE),
            accelerator: process.platform === "darwin" ? "metal" : "cpu",
            languages: ["en"],
            command: [LLAMA as string],
          }),
        },
      );
      const logs: string[] = [];
      const worker = new JobWorker(spec, (level, msg) => logs.push(`${level} ${msg}`));
      try {
        const from = performance.now();
        const r = await worker.run({
          samples: twoVoices(),
          diarize: false,
          decode: null,
          language: "auto",
          glossary: [],
        });
        const wall = (performance.now() - from) / 1000;
        expect(r.text.length).toBeGreaterThan(40);
        expect(r.text.toLowerCase()).toContain("migration");
        expect(r.model?.startsWith("rover-conf(")).toBe(true);
        expect(r.model).toBe(choice.model);
        expect(r.fusion?.dropped).toEqual([]);
        expect(r.words.length).toBeGreaterThan(20);
        const timed = r.words.filter((w) => w.s !== null && w.e !== null);
        expect(timed.length).toBeGreaterThan(r.words.length / 2);
        // The measurement the docs quote: each engine's decode seconds and the pass's wall time.
        console.log(
          `fusion pass on two-voices.wav: ${wall.toFixed(1)} s wall; ${(r.fusion?.engines ?? [])
            .map((e) => `${e.id} load ${e.load_s} s, decode ${e.decode_s} s`)
            .join(", ")}; ${r.words.length} words, ${timed.length} timed: ${r.text}`,
        );
      } finally {
        worker.close();
        t.cleanup();
      }
    },
    600_000,
  );
});
