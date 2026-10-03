/**
 * The engine registry and interfaces (docs/research/asr-architecture.md, ASR-2): the catalog's
 * invariants, which models a machine needs for its settings and platform, and the word confidences
 * the sherpa recognizer derives from its per-token log-probs, checked against the benchmark's own
 * output for the same decodes (`tests/fixtures/parakeet-greedy-words.json`). Nothing here loads a
 * model: the recognizer is a stub that returns the recorded sherpa results.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RecognizerEngine, type WordHyp } from "../src/main/asr/engine.ts";
import {
  type CatalogEntry,
  catalogProblems,
  hostPlatform,
  MODELS,
  modelsFor,
  NEMOTRON,
  PLATFORMS,
  RECOGNIZER,
} from "../src/main/asr/models.ts";
import { SherpaRecognizer, sherpaWords } from "../src/main/asr/sherpa.ts";
import { SETTINGS } from "../src/main/config/schema.ts";
import { createModels } from "./fixtures/asr-fake.ts";

const DIARIZERS = SETTINGS["asr.diarizer"].values as readonly string[];
const ids = (list: readonly { id: string }[]) => list.map((m) => m.id);

describe("ASR-2: the catalog's invariants", () => {
  test("every entry has a job, a licence, a source, files, a runtime, platforms, accelerators and languages", () => {
    expect(catalogProblems(MODELS)).toEqual([]);
  });

  test("positive control: each broken field is reported by id", () => {
    const parakeet = MODELS.find((m) => m.id === RECOGNIZER) as CatalogEntry;
    const broken: CatalogEntry[] = [
      { ...parakeet, id: "a", platforms: [] },
      { ...parakeet, id: "b", licence: "" },
      { ...parakeet, id: "c", job: " " },
      { ...parakeet, id: "d", runtime: "python" as CatalogEntry["runtime"] },
      { ...parakeet, id: "e", platforms: ["darwin-x64" as CatalogEntry["platforms"][number]] },
      { ...parakeet, id: "f", accelerators: [] },
      { ...parakeet, id: "g", languages: [] },
      { ...parakeet, id: "h", serves: [] },
      { ...parakeet, id: "i", files: [] },
      { ...parakeet, id: "j", source: "" },
      { ...parakeet, id: "k", languages: ["English"] },
    ];
    const problems = catalogProblems(broken);
    for (const id of "abcdefghijk") expect(problems.some((p) => p.startsWith(`${id}:`))).toBe(true);
    expect(catalogProblems([parakeet, parakeet])).toEqual([`${RECOGNIZER}: duplicate id`]);
  });

  test("the diarizer choices the settings offer are the ones the catalog knows", () => {
    expect([...DIARIZERS].sort()).toEqual(["embeddings", "nemotron"]);
  });

  test("every released platform gets a recognizer, a VAD and speaker labels, whatever the diarizer", () => {
    for (const platform of PLATFORMS) {
      for (const d of DIARIZERS) {
        const need = modelsFor({ "asr.diarizer": d }, platform);
        const serves = new Set(need.flatMap((m) => (m as CatalogEntry).serves));
        expect({ platform, d, serves: [...serves].sort() }).toEqual({
          platform,
          d,
          serves: expect.arrayContaining(["final", "vad", "live", "diarizer", "embedder"]),
        });
      }
    }
  });

  test("positive control: a recognizer missing one platform leaves that platform without one", () => {
    const narrowed = MODELS.map((m) =>
      m.id === RECOGNIZER ? { ...m, platforms: m.platforms.filter((p) => p !== "linux-arm64") } : m,
    );
    const on = (p: (typeof PLATFORMS)[number]) =>
      modelsFor({ "asr.diarizer": "nemotron" }, p, narrowed).flatMap((m) => m.serves);
    expect(on("linux-x64")).toContain("final");
    expect(on("linux-arm64")).not.toContain("final");
  });
});

describe("ASR-2: modelsFor(settings, platform)", () => {
  test("the lists are today's for either diarizer, on every released platform (no behaviour change)", () => {
    for (const platform of PLATFORMS) {
      expect(ids(modelsFor({ "asr.diarizer": "nemotron" }, platform))).toEqual([
        RECOGNIZER,
        "silero-vad",
        NEMOTRON,
        "titanet-small",
      ]);
      expect(ids(modelsFor({ "asr.diarizer": "embeddings" }, platform))).toEqual([
        RECOGNIZER,
        "silero-vad",
        "pyannote-segmentation-3.0",
        "titanet-small",
      ]);
    }
  });

  test("an entry is left out on a platform it does not list", () => {
    const registry: CatalogEntry[] = MODELS.map((m) =>
      m.id === "titanet-small" ? { ...m, platforms: ["darwin-arm64"] } : m,
    );
    const on = (p: (typeof PLATFORMS)[number]) =>
      ids(modelsFor({ "asr.diarizer": "nemotron" }, p, registry));
    expect(on("darwin-arm64")).toContain("titanet-small");
    expect(on("win32-x64")).not.toContain("titanet-small");
    // Positive control: the same registry without the restriction keeps it everywhere.
    expect(ids(modelsFor({ "asr.diarizer": "nemotron" }, "win32-x64"))).toContain("titanet-small");
  });

  test("a platform akou is not released for gets no model", () => {
    expect(modelsFor({ "asr.diarizer": "nemotron" }, "freebsd-x64")).toEqual([]);
  });

  test("a test registry without catalog fields runs on every platform", () => {
    const fake = [{ id: "fake", job: "test", licence: "MIT", source: "here", files: [] }];
    expect(ids(modelsFor({ "asr.diarizer": "nemotron" }, "freebsd-x64", fake))).toEqual(["fake"]);
  });

  test("hostPlatform names this machine the way the catalog does", () => {
    expect(hostPlatform()).toBe(`${process.platform}-${process.arch}`);
  });
});

interface FixtureUnit {
  set: string;
  unit: string;
  text: string;
  tokens: string[];
  timestamps: number[];
  ys_log_probs: number[];
  benchmark: { words: string[]; conf: number[] };
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "parakeet-greedy-words.json"), "utf8"),
) as { engine: string; units: FixtureUnit[] };

/** The benchmark's word normalizer, only to compare word lists in its scoring space. */
function norm(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]|_/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A word list in the benchmark's space: each normalized piece keeps its word's confidence. */
function scored(words: readonly WordHyp[]): { words: string[]; conf: number[] } {
  const out = { words: [] as string[], conf: [] as number[] };
  for (const w of words) {
    for (const piece of norm(w.w)
      .split(" ")
      .filter((x) => x !== "")) {
      out.words.push(piece);
      out.conf.push(w.conf as number);
    }
  }
  return out;
}

