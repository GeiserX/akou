/**
 * [T4.36] An invented sentence on silence (docs/TRAPS.md, SV-R5): a model that hears noise and no
 * speech writes a sentence anyway ("thank you for watching", Qwen3-ASR before sherpa-onnx 1.13.8),
 * or loops on one word. Bazarr turns that into a wrong subtitle. Every job's pass runs the VAD
 * before any model loads, decodes nothing where it heard no speech, and cuts a decoder loop at its
 * first repeat.
 *
 * The engines are fakes that invent on every unit, one per preset's shape: the model set's
 * recognizer (`fast`, and `auto` on a machine with Parakeet only), one engine (`best`, and `auto`
 * where Qwen is on disk), and a fusion list. The noise is generated here. The fake VAD is an energy
 * gate, so it judges quiet room noise only; noise at -30 dBFS goes through the real Silero VAD,
 * which runs where its model is on disk (`AKOU_MODELS_DIR`, else the app's models folder) and is
 * skipped elsewhere. Speech for the real VAD comes from macOS `say`, written to a file, never
 * played.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FinalEngine, Hypothesis } from "../src/main/asr/engine.ts";
import {
  cutLoop,
  type FusionPass,
  JOB_TRIM_PAD_SECONDS,
  type JobLogLevel,
  type JobPassResult,
  LOOP_MIN_REPEATS,
  loopCut,
  recognizerEngine,
  runJobPass,
} from "../src/main/asr/finalize-worker.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import {
  defaultModelsDir,
  modelFile,
  RECOGNIZER,
  WHISPER_LARGE_V3,
} from "../src/main/asr/models.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { concat, FakeModels, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";

const INVENTED = "thank you for watching";

const MODELS_DIR = defaultModelsDir();
const HAS_SILERO = existsSync(modelFile(MODELS_DIR, "silero-vad", "silero_vad.onnx"));
const HAS_SAY = process.platform === "darwin" && spawnSync("which", ["say"]).status === 0;

const work = tempDir("akou-silence-");
afterAll(() => work.cleanup());

/** A seeded generator in [-1, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return 2 * (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 1;
  };
}

function atRms(x: Float32Array, dbfs: number): Float32Array {
  let s = 0;
  for (const v of x) s += v * v;
  const g = 10 ** (dbfs / 20) / Math.sqrt(s / x.length);
  return x.map((v) => v * g);
}

/** White noise, `dbfs` RMS. */
function white(seconds: number, dbfs: number, seed = 11): Float32Array {
  const r = rng(seed);
  return atRms(
    Float32Array.from({ length: Math.round(seconds * RATE) }, () => r()),
    dbfs,
  );
}

/** Pink noise (Paul Kellet's filter over white), `dbfs` RMS: a room's hum and hiss. */
function pink(seconds: number, dbfs: number, seed = 13): Float32Array {
  const r = rng(seed);
  const b = [0, 0, 0, 0, 0, 0, 0];
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    const w = r();
    b[0] = 0.99886 * (b[0] as number) + w * 0.0555179;
    b[1] = 0.99332 * (b[1] as number) + w * 0.0750759;
    b[2] = 0.969 * (b[2] as number) + w * 0.153852;
    b[3] = 0.8665 * (b[3] as number) + w * 0.3104856;
    b[4] = 0.55 * (b[4] as number) + w * 0.5329522;
    b[5] = -0.7616 * (b[5] as number) - w * 0.016898;
    out[i] = b.reduce((a, v) => a + v, 0) + w * 0.5362;
    b[6] = w * 0.115926;
  }
  return atRms(out, dbfs);
}

function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

interface Stub extends FinalEngine {
  /** Units it was asked to decode, and times it was loaded. */
  units: number;
  loads: number;
}

/** An engine that answers every unit with `said`, as Qwen3-ASR did on noise. */
function stub(
  id: string,
  said: (unit: number) => Partial<Hypothesis> = () => ({ text: INVENTED }),
): Stub {
  const e: Stub = {
    id,
    features: { confidence: false, timestamps: false, glossary: true, languageId: true },
    units: 0,
    loads: 0,
    load: async () => {
      e.loads++;
    },
    unload: async () => {},
    decode: async () => {
      const h = said(e.units++);
      return { engine: id, text: "", words: [], lang: "en", ms: 0, ...h };
    },
  };
  return e;
}

/** One preset's shape of the pass: what decodes, and how many times a model was asked or loaded. */
interface Shape {
  name: string;
  build(models: FakeModels): { engine?: FinalEngine | FusionPass; asked(): number };
}

