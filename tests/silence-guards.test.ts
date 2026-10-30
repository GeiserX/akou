/**
 * [T4.37] An invented sentence on silence (docs/TRAPS.md, SV-R5): a model that hears noise and no
 * speech writes a sentence anyway ("thank you for watching", Qwen3-ASR before sherpa-onnx 1.13.8),
 * or loops on one word. Bazarr turns that into a wrong subtitle. Every job's pass runs the VAD
 * before any model loads, decodes nothing where it heard no speech, and cuts a decoder loop at its
 * first repeat.
 *
 * The engines are fakes that invent on every unit, one per preset's shape: the model set's
 * recognizer (`fast`, and `auto` on a machine with Parakeet only), one engine (`best`, and `auto`
 * where Qwen is on disk), and a fusion list. The noise is generated here. The fake VAD is an energy
 * gate, so it judges quiet room noise only; noise at -30, -40 and -50 dBFS goes through the real
 * Silero VAD, which runs where its model is on disk (`AKOU_MODELS_DIR`, else the app's models
 * folder) and is skipped elsewhere. Speech for the real VAD is the generated
 * `fixtures/two-voices.wav`, read from its file, never played.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FinalEngine, Hypothesis } from "../src/main/asr/engine.ts";
import {
  cutLoop,
  DEFAULT_FINAL,
  type FusionPass,
  JOB_TRIM_PAD_SECONDS,
  type JobLogLevel,
  type JobPassResult,
  LOOP_MIN_REPEATS,
  LOOP_MIN_REPEATS_SHORT,
  loopRuns,
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
import { peak } from "../src/main/asr/pad.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { concat, FakeModels, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";

const INVENTED = "thank you for watching";

const MODELS_DIR = defaultModelsDir();
const HAS_SILERO = existsSync(modelFile(MODELS_DIR, "silero-vad", "silero_vad.onnx"));
/** Where each sentence of `fixtures/two-voices.wav` starts and ends, seconds. */
const TWO_VOICES = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "two-voices.json"), "utf8"),
) as { sentences: [number, number][] };

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

describe("[T4.37] room noise through every preset's pass: empty text, no model asked", () => {
  for (const shape of SHAPES) {
    test(`[T4.37] ten seconds of quiet room noise, ${shape.name}`, async () => {
      expectNoSpeech(await through(shape, white(10, -40), "fake"));
    });
  }

  test("[T4.37] positive control: noise an energy gate calls speech reaches every engine, which invents", async () => {
    // Pink noise at -30 dBFS is loud enough for the fake VAD, which measures energy only. So the
    // engines are handed it and write the invented sentence: what the real VAD keeps from them.
    for (const shape of SHAPES) {
      const r = await through(shape, pink(10, -30), "fake");
      expect(r.asked).toBeGreaterThan(0);
      expect(r.result.text).toContain(INVENTED.split(" ")[0] as string);
      expect(r.result.note).toBeUndefined();
    }
  });

  test("[T4.37] digital silence is no_speech by the energy gate alone, before the VAD runs", async () => {
    // A VAD that hears speech everywhere: only the energy gate can stop this pass.
    const m = modelSet("fake");
    let asked = 0;
    m.vad = () => {
      asked++;
      return { windowSize: 512, accept: () => true, reset: () => {} };
    };
    const r = await runJobPass({ samples: silence(10), diarize: false, decode: null }, m);
    expect([r.text, r.segments, r.note]).toEqual(["", [], "no_speech"]);
    expect([asked, m.loads]).toEqual([0, {}]);
  });
});

