/**
 * akou-5an.24.1: a job's result carries its words, their times and confidences, the pieces the
 * engine refused, and whether speaker labelling ran (SV-J4). The words come from the decode helper
 * both passes share (`decodeUnit`), which returns the engine's whole hypothesis with word times on
 * the timeline of the samples it was given; carrying them changes no text and no language.
 */

import { describe, expect, test } from "bun:test";
import type { FinalEngine, FinalUnit, Hypothesis } from "../src/main/asr/engine.ts";
import {
  clampConf,
  DEFAULT_FINAL,
  decodeUnit,
  hotwordEngine,
  type JobPassResult,
  jobWord,
  runJobPass,
} from "../src/main/asr/finalize-worker.ts";
import { concat, FakeModels, RATE, silence, speak } from "./fixtures/asr-fake.ts";

const NOTE = concat(
  silence(2),
  speak(["hello", "world"]),
  silence(1),
  speak(["ok", "great"]),
  silence(0.5),
);

async function job(
  samples: Float32Array,
  o: ConstructorParameters<typeof FakeModels>[0] = {},
  diarize = false,
  engine?: FinalEngine,
): Promise<JobPassResult> {
  return runJobPass({ samples, diarize, decode: null }, new FakeModels(o), () => {}, engine);
}

/** An engine that answers every unit with the same words, as a stub of Qwen or a broken engine. */
function stub(h: Omit<Hypothesis, "engine" | "ms">): FinalEngine {
  return {
    id: "stub",
    features: { confidence: true, timestamps: false, glossary: false, languageId: false },
    load: async () => {},
    unload: async () => {},
    decode: async (_u: FinalUnit) => ({ engine: "stub", ms: 1, ...h }),
  };
}

describe("akou-5an.24.1: words in a job's result", () => {
  test("carrying the words leaves the text, the segments and the language as they were", async () => {
    const plain = await job(NOTE);
    const timed = await job(NOTE, { words: true });
    expect(plain.text).toBe("hello world ok great");
    expect(timed.text).toBe(plain.text);
    expect(timed.segments).toEqual(plain.segments);
    expect(timed.language).toBe(plain.language);
    // Without word data from the engine, there are no words and no confidence.
    expect(plain.words).toEqual([]);
    expect(plain.confidence).toBeNull();
  });

  test("the words spell the text, with times in seconds into the file, in order, inside their segment", async () => {
    const r = await job(NOTE, { words: true });
    expect(r.words.map((w) => w.w).join(" ")).toBe(r.text);
    let last = 0;
    for (const w of r.words) {
      expect(w.s).not.toBeNull();
      expect(w.e as number).toBeGreaterThanOrEqual(w.s as number);
      expect(w.s as number).toBeGreaterThanOrEqual(last);
      last = w.e as number;
      const seg = r.segments.find((s) => s.s <= (w.s as number) && (w.e as number) <= s.e);
      expect(seg).toBeDefined();
      expect(w.c as number).toBeGreaterThan(0);
      expect(w.c as number).toBeLessThanOrEqual(1);
    }
    // "hello" is spoken 2 s into the file: its time counts from the file, not from the piece
    // (the job trims the silence before it) or the span the engine saw.
    expect(r.words[0]?.s as number).toBeCloseTo(2, 1);
    // "ok" follows hello (0.25 s), a 0.12 s gap, world (0.25 s), its gap and 1 s of silence.
    const ok = 2 + speak(["hello", "world"]).length / RATE + 1;
    expect(r.words[2]?.s as number).toBeCloseTo(ok, 1);
    const cs = r.words.map((w) => w.c as number);
    expect(r.confidence).toBeCloseTo(cs.reduce((a, b) => a + b, 0) / cs.length, 3);
  });

  test("a halved span keeps its words in order, each half offset by its own start", async () => {
    const words = Array.from({ length: 70 }, (_, i) => (i % 2 ? "hello" : "world"));
    const r = await job(speak(words, { gapSeconds: 0.05 }), { refuseOver: 12, words: true });
    expect(r.skipped).toEqual([]);
    expect(r.words.map((w) => w.w).join(" ")).toBe(r.text);
    for (let i = 1; i < r.words.length; i++) {
      expect(r.words[i]?.s as number).toBeGreaterThanOrEqual(r.words[i - 1]?.e as number);
    }
  });

  test("a piece refused down to the split floor is listed in skipped with the engine's reason", async () => {
    const r = await job(NOTE, { refuseOver: 0.1, words: true });
    expect(r.text).toBe("");
    expect(r.words).toEqual([]);
    expect(r.skipped.length).toBeGreaterThan(0);
    for (const s of r.skipped) {
      expect(s.error).toBe("span too long for the fake engine");
      expect(s.e).toBeGreaterThan(s.s);
    }
  });

  test("an engine without word times gives words with null times, and its unit confidence stands in", async () => {
    const r = await job(
      NOTE,
      {},
      false,
      stub({ text: "hola mundo", words: [{ w: "hola" }, { w: "mundo" }], conf: 0.8, lang: "es" }),
    );
    expect(r.words.length).toBeGreaterThan(0);
    for (const w of r.words) expect([w.s, w.e, w.c]).toEqual([null, null, null]);
    expect(r.confidence).toBe(0.8);
    expect(r.language).toBe("es");
  });

  test("a word confidence above 1 is clamped to 1, below 0 to 0, and one that is no number is null", async () => {
    const r = await job(
      NOTE,
      {},
      false,
      stub({
        text: "a b c",
        words: [
          { w: "a", conf: 1.5, t0: 0, t1: 0.1 },
          { w: "b", conf: -0.2, t0: 0.1, t1: 0.2 },
          { w: "c", conf: Number.NaN, t0: 0.2, t1: 0.3 },
        ],
      }),
    );
    expect(r.words.slice(0, 3).map((w) => w.c)).toEqual([1, 0, null]);
    expect(r.confidence).toBe(0.5);
    // Positive control: the clamp is what turns 1.5 into 1; the word as the engine gave it is 1.5.
    expect(jobWord({ w: "a", conf: 1.5 }, 0).c).toBe(1);
    expect(clampConf(1.5)).toBe(1);
    expect(clampConf(undefined)).toBeNull();
  });
});

