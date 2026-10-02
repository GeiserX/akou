/**
 * Moves the wall clock a year ahead for every `bun` that preloads this file, and lets it keep
 * ticking (docs/TESTING.md TS-5): a fixture pinned to the calendar, or code that only works near
 * the day it was written, fails the nightly shifted run before it fails a pull request on its own.
 *
 *   BUN_OPTIONS="--preload=$PWD/scripts/ci/shift-clock.ts" bun test
 *
 * `BUN_OPTIONS` reaches every `bun` the run starts, so the app processes the e2e tests spawn are
 * shifted too. `AKOU_CLOCK_SHIFT_DAYS` changes the distance (365 by default).
 *
 * Not `setSystemTime` from `bun:test`: it stops the clock where it sets it (measured on Bun
 * 1.4.2: `Date.now()` the same before and after a 120 ms sleep), and code that waits on
 * `Date.now()` against a deadline would then wait for ever. Only `Date` moves: timers and
 * `performance.now()` keep real time, which is what they measure.
 */

const days = Number(process.env.AKOU_CLOCK_SHIFT_DAYS ?? "365");
if (!Number.isFinite(days)) throw new Error(`AKOU_CLOCK_SHIFT_DAYS is a number, not ${days}`);
export const SHIFT_MS = days * 24 * 60 * 60 * 1000;

const RealDate = Date;
const shiftedNow = () => RealDate.now() + SHIFT_MS;

// A proxy, not a subclass: dates made elsewhere (a file's mtime) stay `instanceof Date`, and
// `Date.parse`, `Date.UTC` and the prototype are the real ones.
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return args.length === 0
      ? Reflect.construct(target, [shiftedNow()], newTarget)
      : Reflect.construct(target, args, newTarget);
  },
  // `Date()` called as a function gives the time as a string.
  apply() {
    return new RealDate(shiftedNow()).toString();
  },
  get(target, key, receiver) {
    if (key === "now") return shiftedNow;
    return Reflect.get(target, key, receiver);
  },
});
