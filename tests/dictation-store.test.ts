/**
 * The dictation log (src/main/dictation/store.ts): append-only, `seq` gap-free across restarts, a
 * torn last line cut at open and a bad complete line kept but skipped, the rules of the call log.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { DictationLog, newDictationId } from "../src/main/dictation/store.ts";
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
    expect(readFileSync(log.path, "utf8")).toBe("");
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
