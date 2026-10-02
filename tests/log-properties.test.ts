/**
 * The log reader and the fold, by property (docs/TESTING.md TS-22): over seeded, generated event
 * sequences, truncating the file at any byte never throws and loses at most the torn line, the fold
 * of a log equals the fold of the same events re-read (and built one event at a time), and a
 * correction applied twice reads the same as once. Each seed is printed in the failing assertion's
 * message, so a failure replays with that seed alone.
 */

import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { CallView, fold } from "../src/core/log/fold.ts";
import { parseLog } from "../src/core/log/reader.ts";
import { isDictionaryWord, jsonl, LogBuilder, T0 } from "./helpers.ts";
import { rng } from "./synth.ts";

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const WORDS = [
  "we",
  "should",
  "move",
  "the",
  "cluster",
  "deploy",
  "hetzna",
  "annika",
  "kubernetis",
  "box",
  "new",
  "to",
  "café",
  "naïve",
  'say "hi"',
  "back\\slash",
  "日本",
  "🙂",
];
const SPEAKERS = ["you", "c1", "c2", "c3"];

/** A call of 20 to 80 events: lines, revisions and retractions, names, merges, notes and fixes. */
function generate(seed: number): LogEvent[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const text = () => Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick(WORDS)).join(" ");
  const b = new LogBuilder();
  b.created({}, T0);
  b.partStarted(1, T0);
  const revs = new Map<string, number>();
  let notes = 0;
  let fixes = 0;
  const n = 20 + Math.floor(r() * 60);
  for (let i = 0; i < n; i++) {
    const k = r();
    const lines = [...revs.keys()];
    if (k < 0.45 || lines.length === 0) {
      const id = `l${String(revs.size + 1).padStart(6, "0")}`;
      const spk = pick(SPEAKERS);
      b.seg({
        id,
        ch: spk === "you" ? "mic" : "call",
        spk,
        a0: i,
        a1: i + 0.8,
        w0: T0 + i * 1000,
        w1: T0 + i * 1000 + 800,
        text: text(),
      });
      revs.set(id, 1);
    } else if (k < 0.6) {
      const id = pick(lines);
      const rev = (revs.get(id) as number) + 1;
      revs.set(id, rev);
      b.add({
        type: "seg",
        id,
        rev,
        text: r() < 0.15 ? null : text(),
        ...(r() < 0.5 ? { by: "user" } : {}),
      });
    } else if (k < 0.68) {
      b.add({ type: "speaker.name", spk: pick(SPEAKERS.slice(1)), name: text(), by: "user" });
    } else if (k < 0.74) {
      b.add({ type: r() < 0.7 ? "speaker.merge" : "speaker.unmerge", from: "c2", into: "c1" });
    } else if (k < 0.84) {
      notes++;
      b.add({
        type: "note",
        id: `n${notes}`,
        rev: 1,
        text: text(),
        w: T0 + i * 1000,
        afterSeq: b.events.length,
        by: "user",
      });
    } else {
      fixes++;
      // Never the words the correction property fixes, so its positive control always bites.
      const heard = pick(["hetzna", "annika", "kubernetis", "box", "new", "to"]);
      b.add({
        type: "vocab.add",
        id: `v${fixes}`,
        rev: 1,
        term: pick(["Hetzner", "Anika", "Kubernetes", "Zebulon"]),
        heard: [heard],
        by: "user",
        ...(r() < 0.5 ? { segs: [pick(lines)], nth: 0 } : {}),
      });
    }
  }
  return b.events;
}

/** Everything a surface reads from a view, as one comparable value. */
function snapshot(v: CallView): string {
  return JSON.stringify({
    best: v.lines("best", { includeRetracted: true, includeEcho: true }),
    live: v.lines("live"),
    roster: v.roster(),
    notes: v.notes(),
    vocab: v.callVocabulary(),
    parts: v.parts(),
  });
}

const options = { isDictionaryWord };

/** A snapshot with revision numbers and seqs left out: writing the same thing again moves only those. */
const bare = (v: CallView) => snapshot(v).replace(/"(rev|seq)":\d+/g, "");

