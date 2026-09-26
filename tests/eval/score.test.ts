/**
 * The nightly evaluation's scoring (scripts/eval/score.ts, docs/TESTING.md TS-19 and TS-20),
 * against answers worked out by hand, with a positive control for each rule.
 */

import { describe, expect, test } from "bun:test";
import {
  compare,
  der,
  type Measure,
  normalizeText,
  parseRttm,
  percentile,
  summary,
  type Turn,
  wer,
  wordErrors,
} from "../../scripts/eval/score.ts";

describe("WER with the benchmark's normalizer", () => {
  test("NFKC, lower case, apostrophes dropped, punctuation to spaces, accents kept", () => {
    expect(normalizeText("Don’t STOP—the  café's ﬁne, OK?")).toEqual([
      "dont",
      "stop",
      "the",
      "cafés",
      "fine",
      "ok",
    ]);
    expect(normalizeText("¿Qué pasó? ¡Mañana!")).toEqual(["qué", "pasó", "mañana"]);
    // Accents are kept: a dropped accent is an error.
    expect(normalizeText("que")).not.toEqual(normalizeText("qué"));
  });

  test("edits are counted once each; the corpus rate pools every utterance", () => {
    expect(wordErrors(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
    expect(wordErrors(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
    expect(wordErrors(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(wordErrors(["a", "b", "c"], ["a", "b", "c", "d", "e"])).toBe(2);
    expect(wordErrors([], ["a"])).toBe(1);
    // 1 error in 4 words and 1 in 1 word: 2 of 5, not the mean of 25 % and 100 %.
    expect(
      wer([
        { ref: "one two three four", hyp: "one two three for" },
        { ref: "five", hyp: "" },
      ]),
    ).toBe(40);
    expect(wer([{ ref: "Hello, World!", hyp: "hello world" }])).toBe(0);
    expect(() => wer([{ ref: " ,", hyp: "x" }])).toThrow("no reference words");
  });
});

describe("percentiles", () => {
  test("nearest rank", () => {
    const xs = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 90)).toBe(9);
    expect(percentile(xs, 100)).toBe(10);
    expect(percentile([7], 99)).toBe(7);
    expect(() => percentile([], 50)).toThrow();
  });
});

describe("[TS-20] diarization error rate", () => {
  const t = (start: number, end: number, speaker: string): Turn => ({ start, end, speaker });
  const ref = [t(0, 10, "A"), t(10, 20, "B")];

  test("RTTM turns are read as start and start plus duration", () => {
    expect(
      parseRttm(
        "SPEAKER abc 1 0.50 2.25 <NA> <NA> spk00 <NA> <NA>\n\nSPEAKER abc 1 3 1 <NA> <NA> spk01 <NA> <NA>\n",
      ),
    ).toEqual([t(0.5, 2.75, "spk00"), t(3, 4, "spk01")]);
    expect(() => parseRttm("SPEAKER abc 1 x 1 <NA> <NA> s")).toThrow("bad RTTM line");
  });

  test("the same turns under other names score zero: labels are mapped, not matched", () => {
    expect(der(ref, [t(0, 10, "7"), t(10, 20, "3")]).der).toBe(0);
  });

  test("a swapped half, a missed stretch and a false alarm each count, outside the collar", () => {
    // No collar: B's second half labelled A is 5 s of confusion in 20 s of speech.
    const confused = der(ref, [t(0, 10, "x"), t(10, 15, "y"), t(15, 20, "x")], 0);
    expect(confused.confusion).toBeCloseTo(5, 5);
    expect(confused.der).toBeCloseTo(25, 5);
    const missed = der(ref, [t(0, 10, "x")], 0);
    expect(missed.missed).toBeCloseTo(10, 5);
    expect(missed.der).toBeCloseTo(50, 5);
    const extra = der(ref, [t(0, 10, "x"), t(10, 20, "y"), t(20, 25, "z")], 0);
    expect(extra.falseAlarm).toBeCloseTo(5, 5);
    expect(extra.der).toBeCloseTo(25, 5);
  });

  test("the collar forgives a boundary a little late, and only that", () => {
    // B found 0.2 s late: inside a 0.25 s collar it costs nothing, without one it costs 0.2 s.
    const late = [t(0, 10.2, "x"), t(10.2, 20, "y")];
    expect(der(ref, late, 0.25).der).toBe(0);
    expect(der(ref, late, 0).der).toBeCloseTo(1, 5);
  });

  test("overlapping speech counts each speaker", () => {
    const both = [t(0, 10, "A"), t(5, 10, "B")];
    // Only A heard: B's 5 s of overlap are missed, of 15 speaker-seconds.
    const r = der(both, [t(0, 10, "x")], 0);
    expect(r.speech).toBeCloseTo(15, 5);
    expect(r.missed).toBeCloseTo(5, 5);
  });

  test("positive control: everything under one label scores the smaller speaker as confusion", () => {
    expect(der(ref, [t(0, 20, "x")], 0).der).toBeCloseTo(50, 5);
    expect(() => der([], [t(0, 1, "x")])).toThrow("no scored reference speech");
  });
});

describe("[TS-19] comparison with the committed baselines", () => {
  const m = (o: Partial<Measure> & Pick<Measure, "key" | "value">): Measure => ({
    unit: "%",
    better: "lower",
    gate: "baseline",
    ...o,
  });

  test("at or better than the baseline passes, worse fails, both directions", () => {
    const v = compare(
      [
        m({ key: "wer.en", value: 5.849 }),
        m({ key: "wer.es", value: 3.2 }),
        m({ key: "replay", value: 0.9, better: "higher" }),
        m({ key: "replay2", value: 0.8, better: "higher" }),
      ],
      { "wer.en": 5.85, "wer.es": 3.12, replay: 0.9, replay2: 0.85 },
    );
    expect(v.map((x) => [x.key, x.ok])).toEqual([
      ["wer.en", true],
      ["wer.es", false],
      ["replay", true],
      ["replay2", false],
    ]);
    expect(v[1]?.why).toBe("worse than the baseline 3.12");
  });

  test("positive controls: a gated number with no baseline fails; a bound fails whatever the baseline", () => {
    const [none] = compare([m({ key: "der.new", value: 1 })], {});
    expect(none?.ok).toBe(false);
    expect(none?.why).toContain("no committed baseline");
    const [budget] = compare([m({ key: "rtf", value: 0.6, gate: "record", bound: 0.5 })], {});
    expect(budget?.ok).toBe(false);
    const [floor] = compare([m({ key: "recall", value: 0.8, better: "higher", bound: 0.85 })], {
      recall: 0.7,
    });
    expect(floor?.ok).toBe(false);
    expect(floor?.why).toBe("past its bound 0.85");
    // Recorded numbers pass without a baseline, and never fail on a change.
    const [lat] = compare([m({ key: "p95", value: 900, unit: "ms", gate: "record" })], { p95: 10 });
    expect(lat?.ok).toBe(true);
  });

  test("the summary lists failures first and names every baseline", () => {
    const text = summary(
      "models-nightly (linux-x64)",
      compare([m({ key: "a", value: 1 }), m({ key: "b", value: 9 })], { a: 2, b: 3 }),
      ["FLEURS: CC-BY-4.0"],
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("### models-nightly (linux-x64)");
    expect(lines[4]).toContain("**FAIL** | `b` | 9 % | 3 |");
    expect(lines[5]).toContain("ok | `a` | 1 % | 2 |");
    expect(text).toContain("- FLEURS: CC-BY-4.0");
  });
});
