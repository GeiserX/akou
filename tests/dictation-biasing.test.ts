/**
 * DC-L7: the scoring of dictation's biasing gate (`scripts/eval/dictation-biasing.ts`), which the
 * nightly's `biasing` stage runs on Qwen3-ASR and writes to `docs/gates/dictation-biasing.json`.
 * Each rule is checked on a case worked out by hand, and the verdict against each way it must fail.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BiasClip,
  type BiasScore,
  biasClip,
  holds,
  listFor,
  overweighted,
  ownTerms,
  score,
  soundAlikeName,
  verdict,
  vocabulary,
  wrapped,
} from "../scripts/eval/dictation-biasing.ts";
import { isEcho } from "../src/core/dictation/echo.ts";

const none = () => false;

describe("DC-L7: what a clip is scored against", () => {
  test("a term is held as whole words in order, whatever the case and punctuation", () => {
    expect(holds("We met in New York, at noon.", "new york")).toBe(true);
    expect(holds("We met in York New", "New York")).toBe(false);
    expect(holds("carry it", "Karry")).toBe(false);
    expect(holds("anything", "")).toBe(false);
  });

  test("own terms are names not opening a sentence, and the rare words; a sentence's first word is not a name", () => {
    const common = (w: string) => ["then", "flew", "with", "spoke", "about"].includes(w);
    expect(
      ownTerms("Then we flew to New York with Ada. Ada spoke about photosynthesis.", common),
    ).toEqual(["New York", "Ada", "photosynthesis"]);
  });

  test("a sound-alike name keeps the sound and is no known word", () => {
    expect(soundAlikeName("carry", "en", none)).toBe("Karry");
    // Every respelling that keeps the sound is a word: no name.
    expect(soundAlikeName("carry", "en", () => true)).toBeNull();
    expect(soundAlikeName("vaca", "es", none)).toBe("Baca");
  });

  test("a clip's terms are its names and long rare words; its sound-alikes come from its common words, never its terms", () => {
    const refs = [
      "The ferry to Carryton carried photosynthesis kits.",
      "The ferry carried people.",
      "A ferry carried cars to Carryton.",
    ];
    const c = biasClip("a", "en", refs[0] as string, vocabulary(refs));
    expect(c.terms).toEqual(["Carryton", "photosynthesis"]);
    expect(c.soundAlikes).toContain("Pherry");
    expect(c.soundAlikes.some((s) => s.toLowerCase().includes("carryton"))).toBe(false);
  });

  test("a list holds its own terms and sound-alikes up to a third each, fills with distractors the reference does not hold, and is the same every night", () => {
    const c: BiasClip = {
      id: "x",
      lang: "en",
      ref: "Ada met Lin in Oslo",
      terms: ["Ada", "Lin", "Oslo", "Ulm"],
      soundAlikes: ["Mett", "Inn", "Hin", "Zin"],
    };
    const pool = ["Oslo", "Bergen", "Kyiv", "Lima", "Quito", "Riga", "Sofia", "Tunis", "Accra"];
    const l = listFor(c, 10, pool, 5);
    expect(l).toHaveLength(10);
    expect(l.filter((t) => c.terms.includes(t))).toHaveLength(3);
    expect(l.filter((t) => c.soundAlikes.includes(t))).toHaveLength(3);
    expect(l.filter((t) => t === "Oslo")).toHaveLength(1);
    expect(listFor(c, 10, pool, 5)).toEqual(l);
  });
});

describe("DC-L7: the score and the ship rule", () => {
  const clips: BiasClip[] = [
    {
      id: "s",
      lang: "en",
      ref: "Ada flew to Oslo",
      terms: ["Ada", "Oslo"],
      soundAlikes: ["Phlew"],
    },
    { id: "n", lang: "en", ref: "", terms: [], soundAlikes: [] },
    // Another clip's term that this clip's reference holds: said, so written, and no insertion.
    { id: "r", lang: "en", ref: "Lima is far", terms: [], soundAlikes: [] },
  ];
  const listed = [["Ada", "Oslo", "Phlew", "Lima"], ["Lima", "Kyiv"], ["Lima"]];

  test("a hit is an own term written; an insertion is a listed term written that was not said", () => {
    const s = score(clips, ["Ada phlew to Lima", "Kyiv", "Lima is far"], listed, [
      false,
      true,
      false,
    ]);
    expect(s).toEqual({
      hits: 1,
      terms: 2,
      insertions: 3,
      soundAlikeInsertions: 1,
      noiseInsertions: 1,
      echoes: 1,
      answers: 3,
      inserted: ["s: Phlew", "s: Lima", "n: Kyiv"],
    });
  });

  const base: BiasScore = {
    hits: 10,
    terms: 20,
    insertions: 2,
    soundAlikeInsertions: 1,
    noiseInsertions: 0,
    echoes: 0,
    answers: 30,
    inserted: [],
  };
  const at = (o: Partial<BiasScore>): BiasScore => ({ ...base, ...o });

  test("more hits and no more insertions passes, with a control that inserts", () => {
    expect(verdict(base, at({ hits: 14 }), at({ insertions: 9 }))).toEqual({
      pass: true,
      controlBreaks: true,
      reasons: [],
    });
  });

  test("positive control: a control that inserts no more than the baseline fails the gate, whatever the rest", () => {
    const v = verdict(base, at({ hits: 14 }), at({ insertions: 2 }));
    expect(v.pass).toBe(false);
    expect(v.controlBreaks).toBe(false);
    expect(v.reasons[0]).toContain("cannot see one");
  });

  test("insertions above the baseline fail, and so do hits that did not rise", () => {
    expect(verdict(base, at({ hits: 14, insertions: 3 }), at({ insertions: 9 })).reasons).toEqual([
      "insertions rose: 3 against the baseline's 2",
    ]);
    expect(verdict(base, at({ hits: 10 }), at({ insertions: 9 })).reasons).toEqual([
      "hits did not rise: 10 against the baseline's 10",
    ]);
  });

  test("the context is the list wrapped as the app sends it, and the echo guard knows it", () => {
    expect(wrapped(["Ada", "Oslo"])).toEqual(["Technical terms: Ada, Oslo."]);
    expect(wrapped([])).toEqual([]);
    expect(isEcho((wrapped(["Ada", "Oslo"]) as string[])[0] as string)).toBe(true);
    expect(overweighted(["Ada"])[0]).toContain("Ada. Ada. Ada.");
    // The control also gives the sentence with its sound-alike names in place of the words.
    const c: BiasClip = {
      id: "c",
      lang: "en",
      ref: "They carry the cups",
      terms: [],
      soundAlikes: ["Karry", "Kups"],
    };
    expect(overweighted(["Karry"], c)[0]).toEndWith("The speaker says: They Karry the Kups");
  });
});

describe("DC-L7: the committed result", () => {
  test("the gate file holds every setting, and the control broke the insertion ceiling", () => {
    const g = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "docs", "gates", "dictation-biasing.json"), "utf8"),
    ) as {
      measured: string;
      settings: Record<string, BiasScore & { wer: number; echoRate: number }>;
      verdict: { pass: boolean; controlBreaks: boolean };
    };
    expect(g.measured).toMatch(/^\d{4}-\d{2}-\d{2}, /);
    for (const s of ["none", "10", "24", "control"]) {
      expect(g.settings[s]?.answers).toBeGreaterThan(0);
      expect(g.settings[s]?.wer).toBeGreaterThanOrEqual(0);
    }
    expect(g.verdict.controlBreaks).toBe(true);
  });
});
