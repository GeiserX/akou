/**
 * How a level bar moves (WINDOW W3.18): a fast rise, a slow fall, drawn per animation frame, and
 * no frame at all once both bars rest. Pure code: no page, no device.
 */

import { describe, expect, test } from "bun:test";
import {
  ATTACK_MS,
  METER_FLOOR,
  meterStep,
  RELEASE_DB_PER_S,
  SmoothMeters,
} from "../src/ui/meter.ts";

describe("[W3.18] meterStep", () => {
  test("a louder level is reached within a few frames: the attack", () => {
    let db = METER_FLOOR;
    // 16 ms frames: after 100 ms the bar is within a dB of the new level.
    for (let t = 0; t < 100; t += 16) db = meterStep(db, -10, 16);
    expect(db).toBeGreaterThan(-11);
    expect(db).toBeLessThanOrEqual(-10);
    // One frame goes most of the way, never past it.
    const one = meterStep(-60, -10, 16);
    expect(one).toBeGreaterThan(-60 + 50 * (1 - Math.exp(-16 / ATTACK_MS)) - 0.01);
    expect(one).toBeLessThan(-10);
  });

  test("a quieter level is reached slowly and at a steady rate: the release", () => {
    // 250 ms after a loud packet, a silent one: the bar has fallen 6 dB, not to the floor.
    expect(meterStep(-10, -60, 250)).toBeCloseTo(-10 - RELEASE_DB_PER_S / 4, 5);
    // It never falls below its target.
    expect(meterStep(-10, -12, 1000)).toBe(-12);
    // Positive control: a bar set straight from the packets would have jumped to -60.
    expect(meterStep(-10, -60, 250)).toBeGreaterThan(-60);
  });

  test("the bar settles exactly on its level, so the frames can stop", () => {
    let db = -40;
    for (let i = 0; i < 60; i++) db = meterStep(db, -20, 16);
    expect(db).toBe(-20);
    expect(meterStep(-20, -20, 16)).toBe(-20);
  });

  test("levels outside the bar are held to it; a frame after a long pause lands on the level", () => {
    expect(meterStep(METER_FLOOR, -120, 16)).toBe(METER_FLOOR);
    expect(meterStep(-3, 6, 1000)).toBe(0);
    expect(meterStep(METER_FLOOR, Number.NaN, 16)).toBe(METER_FLOOR);
    expect(meterStep(-5, -50, 60_000)).toBe(-50);
    expect(meterStep(-50, -5, 60_000)).toBe(-5);
    expect(meterStep(-50, -5, -16)).toBe(-50);
  });
});

describe("[W3.18] SmoothMeters", () => {
  function rig() {
    const drawn: { ch: string; db: number }[] = [];
    const frames: ((t: number) => void)[] = [];
    let clock = 0;
    const m = new SmoothMeters(
      (ch, db) => drawn.push({ ch, db }),
      (fn) => frames.push(fn),
      () => clock,
    );
    /** Runs the one pending frame 16 ms later; false when none is pending. */
    const frame = () => {
      const fn = frames.shift();
      if (!fn) return false;
      clock += 16;
      fn(clock);
      return true;
    };
    return { m, drawn, frames, frame };
  }

  test("a level is drawn frame by frame, and the frames stop once both bars rest", () => {
    const r = rig();
    r.m.set({ mic: -20, call: -30 });
    // Levels arriving between frames ask for no second frame.
    r.m.set({ mic: -20, call: -30 });
    expect(r.frames.length).toBe(1);
    let n = 0;
    while (r.frame()) n++;
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThan(40);
    const last = (ch: string) => r.drawn.filter((d) => d.ch === ch).at(-1)?.db;
    expect(last("mic")).toBe(-20);
    expect(last("call")).toBe(-30);
    // At rest: nothing more is drawn and no frame is asked for.
    const before = r.drawn.length;
    r.m.set({ mic: -20, call: -30 });
    expect(r.frames.length).toBe(0);
    expect(r.drawn.length).toBe(before);
  });

  test("reset empties both bars at once, without a frame", () => {
    const r = rig();
    r.m.set({ mic: -10, call: -10 });
    while (r.frame());
    r.m.reset();
    expect(r.drawn.slice(-2)).toEqual([
      { ch: "mic", db: METER_FLOOR },
      { ch: "call", db: METER_FLOOR },
    ]);
    expect(r.frames.length).toBe(0);
  });
});
