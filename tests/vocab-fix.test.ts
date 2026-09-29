/**
 * Fix once, applied everywhere (docs/DESIGN.md section 5.4, "A fix on a line"): the pairs a fixed
 * line gives, which of them teach a term, and how the read-time correction applies them: whole
 * words only, the exact spelling for a name's casing, and a line's own rewording carried to the
 * final lines that cover it.
 */

import { describe, expect, test } from "bun:test";
import { fold } from "../src/core/log/fold.ts";
import { correctText, type VocabRule } from "../src/core/vocab/correct.ts";
import { fixPairs, pairKind } from "../src/core/vocab/fix.ts";
import { isDictionaryWord, LogBuilder, T0 } from "./helpers.ts";

const pairs = (a: string, b: string) => fixPairs(a, b).map((p) => [p.heard, p.term]);

describe("the pairs a fixed line gives", () => {
  test("a replaced word, word-aligned with the rest of the line", () => {
    expect(fixPairs("deploy to versal today", "deploy to Vercel today")).toEqual([
      { heard: "versal", term: "Vercel", at: 2 },
    ]);
    // Two runs, each its own pair; a run of words is one pair.
    expect(pairs("we use graph fauna and versal", "we use Grafana and Vercel")).toEqual([
      ["graph fauna", "Grafana"],
      ["versal", "Vercel"],
    ]);
  });

  test("punctuation and the capital at the start of a line are not pairs; a name's capital is", () => {
    expect(pairs("deploy to versal today", "Deploy to versal, today.")).toEqual([]);
    expect(pairs("ask anika about it", "ask Anika about it")).toEqual([["anika", "Anika"]]);
    expect(pairs("iphone sales", "iPhone sales")).toEqual([["iphone", "iPhone"]]);
    // Taking a capital away never teaches anything.
    expect(pairs("ask Anika", "ask anika")).toEqual([]);
    // An accent is a spelling fix.
    expect(pairs("hola jose", "hola José")).toEqual([["jose", "José"]]);
  });

  test("a word added or removed goes with the word before it", () => {
    expect(pairs("we are going store", "we are going to store")).toEqual([["going", "going to"]]);
    expect(pairs("the the plan", "the plan")).toEqual([["the the", "the"]]);
    // At the start of the line, with the word after it.
    expect(pairs("plan works", "the plan works")).toEqual([["plan", "the plan"]]);
  });

  test("a term is a name, a product or jargon; common words are a rewording", () => {
    const kind = (heard: string, term: string, at = 2) =>
      pairKind({ heard, term, at }, isDictionaryWord);
    expect(kind("versal", "Vercel")).toBe("term");
    expect(kind("versal", "vercel")).toBe("term");
    expect(kind("gpt four", "GPT-4")).toBe("term");
    expect(kind("anika", "Anika")).toBe("term");
    expect(kind("the", "a")).toBe("rewording");
    expect(kind("move", "move to")).toBe("rewording");
    // A capital at the start of the line is the sentence's, not a name's.
    expect(kind("move", "Move", 0)).toBe("rewording");
    // A sentence is never a term.
    expect(kind("it is", "Vercel is the one we use now")).toBe("rewording");
    // Without a dictionary only digits and a name's capital make a term.
    expect(pairKind({ heard: "versal", term: "vercel", at: 2 })).toBe("rewording");
    expect(pairKind({ heard: "versal", term: "Vercel", at: 2 })).toBe("term");
  });
});

describe("a fix applies to whole words only", () => {
  const rule: VocabRule = { term: "Vercel", heard: ["versal"], scope: "call" };

  test("never inside a longer word, whatever its case", () => {
    expect(correctText("Versal and universal and versality, versal.", [rule]).text).toBe(
      "Vercel and universal and versality, Vercel.",
    );
  });

  test("a name's casing corrects that exact spelling only, and only call-scoped", () => {
    const name: VocabRule = { term: "Vercel", heard: ["vercel"], scope: "call" };
    const r = correctText("vercel, Vercel and VERCEL", [name]);
    expect(r.text).toBe("Vercel, Vercel and VERCEL");
    expect(r.corrections.map((c) => c.heard)).toEqual(["vercel"]);
    // Positive control: the same pair from a file corrects nothing.
    expect(correctText("vercel", [{ ...name, scope: "file" }], { isDictionaryWord }).text).toBe(
      "vercel",
    );
  });
});

describe("a fix on a live line reads on the final lines that cover it", () => {
  function call() {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.seg({ id: "l000001", ch: "call", a0: 1, a1: 3, w0: T0 + 1000, text: "their plan works" });
    b.seg({ id: "l000002", ch: "call", a0: 8, a1: 9, w0: T0 + 8000, text: "their plan fails" });
    b.add({
      type: "vocab.add",
      id: "v0005",
      rev: 1,
      term: "there",
      heard: ["their"],
      by: "user",
      segs: ["l000001"],
      decode: false,
    });
    return b;
  }

  test("the covering final line reads it, another final line does not", () => {
    const b = call();
    b.partEnded(1, "stop", 12);
    b.seg({ id: "f000001", ch: "call", a0: 0.5, a1: 4, w0: T0 + 500, text: "their plan works" });
    b.seg({ id: "f000002", ch: "call", a0: 7.5, a1: 9.5, w0: T0 + 7500, text: "their plan fails" });
    b.add({ type: "final.part.done", part: 1 });
    const v = fold(b.events);
    expect(v.lines("best").map((l) => l.text)).toEqual(["there plan works", "their plan fails"]);
  });

  test("a final line that arrives after the view was read is covered too", () => {
    const b = call();
    const v = fold(b.events);
    expect(v.lines("best").map((l) => l.text)).toEqual(["there plan works", "their plan fails"]);
    const more = new LogBuilder();
    for (const e of b.events) more.add(e);
    more.seg({ id: "f000001", ch: "call", a0: 0.5, a1: 4, w0: T0 + 500, text: "their plan works" });
    more.add({ type: "final.part.done", part: 1 });
    for (const e of more.events.slice(b.events.length)) v.apply(e);
    expect(v.resolve("f000001")?.text).toBe("there plan works");
    // Positive control: on the mic channel the same time is not covered.
    const mic = fold([
      ...b.events,
      { ...more.events[b.events.length], ch: "mic" } as (typeof b.events)[number],
    ]);
    expect(mic.resolve("f000001")?.text).toBe("their plan works");
  });
});
