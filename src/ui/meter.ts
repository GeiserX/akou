/**
 * How a level bar moves (WINDOW W3.18): the levels arrive four times a second, each the peak of
 * one capture packet, so a bar set straight from them jumps in steps and flickers between loud and
 * quiet packets. The bar is drawn per animation frame instead: it rises to a louder level almost
 * at once (attack) and falls back slowly (release), as a hardware level meter does. The window's
 * two meters and the indicator's two use the same code.
 *
 * A frame is not guaranteed: WebKit runs no `requestAnimationFrame` in a page it does not count as
 * shown, and on macOS the floating indicator, a window that is never activated, is such a page
 * while its timers and pushed levels still run. So each step waits for whichever comes first, the
 * next frame or a short timer, and a page without frames still moves its bars.
 */

import type { Levels } from "./protocol.ts";

/** The bottom of every bar, dBFS: quieter than this draws empty. */
export const METER_FLOOR = -60;
/** How fast a bar rises: the time constant of the approach, ms. */
export const ATTACK_MS = 25;
/** How fast a bar falls, dB per second. */
export const RELEASE_DB_PER_S = 24;
/** How long a step waits for an animation frame before a timer draws it instead, ms. */
export const FRAME_WAIT_MS = 50;

const clamp = (db: number) => Math.max(METER_FLOOR, Math.min(0, Number.isFinite(db) ? db : -120));

/** Where a bar showing `shown` dB is `dtMs` later on its way to `target` dB. */
export function meterStep(shown: number, target: number, dtMs: number): number {
  const to = clamp(target);
  const from = clamp(shown);
  const dt = Math.max(0, dtMs);
  if (to > from) {
    const next = from + (to - from) * (1 - Math.exp(-dt / ATTACK_MS));
    return to - next < 0.05 ? to : next;
  }
  return Math.max(to, from - (RELEASE_DB_PER_S * dt) / 1000);
}

type Channel = keyof Levels;

/** The page's next animation frame; the root tsconfig, which the unit tests use, has no DOM. */
const nextFrame = (fn: (t: number) => void): number =>
  (
    globalThis as unknown as { requestAnimationFrame(f: (t: number) => void): number }
  ).requestAnimationFrame(fn);

/** Runs `fn` after `ms`; returns what cancels it. */
const timer = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * The two bars of a page. `set` gives each its new level, `reset` empties both at once (another
 * call is shown); between the two, one animation frame at a time moves what is drawn (a timer when
 * the page gets no frame), and the steps stop once both bars reached their level.
 */
export class SmoothMeters {
  private shown: Levels = { mic: METER_FLOOR, call: METER_FLOOR };
  private target: Levels = { mic: METER_FLOOR, call: METER_FLOOR };
  private pending = false;
  private at = 0;

  constructor(
    private readonly draw: (ch: Channel, db: number) => void,
    private readonly raf: (fn: (t: number) => void) => unknown = nextFrame,
    private readonly now: () => number = () => performance.now(),
    private readonly after: (fn: () => void, ms: number) => () => void = timer,
  ) {}

  set(l: Levels): void {
    this.target = { mic: clamp(l.mic), call: clamp(l.call) };
    const rests = this.shown.mic === this.target.mic && this.shown.call === this.target.call;
    if (this.pending || rests) return;
    this.at = this.now();
    this.next();
  }

  reset(): void {
    this.shown = { mic: METER_FLOOR, call: METER_FLOOR };
    this.target = { ...this.shown };
    for (const ch of ["mic", "call"] as const) this.draw(ch, METER_FLOOR);
  }

  /** The next step: on the next frame, or on the timer when no frame came first. */
  private next(): void {
    this.pending = true;
    let done = false;
    const run = (t: number) => {
      if (done) return;
      done = true;
      cancel();
      this.step(t);
    };
    const cancel = this.after(() => run(this.now()), FRAME_WAIT_MS);
    this.raf(run);
  }

  private step(t: number): void {
    this.pending = false;
    const dt = t - this.at;
    this.at = t;
    let moving = false;
    for (const ch of ["mic", "call"] as const) {
      const next = meterStep(this.shown[ch], this.target[ch], dt);
      if (next !== this.shown[ch]) {
        this.shown[ch] = next;
        this.draw(ch, next);
      }
      if (next !== this.target[ch]) moving = true;
    }
    if (moving) this.next();
  }
}
