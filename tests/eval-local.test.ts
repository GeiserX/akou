/**
 * `scripts/eval-local.ts` (docs/TESTING.md TS-21): a call's own fixes are its hand reference, the
 * numbers match ones worked out by hand, and nothing but numbers is ever written.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, numbersOnly, scoreCall, withoutFixes } from "../scripts/eval-local.ts";
import type { LogEvent } from "../src/core/log/events.ts";
import { EVENTS_FILE } from "../src/core/log/writer.ts";
import { LogBuilder, T0 } from "./helpers.ts";

const WORDS =
  "deploy today hetzner hetzna should could move cluster clusta talk versal vercel about nothing change here there";

/** A call with every kind of correction: start vocabulary, the app's, and three hand fixes. */
function fixedCall(parts = 1): LogEvent[] {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  // The vocabulary the call started with corrects the recognizer's text: not a hand fix.
  b.add({ type: "vocab.add", id: "v0001", rev: 1, term: "Hetzner", heard: ["hetzna"], by: "user" });
  b.seg({ id: "l000001", ch: "mic", spk: "you", a0: 0, a1: 3, text: "deploy to hetzna today" });
  b.seg({ id: "l000002", spk: "c1", a0: 3, a1: 6, text: "we should move the cluster" });
  b.seg({ id: "l000003", spk: "c2", a0: 6, a1: 9, text: "talk to versal about it" });
  b.seg({ id: "l000004", spk: "c1", a0: 9, a1: 12, text: "nothing to change here" });
  b.seg({ id: "l000005", spk: "c2", a0: 12, a1: 15, text: "the clusta is up" });
  // The app's own vocabulary pass: not a hand fix either.
  b.add({
    type: "vocab.add",
    id: "v0002",
    rev: 1,
    term: "cluster",
    heard: ["clusta"],
    by: "app",
    segs: ["l000005"],
    decode: false,
  });
  // Three hand fixes: a term for the whole call, a rewording of one word, a line rewritten.
  b.add({ type: "vocab.add", id: "v0005", rev: 1, term: "Vercel", heard: ["versal"], by: "user" });
  b.add({
    type: "vocab.add",
    id: "v0006",
    rev: 1,
    term: "could",
    heard: ["should"],
    by: "agent:claude",
    segs: ["l000002"],
    nth: 0,
    decode: false,
  });
  b.add({ type: "seg", id: "l000004", rev: 2, text: "nothing to change there", by: "user" });
  b.partEnded(1, "stop", 15);
  if (parts > 1) {
    b.partStarted(2, T0 + 60_000);
    b.seg({ id: "l000006", part: 2, spk: "c1", a0: 0, a1: 3, text: "one more line" });
    b.partEnded(2, "stop", 3);
  }
  b.add({ type: "call.ended", reason: "stop" });
  return b.events;
}

function root(calls: Record<string, LogEvent[]>): string {
  const r = mkdtempSync(join(tmpdir(), "akou-eval-local-"));
  for (const [name, events] of Object.entries(calls)) {
    const dir = join(r, "work", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, EVENTS_FILE), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }
  return r;
}

describe("the hand reference", () => {
  test("only fixes made after the transcript began, not by the app, are taken out", () => {
    const kept = withoutFixes(fixedCall())
      .filter((e) => e.type === "vocab.add")
      .map((e) => (e as Extract<LogEvent, { type: "vocab.add" }>).id);
    expect(kept).toEqual(["v0001", "v0002"]);
    expect(withoutFixes(fixedCall()).some((e) => e.type === "seg" && e.rev === 2)).toBe(false);
  });

  test("one call scores as worked out by hand", () => {
    const s = scoreCall(fixedCall());
    // Lines 2, 3 and 4 were fixed, one word each: 5 + 5 + 4 reference words. Lines 1 and 5 read
    // the same both ways (start vocabulary, the app's pass), so they count only toward all words.
    expect(s).toMatchObject({
      lines: 5,
      linesFixed: 3,
      refWordsFixed: 14,
      refWordsAll: 22,
      errors: 3,
      // Hetzner, cluster twice: right already. Vercel and could: only after the fix.
      termOccurrences: 5,
      termHits: 3,
    });
  });
});

describe("evaluate and the gate", () => {
  test("a folder of calls gives the numbers, and DER from a hand RTTM, skipping multi-part calls", async () => {
    const r = root({ a: fixedCall(), b: fixedCall(2), c: fixedCall() });
    const rttm = mkdtempSync(join(tmpdir(), "akou-eval-rttm-"));
    try {
      const turn = (s: number, spk: string) => `SPEAKER x 1 ${s} 3 <NA> <NA> ${spk} <NA> <NA>`;
      // Call a labelled as akou heard it; call c with its fourth line given to the wrong speaker.
      writeFileSync(
        join(rttm, "a.rttm"),
        [turn(0, "A"), turn(3, "B"), turn(6, "C"), turn(9, "B"), turn(12, "C")].join("\n"),
      );
      writeFileSync(join(rttm, "b.rttm"), turn(0, "A"));
      writeFileSync(
        join(rttm, "c.rttm"),
        [turn(0, "A"), turn(3, "B"), turn(6, "C"), turn(9, "C"), turn(12, "C")].join("\n"),
      );
      const out = await evaluate(r, rttm);
      expect(out).toMatchObject({
        calls: 3,
        calls_with_fixes: 3,
        lines: 16,
        lines_fixed: 9,
        word_errors: 9,
        wer_fixed_lines: 21.43,
        term_occurrences: 15,
        term_recall: 60,
        der_calls: 2,
        der_skipped_multipart: 1,
      });
      // Call b's extra line is unfixed: 22 + 25 + 22 words.
      expect(out.wer_lower_bound).toBe(Math.round((10000 * 9) / 69) / 100);
      // The positive control: call c's wrong speaker is 2.5 of the 25 scored seconds after the
      // collars; call a has none.
      expect(out.der).toBe(10);
      const alone = await evaluate(root({ a: fixedCall() }), rttm);
      expect(alone.der).toBe(0);
    } finally {
      rmSync(r, { recursive: true, force: true });
      rmSync(rttm, { recursive: true, force: true });
    }
  });

  test("the gate refuses any string, so no text of a call can be written", () => {
    expect(() => numbersOnly({ a: 1, b: { c: "deploy to Hetzner" } })).toThrow(/numbers only/);
    expect(() => numbersOnly({ a: [1, "x"] })).toThrow(/numbers only/);
    expect(() => numbersOnly({ a: Number.NaN })).toThrow(/finite/);
    expect(numbersOnly({ a: 1, b: null, c: { d: 2.5 } })).toContain('"d": 2.5');
  });

  test("the script writes numbers and no word of any call, and writes nothing with no call", () => {
    const r = root({ a: fixedCall() });
    const out = join(r, "result.json");
    try {
      const run = (args: string[]) =>
        Bun.spawnSync(
          [process.execPath, join(import.meta.dir, "..", "scripts", "eval-local.ts"), ...args],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        );
      const ok = run(["--root", r, "--out", out]);
      expect(ok.exitCode).toBe(0);
      const text = readFileSync(out, "utf8");
      expect(JSON.parse(text).lines_fixed).toBe(3);
      for (const w of WORDS.split(" ")) expect(text.toLowerCase()).not.toContain(w);

      const none = join(r, "none.json");
      const empty = run(["--root", join(r, "nowhere"), "--out", none]);
      expect(empty.exitCode).toBe(66);
      expect(existsSync(none)).toBe(false);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