const SHAPES: Shape[] = [
  {
    name: "fast, and auto on Parakeet: the model set's recognizer",
    build: (m) => ({ asked: () => m.calls.length + (m.loads[m.recognizerModel] ?? 0) }),
  },
  {
    name: "best, and auto on Qwen: one engine",
    build: () => {
      const q = stub(QWEN_ASR);
      return { engine: q, asked: () => q.units + q.loads };
    },
  },
  {
    name: "fusion: Qwen, Whisper and Parakeet fused",
    build: (m) => {
      const q = stub(QWEN_ASR);
      const w = stub(WHISPER_LARGE_V3);
      const p = recognizerEngine(RECOGNIZER, m, null);
      return {
        engine: { engines: [q, w, p], fuser: "rover-conf" },
        asked: () =>
          q.units +
          q.loads +
          w.units +
          w.loads +
          m.calls.length +
          (m.loads[m.recognizerModel] ?? 0),
      };
    },
  },
];

/** A fake model set whose recognizer invents on noise, with the real Silero VAD when asked. */
function modelSet(vad: "fake" | "silero"): FakeModels {
  const m = new FakeModels({ hallucinate: INVENTED });
  if (vad === "silero") {
    const real = new SherpaModels({ dir: MODELS_DIR, cacheDir: join(work.dir, "cache") });
    m.vad = () => real.vad();
  }
  return m;
}

async function through(shape: Shape, x: Float32Array, vad: "fake" | "silero") {
  const models = modelSet(vad);
  const { engine, asked } = shape.build(models);
  const lines: { level: JobLogLevel; msg: string }[] = [];
  const result = await runJobPass(
    { samples: x, diarize: true, decode: null, language: "auto" },
    models,
    (level, msg) => lines.push({ level, msg }),
    engine,
  );
  return { result, asked: asked(), lines };
}

function expectNoSpeech(r: {
  result: JobPassResult;
  asked: number;
  lines: { level: JobLogLevel; msg: string }[];
}) {
  expect(r.result.text).toBe("");
  expect(r.result.segments).toEqual([]);
  expect(r.result.words).toEqual([]);
  expect(r.result.language).toBeNull();
  expect(r.result.note).toBe("no_speech");
  // No model was loaded or asked: nothing could be invented.
  expect(r.asked).toBe(0);
  const guard = r.lines.filter((l) => l.msg.startsWith("no-speech guard"));
  expect(guard.map((l) => l.level)).toEqual(["debug"]);
  for (const l of r.lines) expect(l.msg).not.toContain(INVENTED);
}

describe("[T4.36] room noise through every preset's pass: empty text, no model asked", () => {
  for (const shape of SHAPES) {
    test(`[T4.36] ten seconds of quiet room noise, ${shape.name}`, async () => {
      expectNoSpeech(await through(shape, white(10, -40), "fake"));
    });
  }

  test("[T4.36] positive control: noise an energy gate calls speech reaches every engine, which invents", async () => {
    // Pink noise at -30 dBFS is loud enough for the fake VAD, which measures energy only. So the
    // engines are handed it and write the invented sentence: what the real VAD keeps from them.
    for (const shape of SHAPES) {
      const r = await through(shape, pink(10, -30), "fake");
      expect(r.asked).toBeGreaterThan(0);
      expect(r.result.text).toContain(INVENTED.split(" ")[0] as string);
      expect(r.result.note).toBeUndefined();
    }
  });

  test("[T4.36] digital silence is no_speech too, before the VAD runs", async () => {
    const m = modelSet("fake");
    const r = await runJobPass({ samples: silence(10), diarize: false, decode: null }, m);
    expect([r.text, r.segments, r.note]).toEqual(["", [], "no_speech"]);
    expect(m.loads).toEqual({});
  });
});

