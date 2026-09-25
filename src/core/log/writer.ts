/**
 * The single writer of a call's event log (docs/DESIGN.md sections 4.1, 4.2 and 4.5).
 *
 * - One writer per call folder, held by `.akou.lock` (the writer's pid and the id of its process
 *   start). A second writer refuses while the holder is alive; a lock left by a dead process is
 *   taken over, by one writer only. The holder refreshes the lock's mtime every 10 s, so a lock
 *   whose holder cannot be seen (a container restarted as pid 1, a second container on the same
 *   volume) is taken only once that heartbeat has stopped for 30 s (`acquireLock`).
 * - The file is opened for append only. Nothing already written is ever changed; the only
 *   exception is a torn last line from a crash (no newline, or not JSON), which is truncated when
 *   the log is opened. A complete line that fails validation is kept.
 * - One `write()` per line. `fsync` at every lifecycle event, and at most one second after any
 *   other append.
 * - `seq` is assigned here, gap-free from 1, and `t` is the wall clock at write.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { type EventDraft, LIFECYCLE_TYPES, type LogEvent, validateDraft } from "./events.ts";
import { parseLog, type TornTail } from "./reader.ts";

export const EVENTS_FILE = "events.jsonl";
export const LOCK_FILE = ".akou.lock";
export const SYNC_INTERVAL_MS = 1000;
/** The holder of a lock touches it this often. */
export const LOCK_HEARTBEAT_MS = 10_000;
/** A lock whose holder cannot be seen is taken once its mtime is this old. */
export const LOCK_STALE_MS = 30_000;
/**
 * Made once when this process starts, and written into every lock it takes: a lock that names
 * this process's pid with another id was left by an earlier start that had the same pid (a
 * container's Bun is pid 1 on every start).
 */
export const INSTANCE_ID = randomBytes(8).toString("hex");

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
  /** The id written beside the pid (`INSTANCE_ID`). */
  lockId?: string;
  /**
   * Server mode: a holder whose pid is not alive here may be alive in another container on the
   * same volume, so its lock is taken only once its heartbeat has stopped.
   */
  serverMode?: boolean;
  /** Wall clock for the lock's age, epoch ms. */
  lockNow?: () => number;
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

/** The holder a lock file names: its pid and, since SI-4, the id of its process start. */
export function readLock(lockPath: string): { pid: number | null; id: string | null } | null {
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  const [pidText = "", id] = text.trim().split(/\s+/);
  const n = Number.parseInt(pidText, 10);
  return { pid: Number.isInteger(n) ? n : null, id: id ?? null };
}

function readLockPid(lockPath: string): number | null {
  return readLock(lockPath)?.pid ?? null;
}

/**
 * Creates the lock atomically with its content: the pid and id are written to a private file
 * which is then hard-linked into place, and a link fails if the lock already exists.
 */
