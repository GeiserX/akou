/**
 * Who a call speaker is by voice (`src/main/voices/match.ts`), and the thresholds it reads from
 * `docs/gates/voices.json` (`src/main/voices/thresholds.ts`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Candidate,
  decideRanked,
  type LabelState,
  matchVoice,
  rankPeople,
} from "../src/main/voices/match.ts";
import type { Person } from "../src/main/voices/store.ts";
import {
  NO_THRESHOLDS,
  thresholdsFor,
  type VoiceThresholds,
} from "../src/main/voices/thresholds.ts";

const MODEL = "titanet-small";
const DIM = 4;

const T: VoiceThresholds = {
  accept: 0.8,
  offer: 0.6,
  margin: 0.1,
  minMatchSec: 20,
  minLearnSec: 30,
  score: "best",
};

/** A unit vector `deg` degrees from the first axis toward the second. */
function at(deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  return Float32Array.from([Math.cos(r), Math.sin(r), 0, 0]);
}

/** A unit vector `deg` degrees from the first axis toward the third. */
function off(deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  return Float32Array.from([Math.cos(r), 0, Math.sin(r), 0]);
}

function person(name: string, vecs: Float32Array[], model = MODEL): Person {
  return {
    name,
    exemplars: vecs.map((vec, i) => ({
      model,
      dim: vec.length,
      vec,
      secs: 60,
      cons: 0.8,
      call: `call-${name}-${i}`,
      spk: "c1",
      at: "2026-11-27T10:00:00.000Z",
    })),
  };
}

function label(over: Partial<LabelState> = {}): LabelState {
  return {
    spk: "c1",
    secs: 30,
    typed: false,
    voice: null,
    taken: new Set(),
    refused: new Set(),
    ...over,
  };
}

const ANA = person("Ana", [at(0)]);
const BO = person("Bo", [at(90)]);

function run(
  people: Person[],
  vec: Float32Array,
  over: Partial<LabelState> = {},
  thresholds: VoiceThresholds = T,
) {
  return matchVoice({ people, model: MODEL, dim: DIM, vec, label: label(over), thresholds });
}

