/**
 * Fix once, applied everywhere (docs/DESIGN.md section 5.4, "A fix on a line"): the pairs a fixed
 * line gives, which of them teach a term, which spread to the other lines, and how the read-time
 * correction applies them: whole words only, the exact spelling for a name's casing, a line's own
 * rewording on its one word, and that word carried to the final lines that cover it.
 */

import { describe, expect, test } from "bun:test";
import { fold } from "../src/core/log/fold.ts";
import { correctText, type VocabRule } from "../src/core/vocab/correct.ts";
import { type FixPair, fixPairs, keptWords, pairKind, spreads } from "../src/core/vocab/fix.ts";
import { renderNotes } from "../src/main/handoff/export.ts";
import { userNotes } from "../src/main/notes/enhance.ts";
import { renderNote } from "../src/main/notes/notepad.ts";
import { isDictionaryWord, LogBuilder, T0 } from "./helpers.ts";

const pairs = (a: string, b: string) => fixPairs(a, b).map((p) => [p.heard, p.term]);

/** Common words for the kind and spread rules, the way the bundled lists hold them. */
const COMMON = new Set(
  "a about and ask at buy go he him i in is it its lead mark marc next ok okay on said so store tech the their there three to verge we will write talked told pm plan works".split(
    " ",
  ),
);
const common = (w: string) => COMMON.has(w);

/** What a fixed line teaches: `term (wide)`, `term (line)` or `rewording`, pair by pair. */
function taught(before: string, after: string): string[] {
  return fixPairs(before, after).map((p) => {
    const kind = pairKind(p, common);
    const where = kind === "term" ? (spreads(p, common) ? " wide" : " line") : "";
    return `${p.op} ${p.heard} -> ${p.term}: ${kind}${where}`;
  });
}

describe("the pairs a fixed line gives", () => {
  test("a replaced word, word-aligned with the rest of the line", () => {
    expect(fixPairs("deploy to versal today", "deploy to Vercel today")).toEqual([
      { heard: "versal", term: "Vercel", at: 2, from: 2, op: "replace", lead: false },
    ]);
    // Two runs, each its own pair; a run of words is one pair.
    expect(pairs("we use graph fauna and versal", "we use Grafana and Vercel")).toEqual([
      ["graph fauna", "Grafana"],
      ["versal", "Vercel"],
    ]);
  });

  test("punctuation and a sentence's capital are not pairs; a name's capital is", () => {
    expect(pairs("deploy to versal today", "Deploy to versal, today.")).toEqual([]);
    // The capital after a full stop, a question or an exclamation is the sentence's too.
    expect(pairs("ok. so we ship it", "ok. So we ship it")).toEqual([]);
    expect(pairs("really? yes", "really? Yes")).toEqual([]);
    expect(pairs("deploy on vercel", "deploy on Vercel")).toEqual([["vercel", "Vercel"]]);
    expect(pairs("iphone sales", "iPhone sales")).toEqual([["iphone", "iPhone"]]);
    // Taking a capital away never teaches anything.
    expect(pairs("ask Anika", "ask anika")).toEqual([]);
    // An accent is a spelling fix.
    expect(pairs("hola jose", "hola José")).toEqual([["jose", "José"]]);
  });

  test("a word glued by punctuation is one word; neighbouring case changes join", () => {
    expect(pairs("we use next js", "we use Next.js")).toEqual([["next js", "Next.js"]]);
    expect(pairs("gpt four is out", "GPT-4 is out")).toEqual([["gpt four", "GPT-4"]]);
    expect(pairs("a tech lead", "a Tech Lead")).toEqual([["tech lead", "Tech Lead"]]);
    // An apostrophe is no glue: the name is learned, not its possessive.
    expect(pairs("versal's plan", "Vercel's plan")).toEqual([["versal", "Vercel"]]);
  });

  test("a word added or removed goes with the word before it; a repeated word is its own pair", () => {
    expect(fixPairs("we are going store", "we are going to store")).toEqual([
      {
        heard: "going",
        term: "going to",
        at: 2,
        from: 2,
        op: "insert",
        added: "to",
        lead: false,
      },
    ]);
    expect(pairs("the the plan", "the plan")).toEqual([["the the", "the"]]);
    // At the start of the line, with the word after it.
    expect(pairs("plan works", "the plan works")).toEqual([["plan", "the plan"]]);
    // A dropped repeat next to a replacement does not join it.
    expect(fixPairs("the the versal", "the Vercel").map((p) => [p.op, p.heard, p.term])).toEqual([
      ["delete", "the the", "the"],
      ["replace", "versal", "Vercel"],
    ]);
  });
});