function sherpaResult(u: FixtureUnit) {
  return {
    text: u.text,
    tokens: u.tokens,
    timestamps: u.timestamps,
    ys_log_probs: u.ys_log_probs,
  };
}

describe("ASR-2: word confidence from sherpa's per-token log-probs", () => {
  test("the fixture holds low-confidence words, so it can tell derivations apart", () => {
    expect(fixture.engine).toBe(RECOGNIZER);
    expect(fixture.units.length).toBeGreaterThanOrEqual(4);
    const low = fixture.units.flatMap((u) => u.benchmark.conf.filter((c) => c < 0.6));
    expect(low.length).toBeGreaterThanOrEqual(5);
  });

  test("words and confidences match the benchmark's greedy Parakeet output", () => {
    for (const u of fixture.units) {
      const got = scored(sherpaWords(sherpaResult(u)));
      expect({ unit: u.unit, words: got.words }).toEqual({
        unit: u.unit,
        words: u.benchmark.words,
      });
      got.conf.forEach((c, i) => {
        expect(Math.abs(c - (u.benchmark.conf[i] as number))).toBeLessThan(1e-12);
      });
    }
  });

  test("the words keep their surface form and join back into the text", () => {
    for (const u of fixture.units) {
      const words = sherpaWords(sherpaResult(u));
      expect(words.map((w) => w.w).join(" ")).toBe(u.text);
    }
  });

  test("positive control: a mean instead of the lowest log-prob disagrees with the fixture", () => {
    let differ = 0;
    for (const u of fixture.units) {
      const words = sherpaWords(sherpaResult(u));
      let k = 0;
      for (const w of words) {
        const lps: number[] = [];
        for (let n = 0; n === 0 || (k < u.tokens.length && !u.tokens[k]?.startsWith(" ")); n++) {
          lps.push(u.ys_log_probs[k] as number);
          k++;
        }
        const mean = Math.exp(Math.min(0, lps.reduce((a, b) => a + b, 0) / lps.length));
        if (Math.abs(mean - (w.conf as number)) > 1e-3) differ++;
      }
    }
    expect(differ).toBeGreaterThanOrEqual(3);
  });

  test("a word starts at its first token and ends where its last token's duration ends", () => {
    const words = sherpaWords({
      tokens: [" He", "llo", ",", " wor", "ld"],
      timestamps: [0.5, 0.7, 0.9, 1.2, 1.4],
      durations: [0.2, 0.2, 0.08, 0.2, 0.32],
      ys_log_probs: [0, -0.1, -0.5, 0.3, -0.2],
    });
    expect(words.map((w) => w.w)).toEqual(["Hello,", "world"]);
    expect(words[0]).toMatchObject({ t0: 0.5 });
    expect(words[0]?.t1).toBeCloseTo(0.98, 10);
    expect(words[1]?.t0).toBe(1.2);
    expect(words[1]?.t1).toBeCloseTo(1.72, 10);
    expect(words[0]?.conf).toBeCloseTo(Math.exp(-0.5), 12);
    // A boost can lift a log-prob above 0; a confidence never goes above 1.
    expect(words[1]?.conf).toBeCloseTo(Math.exp(-0.2), 12);
    expect(sherpaWords({ tokens: [" ok"], ys_log_probs: [0.4] })[0]?.conf).toBe(1);
  });

  test("without durations a word ends where the next begins; without log-probs it has no confidence", () => {
    const words = sherpaWords({ tokens: [" a", " b"], timestamps: [1, 2] });
    expect(words).toEqual([
      { w: "a", t0: 1, t1: 2 },
      { w: "b", t0: 2, t1: 2 },
    ]);
    expect(sherpaWords({ tokens: [] })).toEqual([]);
    expect(sherpaWords({})).toEqual([]);
  });
});