describe("the match rule", () => {
  test("a voice close to one person and far from the rest is named", () => {
    expect(run([ANA, BO], at(5))).toMatchObject({ kind: "name", name: "Ana" });
  });

  test("a voice under ACCEPT but over OFFER is offered", () => {
    // cos 45 = 0.71
    expect(run([ANA, BO], off(45))).toMatchObject({ kind: "offer", name: "Ana" });
    // cos 60 = 0.5: under OFFER.
    expect(run([ANA, BO], off(60))).toEqual({ kind: "none" });
  });

  test("a runner-up within MARGIN turns a name into an offer", () => {
    // Ana at 0 and Cy at 60 degrees are two voices (cos 0.5). The label at 28: 0.88 and 0.85.
    const cy = person("Cy", [at(60)]);
    expect(run([ANA, cy], at(28))).toMatchObject({ kind: "offer", name: "Ana" });
    // The positive control: Cy farther away leaves Ana named.
    expect(run([ANA, person("Cy", [at(120)])], at(28))).toMatchObject({
      kind: "name",
      name: "Ana",
    });
  });

  test("a label with a typed name is skipped, and so is a label that is not c<N>", () => {
    expect(run([ANA], at(0), { typed: true })).toEqual({ kind: "none" });
    expect(run([ANA], at(0), { spk: "you" })).toEqual({ kind: "none" });
    expect(run([ANA], at(0), { spk: "c?" })).toEqual({ kind: "none" });
    expect(run([ANA], at(0), { spk: "s1" })).toEqual({ kind: "none" });
    // The positive control: the same label untyped is named.
    expect(run([ANA], at(0))).toMatchObject({ kind: "name", name: "Ana" });
  });

  test("a label under MIN_MATCH_SEC is skipped", () => {
    expect(run([ANA], at(0), { secs: 19.9 })).toEqual({ kind: "none" });
    expect(run([ANA], at(0), { secs: 20 })).toMatchObject({ kind: "name" });
  });

  test("one person per call: a person shown on another label is left out", () => {
    expect(run([ANA, BO], at(0), { taken: new Set(["Ana"]) })).toEqual({ kind: "none" });
    // The runner-up goes up when the top person is taken.
    const cy = person("Cy", [at(20)]);
    expect(run([ANA, cy], at(5), { taken: new Set(["Ana"]) })).toMatchObject({
      kind: "name",
      name: "Cy",
    });
    // The positive control: with nobody taken, Ana is offered (Cy is within MARGIN) or named.
    expect(run([ANA, BO], at(0))).toMatchObject({ kind: "name", name: "Ana" });
  });

  test("a person this label refused is left out", () => {
    expect(run([ANA, BO], at(0), { refused: new Set(["Ana"]) })).toEqual({ kind: "none" });
    expect(run([ANA, BO], at(0))).toMatchObject({ kind: "name", name: "Ana" });
  });

  test("the score is the best exemplar, or the mean of them when the gate says mean", () => {
    const two = person("Ana", [at(0), at(60)]);
    const best = rankPeople([two], MODEL, DIM, at(0), "best")[0] as Candidate;
    const mean = rankPeople([two], MODEL, DIM, at(0), "mean")[0] as Candidate;
    expect(best.score).toBeCloseTo(1, 6);
    // The mean of the two points at 30 degrees: cos 30.
    expect(mean.score).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(run([two], at(0), {}, { ...T, score: "mean" })).toMatchObject({ kind: "name" });
    expect(run([two], at(0), {}, { ...T, accept: 0.9, score: "mean" })).toMatchObject({
      kind: "offer",
    });
    expect(run([two], at(0), {}, { ...T, accept: 0.9 })).toMatchObject({ kind: "name" });
  });

  test("an offer is raised to a name, and a name already shown is kept", () => {
    expect(run([ANA, BO], at(0), { voice: { name: "Ana", status: "offered" } })).toMatchObject({
      kind: "name",
      name: "Ana",
    });
    expect(run([ANA, BO], at(0), { voice: { name: "Ana", status: "named" } })).toEqual({
      kind: "none",
    });
    // An offer that still stands is kept, not written again.
    expect(run([ANA, BO], off(45), { voice: { name: "Ana", status: "offered" } })).toEqual({
      kind: "none",
    });
  });
});