describe.skipIf(!HAS_SILERO)(
  "[T4.36] the real Silero VAD (skipped without silero-vad on disk)",
  () => {
    test("[T4.36] white and pink noise at -30 dBFS through every preset's pass: empty text, no model asked", async () => {
      for (const noise of [white(10, -30), pink(10, -30)]) {
        for (const shape of SHAPES) expectNoSpeech(await through(shape, noise, "silero"));
      }
    });

    test.skipIf(!HAS_SAY)(
      "[T4.36] speech from `say` in -30 dBFS noise keeps its text, and its times in the file's clock (skipped without macOS say)",
      async () => {
        const wav = join(work.dir, "say.wav");
        const said = spawnSync("say", [
          "-o",
          wav,
          "--data-format=LEI16@16000",
          "Hello world, this is a test.",
        ]);
        expect(said.status).toBe(0);
        const speech = await readUploadAudio(wav);
        const lead = 3;
        const x = mix(pink(10, -30), concat(silence(lead), speech));
        const q = stub(QWEN_ASR, () => ({ text: "hello world this is a test" }));
        const models = modelSet("silero");
        const r = await runJobPass(
          { samples: x, diarize: false, decode: null },
          models,
          () => {},
          q,
        );
        expect(r.note).toBeUndefined();
        expect(r.segments.length).toBeGreaterThan(0);
        for (const s of r.segments) expect(s.text).toBe("hello world this is a test");
        // The leading and trailing noise were trimmed, and the times are the file's, not the trimmed
        // audio's: the first segment starts near three seconds in, the last ends near the speech's end.
        const end = lead + speech.length / RATE;
        const slack = JOB_TRIM_PAD_SECONDS + 0.3;
        expect(r.segments[0]?.s as number).toBeGreaterThan(lead - slack);
        expect(r.segments[0]?.s as number).toBeLessThan(lead + 0.6);
        expect(r.segments.at(-1)?.e as number).toBeLessThan(end + slack);
        expect(r.segments.at(-1)?.e as number).toBeGreaterThan(end - 1);
      },
    );
  },
);

describe("[T4.36] the loop guard: one short phrase over and over is cut at its first repeat", () => {
  const LOOP = `we should move ${Array(12).fill("the").join(" ")}`;

  test("[T4.36] loopCut finds the first repeat of a phrase of up to four words", () => {
    const w = (s: string) => s.split(" ");
    expect(loopCut(w("the the the the the the the the"))).toBe(1);
    expect(loopCut(w("hello world the the the the the the"))).toBe(3);
    expect(loopCut(w("I think I think I think I think I think I think"))).toBe(2);
    expect(loopCut(w("The, the. THE the! the"))).toBe(1);
    // Fewer than LOOP_MIN_REPEATS in a row is speech, as is a phrase longer than four words.
    expect(
      loopCut(
        w(
          Array(LOOP_MIN_REPEATS - 1)
            .fill("no")
            .join(" "),
        ),
      ),
    ).toBeNull();
    expect(loopCut(w("we should move the build ".repeat(6).trim()))).toBeNull();
    expect(loopCut(w("hello world ok great"))).toBeNull();
    expect(loopCut(w("well - - - - - - fine"))).toBeNull();
  });

  test("[T4.36] cutLoop cuts the text and the words alike, and Han text with no spaces", () => {
    const words = LOOP.split(" ").map((x, i) => ({ w: x, t0: i * 0.3, t1: i * 0.3 + 0.2 }));
    const cut = cutLoop({ engine: "e", text: `${LOOP}.`, words, ms: 0 });
    expect(cut?.h.text).toBe("we should move the");
    expect(cut?.h.words.map((x) => x.w)).toEqual(["we", "should", "move", "the"]);
    expect([cut?.from, cut?.to]).toEqual([15, 4]);
    expect(cutLoop({ engine: "e", text: "我们走吧吧吧吧吧吧", words: [], ms: 0 })?.h.text).toBe(
      "我们走吧",
    );
    expect(cutLoop({ engine: "e", text: "no, no, no, no", words: [], ms: 0 })).toBeNull();
  });

  test("[T4.36] through a job's pass: the looping segment keeps its words before the loop and the phrase once", async () => {
    const x = concat(silence(0.3), speak(["we", "should", "move"]), silence(0.5));
    const q = stub(QWEN_ASR, () => ({ text: LOOP }));
    // Positive control: the engine does loop when it is asked directly.
    expect((await q.decode({ samples: x, lang: "auto", glossary: [] })).text).toBe(LOOP);
    const lines: { level: JobLogLevel; msg: string }[] = [];
    const r = await runJobPass(
      { samples: x, diarize: false, decode: null },
      new FakeModels(),
      (level, msg) => lines.push({ level, msg }),
      q,
    );
    expect(r.segments.map((s) => s.text)).toEqual(["we should move the"]);
    expect(r.text).toBe("we should move the");
    const guard = lines.filter((l) => l.msg.startsWith("loop guard"));
    expect(guard.map((l) => l.level)).toEqual(["debug"]);
    // The line names the times and the counts, never the dropped text.
    expect(guard[0]?.msg).toContain("15 words to 4");
    expect(guard[0]?.msg).not.toContain("the the");
  });

  test("[T4.36] speech that repeats itself a little is kept whole", async () => {
    const x = concat(silence(0.3), speak(["no", "no", "no", "no"]), silence(0.5));
    const q = stub(QWEN_ASR, () => ({ text: "No, no, no, no." }));
    const r = await runJobPass(
      { samples: x, diarize: false, decode: null },
      new FakeModels(),
      () => {},
      q,
    );
    expect(r.text).toBe("No, no, no, no.");
  });
});
