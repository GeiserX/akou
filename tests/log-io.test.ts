import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventDraft } from "../src/core/log/events.ts";
import {
  compareLines,
  eventsAfter,
  parseLog,
  readLog,
  START_CURSOR,
  tail,
} from "../src/core/log/reader.ts";
import {
  EVENTS_FILE,
  LOCK_FILE,
  LockError,
  LogWriteError,
  LogWriter,
  processAlive,
  type Timers,
} from "../src/core/log/writer.ts";
import { jsonl, LogBuilder, T0, tempDir } from "./helpers.ts";

const created: EventDraft = {
  type: "call.created",
  id: "01J8Z6Q4M2VX0K7B3D4E5F6G7H",
  schema: 1,
  workspace: "work",
  title: "Weekly sync",
  tz: "America/Chicago",
  user: "Ana",
  akou: "0.1.0",
};

const segDraft = (id: string, text = "hello there"): EventDraft => ({
  type: "seg",
  id,
  rev: 1,
  layer: "live",
  part: 1,
  ch: "call",
  spk: "c1",
  a0: 0,
  a1: 1,
  w0: T0,
  w1: T0 + 1000,
  text,
  model: "m",
});

const partDraft = (part: number): EventDraft => ({
  type: "part.started",
  part,
  file: `audio/part-00${part}.opus`,
  wallStart: T0,
  monoStart: 1000,
  mic: "mic",
  call: { mode: "system" },
  capture: "akou-capture 0.1.0",
});