describe("the log reader, on any truncation of a generated log (TS-22)", () => {
  test("never throws, and keeps every line whose newline is on disk", () => {
    for (const seed of SEEDS) {
      const events = generate(seed);
      const bytes = new TextEncoder().encode(jsonl(events));
      const ends: number[] = [];
      bytes.forEach((x, i) => {
        if (x === 0x0a) ends.push(i + 1);
      });
      const r = rng(seed * 7919);
      const cuts = new Set<number>([0, bytes.length]);
      for (const e of ends) for (const d of [-1, 0, 1]) cuts.add(e + d);
      for (let i = 0; i < 60; i++) cuts.add(Math.floor(r() * bytes.length));
      for (const k of cuts) {
        if (k < 0 || k > bytes.length) continue;
        const kept = ends.filter((e) => e <= k).length;
        const at = `seed ${seed}, cut at byte ${k} of ${bytes.length}`;
        const got = parseLog(bytes.subarray(0, k));
        expect(got.events, at).toEqual(events.slice(0, kept));
        expect(got.invalid, at).toEqual([]);
        expect(got.committedBytes, at).toBe(kept === 0 ? 0 : (ends[kept - 1] as number));
        expect(got.torn === null, at).toBe(k === 0 || ends.includes(k));
      }
    }
  });

  test("a torn tail of random bytes (power loss) loses only itself", () => {
    for (const seed of SEEDS) {
      const events = generate(seed);
      const good = new TextEncoder().encode(jsonl(events));
      const r = rng(seed * 104729);
      for (let i = 0; i < 20; i++) {
        // One tail in four did get its newline: a final line that is not JSON is still torn. It
        // starts with a zero byte (a block of zeros after power loss), so it never parses as JSON.
        const landed = i % 4 === 3;
        const junk = Uint8Array.from({ length: (landed ? 2 : 1) + Math.floor(r() * 300) }, () => {
          const x = Math.floor(r() * 256);
          return x === 0x0a ? 0 : x;
        });
        if (landed) {
          junk[0] = 0;
          junk[junk.length - 1] = 0x0a;
        }
        const bytes = new Uint8Array(good.length + junk.length);
        bytes.set(good);
        bytes.set(junk, good.length);
        const got = parseLog(bytes);
        expect(got.events, `seed ${seed}, junk ${i}`).toEqual(events);
        expect(got.invalid, `seed ${seed}, junk ${i}`).toEqual([]);
        expect(got.torn?.offset, `seed ${seed}, junk ${i}`).toBe(good.length);
        expect(got.torn?.reason, `seed ${seed}, junk ${i}`).toBe(
          landed ? "unparseable" : "no-newline",
        );
      }
    }
  });
});

describe("the fold of a generated log (TS-22)", () => {
  test("equals the fold of the same events written and read back", () => {
    for (const seed of SEEDS) {
      const events = generate(seed);
      const reread = parseLog(jsonl(events));
      expect(reread.invalid, `seed ${seed}`).toEqual([]);
      expect(snapshot(fold(reread.events, options)), `seed ${seed}`).toBe(
        snapshot(fold(events, options)),
      );
    }
  });

  test("built one event at a time, read in between, equals the fold of the whole log", () => {
    for (const seed of SEEDS) {
      const events = generate(seed);
      const r = rng(seed * 31);
      const v = new CallView(options);
      for (const e of events) {
        v.apply(e);
        // Reads fill the render cache; a later event must invalidate what it changes.
        if (r() < 0.3) snapshot(v);
      }
      expect(snapshot(v), `seed ${seed}`).toBe(snapshot(fold(events, options)));
    }
  });

  test("a correction applied twice reads the same as once; positive control: once changes the line", () => {
    for (const seed of SEEDS) {
      const events = generate(seed);
      const before = fold(events, options);
      const line = before.lines("live").find((l) => /\b(should|move|cluster)\b/.test(l.raw ?? ""));
      if (!line) continue;
      const heard = /\b(should|move|cluster)\b/.exec(line.raw as string)?.[0] as string;
      const b = new LogBuilder();
      for (const e of events) b.add(e, e.t);
      const fix = { type: "vocab.add" as const, id: "vfix", term: "Zebulon", by: "user" };
      b.add({ ...fix, rev: 1, heard: [heard], segs: [line.id], nth: 0 });
      const once = fold(b.events, options);
      expect(once.resolve(line.id)?.text, `seed ${seed}`).not.toBe(line.text);
      b.add({ ...fix, rev: 2, heard: [heard], segs: [line.id], nth: 0 });
      expect(bare(fold(b.events, options)), `seed ${seed}`).toBe(bare(once));

      // The same hand edit of a line, written twice.
      const c = new LogBuilder();
      for (const e of b.events) c.add(e, e.t);
      const rev = (before.segment(line.id)?.rev ?? 1) + 1;
      c.add({ type: "seg", id: line.id, rev, text: "we agreed", by: "user" });
      const edited = fold(c.events, options);
      expect(edited.resolve(line.id)?.raw, `seed ${seed}`).toBe("we agreed");
      c.add({ type: "seg", id: line.id, rev: rev + 1, text: "we agreed", by: "user" });
      expect(bare(fold(c.events, options)), `seed ${seed}`).toBe(bare(edited));
    }
  });
});
