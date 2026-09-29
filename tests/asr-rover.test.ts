/**
 * Confidence ROVER (docs/research/asr-architecture.md, ASR-3), checked against the benchmark's own
 * fusion code: five engines' hypotheses of five units of an Earnings-22 call, and the fused words,
 * frequency vote, two-engine vote and regions the benchmark returned for them
 * (`tests/fixtures/rover-e22.json`). Nothing here loads a model.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hypothesis } from "../src/main/asr/engine.ts";
import {
  build,
  type Column,
  type NetInput,
  ROVER_CONF,
  ROVER_FREQ,
  RoverFuser,
  type RoverParams,
  regions,
  vote,
  voteWords,
  wordKey,
} from "../src/main/asr/rover.ts";

interface FixtureUnit {
  id: string;
  hyps: Record<string, { words: string[]; conf: (number | null)[] }>;
  expected: {
    conf: string[];
    freq: string[];
    qp: string[];
    regions: (string | (string | null)[][])[];
  };
}
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "rover-e22.json"), "utf8"),
) as { engines: Record<string, string>; params: Record<string, number>; units: FixtureUnit[] };
const ORDER = ["Q", "P", "C", "W", "K"];
const inputs = (u: FixtureUnit, engines = ORDER): NetInput[] =>
  engines.map((e) => u.hyps[e] as NetInput);
/** As the benchmark: the default confidence for an engine that reports none, else 1. */
const defaults = (ins: readonly NetInput[], p: RoverParams = ROVER_CONF) =>
  ins.map((h) => (h.conf.some((c) => c !== null && c !== undefined) ? 1 : p.defaultConf));
const fused = (u: FixtureUnit, p: RoverParams, engines = ORDER) => {
  const ins = inputs(u, engines);
  return voteWords(build(ins), p, defaults(ins, p));
};
const asHyp = (u: FixtureUnit, e: string): Hypothesis => {
  const h = u.hyps[e] as FixtureUnit["hyps"][string];
  return {
    engine: FIXTURE.engines[e] as string,
    text: h.words.join(" "),
    words: h.words.map((w, i) => (h.conf[i] == null ? { w } : { w, conf: h.conf[i] as number })),
    ms: 0,
  };
};

describe("ASR-3: the port gives the benchmark's fused words", () => {
  test("the fixture carries the tuned constants and five engines with confidences on Q and P only", () => {
    expect(FIXTURE.params).toEqual({ alpha: 0.4, nullc: 0.5, defc: 0.7 });
    expect(ROVER_CONF).toEqual({ alpha: 0.4, nullConf: 0.5, defaultConf: 0.7 });
    expect(FIXTURE.units.length).toBe(5);
    for (const u of FIXTURE.units) {
      expect(defaults(inputs(u))).toEqual([1, 1, 0.7, 0.7, 0.7]);
    }
  });

  test("rover-conf over QPCWK, frequency over QPCWK and rover-conf over QP match per unit", () => {
    for (const u of FIXTURE.units) {
      expect({ id: u.id, words: fused(u, ROVER_CONF) }).toEqual({
        id: u.id,
        words: u.expected.conf,
      });
      expect({ id: u.id, words: fused(u, ROVER_FREQ) }).toEqual({
        id: u.id,
        words: u.expected.freq,
      });
      expect({ id: u.id, words: fused(u, ROVER_CONF, ["Q", "P"]) }).toEqual({
        id: u.id,
        words: u.expected.qp,
      });
    }
  });

  test("the network splits into the benchmark's agreed words and regions", () => {
    for (const u of FIXTURE.units) {
      const got = regions(build(inputs(u))).map((r) =>
        "agreed" in r ? r.agreed : r.differ.map((col) => col.map((x) => x.w)),
      );
      expect({ id: u.id, regions: got }).toEqual({ id: u.id, regions: u.expected.regions });
    }
  });

  test("the Fuser over the same hypotheses writes the same words, named by its engines", async () => {
    const fuser = new RoverFuser();
    for (const u of FIXTURE.units) {
      const out = await fuser.fuse(
        ORDER.map((e) => asHyp(u, e)),
        { lang: "en", glossary: [] },
      );
      expect(out.words.map((x) => x.w)).toEqual(u.expected.conf);
      expect(out.text).toBe(u.expected.conf.join(" "));
      expect(out.engine).toBe("rover-conf(q-lidc,pk-greedy,cohere,whisper,canary)");
    }
  });

  test("positive control: a mutated alpha changes the fused words", () => {
    for (const alpha of [0, 0.2, 1]) {
      const changed = FIXTURE.units.some(
        (u) => fused(u, { ...ROVER_CONF, alpha }).join(" ") !== u.expected.conf.join(" "),
      );
      expect({ alpha, changed }).toEqual({ alpha, changed: true });
    }
  });

  test("with two engines every alpha below 1 gives the same words", () => {
    for (const u of FIXTURE.units) {
      for (const alpha of [0, 0.2, 0.9]) {
        expect(fused(u, { ...ROVER_CONF, alpha }, ["Q", "P"])).toEqual(u.expected.qp);
      }
    }
  });
});