function tryCreateLock(lockPath: string, pid: number, id: string): boolean {
  const tmp = `${lockPath}.${pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, `${pid} ${id}\n`);
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

export interface LockOptions {
  /** This process's id (`INSTANCE_ID`). */
  id?: string;
  /** Server mode: a holder not alive here may be alive in another container (see below). */
  serverMode?: boolean;
  now?: () => number;
  /** How old an unseen holder's lock must be to be taken; `LOCK_STALE_MS`. */
  staleMs?: number;
}

/**
 * Takes a lock file (docs/research/service-interface.md SI-4). Throws `LockError` while the holder
 * may be alive. Returns the stale holder's pid when it took one over, else null. The app's
 * single-instance lock uses it too. In order:
 *
 * 1. The lock names this process (its pid and its id): refused, a second acquire in one process.
 * 2. Its pid is alive here and is not this process: refused, as always.
 * 3. App mode and its pid is dead: taken at once, so a crash adds no wait to the next launch.
 * 4. Otherwise (this pid with another id: an earlier start with the same pid, as a container's
 *    pid 1; or, in server mode, a pid this namespace cannot see): taken only once the lock's
 *    mtime, which its holder refreshes every 10 s, is older than 30 s.
 */
export function acquireLock(
  lockPath: string,
  pid: number,
  isAlive: (pid: number) => boolean,
  o: LockOptions = {},
): number | null {
  const id = o.id ?? INSTANCE_ID;
  if (tryCreateLock(lockPath, pid, id)) return null;
  const found = readLock(lockPath);
  const holder = found?.pid ?? null;
  if (holder !== null) {
    if (holder === pid && found?.id === id) throw new LockError(lockPath, holder);
    const alive = holder !== pid && isAlive(holder);
    if (alive) throw new LockError(lockPath, holder);
    if (holder === pid || o.serverMode) {
      let age = Number.POSITIVE_INFINITY;
      try {
        age = (o.now ?? Date.now)() - statSync(lockPath).mtimeMs;
      } catch {}
      if (age < (o.staleMs ?? LOCK_STALE_MS)) throw new LockError(lockPath, holder);
    }
  }
  // The holder is gone (a crash): take the lock over. Two writers may both have read the same
  // stale holder, so never delete the lock blindly: move it aside atomically and look at what was
  // moved. If it is not the stale lock that was judged dead, another writer took it over first;
  // put it back and refuse.
  const aside = `${lockPath}.${pid}.${Math.random().toString(36).slice(2)}.stale`;
  let moved = true;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    moved = false;
  }
  if (moved) {
    const was = readLock(aside);
    if (was?.pid !== holder || was?.id !== (found?.id ?? null)) {
      try {
        // Restore the other writer's lock; if a third writer already made a new one, keep that.
        linkSync(aside, lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      } finally {
        unlinkSync(aside);
      }
      throw new LockError(lockPath, was?.pid ?? -1);
    }
    unlinkSync(aside);
  }
  if (!tryCreateLock(lockPath, pid, id)) {
    throw new LockError(lockPath, readLockPid(lockPath) ?? -1);
  }
  return holder ?? -1;
}

/**
 * The holder's heartbeat: touches the lock every `LOCK_HEARTBEAT_MS` while it still names this
 * holder, so another container on the same volume sees it is alive. Returns the stop function.
 */
export function lockHeartbeat(
  lockPath: string,
  pid: number,
  id: string = INSTANCE_ID,
  every: number = LOCK_HEARTBEAT_MS,
): () => void {
  const beat = () => {
    const held = readLock(lockPath);
    if (held?.pid !== pid || held.id !== id) return;
    try {
      const t = new Date();
      utimesSync(lockPath, t, t);
    } catch {}
  };
  const timer = setInterval(beat, every);
  // A heartbeat must never keep the process alive on its own.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
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
  private readonly lockId: string;
  private stopHeartbeat: () => void = () => {};
  /** Counters for tests and diagnostics. */
  readonly stats = { writes: 0, syncs: 0 };

  private constructor(dir: string, opts: WriterOptions) {
    this.path = join(dir, EVENTS_FILE);
    this.lockPath = join(dir, LOCK_FILE);
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.syncIntervalMs = opts.syncIntervalMs ?? SYNC_INTERVAL_MS;
    this.pid = opts.pid ?? process.pid;

    this.lockId = opts.lockId ?? INSTANCE_ID;
    const staleLockPid = acquireLock(this.lockPath, this.pid, opts.isAlive ?? processAlive, {
      id: this.lockId,
      serverMode: opts.serverMode,
      now: opts.lockNow,
    });
    this.stopHeartbeat = lockHeartbeat(this.lockPath, this.pid, this.lockId);
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
        // Invalid lines keep their seq too, so a line from a newer build is never given a twin.
        last = r.lastSeq;
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
    this.stopHeartbeat();
    const held = readLock(this.lockPath);
    if (held?.pid !== this.pid || (held.id !== null && held.id !== this.lockId)) return;
    try {
      unlinkSync(this.lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