/** A manual timer so fsync scheduling is observable without real time passing. */
function manualTimers(): Timers & { fire(): void; pending(): number } {
  let queue: Array<() => void> = [];
  return {
    set(fn) {
      queue.push(fn);
      return fn;
    },
    clear(h) {
      queue = queue.filter((f) => f !== h);
    },
    fire() {
      const q = queue;
      queue = [];
      for (const f of q) f();
    },
    pending: () => queue.length,
  };
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function callDir(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

function open(dir: string, opts: Parameters<typeof LogWriter.open>[1] = {}): LogWriter {
  const w = LogWriter.open(dir, opts);
  cleanups.unshift(() => w.close());
  return w;
}

describe("writer (DESIGN 4.1, 4.2)", () => {
  test("assigns gap-free seq from 1 and t from the wall clock", async () => {
    const dir = callDir();
    let now = T0;
    const w = open(dir, { now: () => now++ });
    w.append(created);
    w.append(partDraft(1));
    w.append(segDraft("l000001"));
    w.close();
    const r = await readLog(join(dir, EVENTS_FILE));
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r.events.map((e) => e.t)).toEqual([T0, T0 + 1, T0 + 2]);
    expect(r.seqErrors).toEqual([]);
    expect(r.torn).toBeNull();
  });

  test("every line is one JSON object with seq, t and type first", () => {
    const dir = callDir();
    const w = open(dir);
    w.append(created);
    w.append(segDraft("l000001", 'a "quoted"\nline'));
    w.close();
    const lines = readFileSync(join(dir, EVENTS_FILE), "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(Object.keys(JSON.parse(lines[1] as string)).slice(0, 3)).toEqual(["seq", "t", "type"]);
  });

  test("the caller cannot choose seq or t", () => {
    const dir = callDir();
    const w = open(dir, { now: () => 7 });
    const e = w.append({ ...created, seq: 99, t: 1 } as unknown as EventDraft);
    expect(e.seq).toBe(1);
    expect(e.t).toBe(7);
  });

  test("the first event must be call.created, and only the first", () => {
    const dir = callDir();
    const w = open(dir);
    expect(() => w.append(partDraft(1))).toThrow(LogWriteError);
    w.append(created);
    expect(() => w.append(created)).toThrow(LogWriteError);
    expect(w.lastSeq).toBe(1);
  });

  test("an invalid event is refused and nothing is written", () => {
    const dir = callDir();
    const w = open(dir);
    w.append(created);
    const before = readFileSync(join(dir, EVENTS_FILE));
    expect(() => w.append({ type: "note", id: "n1" } as unknown as EventDraft)).toThrow(
      LogWriteError,
    );
    expect(() => w.append({ type: "partial", text: "x" } as unknown as EventDraft)).toThrow(
      /unknown event type/,
    );
    expect(readFileSync(join(dir, EVENTS_FILE))).toEqual(before);
    expect(w.lastSeq).toBe(1);
  });

  test("nothing is rewritten: every earlier byte stays a prefix of the file", () => {
    const dir = callDir();
    const w = open(dir);
    w.append(created);
    w.append(segDraft("l000001", "first words"));
    const snapshot = readFileSync(join(dir, EVENTS_FILE));
    // A correction is a new event with a higher rev, never an edit of the old line.
    w.append({ type: "seg", id: "l000001", rev: 2, text: "first word", by: "user" });
    w.close();
    const after = readFileSync(join(dir, EVENTS_FILE));
    expect(after.subarray(0, snapshot.length)).toEqual(snapshot);
    expect(after.length).toBeGreaterThan(snapshot.length);
  });

  test("fsync at every lifecycle event, and within one interval for anything else", () => {
    const dir = callDir();
    const timers = manualTimers();
    const w = open(dir, { timers });
    w.append(created);
    expect(w.stats.syncs).toBe(1);
    w.append(segDraft("l000001"));
    w.append(segDraft("l000002"));
    expect(w.stats.syncs).toBe(1);
    expect(timers.pending()).toBe(1); // one deferred sync, however many appends
    timers.fire();
    expect(w.stats.syncs).toBe(2);
    w.append(segDraft("l000003"));
    w.append(partDraft(1)); // lifecycle: synced at once, and the pending timer is dropped
    expect(w.stats.syncs).toBe(3);
    expect(timers.pending()).toBe(0);
  });

  test("close syncs, releases the lock, and refuses later appends", () => {
    const dir = callDir();
    const timers = manualTimers();
    const w = LogWriter.open(dir, { timers });
    w.append(created);
    w.append(segDraft("l000001"));
    w.close();
    expect(w.stats.syncs).toBe(2);
    expect(readdirSync(dir)).not.toContain(LOCK_FILE);
    expect(() => w.append(segDraft("l000002"))).toThrow(LogWriteError);
  });

  test("reopening continues the sequence", async () => {
    const dir = callDir();
    const w1 = LogWriter.open(dir);
    w1.append(created);
    w1.append(partDraft(1));
    w1.close();
    const w2 = open(dir);
    expect(w2.lastSeq).toBe(2);
    expect(w2.append(segDraft("l000001")).seq).toBe(3);
    w2.close();
    expect((await readLog(join(dir, EVENTS_FILE))).seqErrors).toEqual([]);
  });

  test("[Two writers]: a second writer on the same folder refuses (.akou.lock)", () => {
    const dir = callDir();
    const first = open(dir);
    first.append(created);
    expect(() => LogWriter.open(dir)).toThrow(LockError);
    try {
      LogWriter.open(dir);
    } catch (err) {
      expect((err as LockError).holderPid).toBe(process.pid);
    }
    // The refused writer changed nothing.
    expect(first.append(partDraft(1)).seq).toBe(2);
    // Positive control: once the first writer is gone, a writer is accepted, so the refusal
    // above came from the lock and not from something that always fails.
    first.close();
    const second = open(dir);
    expect(second.lastSeq).toBe(2);
  });

  test("[Two writers]: the lock holds the writer's pid", () => {
    const dir = callDir();
    open(dir, { pid: 4242, isAlive: () => true });
    expect(readFileSync(join(dir, LOCK_FILE), "utf8").trim()).toBe("4242");
  });

  test("a lock left by a dead process is taken over (crash recovery)", async () => {
    const dir = callDir();
    const child = Bun.spawn([process.execPath, "--version"], { stdout: "ignore" });
    await child.exited;
    expect(processAlive(child.pid)).toBe(false);
    writeFileSync(join(dir, LOCK_FILE), `${child.pid}\n`);
    const w = open(dir);
    expect(w.report.staleLockPid).toBe(child.pid);
    expect(readFileSync(join(dir, LOCK_FILE), "utf8").trim()).toBe(String(process.pid));
  });

  test("[Two writers]: two writers taking over the same stale lock at once cannot both win", () => {
    const dir = callDir();
    const stale = 999_001;
    writeFileSync(join(dir, LOCK_FILE), `${stale}\n`);
    let first: LogWriter | null = null;
    // B reads the stale pid, then, before B acts on it, A takes the lock over completely.
    const openB = () =>
      LogWriter.open(dir, {
        pid: 2002,
        isAlive: (pid) => {
          if (pid === stale && first === null) {
            first = open(dir, { pid: 1001, isAlive: (p) => p !== stale });
          }
          return pid !== stale;
        },
      });
    expect(openB).toThrow(LockError);
    expect(first).not.toBeNull();
    expect(readFileSync(join(dir, LOCK_FILE), "utf8").trim()).toBe("1001");
    expect(readdirSync(dir).sort()).toEqual([LOCK_FILE, EVENTS_FILE].sort());
  });

  test("[Two writers]: a writer whose stale lock was taken over does not remove the new holder's lock", () => {
    const dir = callDir();
    const a = LogWriter.open(dir, { pid: 1001, isAlive: () => true });
    // B judges 1001 dead and takes the lock over.
    const b = open(dir, { pid: 1002, isAlive: () => false });
    expect(b.report.staleLockPid).toBe(1001);
    a.close();
    expect(readFileSync(join(dir, LOCK_FILE), "utf8").trim()).toBe("1002");
    // Positive control: the holder's own close does remove it.
    b.close();
    expect(readdirSync(dir)).not.toContain(LOCK_FILE);
  });

  test("processAlive: this process is alive, nonsense pids are not", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-5)).toBe(false);
  });

  test("[F2.50] Torn last line: the writer truncates it at the next open", async () => {
    const dir = callDir();
    const w1 = LogWriter.open(dir);
    w1.append(created);
    w1.append(partDraft(1));
    w1.close();
    const good = readFileSync(join(dir, EVENTS_FILE));
    const torn = '{"seq":3,"t":1,"type":"seg","id":"l0';
    appendFileSync(join(dir, EVENTS_FILE), torn);
    const w2 = open(dir);
    expect(w2.report.truncated).toEqual({
      offset: good.length,
      bytes: torn.length,
      reason: "no-newline",
    });
    expect(readFileSync(join(dir, EVENTS_FILE))).toEqual(good);
    expect(w2.append(segDraft("l000001")).seq).toBe(3);
    w2.close();
    const r = await readLog(join(dir, EVENTS_FILE));
    expect(r.torn).toBeNull();
    expect(r.seqErrors).toEqual([]);
    expect(r.events).toHaveLength(3);
  });

  test("[F2.50] Torn last line: garbage after the last newline (power loss) is truncated too", () => {
    const dir = callDir();
    const w1 = LogWriter.open(dir);
    w1.append(created);
    w1.close();
    const good = readFileSync(join(dir, EVENTS_FILE));
    appendFileSync(join(dir, EVENTS_FILE), "\u0000\u0000\u0000\n");
    const w2 = open(dir);
    expect(w2.report.truncated?.reason).toBe("unparseable");
    expect(readFileSync(join(dir, EVENTS_FILE))).toEqual(good);
  });

  test("a complete last line from a newer schema is kept, skipped and counted, never truncated", async () => {
    const dir = callDir();
    const w1 = LogWriter.open(dir);
    w1.append(created);
    w1.append(partDraft(1));
    w1.close();
    const future = `${JSON.stringify({ seq: 3, t: T0, type: "seg.future", id: "x" })}\n`;
    appendFileSync(join(dir, EVENTS_FILE), future);
    const before = readFileSync(join(dir, EVENTS_FILE));
    const w2 = open(dir);
    expect(w2.report.truncated).toBeNull();
    expect(w2.report.invalidLines).toBe(1);
    expect(readFileSync(join(dir, EVENTS_FILE))).toEqual(before);
    // The writer continues after the kept line's seq, never reusing it.
    expect(w2.lastSeq).toBe(3);
    expect(w2.append(segDraft("l000001")).seq).toBe(4);
    w2.close();
    const r = await readLog(join(dir, EVENTS_FILE));
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(r.invalid).toHaveLength(1);
    expect(r.torn).toBeNull();
    expect(r.seqErrors).toEqual([]);
  });

  test("[T3.13] Disk reads give part 1 only: a multi-part call writes one log and no per-part transcript", () => {
    const dir = callDir();
    const w = LogWriter.open(dir);
    w.append(created);
    w.append(partDraft(1));
    w.append(segDraft("l000001"));
    w.append({ type: "part.ended", part: 1, reason: "restart", fileSeconds: 30 });
    w.append(partDraft(2));
    w.append({ ...segDraft("l000002"), part: 2 } as EventDraft);
    expect(readdirSync(dir).sort()).toEqual([LOCK_FILE, EVENTS_FILE].sort());
    w.close();
    expect(readdirSync(dir)).toEqual([EVENTS_FILE]);
  });
});

