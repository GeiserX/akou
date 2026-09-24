/**
 * The dead-call-side rule (docs/DESIGN.md section 2.5, TRAPS T0.2 and T1.29), as a pure state
 * machine driven by a clock in seconds.
 *
 * The rule lives in the helper, which owns the devices. This TypeScript version is its reference:
 * the fake helper runs it, and the Rust helper ports it with the same test table.
 *
 * - Two silences. Buffers of zeros: the stream runs and carries silence, as real calls do for
 *   minutes, so only 10 s of it while the OS says output is running leads to a probe. No buffers
 *   at all, from a stream that has delivered: its IO callback stopped, a dead tap almost every
 *   time, so it is probed after 1 s. Still a probe first: a tap on one quiet app delivers nothing
 *   while other apps play, and the probe of the same app hears nothing then.
 * - Either silence counts only while output runs, so a tap that was quiet while nothing played is
 *   never "silent for 35 s" at the first tick of output.
 * - Action: probe for up to 3 s. If the probe hears audio, rebuild the call stream and report
 *   `dead`. Rebuilds back off 10, 30, 60 s, then every minute, at most 5 per part.
 * - A probe is dropped when the stream shows it is alive before the verdict: audio for either
 *   probe, any buffer for a probe of a stopped stream.
 * - The Rust helper turns the 1 s path off where its probe hears the whole output while only
 *   some apps are captured (Windows and Linux per-app capture): there no buffers waits like zeros.
 * - Audio returning after `dead` reports `ok`. Nothing runs while paused, and one tick never asks
 *   for two rebuilds.
 */

export const DEAD_AFTER_S = 10;
/** No buffers at all for this long, while output runs, after the stream delivered: probe now. */
export const STOPPED_AFTER_S = 1;
export const PROBE_S = 3;
export const BACKOFF_S = [10, 30, 60] as const;
export const EVERY_MINUTE_S = 60;
export const MAX_REBUILDS = 5;

export type DeadCallAction =
  | { kind: "none" }
  | { kind: "probe" }
  | { kind: "rebuild"; rebuilds: number }
  | { kind: "health"; state: "dead" | "ok"; silentFor: number; rebuilds: number; detail: string };

export interface DeadCallTick {
  /** Seconds on a monotonic clock. */
  t: number;
  /** The OS reports the output device running. */
  outputRunning: boolean;
  /** The call stream delivered non-zero audio since the last tick. */
  heard: boolean;
  /** The call stream delivered any buffer since the last tick, zeros included. Default true. */
  delivered?: boolean;
  paused?: boolean;
}

type Why = "zeros" | "stopped";

export class DeadCallMonitor {
  /** Start of the current stretch of output running with no audio from the stream. */
  private silentSince: number | null = null;
  /** Start of the current stretch of output running with no buffer at all. */
  private stoppedSince: number | null = null;
  private everDelivered = false;
  private probing: Why | null = null;
  private nextAllowed = -Infinity;
  private dead = false;
  rebuilds = 0;

  constructor(start: number) {
    this.silentSince = start;
  }

  /** One observation. Returns the actions for this tick, in order. */
  tick(o: DeadCallTick): DeadCallAction[] {
    if (o.paused) {
      // Paused time is not silence.
      this.silentSince = null;
      this.stoppedSince = null;
      return [];
    }
    const delivered = (o.delivered ?? true) || o.heard;
    if (delivered) {
      this.everDelivered = true;
      this.stoppedSince = null;
      // The stream is running again: its callback did not stop for good.
      if (this.probing === "stopped") this.probing = null;
    }
    if (o.heard) {
      this.silentSince = null;
      // A probe asked before this audio arrived would only rebuild a tap that works.
      this.probing = null;
      if (this.dead) {
        this.dead = false;
        return [
          {
            kind: "health",
            state: "ok",
            silentFor: 0,
            rebuilds: this.rebuilds,
            detail: "call audio is back",
          },
        ];
      }
      return [];
    }
    if (!o.outputRunning) {
      // Silence with nothing playing is not a symptom; the count starts again when output runs.
      this.silentSince = null;
      this.stoppedSince = null;
      return [];
    }
    this.silentSince ??= o.t;
    const silentFor = o.t - this.silentSince;
    let stoppedFor = 0;
    if (!delivered && this.everDelivered) {
      this.stoppedSince ??= o.t;
      stoppedFor = o.t - this.stoppedSince;
    }
    if (this.probing !== null || o.t < this.nextAllowed || this.rebuilds >= MAX_REBUILDS) return [];
    if (stoppedFor >= STOPPED_AFTER_S) this.probing = "stopped";
    else if (silentFor >= DEAD_AFTER_S) this.probing = "zeros";
    else return [];
    return [{ kind: "probe" }];
  }

  /** The probe's verdict, within `PROBE_S` of the `probe` action. */
  probeResult(t: number, heardAudio: boolean): DeadCallAction[] {
    const why = this.probing;
    if (why === null) return [];
    this.probing = null;
    const silentFor = this.silentSince === null ? 0 : t - this.silentSince;
    if (!heardAudio) {
      // Output running but nothing audible anywhere: a quiet call, not a dead tap.
      this.nextAllowed = t + DEAD_AFTER_S;
      return [];
    }
    const wait = BACKOFF_S[this.rebuilds] ?? EVERY_MINUTE_S;
    this.rebuilds++;
    this.nextAllowed = t + wait;
    this.dead = true;
    const base =
      why === "stopped"
        ? "the call stream stopped delivering while output runs, probe heard audio, rebuilding"
        : "output running, probe heard audio, rebuilding";
    const detail =
      this.rebuilds >= MAX_REBUILDS ? `${base} (last automatic rebuild for this part)` : base;
    return [
      { kind: "health", state: "dead", silentFor, rebuilds: this.rebuilds, detail },
      { kind: "rebuild", rebuilds: this.rebuilds },
    ];
  }
}
