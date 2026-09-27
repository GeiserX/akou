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
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
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

/** A new dictation id: time-ordered, unique across runs. */
export function newDictationId(now: number): string {
  return `d${now.toString(36)}${randomBytes(3).toString("hex")}`;
}

export interface LogOpenReport {
  /** Bytes of a torn last line cut at open. */
  truncated: number;
  invalidLines: number;
}

export class DictationLog {
  private readonly all: DictationEvent[] = [];
  private seq = 0;
  private fd: number | null;
  readonly path: string;
  readonly report: LogOpenReport;

  constructor(
    readonly dir: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, DICTATION_EVENTS);
    this.report = this.load();
    this.fd = openSync(this.path, "a", 0o600);
  }

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
      this.seq = Math.max(this.seq, e.seq);
    }
    return report;
  }

  /** Appends one event and returns it. Throws on a malformed draft or a closed log. */
  append(draft: DictationDraft): DictationEvent {
    const bad = checkDictationDraft(draft as unknown as Record<string, unknown>);
    if (bad !== null) throw new Error(`a bad dictation event (${bad})`);
    if (this.fd === null) throw new Error("the dictation log is closed");
    const e = { v: 1, seq: this.seq + 1, t: this.now(), ...draft } as DictationEvent;
    writeSync(this.fd, `${JSON.stringify(e)}\n`);
    fsyncSync(this.fd);
    this.seq = e.seq;
    this.all.push(e);
    return e;
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
