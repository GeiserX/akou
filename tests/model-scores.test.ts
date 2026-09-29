/**
 * The Models page's two bars (docs/ux/SERVER.md SV-U6): every catalog model has an accuracy and a
 * speed that is either a number with what was measured and where it is written down, or an
 * explicit "not measured" with the reason; and the 0 to 100 scores follow the formulas the file
 * states. A model added to the catalog with no row fails here until someone writes its row.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  FORMULAS,
  type Measure,
  type ModelScores,
  type NotMeasured,
  REFERENCE_MACHINE,
  SCORES,
  score,
  scoresOf,
} from "../src/main/asr/model-scores.ts";
import { type CatalogEntry, MODELS } from "../src/main/asr/models.ts";

const ROOT = join(import.meta.dir, "..");

/** What is wrong with one side of a model's scores, or null when it is whole. */
function sideProblem(s: Measure | NotMeasured | undefined): string | null {
  if (!s) return "missing";
  if ("notMeasured" in s) return s.notMeasured.trim() === "" ? "not measured with no reason" : null;
  if (!Number.isFinite(s.value) || s.value <= 0) return `value ${s.value}`;
  if (s.what.trim() === "") return "no description of what was measured";
  if (s.source.trim() === "") return "no source";
  if (/^https?:\/\//.test(s.source)) return null;
  const file = s.source.split("#")[0] as string;
  return existsSync(join(ROOT, file)) ? null : `source ${file} is not in the repository`;
}

/** Every catalog entry with no scores, or a side with no number and no reason. */
function unscored(catalog: readonly CatalogEntry[]): string[] {
  const out: string[] = [];
  for (const m of catalog) {
    const s: ModelScores | null = scoresOf(m);
    if (!s) {
      out.push(`${m.id}: no row in model-scores.ts`);
      continue;
    }
    for (const side of ["accuracy", "speed"] as const) {
      const p = sideProblem(s[side]);
      if (p) out.push(`${m.id} ${side}: ${p}`);
    }
  }
  return out;
}

describe("[SV-U6] every catalog model is scored with a source, or marked not measured", () => {
  test("the whole catalog, every platform's entries", () => {
    expect(unscored(MODELS)).toEqual([]);
  });

  test("positive control: a recognizer added with no row is reported", () => {
    const fake = {
      ...(MODELS[0] as CatalogEntry),
      id: "new-recognizer-without-scores",
    } satisfies CatalogEntry;
    expect(unscored([...MODELS, fake])).toEqual([
      "new-recognizer-without-scores: no row in model-scores.ts",
    ]);
  });

  test("positive control: a number whose source is not in the repository is reported", () => {
    const at = MODELS[0] as CatalogEntry;
    const row = SCORES[at.id] as ModelScores;
    const moved = { ...(row.accuracy as Measure), source: "docs/research/gone.md#x" };
    expect(sideProblem(moved)).toBe("source docs/research/gone.md is not in the repository");
    expect(sideProblem({ notMeasured: " " })).toBe("not measured with no reason");
  });

  test("a llama-server build is a program, answered without a row, whatever its release", () => {
    const build = MODELS.find((m) => m.serves.length === 1 && m.serves[0] === "runtime");
    expect(build).toBeDefined();
    const s = scoresOf(build as CatalogEntry) as ModelScores;
    expect("notMeasured" in s.accuracy && "notMeasured" in s.speed).toBe(true);
    const renamed = { ...(build as CatalogEntry), id: "llama-server-b99999-linux-x64-cpu" };
    expect(scoresOf(renamed)).toEqual(s);
  });

  test("the recognizers are measured on the same sets, so their bars compare", () => {
    const speech = MODELS.filter((m) => m.serves.includes("final"));
    for (const m of speech) {
      const s = scoresOf(m) as ModelScores;
      expect([m.id, "metric" in s.accuracy && s.accuracy.metric]).toEqual([m.id, "wer"]);
      expect([m.id, "metric" in s.speed && s.speed.what.includes(REFERENCE_MACHINE)]).toEqual([
        m.id,
        true,
      ]);
    }
  });
});

describe("[SV-U6] the 0 to 100 scores follow the stated formulas", () => {
  const m = (metric: Measure["metric"], value: number): Measure => ({
    metric,
    value,
    what: "x",
    source: "x",
  });

  test("accuracy from WER: 100 - 5 x WER, a 20 % WER scores 0", () => {
    expect(score(m("wer", 0))).toBe(100);
    expect(score(m("wer", 4.55))).toBe(77);
    expect(score(m("wer", 20))).toBe(0);
    expect(score(m("wer", 35))).toBe(0);
  });

  test("accuracy from DER: 100 - DER", () => {
    expect(score(m("der", 9.9))).toBe(90);
    expect(score(m("der", 59))).toBe(41);
  });

  test("speed from RTFx: 50 x log10, real time 0, 10x 50, 100x 100, clamped", () => {
    expect(score(m("rtfx", 1))).toBe(0);
    expect(score(m("rtfx", 10))).toBe(50);
    expect(score(m("rtfx", 100))).toBe(100);
    expect(score(m("rtfx", 1000))).toBe(100);
    expect(score(m("rtfx", 0.5))).toBe(0);
  });

  test("the live setups' bars: AMI WER, seconds, cores and GB, each at the anchor its words state", () => {
    expect(score(m("call-wer", 0))).toBe(100);
    expect(score(m("call-wer", 18.8))).toBe(62);
    expect(score(m("call-wer", 50))).toBe(0);
    expect(score(m("seconds", 0.5))).toBe(75);
    expect(score(m("seconds", 2))).toBe(0);
    expect(score(m("cores", 1))).toBe(50);
    expect(score(m("cores", 2))).toBe(0);
    expect(score(m("gb", 8))).toBe(50);
    expect(score(m("gb", 16))).toBe(0);
    expect(score(m("gb", 32))).toBe(0);
  });

  test("each formula is stated in words for the page", () => {
    expect(Object.keys(FORMULAS).sort()).toEqual([
      "call-wer",
      "cores",
      "der",
      "gb",
      "rtfx",
      "seconds",
      "wer",
    ]);
  });

  test("the shipped recognizers: Qwen is the more accurate, Parakeet the faster", () => {
    const at = (id: string, side: "accuracy" | "speed") =>
      score((SCORES[id] as ModelScores)[side] as Measure);
    expect(at("qwen3-asr-1.7b", "accuracy")).toBeGreaterThan(
      at("parakeet-tdt-0.6b-v3-fp32", "accuracy"),
    );
    expect(at("parakeet-tdt-0.6b-v3-fp32", "speed")).toBeGreaterThan(at("qwen3-asr-1.7b", "speed"));
  });
});
