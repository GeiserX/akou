/**
 * The `CaptureEngine` interface (docs/DESIGN.md section 1.3): the app's one view of capture,
 * whichever way it runs. Today there are two child-process implementations, the `akou-capture`
 * helper (`helper.ts`) and hark as a macOS fallback (`hark.ts`); the napi addon, if M0 needs it,
 * implements the same interface in-process.
 *
 * The contract every implementation keeps:
 *
 * - `start` spawns and returns at once. No timeout starts before the spawn; the caller owns the
 *   start budget and measures it from the returned session.
 * - Nothing blocks the caller. Packets and messages arrive through the handlers; `send` never
 *   throws; `stop` resolves within its budget plus a short kill grace even if the helper hangs.
 */

import type { Channel } from "../../core/log/events.ts";
import type { HelperCommand, HelperMessage, Packet } from "./protocol.ts";

export interface CaptureStartOptions {
  /** Part number, 1-based. */
  part: number;
  /** Absolute path of the part's audio file (`<call>/audio/part-NNN.opus`). */
  out: string;
  /** `default`, `none`, or a device id. */
  mic: string;
  /** `system`, `none`, or `app:<id>[,<id>]`. */
  call: string;
  /** The app's own bundle id or pid, whose audio the helper excludes (DESIGN 2.3). */
  excludeResponsible?: string;
  /** Where the helper's stderr is kept (`<call>/logs/capture-part-NNN.log`). */
  logPath?: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** We killed it (stop budget spent, protocol error, or `kill()`). */
  killedByUs: boolean;
  /** The `stopped` message, when the helper sent one before exiting. */
  stopped?: { fileSeconds: number; reason: string };
  /** A protocol error on stdout, which makes the session kill the helper. */
  protocolError?: string;
}

export interface CaptureHandlers {
  packet(p: Packet): void;
  message(m: HelperMessage): void;
  /** Called once, whatever the cause. */
  exit(e: ExitInfo): void;
}

export interface StopOutcome {
  /** The helper did not exit within the budget and was killed. */
  killed: boolean;
  exit: ExitInfo | null;
  /** How long the stop took, ms. */
  ms: number;
}

export interface CaptureSession {
  readonly pid: number | undefined;
  /** `akou-capture/1` or `stereo-s16le`. */
  readonly dialect: string;
  readonly exited: Promise<ExitInfo>;
  /** Sends one command. Never throws, never waits. */
  send(cmd: HelperCommand): void;
  /**
   * Asks the helper to stop and waits at most `budgetMs`, then kills it. Resolves within the
   * budget plus a short grace for the kill, even when the helper never exits.
   */
  stop(budgetMs: number): Promise<StopOutcome>;
  /** Kills at once. */
  kill(): void;
}

export interface CaptureEngine {
  /** `akou-capture`, `hark`: goes into `part.started.capture` with the version from `hello`. */
  readonly name: string;
  /** Spawns. Throws `SpawnError` when the program cannot be started at all. */
  start(opts: CaptureStartOptions, handlers: CaptureHandlers): CaptureSession;
}

export class SpawnError extends Error {
  override name = "SpawnError";
}

// ---------------------------------------------------------------------------
// Time

/**
 * Wall clock, host clock and timers in one place, so every budget can be driven by a fake clock
 * in tests (TRAPS T4.31) and a real one in the app.
 */
export interface Clock {
  /** Wall clock, epoch ms. */
  now(): number;
  /** Monotonic clock, nanoseconds. Only differences are meaningful. */
  mono(): bigint;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  mono: () => process.hrtime.bigint(),
  setTimeout(fn, ms) {
    return setTimeout(fn, ms);
  },
  clearTimeout(h) {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

/** Resolves after `ms` on the given clock. */
export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

/**
 * Races a promise against a deadline on the given clock. Resolves `{ok: false}` at the deadline;
 * the promise keeps running and its result is dropped.
 */
export function withDeadline<T>(
  clock: Clock,
  p: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve) => {
    let done = false;
    const h = clock.setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false });
    }, ms);
    p.then(
      (value) => {
        if (done) return;
        done = true;
        clock.clearTimeout(h);
        resolve({ ok: true, value });
      },
      () => {
        if (done) return;
        done = true;
        clock.clearTimeout(h);
        resolve({ ok: false });
      },
    );
  });
}

export const CHANNELS: readonly Channel[] = ["mic", "call"];
