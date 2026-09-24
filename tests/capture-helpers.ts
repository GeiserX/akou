/**
 * Test support for capture and call tests: a manual clock that drives every budget (TRAPS T4.31),
 * and a scripted in-process engine whose helper does exactly what a test tells it to.
 */

import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { readLog } from "../src/core/log/reader.ts";
import { EVENTS_FILE } from "../src/core/log/writer.ts";
import {
  type CaptureEngine,
  type CaptureHandlers,
  type CaptureSession,
  type CaptureStartOptions,
  type Clock,
  type ExitInfo,
  type StopOutcome,
  withDeadline,
} from "../src/main/capture/engine.ts";
import { KILL_GRACE_MS } from "../src/main/capture/helper.ts";
import { CAPTURE_RATE, type HealthMsg, type HelperCommand } from "../src/main/capture/protocol.ts";
import { T0 } from "./helpers.ts";

/** Lets pending promise callbacks run. */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Lets promise chains settle without a trip through the event loop. */
async function microtasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await null;
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class ManualClock implements Clock {
  t = T0;
  monoNs = 5_000_000_000n;
  private timers: Timer[] = [];
  private nextId = 1;

  now(): number {
    return this.t;
  }

  mono(): bigint {
    return this.monoNs;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Moves time forward, firing due timers in order and letting promises settle after each. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.step(next.at - this.t);
      next.fn();
      await microtasks();
    }
    this.step(end - this.t);
    await flush();
  }

  private step(ms: number): void {
    this.t += ms;
    this.monoNs += BigInt(Math.round(ms * 1e6));
  }
}

export class ScriptedSession implements CaptureSession {
  readonly pid = 4242;
  readonly dialect = "scripted";
  readonly exited: Promise<ExitInfo>;
  readonly sent: HelperCommand[] = [];
  /** Ignores `stop`: a hung teardown. */
  hangOnStop = false;
  exitInfo: ExitInfo | null = null;
  private resolveExit!: (e: ExitInfo) => void;
  private fileFrames = 0;
  anchorNs = 0n;

  constructor(
    readonly opts: CaptureStartOptions,
    private readonly handlers: CaptureHandlers,
    private readonly clock: ManualClock,
  ) {
    this.exited = new Promise((r) => {
      this.resolveExit = r;
    });
    handlers.message({ type: "hello", protocol: "akou-capture/1", version: "9.9.9", caps: [] });
  }

  capturing(): void {
    this.anchorNs = this.clock.mono();
    this.handlers.message({
      type: "capturing",
      mic: { id: "default", name: "Test Mic", rate: 48000 },
      call: { mode: "system", rate: 48000 },
      exclude: [],
      capture_ns: this.anchorNs.toString(),
    });
  }

  /** One packet per channel of `seconds` at the current host clock and file position. */
  audio(seconds = 0.1, o: { callZero?: boolean; callOmit?: boolean; value?: number } = {}): void {
    const n = Math.round(seconds * CAPTURE_RATE);
    const fileSeconds = this.fileFrames / CAPTURE_RATE;
    const captureNs = this.clock.mono();
    const v = o.value ?? 0.25;
    this.handlers.packet({
      ch: "mic",
      zeroFilled: false,
      captureNs,
      fileSeconds,
      samples: new Float32Array(n).fill(v),
    });
    if (!o.callOmit) {
      this.handlers.packet({
        ch: "call",
        zeroFilled: !!o.callZero,
        captureNs,
        fileSeconds,
        samples: new Float32Array(n).fill(o.callZero ? 0 : v),
      });
    }
    this.fileFrames += n;
  }

  health(ch: HealthMsg["ch"], state: string, rebuilds = 0): void {
    this.handlers.message({
      type: "health",
      ch,
      state,
      silent_for: 10,
      rebuilds,
      detail: "scripted",
    });
  }

  get fileSeconds(): number {
    return this.fileFrames / CAPTURE_RATE;
  }

  exit(code: number | null, signal: string | null = null, killedByUs = false): void {
    if (this.exitInfo) return;
    const info: ExitInfo = { code, signal, killedByUs };
    this.exitInfo = info;
    this.resolveExit(info);
    this.handlers.exit(info);
  }

  send(cmd: HelperCommand): void {
    this.sent.push(cmd);
    if (cmd === "stop" && !this.hangOnStop && !this.exitInfo) {
      this.handlers.message({ type: "stopped", file_seconds: this.fileSeconds, reason: "stop" });
      const info: ExitInfo = {
        code: 0,
        signal: null,
        killedByUs: false,
        stopped: { fileSeconds: this.fileSeconds, reason: "stop" },
      };
      this.exitInfo = info;
      queueMicrotask(() => {
        this.resolveExit(info);
        this.handlers.exit(info);
      });
    }
  }

  kill(): void {
    this.exit(null, "SIGKILL", true);
  }

  async stop(budgetMs: number): Promise<StopOutcome> {
    const t0 = this.clock.now();
    if (this.exitInfo) return { killed: false, exit: this.exitInfo, ms: 0 };
    this.send("stop");
    const first = await withDeadline(this.clock, this.exited, budgetMs);
    if (first.ok) return { killed: false, exit: first.value, ms: this.clock.now() - t0 };
    this.kill();
    const second = await withDeadline(this.clock, this.exited, KILL_GRACE_MS);
    return { killed: true, exit: second.ok ? second.value : null, ms: this.clock.now() - t0 };
  }
}

/** An engine whose sessions a test drives by hand. */
export class ScriptedEngine implements CaptureEngine {
  readonly name = "scripted";
  readonly sessions: ScriptedSession[] = [];
  /** Runs inside `start`, after the session exists (e.g. to capture at once). */
  onStart: ((s: ScriptedSession) => void) | null = null;
  /** Makes the spawn itself fail. */
  spawnError: string | null = null;
  /** How long the spawn itself takes on the manual clock. */
  spawnMs = 0;

  constructor(private readonly clock: ManualClock) {}

  start(opts: CaptureStartOptions, handlers: CaptureHandlers): CaptureSession {
    if (this.spawnError) throw new Error(this.spawnError);
    if (this.spawnMs > 0) {
      // A synchronous spawn that takes this long: time passes before any budget can start.
      this.clock.t += this.spawnMs;
      this.clock.monoNs += BigInt(this.spawnMs * 1e6);
    }
    const s = new ScriptedSession(opts, handlers, this.clock);
    this.sessions.push(s);
    this.onStart?.(s);
    return s;
  }

  get last(): ScriptedSession {
    const s = this.sessions[this.sessions.length - 1];
    if (!s) throw new Error("no session started");
    return s;
  }
}

export async function logOf(dir: string): Promise<LogEvent[]> {
  return (await readLog(join(dir, EVENTS_FILE))).events;
}

export function types(events: readonly LogEvent[]): string[] {
  return events.map((e) => e.type);
}

export function ofType<T extends LogEvent["type"]>(
  events: readonly LogEvent[],
  type: T,
): Extract<LogEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<LogEvent, { type: T }>[];
}

/** Polls a condition on the real clock; fails the test with `what` after `ms`. */
export async function until(
  cond: () => boolean | Promise<boolean>,
  ms: number,
  what: string,
): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}
