/**
 * The dead-call-side rule (docs/DESIGN.md section 2.5, TRAPS T0.2 and T1.29), as a pure state
 * machine driven by a clock in seconds.
 *
 * The rule lives in the helper, which owns the devices. This TypeScript version is its reference:
 * the fake helper runs it, and the Rust helper ports it with the same test table.
 *
 * - Condition: the OS says output is running **and** the call stream has delivered exact zeros or
 *   nothing for 10 s. Silence alone never triggers anything; real calls have minutes of zeros.
 * - Action: probe for up to 3 s. If the probe hears audio, rebuild the call stream and report
 *   `dead`. Rebuilds back off 10, 30, 60 s, then every minute, at most 5 per part.
 * - Audio returning after `dead` reports `ok`. Nothing runs while paused, and one tick never asks
 *   for two rebuilds.
 */

export const DEAD_AFTER_S = 10;
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
  paused?: boolean;
}

export class DeadCallMonitor {
  private silentSince: number | null = null;
  private probing = false;
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
      return [];
    }
    if (o.heard) {
      this.silentSince = null;
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
    if (this.silentSince === null) this.silentSince = o.t;
    const silentFor = o.t - this.silentSince;
    if (
      !this.probing &&
      o.outputRunning &&
      silentFor >= DEAD_AFTER_S &&
      o.t >= this.nextAllowed &&
      this.rebuilds < MAX_REBUILDS
    ) {
      this.probing = true;
      return [{ kind: "probe" }];
    }
    return [];
  }

  /** The probe's verdict, within `PROBE_S` of the `probe` action. */
  probeResult(t: number, heardAudio: boolean): DeadCallAction[] {
    if (!this.probing) return [];
    this.probing = false;
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
    const detail =
      this.rebuilds >= MAX_REBUILDS
        ? "output running, probe heard audio, rebuilding (last automatic rebuild for this part)"
        : "output running, probe heard audio, rebuilding";
    return [
      { kind: "health", state: "dead", silentFor, rebuilds: this.rebuilds, detail },
      { kind: "rebuild", rebuilds: this.rebuilds },
    ];
  }
}