describe("reader (DESIGN 4.2, 4.5)", () => {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.seg({ id: "l000001", text: "one" });
  b.seg({ id: "l000002", text: "two" });
  const whole = jsonl(b.events);

  test("reads every committed event", () => {
    const r = parseLog(whole);
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(r.torn).toBeNull();
    expect(r.invalid).toEqual([]);
    expect(r.committedBytes).toBe(new TextEncoder().encode(whole).length);
  });

  test("[F2.50] Torn last line: readers ignore a truncated final line and report it", () => {
    const chopped = whole.slice(0, whole.length - 20);
    const r = parseLog(chopped);
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r.torn?.reason).toBe("no-newline");
    expect(r.invalid).toEqual([]);
    // Chopping at every byte of the last line never yields a bad event or an exception.
    const lastStart = whole.lastIndexOf("\n", whole.length - 2) + 1;
    for (let cut = lastStart + 1; cut < whole.length; cut++) {
      const x = parseLog(whole.slice(0, cut));
      expect(x.events).toHaveLength(3);
      expect(x.torn).not.toBeNull();
    }
  });

  test("[F2.50] positive control: a broken line in the middle is not silently treated as torn", () => {
    const lines = whole.split("\n");
    lines[1] = (lines[1] as string).slice(0, 15);
    const r = parseLog(lines.join("\n"));
    expect(r.torn).toBeNull();
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0]?.line).toBe(2);
    expect(r.seqErrors).toEqual(["line 3: seq jumps from 1 to 3"]);
  });

  test("a valid-JSON line that fails validation is invalid wherever it sits, and its seq counts", () => {
    const future = { seq: 5, t: T0, type: "seg.future", id: "x" };
    const last = parseLog(`${whole}${JSON.stringify(future)}\n`);
    expect(last.torn).toBeNull();
    expect(last.invalid).toHaveLength(1);
    expect(last.lastSeq).toBe(5);
    expect(last.seqErrors).toEqual([]);
    const next = { ...(b.events[3] as object), seq: 6 };
    const middle = parseLog(`${whole}${JSON.stringify(future)}\n${JSON.stringify(next)}\n`);
    expect(middle.torn).toBeNull();
    expect(middle.invalid).toHaveLength(1);
    expect(middle.seqErrors).toEqual([]);
    expect(middle.lastSeq).toBe(6);
    // A tailer consumes it the same way.
    const dir = callDir();
    const path = join(dir, EVENTS_FILE);
    writeFileSync(path, `${whole}${JSON.stringify(future)}\n`);
    const t = tail(path);
    expect(t.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(t.invalid).toHaveLength(1);
    expect(t.seqErrors).toEqual([]);
  });

  test("a missing file reads as empty", async () => {
    const r = await readLog(join(callDir(), "nope.jsonl"));
    expect(r.events).toEqual([]);
  });

  test("seq problems are reported: gaps, repeats, and a first event that is not call.created", () => {
    const [e1, e2, e3] = b.events;
    expect(parseLog(jsonl([e1, e3])).seqErrors).toHaveLength(1);
    expect(parseLog(jsonl([e1, e2, e2])).seqErrors).toHaveLength(1);
    expect(parseLog(jsonl([{ ...e2, seq: 1 }])).seqErrors[0]).toMatch(/call\.created/);
  });

  test("eventsAfter returns events past a cursor", () => {
    expect(eventsAfter(b.events, 2).map((e) => e.seq)).toEqual([3, 4]);
    expect(eventsAfter(b.events, 4)).toEqual([]);
  });

  test("tail: follows a growing file from a cursor and leaves a partial line pending", () => {
    const dir = callDir();
    const path = join(dir, EVENTS_FILE);
    const [l1, l2, l3, l4] = whole.split("\n").map((l) => `${l}\n`);
    writeFileSync(path, `${l1}${l2}`);
    const first = tail(path);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.pending).toBeNull();

    // Half a line written: not delivered, cursor stays at the line boundary.
    appendFileSync(path, (l3 as string).slice(0, 10));
    const second = tail(path, first.cursor);
    expect(second.events).toEqual([]);
    expect(second.pending?.bytes).toBe(10);
    expect(second.cursor).toEqual(first.cursor);

    // The rest of the line lands, plus another.
    appendFileSync(path, `${(l3 as string).slice(10)}${l4}`);
    const third = tail(path, second.cursor);
    expect(third.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(third.cursor.seq).toBe(4);
    expect(third.seqErrors).toEqual([]);
    expect(tail(path, third.cursor).events).toEqual([]);
  });

  test("tail: a cursor holding only a seq resumes after that seq", () => {
    const dir = callDir();
    const path = join(dir, EVENTS_FILE);
    writeFileSync(path, whole);
    const r = tail(path, { ...START_CURSOR, seq: 2 });
    expect(r.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(r.seqErrors).toEqual([]);
  });

  test("tail: a revision reaches a cursor holder as an ordinary new event", () => {
    const dir = callDir();
    const w = LogWriter.open(dir);
    cleanups.unshift(() => w.close());
    w.append(created);
    w.append(segDraft("l000001", "cubernetes"));
    const path = join(dir, EVENTS_FILE);
    const c1 = tail(path);
    w.append({ type: "seg", id: "l000001", rev: 2, text: "Kubernetes", by: "user" });
    const c2 = tail(path, c1.cursor);
    expect(c2.events).toHaveLength(1);
    expect(c2.events[0]).toMatchObject({ type: "seg", id: "l000001", rev: 2 });
  });

  test("[T1.42] Undefined order of simultaneous lines: same w0 orders mic before call, then seq", () => {
    const lines = [
      { id: "a", w0: 1000, ch: "call" as const, seq: 1 },
      { id: "b", w0: 1000, ch: "mic" as const, seq: 5 },
      { id: "c", w0: 1000, ch: "call" as const, seq: 3 },
      { id: "d", w0: 999, ch: "call" as const, seq: 9 },
      { id: "e", w0: 1000, ch: "mic" as const, seq: 2 },
    ];
    const sorted = [...lines].sort(compareLines).map((l) => l.id);
    expect(sorted).toEqual(["d", "e", "b", "a", "c"]);
    // Positive control: the fixture really distinguishes the rule from plain seq order and from a
    // time-only sort, so a regression to either would fail the assertion above.
    expect([...lines].sort((x, y) => x.seq - y.seq).map((l) => l.id)).not.toEqual(sorted);
    expect([...lines].sort((x, y) => x.w0 - y.w0).map((l) => l.id)).not.toEqual(sorted);
  });
});
