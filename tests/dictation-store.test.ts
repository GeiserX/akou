/**
 * The dictation log (src/main/dictation/store.ts): append-only, `seq` gap-free across restarts, a
 * torn last line cut at open and a bad complete line kept but skipped, the rules of the call log.
 * Deleting (DC-H2) is the one rewrite: a tombstone stays, the dictation's text leaves the disk.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { DictationItem } from "../src/core/dictation/events.ts";
import { DictationLog, expiredDictations, newDictationId } from "../src/main/dictation/store.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function dir(): string {
  const t = tempDir("akou-dict-");
  cleanups.push(t.cleanup);
  return t.dir;
}

const TARGET = { app: "com.example.editor", pid: 1, window: "w1", field: "editable" as const };

function dictate(log: DictationLog, id: string, text: string): void {
  log.append({ type: "dictation.started", id, target: TARGET, engine: "fast", by: "user" });
  log.append({ type: "dictation.ended", id, reason: "release", seconds: 1.2 });
  log.append({
    type: "dictation.text",
    id,
    raw: text,
    text,
    language: "en",
    words: [],
    engine: "fast",
    model: "fake-parakeet",
    ms: 12,
  });
  log.append({ type: "dictation.inserted", id, method: "paste", receipt_ms: 30 });
}

describe("the dictation log", () => {
  test("events fold into dictations, newest first, and seq is gap-free across a reopen", () => {
    const d = dir();
    let t = 1000;
    const a = new DictationLog(d, () => t++);
    dictate(a, "da", "hello world");
    a.close();
    const b = new DictationLog(d, () => t++);
    dictate(b, "db", "thanks");
    expect(b.events().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(b.items().map((i) => [i.id, i.state, i.text])).toEqual([
      ["db", "inserted", "thanks"],
      ["da", "inserted", "hello world"],
    ]);
    expect(b.item("da")).toMatchObject({ target: TARGET, seconds: 1.2, model: "fake-parakeet" });
    b.close();
  });

  test("the file is only ever appended to", () => {
    const d = dir();
    const log = new DictationLog(d);
    dictate(log, "da", "one");
    const before = readFileSync(log.path, "utf8");
    dictate(log, "db", "two");
    expect(readFileSync(log.path, "utf8").startsWith(before)).toBe(true);
    log.close();
  });

  test("a torn last line is cut at open; a bad complete line is kept and skipped", () => {
    const d = dir();
    const log = new DictationLog(d);
    dictate(log, "da", "one");
    log.close();
    appendFileSync(log.path, '{"v":1,"seq":5,"t":1,"type":"dictation.nonsense","id":"x"}\n');
    const torn = '{"v":1,"seq":6,"t":1,"type":"dicta';
    appendFileSync(log.path, torn);
    const again = new DictationLog(d);
    expect(again.report).toEqual({ truncated: torn.length, invalidLines: 1 });
    expect(readFileSync(log.path, "utf8").endsWith("\n")).toBe(true);
    expect(readFileSync(log.path, "utf8")).toContain("dictation.nonsense");
    // The next event follows the last good one.
    dictate(again, "db", "two");
    expect(again.events().at(-1)?.seq).toBe(8);
    again.close();
  });

  test("a malformed event is refused and nothing is written", () => {
    const d = dir();
    const log = new DictationLog(d);
    expect(() =>
      log.append({ type: "dictation.ended", id: "bad id!", reason: "release", seconds: 1 }),
    ).toThrow(/bad dictation event/);
    // The max-length warning's second is a number or absent (DC-A3).
    const warned = { type: "dictation.ended", id: "d1", reason: "max", seconds: 1 } as const;
    expect(() => log.append({ ...warned, warned: "soon" as unknown as number })).toThrow(
      /bad dictation event/,
    );
    expect(readFileSync(log.path, "utf8")).toBe("");
    // Positive control: a number is taken.
    log.append({ ...warned, warned: 0.5 });
    expect(readFileSync(log.path, "utf8")).toContain('"warned":0.5');
    log.close();
  });

  test("a last line that ends in a newline but is not JSON is torn too", () => {
    const d = dir();
    writeFileSync(`${d}/events.jsonl`, "not json\n");
    const log = new DictationLog(d);
    expect(log.report.truncated).toBe(9);
    log.close();
  });

  test("ids are unique and time-ordered", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newDictationId(1_700_000_000_000)));
    expect(ids.size).toBe(200);
    expect(newDictationId(2) > newDictationId(1)).toBe(true);
  });
});

describe("DC-H2: deleting a dictation", () => {
  test("forget leaves a tombstone, takes the text off the disk, and keeps the others", () => {
    const d = dir();
    let t = 1000;
    const log = new DictationLog(d, () => t++);
    dictate(log, "da", "secret words");
    dictate(log, "db", "keep me");
    expect(log.forget(["da", "dnope"])).toEqual(["da"]);
    const file = readFileSync(log.path, "utf8");
    expect(file).not.toContain("secret words");
    expect(file).toContain("keep me");
    expect(file).toContain('"type":"dictation.deleted","id":"da"');
    expect(log.items().map((i) => i.id)).toEqual(["db"]);
    expect(log.item("da")).toBeNull();
    // `seq` keeps rising past the gap the deleted dictation left.
    dictate(log, "dc", "after");
    expect(log.events().map((e) => e.seq)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13]);
    log.close();
    const again = new DictationLog(d);
    expect(again.items().map((i) => i.id)).toEqual(["dc", "db"]);
    expect(again.report).toEqual({ truncated: 0, invalidLines: 0 });
    again.close();
  });

  test("a deleted dictation takes nothing more: an event that arrives later is dropped", () => {
    const d = dir();
    const log = new DictationLog(d);
    log.append({ type: "dictation.started", id: "da", target: null, engine: "fast", by: "user" });
    log.forget(["da"]);
    expect(log.append({ type: "dictation.empty", id: "da" })).toBeNull();
    expect(readFileSync(log.path, "utf8")).not.toContain("dictation.empty");
    expect(log.forget(["da"])).toEqual([]);
    log.close();
  });

  test("a crash between the tombstone and the rewrite is finished at the next open", () => {
    const d = dir();
    const log = new DictationLog(d);
    dictate(log, "da", "secret words");
    log.close();
    const tomb = { v: 1, seq: 5, t: 1, type: "dictation.deleted", id: "da" };
    appendFileSync(log.path, `${JSON.stringify(tomb)}\n`);
    const again = new DictationLog(d);
    expect(readFileSync(log.path, "utf8")).toBe(`${JSON.stringify(tomb)}\n`);
    expect(again.items()).toEqual([]);
    again.close();
  });

  test("positive control: without the tombstone the text stays on the disk", () => {
    const d = dir();
    const log = new DictationLog(d);
    dictate(log, "da", "secret words");
    log.close();
    new DictationLog(d).close();
    expect(readFileSync(log.path, "utf8")).toContain("secret words");
  });
});

describe("DC-H2: what dictation.retainDays deletes", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const item = (id: string, at: number, state: DictationItem["state"] = "inserted") =>
    ({ id, at, state }) as DictationItem;
  const now = 100 * DAY;

  test("past the days, whatever the state; within them, nothing", () => {
    const items = [
      item("d3", now - DAY),
      item("d2", now - 31 * DAY, "transcribing"),
      item("d1", now - 40 * DAY),
    ];
    expect(expiredDictations(items, now, 30)).toEqual(["d2", "d1"]);
    expect(expiredDictations(items, now, 60)).toEqual([]);
  });

  test("0 keeps the newest and any still being decoded or inserted", () => {
    const items = [item("d3", now), item("d2", now - 5, "inserting"), item("d1", now - 9)];
    expect(expiredDictations(items, now, 0)).toEqual(["d1"]);
    expect(expiredDictations([item("d1", now)], now, 0)).toEqual([]);
  });
});
