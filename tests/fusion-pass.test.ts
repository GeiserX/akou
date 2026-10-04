/**
 * ASR-6 (akou-chp.6): the N-engine final pass, `runEngines`, with fake engines. Every engine
 * decodes every unit, one engine loaded at a time; the fuser joins them; an engine that crashes,
 * will not load or is over the memory budget is left out and the pass goes on with the rest. Then
 * the same pass inside a file job (`runJobPass`), and how a job names it: the `fusion` preset,
 * `rover-conf(...)`, `asr.final.engines` and `asr.fusion` (akou-5an.41, SV-R1).
 */

import { describe, expect, test } from "bun:test";
import type { FinalEngine, FinalUnit, Hypothesis, WordHyp } from "../src/main/asr/engine.ts";
import {
  type EnginesOptions,
  type EngineUnit,
  type JobProgress,
  recognizerEngine,
  runEngines,
  runJobPass,
} from "../src/main/asr/finalize-worker.ts";
import {
  engineIds,
  engineMemoryMb,
  FUSION_DEFAULT,
  fusionChoice,
  fusionModelId,
  fusionParts,
  memoryBudgetMb,
} from "../src/main/asr/fusion.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import {
  CANARY_1B_V2,
  MODELS,
  type ModelSpecEntry,
  NEMOTRON,
  RECOGNIZER,
  WHISPER_LARGE_V3,
} from "../src/main/asr/models.ts";
import { RoverFuser } from "../src/main/asr/rover.ts";
import { validateSetting } from "../src/main/config/schema.ts";
import { jobModels } from "../src/main/server/jobs.ts";
import { ModelRefused, ModelStore, resolveModel } from "../src/main/server/model-store.ts";
import { PRESETS } from "../src/main/server/presets.ts";
import { concat, createEngine, FakeModels, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";

/** What a fake engine says for one unit: its words, or a way to fail. */
type Say = WordHyp[] | "refuse" | "crash";

interface FakeLog {
  events: string[];
  /** The language each decode was given, in call order. */
  langs: string[];
  /** Engines loaded at once, at most. */
  peak: number;
}

const newLog = (): FakeLog & { resident: number } => ({
  events: [],
  langs: [],
  peak: 0,
  resident: 0,
});

/**
 * A fake engine: `say(u)` is its answer for the u-th unit it decodes (units decode in order, one
 * call each, since none is long enough to halve). `crash` throws a fatal error, `refuse` a plain
 * one (the pass halves nothing under 20 s, so the unit is refused).
 */
function fake(
  id: string,
  say: (u: number) => Say,
  log: FakeLog & { resident: number },
  o: {
    languageId?: boolean;
    lang?: string;
    loadFails?: number;
    memoryMb?: number;
  } = {},
): FinalEngine {
  let u = 0;
  let loadFails = o.loadFails ?? 0;
  let loaded = false;
  return {
    id,
    features: {
      confidence: true,
      timestamps: true,
      glossary: false,
      languageId: o.languageId ?? false,
    },
    ...(o.memoryMb === undefined ? {} : { memoryMb: o.memoryMb }),
    load: async () => {
      log.events.push(`${id}.load`);
      if (loadFails > 0) {
        loadFails--;
        throw new Error(`${id} has no model file`);
      }
      if (!loaded) {
        loaded = true;
        log.resident++;
        log.peak = Math.max(log.peak, log.resident);
      }
    },
    unload: async () => {
      log.events.push(`${id}.unload`);
      if (loaded) log.resident--;
      loaded = false;
    },
    decode: async (unit: FinalUnit): Promise<Hypothesis> => {
      const k = u++;
      log.events.push(`${id}.decode${k}`);
      log.langs.push(`${id}:${unit.lang}`);
      const s = say(k);
      if (s === "crash") throw Object.assign(new Error(`${id} crashed`), { fatal: true });
      if (s === "refuse") throw new Error(`${id} refused the unit`);
      const h: Hypothesis = { engine: id, text: s.map((w) => w.w).join(" "), words: s, ms: 1 };
      if (o.lang && s.length > 0) h.lang = unit.lang === "auto" ? o.lang : unit.lang;
      return h;
    },
  };
}

const words = (text: string, conf?: number): WordHyp[] =>
  text.split(" ").map((w) => (conf === undefined ? { w } : { w, conf }));

/** Three units of one second of tone each; their content is the fakes' script, not the audio. */
const AUDIO = speak(["hello", "world", "ok", "great"]);
const UNITS: EngineUnit[] = [0, 1, 2].map((k) => ({
  samples: AUDIO,
  from: Math.min(AUDIO.length - RATE / 2, k * 4000),
  to: Math.min(AUDIO.length, k * 4000 + RATE / 2),
}));

const OPTS: EnginesOptions = {
  fuser: "rover-conf",
  lang: "auto",
  glossary: [],
  minSplitSeconds: 20,
};

describe("[ASR-6] the N-engine pass: one engine at a time, fused, a failing engine left out", () => {
  test("1 to 5 engines: every engine decodes every unit, one loaded at a time, and the model names them all", async () => {
    for (let n = 1; n <= 5; n++) {
      const log = newLog();
      const ids = Array.from({ length: n }, (_, i) => `e${i + 1}`);
      const engines = ids.map((id) => fake(id, () => words("move the box", 0.9), log));
      const r = await runEngines(engines, UNITS, OPTS);
      expect(r.hyps.map((h) => h.text)).toEqual(["move the box", "move the box", "move the box"]);
      expect(r.model).toBe(n === 1 ? "e1" : `rover-conf(${ids.join(",")})`);
      expect(r.ran.map((x) => [x.id, x.units])).toEqual(ids.map((id) => [id, 3]));
      expect(r.dropped).toEqual([]);
      expect(log.peak).toBe(1);
      for (const id of ids) {
        expect(log.events.filter((e) => e.startsWith(`${id}.decode`))).toHaveLength(3);
      }
      // One engine at a time: each loads, decodes all three units, unloads, before the next loads.
      // A list of one keeps its engine loaded, as a single-engine job always has.
      expect(log.events).toEqual(
        ids.flatMap((id) => [
          `${id}.load`,
          `${id}.decode0`,
          `${id}.decode1`,
          `${id}.decode2`,
          ...(n > 1 ? [`${id}.unload`] : []),
        ]),
      );
    }
  });

  test("a crash of engine 2 of 3 mid-pass: its first unit stays fused in, the rest are the fusion of 1 and 3", async () => {
    const log = newLog();
    const e1 = fake("e1", (u) => words(u === 1 ? "move the box" : "we should move", 0.5), log);
    const e2 = fake("e2", (u) => (u === 0 ? words("we should move", 0.9) : "crash"), log);
    const e3 = fake("e3", (u) => words(u === 1 ? "move the bucks" : "we should move", 0.95), log);
    const r = await runEngines([e1, e2, e3], UNITS, OPTS);
    expect(r.model).toBe("rover-conf(e1,e2,e3)");
    expect(r.dropped).toEqual([{ engine: "e2", reason: "e2 crashed", units: 2 }]);
    expect(r.ran.map((x) => [x.id, x.units])).toEqual([
      ["e1", 3],
      ["e2", 1],
      ["e3", 3],
    ]);
    // Unit 1 is the fusion of engines 1 and 3 alone, exactly.
    const one = (id: string, text: string, conf: number): Hypothesis => ({
      engine: id,
      text,
      words: words(text, conf),
      ms: 0,
    });
    const expected = new RoverFuser().fuseSync([
      one("e1", "move the box", 0.5),
      one("e3", "move the bucks", 0.95),
    ]);
    expect(r.hyps[1]?.text).toBe(expected.text);
    expect(r.hyps[1]?.text).toBe("move the bucks");
    expect(r.hyps[1]?.engine).toBe("rover-conf(e1,e3)");
    expect(r.hyps[0]?.engine).toBe("rover-conf(e1,e2,e3)");
    // The crash costs engine 2 only: engine 3 still ran after it.
    expect(log.events.filter((e) => e.startsWith("e3.decode"))).toHaveLength(3);
  });

  test("engine 2 of 3 crashing on its first unit: the model is the fusion of 1 and 3", async () => {
    const log = newLog();
    const r = await runEngines(
      [
        fake("e1", () => words("ok great", 0.9), log),
        fake("e2", () => "crash", log),
        fake("e3", () => words("ok great"), log),
      ],
      UNITS,
      OPTS,
    );
    expect(r.model).toBe("rover-conf(e1,e3)");
    expect(r.dropped).toEqual([{ engine: "e2", reason: "e2 crashed", units: 3 }]);
    expect(r.hyps.map((h) => h.text)).toEqual(["ok great", "ok great", "ok great"]);
  });

  test("an engine over the memory budget is dropped before it loads; positive control: with no budget it runs", async () => {
    const run = async (budget: number) => {
      const log = newLog();
      const r = await runEngines(
        [
          fake("e1", () => words("hello world", 0.9), log, { memoryMb: 3000 }),
          fake("big", () => words("hello there", 0.99), log, { memoryMb: 9000 }),
          fake("e3", () => words("hello world", 0.8), log, { memoryMb: 1500 }),
        ],
        UNITS,
        { ...OPTS, memoryBudgetMb: budget },
      );
      return { r, log };
    };
    const { r, log } = await run(8000);
    expect(r.dropped).toEqual([
      {
        engine: "big",
        reason: "needs about 9000 MB, over the memory budget of 8000 MB (asr.memoryBudgetMb)",
        units: null,
      },
    ]);
    expect(log.events.some((e) => e.startsWith("big."))).toBe(false);
    expect(r.model).toBe("rover-conf(e1,e3)");
    const free = await run(0);
    expect(free.r.dropped).toEqual([]);
    expect(free.r.model).toBe("rover-conf(e1,big,e3)");
    expect(free.log.events).toContain("big.load");
  });

  test("an engine whose load fails is tried twice, then left out for the whole pass", async () => {
    const log = newLog();
    const r = await runEngines(
      [
        fake("e1", () => words("thanks", 0.9), log),
        fake("e2", () => words("thanks"), log, { loadFails: 2 }),
      ],
      UNITS,
      OPTS,
    );
    expect(log.events.filter((e) => e === "e2.load")).toHaveLength(2);
    expect(log.events.some((e) => e.startsWith("e2.decode"))).toBe(false);
    expect(r.dropped).toEqual([
      { engine: "e2", reason: "did not load: e2 has no model file", units: null },
    ]);
    expect(r.model).toBe("rover-conf(e1)");
    // A load that fails once and then works is no drop.
    const again = newLog();
    const ok = await runEngines(
      [
        fake("e1", () => words("thanks", 0.9), again),
        fake("e2", () => words("thanks"), again, { loadFails: 1 }),
      ],
      UNITS,
      OPTS,
    );
    expect(ok.dropped).toEqual([]);
    expect(ok.model).toBe("rover-conf(e1,e2)");
  });

  test("an engine that refuses one unit is left out of that unit only", async () => {
    const log = newLog();
    const r = await runEngines(
      [
        fake("e1", (u) => (u === 2 ? "refuse" : words("new box", 0.4)), log),
        fake("e2", () => words("new books", 0.9), log),
      ],
      UNITS,
      OPTS,
    );
    expect(r.dropped).toEqual([{ engine: "e1", reason: "e1 refused the unit", units: 1 }]);
    expect(r.hyps[2]?.text).toBe("new books");
    expect(r.hyps[2]?.engine).toBe("e2");
    expect(r.skipped).toEqual([]);
    expect(r.model).toBe("rover-conf(e1,e2)");
  });

  test("a unit every engine refused keeps the first engine's partial answer and lists its pieces", async () => {
    const log = newLog();
    const r = await runEngines(
      [fake("e1", () => "refuse", log), fake("e2", () => "refuse", log)],
      UNITS.slice(0, 1),
      OPTS,
    );
    expect(r.hyps[0]?.text).toBe("");
    expect(r.skipped).toEqual([
      {
        unit: 0,
        from: UNITS[0]?.from as number,
        to: UNITS[0]?.to as number,
        error: "e1 refused the unit",
      },
    ]);
  });

  test("no engine left: the pass fails naming each one; with one engine, its own error", async () => {
    const log = newLog();
    const gone = runEngines(
      [fake("e1", () => "crash", log), fake("e2", () => words("x"), log, { loadFails: 2 })],
      UNITS,
      OPTS,
    );
    await expect(gone).rejects.toThrow(
      "no engine is left to decode with: e1: e1 crashed; e2: did not load: e2 has no model file",
    );
    const lone = runEngines([fake("q", () => "crash", newLog())], UNITS, OPTS);
    await expect(lone).rejects.toThrow("q crashed");
  });

  test("[positive control] fusion changes the text: the higher-confidence word wins, and under first it does not", async () => {
    const pass = async (fuser: EnginesOptions["fuser"]) => {
      const log = newLog();
      const e1 = fake(
        "e1",
        () => [
          { w: "move", conf: 0.95 },
          { w: "the", conf: 0.95 },
          { w: "box", conf: 0.3 },
        ],
        log,
      );
      const e2 = fake(
        "e2",
        () => [
          { w: "move", conf: 0.9 },
          { w: "the", conf: 0.9 },
          { w: "bucks", conf: 0.92 },
        ],
        log,
      );
      return runEngines([e1, e2], UNITS.slice(0, 1), { ...OPTS, fuser });
    };
    const fused = await pass("rover-conf");
    expect(fused.hyps[0]?.text).toBe("move the bucks");
    expect(fused.model).toBe("rover-conf(e1,e2)");
    // The same check under `first` would fail: the first engine's low-confidence word stands.
    const first = await pass("first");
    expect(first.hyps[0]?.text).toBe("move the box");
    expect(first.hyps[0]?.text).not.toBe(fused.hyps[0]?.text);
    expect(first.model).toBe("first(e1,e2)");
  });

  test("fused words take their times from the engine that has them, and confidences where present", async () => {
    const log = newLog();
    const r = await runEngines(
      [
        fake("q", () => words("hello world", 0.9), log),
        fake("w", () => words("hello world"), log),
        fake(
          "p",
          () => [
            { w: "hello", conf: 0.8, t0: 0.1, t1: 0.3 },
            { w: "world", conf: 0.7, t0: 0.35, t1: 0.45 },
          ],
          log,
        ),
      ],
      UNITS.slice(0, 1),
      OPTS,
    );
    const from = (UNITS[0]?.from as number) / RATE;
    const w = r.hyps[0]?.words ?? [];
    expect(w.map((x) => x.w)).toEqual(["hello", "world"]);
    expect(w[0]?.t0).toBeCloseTo(from + 0.1, 5);
    expect(w[1]?.t1).toBeCloseTo(from + 0.45, 5);
    expect(w.map((x) => x.conf)).toEqual([0.9, 0.9]);
  });

  test("the language: on auto the first engine that identifies one decodes first and the others get what it heard", async () => {
    const log = newLog();
    const p = fake("p", () => words("hola"), log);
    const q = fake("q", () => words("hola", 0.9), log, { languageId: true, lang: "es" });
    const w = fake("w", () => words("hola"), log, { languageId: true, lang: "en" });
    const c = fake("c", () => words("hola"), log);
    const r = await runEngines([p, q, w, c], UNITS.slice(0, 1), OPTS);
    // q is the first in the list that identifies languages: it runs first, then the list's order.
    expect(log.events.filter((e) => e.endsWith(".load"))).toEqual([
      "q.load",
      "p.load",
      "w.load",
      "c.load",
    ]);
    expect(log.langs).toEqual(["q:auto", "p:es", "w:es", "c:es"]);
    expect(r.hyps[0]?.lang).toBe("es");
    // The fuser's priority is still the list's order.
    expect(r.model).toBe("rover-conf(p,q,w,c)");
    // A job language is forced on every engine, and the list's order stands.
    const forced = newLog();
    await runEngines(
      [
        fake("p", () => words("salut"), forced),
        fake("q", () => words("salut"), forced, { languageId: true, lang: "es" }),
      ],
      UNITS.slice(0, 1),
      { ...OPTS, lang: "fr" },
    );
    expect(forced.langs).toEqual(["p:fr", "q:fr"]);
  });

  test("a language engine that will not load leaves the next one to identify the language", async () => {
    const log = newLog();
    await runEngines(
      [
        fake("q", () => words("x"), log, { languageId: true, lang: "es", loadFails: 2 }),
        fake("c", () => words("hola"), log),
        fake("w", () => words("hola"), log, { languageId: true, lang: "de" }),
      ],
      UNITS.slice(0, 1),
      OPTS,
    );
    expect(log.langs).toEqual(["w:auto", "c:de"]);
  });
});

describe("[ASR-6] the N-engine pass in a file job", () => {
  const NOTE = concat(silence(1), speak(["hello", "world"]), silence(1), speak(["ok", "great"]));

  test("Parakeet, a fake Whisper and a fake Canary: the fused text, the model, words with times, the engines' report", async () => {
    const models = new FakeModels({ words: true });
    const r = await runJobPass({ samples: NOTE, diarize: false, decode: null }, models, () => {}, {
      engines: [
        createEngine({}, WHISPER_LARGE_V3),
        recognizerEngine(RECOGNIZER, models, null),
        createEngine({}, CANARY_1B_V2),
      ],
      fuser: "rover-conf",
    });
    expect(r.text).toBe("hello world ok great");
    expect(r.model).toBe(`rover-conf(${WHISPER_LARGE_V3},${RECOGNIZER},${CANARY_1B_V2})`);
    expect(r.words.map((w) => w.w).join(" ")).toBe(r.text);
    // Parakeet gives the times and confidences; the transcribe-cpp engines give neither.
    for (const w of r.words) {
      expect(w.s).not.toBeNull();
      expect(w.c).not.toBeNull();
    }
    expect(r.words[0]?.s as number).toBeCloseTo(1, 1);
    expect(r.fusion?.fuser).toBe("rover-conf");
    expect(r.fusion?.engines.map((e) => e.id)).toEqual([
      WHISPER_LARGE_V3,
      RECOGNIZER,
      CANARY_1B_V2,
    ]);
    expect(r.fusion?.dropped).toEqual([]);
    for (const e of r.fusion?.engines ?? []) expect(e.units).toBe(r.segments.length);
    expect(r.language).toBe("en");
  });

  test("an engine that will not load is left out, and the job is done with the others", async () => {
    const models = new FakeModels({ words: true });
    const fails = { engineLoadFails: [WHISPER_LARGE_V3] };
    const r = await runJobPass({ samples: NOTE, diarize: false, decode: null }, models, () => {}, {
      engines: [createEngine(fails, WHISPER_LARGE_V3), recognizerEngine(RECOGNIZER, models, null)],
      fuser: "rover-conf",
    });
    expect(r.text).toBe("hello world ok great");
    expect(r.model).toBe(`rover-conf(${RECOGNIZER})`);
    expect(r.fusion?.dropped).toEqual([
      {
        engine: WHISPER_LARGE_V3,
        reason: `did not load: ${WHISPER_LARGE_V3} would not load`,
        units: null,
      },
    ]);
  });

  test("[akou-5an.116] the progress counts every engine: each piece once per engine, and it only grows", async () => {
    const models = new FakeModels({ words: true });
    const seen: JobProgress[] = [];
    const r = await runJobPass(
      { samples: NOTE, diarize: false, decode: null, progress: (p) => seen.push(p) },
      models,
      () => {},
      {
        engines: [createEngine({}, WHISPER_LARGE_V3), recognizerEngine(RECOGNIZER, models, null)],
        fuser: "rover-conf",
      },
    );
    const done = seen.filter((p) => p.stage === "transcribe").map((p) => p.done_s);
    // The stage's start, then one report per piece per engine.
    expect(done.length).toBe(1 + 2 * r.segments.length);
    for (let i = 1; i < done.length; i++) {
      expect(done[i] as number).toBeGreaterThan(done[i - 1] as number);
    }
    // The first engine takes it to half way at most; the second one past it, never past the file.
    expect(done[r.segments.length] as number).toBeLessThanOrEqual(r.duration_s / 2);
    expect(done.at(-1) as number).toBeGreaterThan(r.duration_s / 2);
    expect(done.at(-1) as number).toBeLessThanOrEqual(r.duration_s);
    for (const p of seen) expect(p.total_s).toBe(r.duration_s);
  });

  test("a single-engine job carries no fusion report and keeps its engine's own words", async () => {
    const r = await runJobPass(
      { samples: NOTE, diarize: false, decode: null },
      new FakeModels(),
      () => {},
    );
    expect(r.fusion).toBeUndefined();
    expect(r.model).toBe("fake-parakeet");
    expect(r.words).toEqual([]);
  });
});

describe("[akou-5an.41] the fusion preset: its table row, how a job names it, the settings", () => {
  test("the preset is built, names three engines of the registry, Nemotron and rover-conf", () => {
    const p = PRESETS.find((x) => x.name === "fusion");
    expect(p).toMatchObject({ built: true, fusion: "rover-conf", diarizer: NEMOTRON });
    expect(p?.engines).toEqual([QWEN_ASR, WHISPER_LARGE_V3, RECOGNIZER]);
    expect(FUSION_DEFAULT).toEqual(p?.engines as string[]);
    // Every engine id of every built preset is in the registry.
    const ids = new Set(MODELS.map((m) => m.id));
    for (const x of PRESETS.filter((y) => y.built)) {
      for (const id of [...x.engines, x.diarizer]) expect(ids.has(id)).toBe(true);
    }
  });

  test("a fused model id round-trips, and its engines are what a job ran", () => {
    const id = fusionModelId("rover-conf", FUSION_DEFAULT);
    expect(id).toBe(`rover-conf(${QWEN_ASR},${WHISPER_LARGE_V3},${RECOGNIZER})`);
    expect(fusionParts(id)).toEqual({ fuser: "rover-conf", engines: [...FUSION_DEFAULT] });
    expect(fusionParts(" first( a , b ) ")).toEqual({ fuser: "first", engines: ["a", "b"] });
    expect(fusionParts(RECOGNIZER)).toBeNull();
    expect(fusionParts("sum(a,b)")).toBeNull();
    expect(engineIds(id)).toEqual([...FUSION_DEFAULT]);
    expect(engineIds(RECOGNIZER)).toEqual([RECOGNIZER]);
    expect(jobModels(`rover-conf(${QWEN_ASR},${RECOGNIZER})`, true, "nemotron")).toEqual([
      QWEN_ASR,
      RECOGNIZER,
      "silero-vad",
      NEMOTRON,
    ]);
  });

  const o = (extra: Partial<Parameters<typeof resolveModel>[1]> = {}) => ({
    catalog: MODELS,
    defaultModel: "auto",
    ...extra,
  });
  const refusal = (fn: () => unknown): ModelRefused => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ModelRefused) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  };

  test("preset fusion, server.default_model fusion and a fused id all run the pass", () => {
    const model = fusionModelId("rover-conf", FUSION_DEFAULT);
    expect(resolveModel({ preset: "fusion" }, o())).toEqual({
      model,
      preset: "fusion",
      source: "request",
    });
    expect(resolveModel({}, o({ defaultModel: "fusion" }))).toEqual({
      model,
      preset: "fusion",
      source: "server_default",
    });
    expect(resolveModel({ model }, o())).toMatchObject({ model, preset: "fusion" });
    const two = `rover-conf(${QWEN_ASR},${RECOGNIZER})`;
    expect(resolveModel({ model: two }, o())).toMatchObject({ model: two, preset: "custom" });
    // asr.final.engines and asr.fusion make the preset's model.
    const four = [...FUSION_DEFAULT, CANARY_1B_V2];
    expect(
      resolveModel({ preset: "fusion" }, o({ fusion: { fuser: "rover-freq", engines: four } })),
    ).toMatchObject({ model: fusionModelId("rover-freq", four), preset: "fusion" });
  });

  test("refused: an LLM fuser (409), an engine the pass cannot run (422), a transcribe-cpp engine alone (409)", () => {
    const llm = refusal(() => resolveModel({ model: `llm-pick(${QWEN_ASR},${RECOGNIZER})` }, o()));
    expect([llm.status, llm.code]).toEqual([409, "preset_unavailable"]);
    expect(llm.message).toContain("not built");
    const bad = refusal(() => resolveModel({ model: `rover-conf(${QWEN_ASR},nope)` }, o()));
    expect([bad.status, bad.code, bad.details.field]).toEqual([422, "unknown_model", "model"]);
    expect(refusal(() => resolveModel({ model: "rover-conf()" }, o())).status).toBe(422);
    expect(
      refusal(() => resolveModel({ model: `rover-conf(${QWEN_ASR},${QWEN_ASR})` }, o())).status,
    ).toBe(422);
    const alone = refusal(() => resolveModel({ model: WHISPER_LARGE_V3 }, o()));
    expect([alone.status, alone.code, alone.details.preset]).toEqual([
      409,
      "preset_unavailable",
      "fusion",
    ]);
    expect(alone.message).toContain("rover-conf(");
  });

  test("the store's needs for a fused job: each engine, Qwen's llama-server build, the helpers once", () => {
    const t = tempDir("akou-fusion-needs-");
    try {
      const catalog = MODELS.filter((m) =>
        [QWEN_ASR, WHISPER_LARGE_V3, RECOGNIZER, "silero-vad", NEMOTRON, "build-x"].includes(m.id),
      );
      const store = new ModelStore({
        dir: () => t.dir,
        machine: () => catalog.filter((m) => [RECOGNIZER, "silero-vad", NEMOTRON].includes(m.id)),
        catalog: () => [
          ...catalog,
          { id: "build-x", job: "a build", licence: "MIT", source: "x", files: [] },
        ],
        requires: (id) => (id === QWEN_ASR ? ["build-x"] : []),
        autoDownload: () => true,
        maxGb: () => 0,
        unusedDays: () => 0,
        log: () => {},
      });
      expect(store.needs(fusionModelId("rover-conf", FUSION_DEFAULT))).toEqual([
        QWEN_ASR,
        "build-x",
        "silero-vad",
        NEMOTRON,
        WHISPER_LARGE_V3,
        RECOGNIZER,
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("asr.final.engines and asr.fusion are checked against what the pass runs", () => {
    expect(validateSetting("asr.final.engines", [RECOGNIZER, CANARY_1B_V2]).ok).toBe(true);
    expect(validateSetting("asr.final.engines", []).ok).toBe(true);
    const unknown = validateSetting("asr.final.engines", [RECOGNIZER, "whisper-large-v3-turbo"]);
    expect(unknown).toMatchObject({ ok: false });
    expect((unknown as { error: string }).error).toContain("whisper-large-v3-turbo cannot run");
    expect(validateSetting("asr.final.engines", [RECOGNIZER, RECOGNIZER]).ok).toBe(false);
    expect(validateSetting("asr.fusion", "rover-freq").ok).toBe(true);
    const llm = validateSetting("asr.fusion", "llm-free");
    expect((llm as { error: string }).error).toContain("not built");
    expect(validateSetting("asr.fusion", "vote").ok).toBe(false);
    expect(validateSetting("asr.memoryBudgetMb", -1).ok).toBe(false);
    expect(fusionChoice({ "asr.final.engines": [], "asr.fusion": "rover-conf" }).engines).toEqual(
      FUSION_DEFAULT,
    );
    expect(
      fusionChoice({ "asr.final.engines": [CANARY_1B_V2, RECOGNIZER], "asr.fusion": "first" }),
    ).toEqual({ fuser: "first", engines: [CANARY_1B_V2, RECOGNIZER] });
  });

  test("the memory estimate is the catalog's file sizes and a fifth more; the budget's default is 60 % of memory", () => {
    const q = MODELS.find((m) => m.id === QWEN_ASR) as ModelSpecEntry;
    const bytes = q.files.reduce((n, f) => n + f.size, 0);
    expect(engineMemoryMb(QWEN_ASR, MODELS)).toBe(Math.round((bytes * 1.2) / 2 ** 20));
    expect(engineMemoryMb("nope", MODELS)).toBeUndefined();
    expect(memoryBudgetMb(4096, 16 * 2 ** 30)).toBe(4096);
    expect(memoryBudgetMb(0, 16 * 2 ** 30)).toBe(Math.floor(0.6 * 16 * 1024));
  });
});