describe("ASR-2: SherpaRecognizer is the first FinalEngine", () => {
  function stub(u: FixtureUnit) {
    return {
      createStream: () => ({ acceptWaveform: () => {} }),
      decode: () => {},
      getResult: () => ({ ...sherpaResult(u), text: ` ${u.text} ` }),
    };
  }

  test("decode keeps its text and adds the words (the live and final passes read only the text)", () => {
    const u = fixture.units[0] as FixtureUnit;
    const r = new SherpaRecognizer(RECOGNIZER, stub(u), "greedy").decode(new Float32Array(16000));
    expect(r.text).toBe(u.text);
    expect(scored(r.words ?? []).words).toEqual(u.benchmark.words);
  });

  test("as a FinalEngine it returns a Hypothesis with the engine id, words, confidences and times", async () => {
    const u = fixture.units[2] as FixtureUnit;
    const rec = new SherpaRecognizer(RECOGNIZER, stub(u), "greedy");
    const engine = new RecognizerEngine({
      recognizerModel: RECOGNIZER,
      prepare: () => ({
        recognizer: rec,
        arg: undefined,
        entries: [],
        dropped: [],
        warnings: [],
        checks: [],
      }),
    });
    expect(engine.id).toBe(RECOGNIZER);
    expect(engine.features).toEqual({
      confidence: true,
      timestamps: true,
      glossary: false,
      languageId: false,
    });
    await engine.load();
    const h = await engine.decode({ samples: new Float32Array(16000), lang: "auto", glossary: [] });
    expect(h.engine).toBe(RECOGNIZER);
    expect(h.text).toBe(u.text);
    expect(h.words.length).toBe(u.text.split(" ").length);
    expect(h.words.every((w) => w.conf !== undefined && w.t0 !== undefined)).toBe(true);
    expect(h.ms).toBeGreaterThanOrEqual(0);
    await engine.unload();
  });

  test("it loads the recognizer once, through the model set, and works over the CI fakes too", async () => {
    const set = createModels({}, "fake-recognizer");
    let prepared = 0;
    const engine = new RecognizerEngine({
      recognizerModel: set.recognizerModel,
      prepare: (l) => {
        prepared++;
        return set.prepare(l);
      },
    });
    await engine.load();
    await engine.load();
    const a = await engine.decode({ samples: new Float32Array(160), lang: "en", glossary: [] });
    expect(prepared).toBe(1);
    expect(a.engine).toBe(set.recognizerModel);
    expect(a.words).toEqual([]);
    // Positive control: after unload the next decode prepares again.
    await engine.unload();
    await engine.decode({ samples: new Float32Array(160), lang: "en", glossary: [] });
    expect(prepared).toBe(2);
  });
});