describe("what a pair teaches", () => {
  test("a name, product or jargon word is a term; its heard form spreads unless it is common", () => {
    expect(taught("deploy to versal today", "deploy to Vercel today")).toEqual([
      "replace versal -> Vercel: term wide",
    ]);
    expect(taught("deploy on vercel", "deploy on Vercel")).toEqual([
      "replace vercel -> Vercel: term wide",
    ]);
    expect(taught("iphone sales", "iPhone sales")).toEqual(["replace iphone -> iPhone: term wide"]);
    expect(taught("we use next js", "we use Next.js")).toEqual([
      "replace next js -> Next.js: term wide",
    ]);
    // A name spelled differently from a common word: learned, but only this line is changed.
    expect(taught("I talked to mark", "I talked to Marc")).toEqual([
      "replace mark -> Marc: term line",
    ]);
    // A word added teaches only itself, and never spreads.
    expect(taught("we deploy it on", "we deploy it on Vercel")).toEqual([
      "insert on -> on Vercel: term line",
    ]);
  });

  test("a common word in another case, a number or capitals is a rewording", () => {
    expect(taught("I write it in go", "I write it in Go")).toEqual(["replace go -> Go: rewording"]);
    expect(taught("ask will about it", "ask Will about it")).toEqual([
      "replace will -> Will: rewording",
    ]);
    expect(taught("a tech lead", "a Tech Lead")).toEqual([
      "replace tech lead -> Tech Lead: rewording",
    ]);
    expect(taught("meet at three pm", "meet at 3 pm")).toEqual(["replace three -> 3: rewording"]);
    expect(taught("we said okay", "we said OK")).toEqual(["replace okay -> OK: rewording"]);
    expect(taught("their plan works", "there plan works")).toEqual([
      "replace their -> there: rewording",
    ]);
    expect(taught("the the plan", "the plan")).toEqual(["delete the the -> the: rewording"]);
    // A sentence is never a term.
    const long: FixPair = {
      heard: "it is",
      term: "Vercel is the one we use now",
      at: 2,
      from: 2,
      op: "replace",
      lead: false,
    };
    expect(pairKind(long, common)).toBe("rewording");
    // Without a dictionary only a digit next to letters or a name's capital makes a term.
    const bare = (term: string): FixPair => ({ ...long, heard: "versal", term });
    expect(pairKind(bare("vercel"))).toBe("rewording");
    expect(pairKind(bare("Vercel"))).toBe("term");
  });

  test("the words written back as heard", () => {
    const before = "the next step is next";
    const kept = keptWords(before, "The Next step is next");
    // "the" and "next" changed case, "step", "is" and the last "next" are as heard.
    expect([...kept].map((at) => before.slice(at).split(" ")[0])).toEqual(["step", "is", "next"]);
  });
});