describe.skipIf(!HAS_SILERO)(
  "[T4.37] the real Silero VAD (skipped without silero-vad on disk)",
  () => {
    test("[T4.37] white and pink noise at -30 dBFS through every preset's pass: empty text, no model asked", async () => {
      for (const noise of [white(10, -30), pink(10, -30)]) {
        for (const shape of SHAPES) expectNoSpeech(await through(shape, noise, "silero"));
      }
    });

    test("[T4.37] faint noise at -40 and -50 dBFS, above the peak gate: the VAD alone keeps it from every engine", async () => {
      // Since sherpa-onnx 2.0 Parakeet's final pass decodes very quiet input (a gentler log floor
      // in its features), and handed faint noise unguarded it writes whole sentences. These peaks
      // clear the -50 dBFS gate, so only the VAD stands between the noise and the engines; fainter
      // noise is stopped by the gate first.
      for (const dbfs of [-40, -50]) {
        for (const noise of [white(10, dbfs), pink(10, dbfs)]) {
          expect(peak(noise)).toBeGreaterThan(10 ** (DEFAULT_FINAL.silenceDbfs / 20));
          for (const shape of SHAPES) expectNoSpeech(await through(shape, noise, "silero"));
        }
      }
    });

    test("[T4.37] speech in -30 dBFS noise keeps its text, and its times in the file's clock", async () => {
      // The first sentence of the generated two-voice fixture, three seconds into ten of noise.
      const fixture = await readUploadAudio(join(import.meta.dir, "fixtures", "two-voices.wav"));
      const [said0, said1] = TWO_VOICES.sentences[0] as [number, number];
      const speech = fixture.subarray(0, Math.round((said1 + 0.5) * RATE));
      const lead = 3;
      const x = mix(pink(15, -30), concat(silence(lead), speech));
      const q = stub(QWEN_ASR, () => ({ text: "the first sentence" }));
      const r = await runJobPass(
        { samples: x, diarize: false, decode: null },
        modelSet("silero"),
        () => {},
        q,
      );
      expect(r.note).toBeUndefined();
      expect(r.segments.length).toBeGreaterThan(0);
      for (const s of r.segments) expect(s.text).toBe("the first sentence");
      // The leading and trailing noise were trimmed, and the times are the file's, not the
      // trimmed audio's: the first segment starts near where the sentence starts, the last ends
      // within the pad and Silero's short hold after the clip, seconds before the noise ends.
      const start = lead + said0;
      const clipEnd = lead + speech.length / RATE;
      expect(r.segments[0]?.s as number).toBeGreaterThan(start - JOB_TRIM_PAD_SECONDS - 0.3);
      expect(r.segments[0]?.s as number).toBeLessThan(start + 0.6);
      expect(r.segments.at(-1)?.e as number).toBeGreaterThan(lead + said1 - 1);
      expect(r.segments.at(-1)?.e as number).toBeLessThan(clipEnd + JOB_TRIM_PAD_SECONDS + 0.5);
      expect(r.segments.at(-1)?.e as number).toBeLessThan(x.length / RATE - 4);
    });
  },
);