describe("traps", () => {
  test("[VO-2] a forgotten person never matches", () => {
    const store = [ANA, BO];
    const forgotten = [BO];
    expect(run(forgotten, at(0))).toEqual({ kind: "none" });
    // A label that shows the forgotten person's name loses it.
    expect(run(forgotten, at(0), { voice: { name: "Ana", status: "named" } })).toEqual({
      kind: "withdraw",
      name: "Ana",
      next: { kind: "none" },
    });
    // The positive control: before the forget the same voice is Ana, and the name stays.
    expect(run(store, at(0))).toMatchObject({ kind: "name", name: "Ana" });
    expect(run(store, at(0), { voice: { name: "Ana", status: "named" } })).toEqual({
      kind: "none",
    });
  });

  test("[VO-3] a model or size mismatch is skipped", () => {
    const otherModel = person("Ana", [at(0)], "campplus-zh-en-advanced");
    const otherSize = person("Ana", [Float32Array.from([1, 0, 0])]);
    expect(run([otherModel], at(0))).toEqual({ kind: "none" });
    expect(run([otherSize], at(0))).toEqual({ kind: "none" });
    expect(rankPeople([otherModel, otherSize], MODEL, DIM, at(0))).toEqual([]);
    // A centroid of another size than the running embedder scores no one.
    expect(run([ANA], Float32Array.from([1, 0, 0]))).toEqual({ kind: "none" });
    // A person keeps only the exemplars of the running embedder.
    const mixed: Person = {
      name: "Ana",
      exemplars: [...otherModel.exemplars, ...ANA.exemplars],
    };
    expect(rankPeople([mixed], MODEL, DIM, off(60))[0]?.exemplars.length).toBe(1);
    // The positive control: the same vector with the running model and size is named.
    expect(run([ANA], at(0))).toMatchObject({ kind: "name", name: "Ana" });
  });

  test("[VO-10] a label that drifts to another voice loses its voice name", () => {
    const named = { voice: { name: "Ana", status: "named" as const } };
    // Now Bo's voice: Ana is withdrawn and the label decides again.
    expect(run([ANA, BO], at(85), named)).toEqual({
      kind: "withdraw",
      name: "Ana",
      next: expect.objectContaining({ kind: "name", name: "Bo" }) as never,
    });
    // Ana fell under OFFER (cos 60 = 0.5) with nobody else close: withdrawn, nothing in her place.
    expect(run([ANA, BO], off(60), named)).toEqual({
      kind: "withdraw",
      name: "Ana",
      next: { kind: "none" },
    });
    // Another person now named while Ana still scores over OFFER: Ana (0) at cos 45 = 0.71, Bo
    // (50) at cos 5 = 0.996, a margin of 0.29. Ana is withdrawn and Bo named in her place.
    const near = person("Bo", [at(50)]);
    expect(run([ANA, near], at(45), named)).toEqual({
      kind: "withdraw",
      name: "Ana",
      next: expect.objectContaining({ kind: "name", name: "Bo" }) as never,
    });
    // Its positive control: at 10 degrees the voice is still Ana's (Bo at cos 40 = 0.77).
    expect(run([ANA, near], at(10), named)).toEqual({ kind: "none" });
    // Under ACCEPT but over OFFER (0.71) and nobody else named: the name stays.
    expect(run([ANA, BO], off(45), named)).toEqual({ kind: "none" });
    // A withdrawn person is not offered to that label again.
    expect(run([ANA, BO], at(0), { refused: new Set(["Ana"]) })).toEqual({ kind: "none" });
    // An offer withdrawn the same way.
    expect(run([ANA, BO], at(85), { voice: { name: "Ana", status: "offered" } })).toMatchObject({
      kind: "withdraw",
      name: "Ana",
    });
    // With no offers the floor is ACCEPT.
    expect(run([ANA, BO], off(45), named, { ...T, offer: null })).toMatchObject({
      kind: "withdraw",
      name: "Ana",
    });
    // The positive control: the voice still Ana's keeps the name.
    expect(run([ANA, BO], at(5), named)).toEqual({ kind: "none" });
  });

  test("[VO-11] the same voice under two names does not count as the runner-up", () => {
    const e0 = at(0);
    const cand = (name: string, score: number, best: Float32Array): Candidate => ({
      name,
      score,
      best,
      exemplars: [best],
    });
    // Ana and "Ana Ruiz" are one voice stored twice: her exemplars are 0.98 alike, over ACCEPT.
    const twice = [cand("Ana", 0.95, e0), cand("Ana Ruiz", 0.93, at(10)), cand("Bo", 0.2, at(90))];
    expect(decideRanked(twice, label(), T)).toMatchObject({ kind: "name", name: "Ana" });
    // The positive control: a second person just as close but with another voice (exemplars 0.5
    // alike) is a real runner-up, and the name becomes an offer.
    const two = [cand("Ana", 0.95, e0), cand("Cy", 0.93, at(60)), cand("Bo", 0.2, at(90))];
    expect(decideRanked(two, label(), T)).toMatchObject({ kind: "offer", name: "Ana" });
    // From real exemplars: the label at 3 degrees between Ana (0) and Ana Ruiz (10).
    const ruiz = person("Ana Ruiz", [at(10)]);
    expect(run([ANA, ruiz, BO], at(3))).toMatchObject({ kind: "name", name: "Ana" });
    // A label showing "Ana Ruiz" whose voice now ranks Ana a little higher keeps its name: the
    // two are one voice, so Ana on top does not move it away.
    const shown = label({ voice: { name: "Ana Ruiz", status: "named" } });
    const swapped = [cand("Ana", 0.92, e0), cand("Ana Ruiz", 0.91, at(8)), cand("Bo", 0.2, at(90))];
    expect(decideRanked(swapped, shown, T)).toEqual({ kind: "none" });
    // The positive control: a new top of another voice (exemplars 0.64 alike) withdraws it.
    const other = [cand("Cy", 0.92, at(58)), cand("Ana Ruiz", 0.7, at(8)), cand("Bo", 0.2, at(90))];
    expect(decideRanked(other, shown, T)).toEqual({
      kind: "withdraw",
      name: "Ana Ruiz",
      next: expect.objectContaining({ kind: "name", name: "Cy" }) as never,
    });
  });

  test("null thresholds do nothing", () => {
    expect(run([ANA, BO], at(0), {}, { ...NO_THRESHOLDS })).toEqual({ kind: "none" });
    expect(run([ANA, BO], at(0), {}, thresholdsFor("no-such-model"))).toEqual({ kind: "none" });
    // The shipped gate file: CAM++ was not picked, so its values are null and akou does nothing by voice.
    expect(run([ANA, BO], at(0), {}, thresholdsFor("campplus-zh-en-advanced"))).toEqual({
      kind: "none",
    });
    // A shown name is not withdrawn either.
    expect(
      run([BO], at(0), { voice: { name: "Ana", status: "named" } }, { ...NO_THRESHOLDS }),
    ).toEqual({ kind: "none" });
    // ACCEPT null: offers only. MIN_MATCH_SEC null: nothing.
    expect(run([ANA, BO], at(0), {}, { ...T, accept: null })).toMatchObject({ kind: "offer" });
    expect(run([ANA, BO], at(0), {}, { ...T, margin: null })).toMatchObject({ kind: "offer" });
    expect(run([ANA, BO], at(0), {}, { ...T, minMatchSec: null })).toEqual({ kind: "none" });
    // The positive control: with numbers the same voice is named.
    expect(run([ANA, BO], at(0))).toMatchObject({ kind: "name" });
  });
});