describe("akou-5an.24.1: whether speaker labelling ran", () => {
  const TWO = concat(
    silence(0.4),
    speak(["hello", "world"]),
    silence(0.8),
    speak(["ok", "great"], { voice: 2 }),
    silence(0.6),
  );

  test("a job with the speaker helper unavailable reports labelled false, its error, and the same text", async () => {
    const failed = await job(TWO, { diarizeFails: "no akou-diarize command" }, true);
    expect(failed.speakers).toEqual({
      asked: true,
      labelled: false,
      error: "no akou-diarize command",
    });
    for (const s of failed.segments) expect(s.speaker).toBeNull();
    // Positive control: with the helper there, the same job is labelled.
    const ok = await job(TWO, {}, true);
    expect(ok.speakers).toEqual({ asked: true, labelled: true, error: null });
    expect(failed.text).toBe(ok.text);
  });

  test("a job that did not ask for speakers says so", async () => {
    expect((await job(TWO)).speakers).toEqual({ asked: false, labelled: false, error: null });
    expect((await job(silence(2), {}, true)).speakers).toEqual({
      asked: true,
      labelled: false,
      error: null,
    });
  });
});

describe("decodeUnit: one engine, one span, the whole hypothesis", () => {
  test("word times are on the timeline of the samples, and clamped into the span", async () => {
    const models = new FakeModels({ words: true });
    const engine = hotwordEngine(models.prepare(null));
    const x = concat(silence(2), speak(["deploy", "today"]), silence(0.5));
    const from = Math.round(1.5 * RATE);
    const h = await decodeUnit(
      engine,
      { lang: "auto", glossary: [] },
      x,
      from,
      x.length,
      DEFAULT_FINAL,
    );
    expect(h.engine).toBe("fake-parakeet");
    expect(h.text).toBe("deploy today");
    expect(h.words.map((w) => w.w)).toEqual(["deploy", "today"]);
    expect(h.words[0]?.t0 as number).toBeCloseTo(2, 1);
    for (const w of h.words) {
      expect(w.t0 as number).toBeGreaterThanOrEqual(from / RATE);
      expect(w.t1 as number).toBeLessThanOrEqual(x.length / RATE);
    }
  });

  test("an error marked fatal ends the pass instead of being halved", async () => {
    const down: FinalEngine = {
      ...stub({ text: "", words: [] }),
      decode: async () => {
        throw Object.assign(new Error("engine down"), { fatal: true });
      },
    };
    const skipped: string[] = [];
    await expect(
      decodeUnit(
        down,
        { lang: "auto", glossary: [] },
        NOTE,
        0,
        NOTE.length,
        DEFAULT_FINAL,
        (_a, _b, e) => skipped.push(e),
      ),
    ).rejects.toThrow("engine down");
    expect(skipped).toEqual([]);
  });
});