describe("[T4.37] the loop guard: a short phrase over and over keeps it once and what follows", () => {
  const LOOP = `we should move ${Array(12).fill("the").join(" ")}`;
  const THANKS = "谢谢观看。".repeat(6);

  test("[T4.37] loopRuns: eight in a row for one or two words, five for three or four", () => {
    const w = (s: string) => s.split(" ");
    const n = (k: number, p: string) => Array(k).fill(p).join(" ");
    expect(LOOP_MIN_REPEATS_SHORT).toBe(8);
    expect(LOOP_MIN_REPEATS).toBe(5);
    expect(loopRuns(w(n(8, "the")))).toEqual([{ from: 1, to: 8 }]);
    expect(loopRuns(w(`hello world ${n(10, "the")} ok`))).toEqual([{ from: 3, to: 12 }]);
    expect(loopRuns(w(n(8, "I think")))).toEqual([{ from: 2, to: 16 }]);
    expect(loopRuns(w(n(5, "we should go")))).toEqual([{ from: 3, to: 15 }]);
    expect(loopRuns(w("The, the. THE the! the THE the, the"))).toEqual([{ from: 1, to: 8 }]);
    // Speech: under the bar, or a phrase longer than four words.
    expect(loopRuns(w(n(LOOP_MIN_REPEATS_SHORT - 1, "the")))).toEqual([]);
    expect(loopRuns(w(n(4, "we should go")))).toEqual([]);
    expect(loopRuns(w(n(6, "we should move the build")))).toEqual([]);
    expect(loopRuns(w("well - - - - - - - - - fine"))).toEqual([]);
  });

  test("[T4.37] film lines that repeat a word are kept whole", () => {
    for (const text of [
      "No, no, no, no, no!",
      "Go! Go! Go! Go! Go! Go! Get in!",
      "no no no no no, put it down",
      "哈哈哈哈哈",
    ]) {
      expect(cutLoop({ engine: "e", text, words: [], ms: 0 })).toBeNull();
    }
  });

  test("[T4.37] a loop is spliced out: the phrase once, and the words after it kept", () => {
    const go = `${Array(10).fill("Go!").join(" ")} Get in!`;
    const words = go.split(" ").map((x, i) => ({ w: x, t0: i * 0.3, t1: i * 0.3 + 0.2 }));
    const cut = cutLoop({ engine: "e", text: go, words, ms: 0 });
    expect(cut?.h.text).toBe("Go! Get in!");
    expect(cut?.h.words.map((x) => [x.w, x.t0])).toEqual([
      ["Go!", 0],
      ["Get", 3],
      ["in!", 3.3],
    ]);
    expect([cut?.from, cut?.to]).toEqual([12, 3]);
    const the = cutLoop({ engine: "e", text: `${LOOP}.`, words: [], ms: 0 });
    expect(the?.h.text).toBe("we should move the.");
  });

  test("[T4.37] a loop ending the sentence keeps its mark on the kept word, with that word's own times", () => {
    const said = [...Array(8).fill("the"), "the."];
    const words = said.map((x, i) => ({ w: x, t0: i * 0.3, t1: i * 0.3 + 0.2 }));
    const cut = cutLoop({ engine: "e", text: said.join(" "), words, ms: 0 });
    expect(cut?.h.text).toBe("the.");
    expect(cut?.h.words.map((x) => x.w).join(" ")).toBe(cut?.h.text as string);
    expect(cut?.h.words).toEqual([{ w: "the.", t0: 0, t1: 0.2 }]);
  });

  test("[T4.37] Han text: 谢谢观看。 said six times is cut to one, and the words read as the text", () => {
    // Qwen's words are its text split on spaces, so Han text is one word holding the whole loop.
    const one = cutLoop({ engine: "e", text: THANKS, words: [{ w: THANKS, conf: 0.4 }], ms: 0 });
    expect(one?.h.text).toBe("谢谢观看。");
    expect(one?.h.words).toEqual([{ w: "谢谢观看。", conf: 0.4 }]);
    const ba = `我们走${"吧".repeat(10)}`;
    const two = cutLoop({ engine: "e", text: ba, words: [{ w: ba }], ms: 0 });
    expect([two?.h.text, two?.h.words.map((x) => x.w).join("")]).toEqual(["我们走吧", "我们走吧"]);
  });

  test("[T4.37] through a job's pass: the looping segment keeps its words before the loop and the phrase once", async () => {
    const x = concat(silence(0.3), speak(["we", "should", "move"]), silence(0.5));
    const q = stub(QWEN_ASR, () => ({ text: `${LOOP} today` }));
    // Positive control: the engine does loop when it is asked directly.
    expect((await q.decode({ samples: x, lang: "auto", glossary: [] })).text).toBe(`${LOOP} today`);
    const lines: { level: JobLogLevel; msg: string }[] = [];
    const r = await runJobPass(
      { samples: x, diarize: false, decode: null },
      new FakeModels(),
      (level, msg) => lines.push({ level, msg }),
      q,
    );
    expect(r.segments.map((s) => s.text)).toEqual(["we should move the today"]);
    const guard = lines.filter((l) => l.msg.startsWith("loop guard"));
    expect(guard.map((l) => l.level)).toEqual(["debug"]);
    // The line names the times and the counts, never the dropped text.
    expect(guard[0]?.msg).toContain("16 words to 5");
    expect(guard[0]?.msg).not.toContain("the the");
  });

  test("[T4.37] five no's said through a job's pass are kept whole", async () => {
    const x = concat(silence(0.3), speak(["no", "no", "no", "no", "no"]), silence(0.5));
    const q = stub(QWEN_ASR, () => ({ text: "No, no, no, no, no." }));
    const r = await runJobPass(
      { samples: x, diarize: false, decode: null },
      new FakeModels(),
      () => {},
      q,
    );
    expect(r.text).toBe("No, no, no, no, no.");
  });
});