describe("ASR-3: invariants", () => {
  test("N=1 is the identity, for the network and for the Fuser", async () => {
    for (const u of FIXTURE.units) {
      for (const e of ORDER) {
        const one = [u.hyps[e] as NetInput];
        expect(voteWords(build(one), ROVER_CONF, defaults(one))).toEqual([
          ...(one[0] as NetInput).words,
        ]);
        const h = asHyp(u, e);
        expect(await new RoverFuser().fuse([h], { lang: "en", glossary: [] })).toEqual(h);
      }
    }
  });

  test("no hypotheses is refused", () => {
    expect(() => new RoverFuser().fuseSync([])).toThrow(RangeError);
  });

  test("a column every engine agrees on keeps its word, whatever the constants and confidences", () => {
    // A seeded generator: hypotheses drawn from a small vocabulary so that networks hold both agreed
    // and disputed columns, with random confidences (some missing) and random constants.
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const vocab = ["a", "b", "c", "d", "e"];
    let agreed = 0;
    let disputed = 0;
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(rand() * 5);
      const base = Array.from(
        { length: 3 + Math.floor(rand() * 8) },
        () => vocab[Math.floor(rand() * 5)] as string,
      );
      const ins: NetInput[] = Array.from({ length: n }, () => {
        const words = base.flatMap((w) => {
          const r = rand();
          if (r < 0.1) return [];
          if (r < 0.2) return [vocab[Math.floor(rand() * 5)] as string];
          if (r < 0.25) return [w, vocab[Math.floor(rand() * 5)] as string];
          return [w];
        });
        return { words, conf: words.map(() => (rand() < 0.2 ? null : rand())) };
      });
      const p: RoverParams = { alpha: rand(), nullConf: rand() * 2, defaultConf: rand() };
      const cols = build(ins);
      const won = vote(cols, p, defaults(ins, p));
      cols.forEach((col: Column, k) => {
        const w = col[0]?.w;
        if (w != null && col.every((x) => x.w === w)) {
          agreed++;
          expect(won[k]).toBe(0);
        } else disputed++;
      });
      // Every engine's words are in the network in order, one per column at most.
      ins.forEach((h, s) => {
        expect(cols.flatMap((col) => (col[s]?.w == null ? [] : [col[s]?.w]))).toEqual([...h.words]);
      });
    }
    expect(agreed).toBeGreaterThan(100);
    expect(disputed).toBeGreaterThan(100);
  });
});

