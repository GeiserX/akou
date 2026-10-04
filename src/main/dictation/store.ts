/**
 * The dictation log (docs/ux/DICTATION.md section 10): `dictation/events.jsonl` under the config
 * folder, append-only, with the rules of the call log's writer (docs/DESIGN.md section 4.1): one
 * `write` per line, `seq` gap-free from 1, `t` the wall clock at write, nothing already written ever
 * changed, and a torn last line (no newline, or not JSON) truncated when the log is opened. A
 * complete line that fails validation is kept and skipped. The app holds the app lock, so this
 * process is the log's one writer.
 *
 * Every line is synced at once: dictations are rare, and a dictation the user just saw inserted
 * must survive a crash a second later.
 *
 * Deleting is the one exception to append-only (DC-H2): a deleted dictation's text must be gone
 * from the disk, not only hidden. `forget` appends a `dictation.deleted` tombstone, then writes the
 * log again without that dictation's other events (a new file renamed over the old one), so `seq`
 * keeps rising and a gap in it is a deleted dictation. A crash between the two is finished at the
 * next open. An event for a deleted dictation that arrives later (a decode still running) is
 * dropped.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  checkDictationDraft,
  checkDictationEvent,
  type DictationDraft,
  type DictationEvent,
  type DictationItem,
  foldDictations,
} from "../../core/dictation/events.ts";

export const DICTATION_DIR = "dictation";
export const DICTATION_EVENTS = "events.jsonl";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The states a dictation ends in; one in another state is still being decoded or inserted. */
export const FINAL: ReadonlySet<DictationItem["state"]> = new Set([
  "done",
  "inserted",
  "drafted",
  "discarded",
  "cancelled",
  "empty",
  "failed",
]);

/**
 * The dictations `dictation.retainDays` deletes now (DC-H2), from `items` newest first: those
 * started more than `days` ago; with 0, every finished one but the newest, which paste last and fix
 * last still need.
 */
export function expiredDictations(
  items: readonly DictationItem[],
  now: number,
  days: number,
): string[] {
  if (days > 0) return items.filter((it) => it.at < now - days * DAY_MS).map((it) => it.id);
  return items
    .slice(1)
    .filter((it) => FINAL.has(it.state))
    .map((it) => it.id);
}

/**
 * A new dictation id: time-ordered, unique across runs. 64 random bits after the millisecond, so
 * ids made in the same millisecond never meet (24 bits collided once in about 840 runs of 200).
 */
export function newDictationId(now: number): string {
  return `d${now.toString(36)}${randomBytes(8).toString("hex")}`;
}

export interface LogOpenReport {
  /** Bytes of a torn last line cut at open. */
  truncated: number;
  invalidLines: number;
}

export class DictationLog {
  private all: DictationEvent[] = [];
  /** Dictations with a tombstone: nothing more of theirs is written. */
  private readonly deleted = new Set<string>();
  private seq = 0;
  private fd: number | null;
  readonly path: string;
  readonly report: LogOpenReport;

  constructor(
    readonly dir: string,
    // clock: the default of an injected clock; tests pass their own.
    private readonly now: () => number = () => Date.now(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, DICTATION_EVENTS);
    this.report = this.load();
    this.fd = openSync(this.path, "a", 0o600);
    // A crash after a tombstone and before the rewrite: finish it now.
    if (this.all.some((e) => e.type !== "dictation.deleted" && this.deleted.has(e.id))) {
      this.rewrite();
    }
  }

  /** Called with every event appended. */
  onAppend: ((e: DictationEvent) => void) | null = null;

  private load(): LogOpenReport {
    const report = { truncated: 0, invalidLines: 0 };
    if (!existsSync(this.path)) return report;
    const buf = readFileSync(this.path);
    let end = buf.length;
    // A torn tail: everything after the last newline, or a last line that is not JSON.
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl !== buf.length - 1) end = lastNl + 1;
    const text = buf.subarray(0, end).toString("utf8");
    const lines = text.split("\n");
    lines.pop();
    const last = lines.at(-1);
    if (last !== undefined && !parses(last)) {
      end -= Buffer.byteLength(`${last}\n`);
      lines.pop();
    }
    if (end < buf.length) {
      truncateSync(this.path, end);
      report.truncated = buf.length - end;
    }
    for (const line of lines) {
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        report.invalidLines++;
        continue;
      }
      if (checkDictationEvent(o) !== null) {
        report.invalidLines++;
        continue;
      }
      const e = o as DictationEvent;
      this.all.push(e);
      if (e.type === "dictation.deleted") this.deleted.add(e.id);
      this.seq = Math.max(this.seq, e.seq);
    }
    return report;
  }

  /**
   * Appends one event and returns it; an event of a deleted dictation is dropped and null returned.
   * Throws on a malformed draft or a closed log.
   */
  append(draft: DictationDraft): DictationEvent | null {
    const bad = checkDictationDraft(draft as unknown as Record<string, unknown>);
    if (bad !== null) throw new Error(`a bad dictation event (${bad})`);
    if (this.fd === null) throw new Error("the dictation log is closed");
    if (this.deleted.has(draft.id)) return null;
    const e = { v: 1, seq: this.seq + 1, t: this.now(), ...draft } as DictationEvent;
    writeSync(this.fd, `${JSON.stringify(e)}\n`);
    fsyncSync(this.fd);
    this.seq = e.seq;
    this.all.push(e);
    if (e.type === "dictation.deleted") this.deleted.add(e.id);
    this.onAppend?.(e);
    return e;
  }

  /**
   * Deletes dictations (DC-H2): a tombstone each, then the log written again without their other
   * events. Ids the log does not hold, or holds deleted already, are skipped. Returns the ids
   * deleted.
   */
  forget(ids: Iterable<string>): string[] {
    const known = new Set(this.all.filter((e) => e.type === "dictation.started").map((e) => e.id));
    const gone: string[] = [];
    for (const id of new Set(ids)) {
      if (!known.has(id) || this.deleted.has(id)) continue;
      this.append({ type: "dictation.deleted", id });
      gone.push(id);
    }
    if (gone.length > 0) this.rewrite();
    return gone;
  }

  /** Writes the log again without the events of deleted dictations, their tombstones kept. */
  private rewrite(): void {
    const keep = this.all.filter((e) => e.type === "dictation.deleted" || !this.deleted.has(e.id));
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, keep.map((e) => `${JSON.stringify(e)}\n`).join(""));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (this.fd !== null) closeSync(this.fd);
    renameSync(tmp, this.path);
    this.fd = openSync(this.path, "a", 0o600);
    this.all = keep;
  }

  events(): readonly DictationEvent[] {
    return this.all;
  }

  /** Every dictation, newest first. */
  items(): DictationItem[] {
    return foldDictations(this.all).reverse();
  }

  item(id: string): DictationItem | null {
    return foldDictations(this.all.filter((e) => e.id === id))[0] ?? null;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}
