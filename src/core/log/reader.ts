/**
 * Reading an event log (docs/DESIGN.md sections 4.2 and 4.5).
 *
 * A line is committed only once its newline is on disk. The last line of a file that has no
 * newline, or that does not parse, is a torn write (power loss or a write still in progress): it
 * is ignored and reported, never guessed at. The writer truncates it at the next open.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { type LogEvent, validateEvent } from "./events.ts";

export interface TornTail {
  /** Byte offset where the torn line starts; the committed log is everything before it. */
  offset: number;
  bytes: number;
  reason: "no-newline" | "unparseable";
}

export interface InvalidLine {
  /** 1-based line number. */
  line: number;
  offset: number;
  error: string;
}

export interface ReadResult {
  events: LogEvent[];
  /** Set when the file ends in a torn line, which was ignored. */
  torn: TornTail | null;
  /** Complete lines in the middle of the file that failed validation. They are skipped. */
  invalid: InvalidLine[];
  /** Sequence problems: a gap, a duplicate, or a first event that is not `call.created`. */
  seqErrors: string[];
  /** Byte length of the committed part of the input (up to and including the last good newline). */
  committedBytes: number;
}

const NL = 0x0a;
const decoder = new TextDecoder("utf-8", { fatal: false });

function parseLine(
  bytes: Uint8Array,
): { ok: true; event: LogEvent } | { ok: false; error: string } {
  const text = decoder.decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  const v = validateEvent(raw);
  return v.ok ? { ok: true, event: v.value } : { ok: false, error: v.error };
}

/**
 * Parses the bytes of a log. `baseOffset` and `firstLine` let a tailer parse a slice of a file
 * and still report absolute positions.
 */
export function parseLog(
  input: Uint8Array | string,
  opts: { baseOffset?: number; firstLine?: number; expectSeq?: number } = {},
): ReadResult {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const base = opts.baseOffset ?? 0;
  const events: LogEvent[] = [];
  const invalid: InvalidLine[] = [];
  const seqErrors: string[] = [];
  let torn: TornTail | null = null;
  let expect = opts.expectSeq ?? 1;
  let line = opts.firstLine ?? 1;
  let start = 0;
  let committed = 0;

  while (start < bytes.length) {
    const nl = bytes.indexOf(NL, start);
    if (nl === -1) {
      torn = { offset: base + start, bytes: bytes.length - start, reason: "no-newline" };
      break;
    }
    const slice = bytes.subarray(start, nl);
    const isLast = nl === bytes.length - 1;
    if (slice.length > 0) {
      const r = parseLine(slice);
      if (r.ok) {
        const ev = r.event;
        if (expect === 1 && ev.seq === 1 && ev.type !== "call.created") {
          seqErrors.push(`seq 1 is "${ev.type}", expected "call.created"`);
        }
        if (ev.seq !== expect) {
          seqErrors.push(
            ev.seq < expect
              ? `line ${line}: seq ${ev.seq} repeats or goes backwards (expected ${expect})`
              : `line ${line}: seq jumps from ${expect - 1} to ${ev.seq}`,
          );
        }
        expect = Math.max(expect, ev.seq + 1);
        events.push(ev);
      } else if (isLast) {
        // A final line that does not parse is a torn write even if a newline landed.
        torn = { offset: base + start, bytes: nl + 1 - start, reason: "unparseable" };
        break;
      } else {
        invalid.push({ line, offset: base + start, error: r.error });
      }
    }
    committed = nl + 1;
    start = nl + 1;
    line++;
  }

  return { events, torn, invalid, seqErrors, committedBytes: committed };
}

/** Reads a whole log file. A missing file reads as empty. */
export async function readLog(path: string): Promise<ReadResult> {
  const file = Bun.file(path);
  if (!(await file.exists())) return parseLog(new Uint8Array());
  return parseLog(new Uint8Array(await file.arrayBuffer()));
}

/** Committed events with `seq` greater than `afterSeq`, for a reader holding a cursor. */
export function eventsAfter(events: readonly LogEvent[], afterSeq: number): LogEvent[] {
  return events.filter((e) => e.seq > afterSeq);
}

export interface TailCursor {
  /** Byte offset of the first byte not yet consumed (always at a line boundary). */
  offset: number;
  /** Highest `seq` delivered so far. */
  seq: number;
  /** Line number of the next line. */
  line: number;
}

export const START_CURSOR: TailCursor = { offset: 0, seq: 0, line: 1 };

export interface TailResult {
  events: LogEvent[];
  cursor: TailCursor;
  invalid: InvalidLine[];
  seqErrors: string[];
  /** A trailing partial line that was left for the next poll. */
  pending: TornTail | null;
}

/**
 * Reads what was appended after `cursor`. A partial last line is not consumed: the next poll sees
 * it again once its newline has been written. Events with `seq <= cursor.seq` are dropped, so a
 * cursor built from a `seq` alone (offset 0) works too.
 */
export function tail(path: string, cursor: TailCursor = START_CURSOR): TailResult {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], cursor, invalid: [], seqErrors: [], pending: null };
  }
  if (size <= cursor.offset) {
    return { events: [], cursor, invalid: [], seqErrors: [], pending: null };
  }
  const buf = new Uint8Array(size - cursor.offset);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, cursor.offset + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  // Only complete lines are consumed; a partial last line stays pending for the next poll.
  const lastNl = buf.lastIndexOf(NL);
  const complete = lastNl === -1 ? buf.subarray(0, 0) : buf.subarray(0, lastNl + 1);
  const r = parseLog(complete, {
    baseOffset: cursor.offset,
    firstLine: cursor.line,
    // A cursor holding only a seq (offset 0) re-reads the file from the start.
    expectSeq: cursor.offset === 0 ? 1 : cursor.seq + 1,
  });
  const events = r.events.filter((e) => e.seq > cursor.seq);
  const invalid = [...r.invalid];
  if (r.torn) {
    // A newline-terminated line that does not parse, followed by nothing yet: report it.
    invalid.push({ line: -1, offset: r.torn.offset, error: `unparseable line (${r.torn.reason})` });
  }
  const consumedLines = countNewlines(complete);
  const last = events.at(-1);
  const pendingBytes = buf.length - complete.length;
  return {
    events,
    cursor: {
      offset: cursor.offset + complete.length,
      seq: last ? last.seq : cursor.seq,
      line: cursor.line + consumedLines,
    },
    invalid,
    seqErrors: r.seqErrors,
    pending:
      pendingBytes > 0
        ? { offset: cursor.offset + complete.length, bytes: pendingBytes, reason: "no-newline" }
        : null,
  };
}

function countNewlines(b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === NL) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Ordering

export interface Orderable {
  w0: number;
  ch: "mic" | "call";
  seq: number;
}

/**
 * The one sort order for simultaneous lines (DESIGN 4.4): wall time, then mic before call, then
 * `seq`. Every reader uses this function.
 */
export function compareLines(a: Orderable, b: Orderable): number {
  if (a.w0 !== b.w0) return a.w0 - b.w0;
  if (a.ch !== b.ch) return a.ch === "mic" ? -1 : 1;
  return a.seq - b.seq;
}