describe("ASR-3: spelling, confidence and times of the fused words", () => {
  const hyp = (engine: string, words: Hypothesis["words"], lang?: string): Hypothesis => ({
    engine,
    text: words.map((x) => x.w).join(" "),
    words,
    ms: 0,
    ...(lang ? { lang } : {}),
  });

  test("words align by their key, and the earliest engine's spelling wins", () => {
    expect(wordKey("Merlin's,")).toBe("merlins");
    expect(wordKey("—")).toBe("");
    const q = hyp("q", [{ w: "Welcome," }, { w: "Merlin's" }, { w: "results." }], "en");
    const p = hyp("p", [
      { w: "welcome", conf: 0.9, t0: 0.1, t1: 0.4 },
      { w: "merlins", conf: 0.5, t0: 0.5, t1: 0.9 },
      { w: "result", conf: 0.99, t0: 1, t1: 1.3 },
    ]);
    const out = new RoverFuser().fuseSync([q, p]);
    expect(out.engine).toBe("rover-conf(q,p)");
    expect(out.lang).toBe("en");
    // Q reports no confidences, so its words vote at 0.7: "result" (0.99) beats "results." (0.7).
    expect(out.words).toEqual([
      { w: "Welcome,", conf: 0.9, t0: 0.1, t1: 0.4 },
      { w: "Merlin's", conf: 0.5, t0: 0.5, t1: 0.9 },
      { w: "result", conf: 0.99, t0: 1, t1: 1.3 },
    ]);
    expect(out.text).toBe("Welcome, Merlin's result");
  });

  test("a word that is only punctuation joins the word before it and never takes a column", () => {
    // As its own column the dash would be outvoted by the two engines that have no word there.
    const a = hyp("a", [{ w: "—" }, { w: "yes" }, { w: "—" }, { w: "no" }]);
    const b = hyp("b", [{ w: "yes" }, { w: "no" }]);
    const c = hyp("c", [{ w: "yes" }, { w: "no" }]);
    expect(new RoverFuser().fuseSync([a, b, c]).text).toBe("— yes — no");
  });

  test("a word that agrees takes the highest confidence and the earliest engine's times", () => {
    const q = hyp("q", [{ w: "yes", conf: 0.6, t0: 1, t1: 2 }]);
    const p = hyp("p", [{ w: "yes", conf: 0.9, t0: 3, t1: 4 }]);
    expect(new RoverFuser().fuseSync([q, p]).words).toEqual([
      { w: "yes", conf: 0.9, t0: 1, t1: 2 },
    ]);
  });

  test("a word the benchmark's key splits aligns part by part, and never repeats", () => {
    expect(wordKey("well-known,")).toBe("well known");
    expect(wordKey("rock'n'roll")).toBe("rocknroll");
    const fuse = (...hs: Hypothesis[]) => new RoverFuser().fuseSync(hs);
    const q = hyp("q", [{ w: "a" }, { w: "well-known" }, { w: "b" }]);
    const p = hyp("p", [
      { w: "a", conf: 0.9 },
      { w: "well", conf: 0.9, t0: 1, t1: 1.2 },
      { w: "known", conf: 0.6, t0: 1.2, t1: 1.5 },
      { w: "b", conf: 0.9 },
    ]);
    // Both parts win with Q's spelling, so they join back into Q's word.
    expect(fuse(q, p).words).toEqual([
      { w: "a", conf: 0.9 },
      { w: "well-known", conf: 0.6, t0: 1, t1: 1.5 },
      { w: "b", conf: 0.9 },
    ]);
    expect(fuse(p, q).text).toBe("a well known b");
    expect(
      fuse(hyp("q", [{ w: "follow-up." }]), hyp("p", [{ w: "follow" }, { w: "up" }])).text,
    ).toBe("follow-up.");
    const grew = (w: string[]) =>
      hyp(
        "x",
        w.map((x) => ({ w: x })),
      );
    expect(fuse(grew(["grew", "3.5", "percent"]), grew(["grew", "3", "5", "percent"])).text).toBe(
      "grew 3.5 percent",
    );
    expect(fuse(grew(["—", "well-known"]), grew(["well", "known"])).text).toBe("— well-known");
    // A part another engine wins splits the word, and its punctuation stays on the left part.
    const shown = hyp("p", [
      { w: "well", conf: 0.9 },
      { w: "shown", conf: 0.9 },
    ]);
    expect(fuse(hyp("q", [{ w: "well-known" }]), shown).text).toBe("well- shown");
  });

  test("a word with no confidence from an engine that reports them votes at 1, not the default", () => {
    // Q's "yes" carries no confidence while its other words do, so it scores 1 and beats P's 0.8;
    // at the default 0.7 it would lose.
    const q = hyp("q", [{ w: "yes" }, { w: "we", conf: 0.9 }]);
    const p = hyp("p", [
      { w: "yet", conf: 0.8 },
      { w: "we", conf: 0.9 },
    ]);
    expect(new RoverFuser().fuseSync([q, p]).text).toBe("yes we");
    const bare = hyp("q", [{ w: "yes" }, { w: "we" }]);
    expect(new RoverFuser().fuseSync([bare, p]).text).toBe("yet we");
  });
});