describe("thresholds", () => {
  const FILE = join(import.meta.dir, "..", "docs", "gates", "voices.json");

  test("the thresholds are the gate file's, per model", () => {
    const table = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Record<string, unknown>>;
    expect(Object.keys(table).length).toBeGreaterThan(0);
    for (const [model, e] of Object.entries(table)) {
      expect(Object.keys(e).sort()).toEqual(
        ["accept", "margin", "minLearnSec", "minMatchSec", "offer", "score"].sort(),
      );
      for (const k of ["accept", "offer", "margin", "minMatchSec", "minLearnSec"])
        expect(e[k] === null || typeof e[k] === "number").toBe(true);
      expect(["best", "mean"]).toContain(e.score as string);
      expect(thresholdsFor(model)).toEqual(e as unknown as VoiceThresholds);
    }
  });

  test("a model with no entry, and a malformed entry, read as null", () => {
    expect(thresholdsFor("no-such-model")).toEqual({ ...NO_THRESHOLDS });
    expect(thresholdsFor("toString")).toEqual({ ...NO_THRESHOLDS });
    expect(thresholdsFor("__proto__")).toEqual({ ...NO_THRESHOLDS });
    const table = { m: { accept: "0.8", offer: Number.NaN, margin: 0.1, score: "median" } };
    expect(thresholdsFor("m", table)).toEqual({ ...NO_THRESHOLDS, margin: 0.1 });
    // The positive control: numbers in a table are read.
    expect(thresholdsFor("m", { m: { ...T } })).toEqual(T);
  });
});