describe("a fix applies to whole words only", () => {
  const rule: VocabRule = { term: "Vercel", heard: ["versal"], scope: "call" };

  test("never inside a longer word, whatever its case", () => {
    expect(correctText("Versal and universal and versality, versal.", [rule]).text).toBe(
      "Vercel and universal and versality, Vercel.",
    );
  });

  test("a name's casing corrects that exact spelling only, from the call or a file", () => {
    const name: VocabRule = { term: "Vercel", heard: ["vercel"], scope: "call" };
    const r = correctText("vercel, Vercel and VERCEL", [name]);
    expect(r.text).toBe("Vercel, Vercel and VERCEL");
    expect(r.corrections.map((c) => c.heard)).toEqual(["vercel"]);
    // A later call reads the workspace's word the same way.
    const file = correctText("we deploy on vercel", [{ ...name, scope: "file" }], {
      isDictionaryWord,
    });
    expect(file.text).toBe("we deploy on Vercel");
    // Positive control: a speaker name's casing is never a heard form.
    expect(correctText("vercel", [{ ...name, scope: "name" }], { isDictionaryWord }).text).toBe(
      "vercel",
    );
  });

  test("a line's rewording changes its one word, and on another line only a word said once", () => {
    const one: VocabRule = {
      term: "and",
      heard: ["to"],
      scope: "call",
      segs: ["l1", "f1", "f2"],
      at: { seg: "l1", nth: 2 },
    };
    const line = "I told him to go to the store to buy it";
    expect(correctText(line, [one], { segId: "l1" }).text).toBe(
      "I told him to go to the store and buy it",
    );
    // A covering line where the word occurs once reads it; where it occurs twice, it cannot tell.
    expect(correctText("store to buy it", [one], { segId: "f1" }).text).toBe("store and buy it");
    expect(correctText("go to the store to buy it", [one], { segId: "f2" }).text).toBe(
      "go to the store to buy it",
    );
    // Positive control: without `at` every copy on the line changes.
    const { at: _at, ...all } = one;
    expect(correctText(line, [all], { segId: "l1" }).text).toBe(
      "I told him and go and the store and buy it",
    );
  });
});

describe("a fix on a line reads on the final lines that cover it", () => {
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
      nth: 0,
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

  test("a fix on a final line outlives the final pass running again", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.partEnded(1, "stop", 12);
    b.seg({ id: "f000001", ch: "call", a0: 0.5, a1: 4, w0: T0 + 500, text: "their plan works" });
    b.add({ type: "final.part.done", part: 1 });
    b.add({
      type: "vocab.add",
      id: "v0005",
      rev: 1,
      term: "there",
      heard: ["their"],
      by: "user",
      segs: ["f000001"],
      nth: 0,
      decode: false,
    });
    // The pass runs again: the old final line is retracted, a new one covers the same audio.
    b.add({ type: "seg", id: "f000001", rev: 2, text: null });
    b.seg({ id: "f000002", ch: "call", a0: 0.6, a1: 4, w0: T0 + 600, text: "their plan works" });
    const v = fold(b.events);
    expect(v.resolve("f000002")?.text).toBe("there plan works");
  });
});

describe("a fix's note is akou's record, not the user's words", () => {
  test("enhanced notes leave it out of the user's own; the export and the pad say where it came from", () => {
    const b = new LogBuilder();
    b.created();
    b.add({
      type: "note",
      id: "n0001",
      rev: 1,
      text: "ask about the budget",
      w: T0,
      afterSeq: 1,
      by: "user",
    });
    b.add({
      type: "note",
      id: "n0002",
      rev: 1,
      text: "Fixed: versal -> Vercel",
      w: T0 + 1000,
      afterSeq: 2,
      by: "user",
      from: "fix",
    });
    const v = fold(b.events);
    expect(userNotes(v).map((n) => n.text)).toEqual(["ask about the budget"]);
    expect(renderNotes(v, "UTC").split("\n")[1]).toEndWith(
      "Fixed: versal -> Vercel _(from a fix)_",
    );
    const fix = v.notes().find((n) => n.id === "n0002");
    expect(fix && renderNote(fix, "UTC")).toContain("(from a fix) Fixed: versal -> Vercel");
  });
});
