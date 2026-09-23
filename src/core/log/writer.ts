/**
 * The single writer of a call's event log (docs/DESIGN.md sections 4.1, 4.2 and 4.5).
 *
 * - One writer per call folder, held by `.akou.lock` (the writer's pid). A second writer refuses
 *   while the holder is alive; a lock left by a dead process is taken over.
 * - The file is opened for append only. Nothing already written is ever changed; the only
 *   exception is a torn last line from a crash, which is truncated when the log is opened.
 * - One `write()` per line. `fsync` at every lifecycle event, and at most one second after any
 *   other append.
 * - `seq` is assigned here, gap-free from 1, and `t` is the wall clock at write.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { type EventDraft, LIFECYCLE_TYPES, type LogEvent, validateDraft } from "./events.ts";
import { parseLog, type TornTail } from "./reader.ts";

export const EVENTS_FILE = "events.jsonl";
export const LOCK_FILE = ".akou.lock";
export const SYNC_INTERVAL_MS = 1000;

export class LockError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holderPid: number,
  ) {
    super(`another writer (pid ${holderPid}) holds ${lockPath}`);
    this.name = "LockError";
  }
}

export class LogWriteError extends Error {
  override name = "LogWriteError";
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set(fn, ms) {
    const h = setTimeout(fn, ms);
    // A pending fsync must never keep the process alive on its own.
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear(h) {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface WriterOptions {
  /** Wall clock for `t`, epoch ms. */
  now?: () => number;
  /** Timers for the deferred fsync; tests inject a manual one. */
  timers?: Timers;
  syncIntervalMs?: number;
  /** The pid written into the lock file. */
  pid?: number;
  /** Is this pid alive? Used to tell a live holder from a stale lock. */
  isAlive?: (pid: number) => boolean;
}

export interface OpenReport {
  /** The torn last line that was truncated at open, if any. */
  truncated: TornTail | null;
  /** Complete lines that failed validation. They stay in the file and are skipped by readers. */
  invalidLines: number;
  seqErrors: string[];
  /** A stale lock left by a dead process that was taken over. */
  staleLockPid: number | null;
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Creates the lock atomically with its content: the pid is written to a private file which is then
 * hard-linked into place, and a link fails if the lock already exists.
 */
function tryCreateLock(lockPath: string, pid: number): boolean {
  const tmp = `${lockPath}.${pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, `${pid}\n`);
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

function acquireLock(
  lockPath: string,
  pid: number,
  isAlive: (pid: number) => boolean,
): number | null {
  if (tryCreateLock(lockPath, pid)) return null;
  const holder = readLockPid(lockPath);
  if (holder !== null && isAlive(holder)) throw new LockError(lockPath, holder);
  // The holder is gone (a crash): take the lock over. A racing writer that also saw the stale lock
  // loses at the link step below.
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!tryCreateLock(lockPath, pid)) {
    throw new LockError(lockPath, readLockPid(lockPath) ?? -1);
  }
  return holder ?? -1;
}

export class LogWriter {
  readonly path: string;
  readonly lockPath: string;
  readonly report: OpenReport;
  private fd: number;
  private seq: number;
  private dirty = false;
  private timer: unknown = null;
  private closed = false;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly syncIntervalMs: number;
  private readonly pid: number;
  /** Counters for tests and diagnostics. */
  readonly stats = { writes: 0, syncs: 0 };

  private constructor(dir: string, opts: WriterOptions) {
    this.path = join(dir, EVENTS_FILE);
    this.lockPath = join(dir, LOCK_FILE);
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.syncIntervalMs = opts.syncIntervalMs ?? SYNC_INTERVAL_MS;
    this.pid = opts.pid ?? process.pid;

    const staleLockPid = acquireLock(this.lockPath, this.pid, opts.isAlive ?? processAlive);
    try {
      let truncated: TornTail | null = null;
      let invalidLines = 0;
      let seqErrors: string[] = [];
      let last = 0;
      if (existsSync(this.path)) {
        const r = parseLog(new Uint8Array(readFileSync(this.path)));
        if (r.torn) {
          truncateSync(this.path, r.torn.offset);
          truncated = r.torn;
        }
        invalidLines = r.invalid.length;
        seqErrors = r.seqErrors;
        for (const e of r.events) last = Math.max(last, e.seq);
      }
      this.seq = last;
      this.fd = openSync(this.path, "a");
      if (truncated) fsyncSync(this.fd);
      this.report = { truncated, invalidLines, seqErrors, staleLockPid };
    } catch (err) {
      this.releaseLock();
      throw err;
    }
  }

  /** Opens (or creates) the log in a call folder and takes its lock. */
  static open(dir: string, opts: WriterOptions = {}): LogWriter {
    return new LogWriter(dir, opts);
  }

  /** The highest `seq` in the log. 0 for an empty log. */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * Validates, stamps and appends one event. Returns the event as written. The first event of a
   * log must be `call.created`, and only the first.
   */
  append(draft: EventDraft): LogEvent {
    if (this.closed) throw new LogWriteError("log writer is closed");
    const v = validateDraft(draft);
    if (!v.ok) throw new LogWriteError(`refused event: ${v.error}`);
    if (this.seq === 0 && draft.type !== "call.created") {
      throw new LogWriteError(`the first event must be call.created, got ${draft.type}`);
    }
    if (this.seq > 0 && draft.type === "call.created") {
      throw new LogWriteError("call.created may only be the first event");
    }
    // The envelope is the writer's: any seq or t the caller passed is dropped.
    const { type, seq: _seq, t: _t, ...body } = draft as { type: string } & Record<string, unknown>;
    const event = { seq: this.seq + 1, t: this.now(), type, ...body } as unknown as LogEvent;
    const bytes = new TextEncoder().encode(`${JSON.stringify(event)}\n`);
    const n = writeSync(this.fd, bytes);
    if (n !== bytes.length) {
      // A short write leaves a torn line; the next open truncates it. Refuse further appends.
      this.closed = true;
      throw new LogWriteError(`short write: ${n} of ${bytes.length} bytes`);
    }
    this.seq = event.seq;
    this.stats.writes++;
    this.dirty = true;
    if (LIFECYCLE_TYPES.has(event.type)) {
      this.sync();
    } else if (this.timer === null) {
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.sync();
      }, this.syncIntervalMs);
    }
    return event;
  }

  /** Flushes pending appends to disk now. */
  sync(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    if (!this.dirty || this.closed) return;
    fsyncSync(this.fd);
    this.dirty = false;
    this.stats.syncs++;
  }

  /** Syncs, closes the file and releases the lock. */
  close(): void {
    if (this.fd === -1) return;
    if (!this.closed) this.sync();
    this.closed = true;
    closeSync(this.fd);
    this.fd = -1;
    this.releaseLock();
  }

  private releaseLock(): void {
    if (readLockPid(this.lockPath) !== this.pid) return;
    try {
      unlinkSync(this.lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
