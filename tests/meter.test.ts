/**
 * How a level bar moves (WINDOW W3.18): a fast rise, a slow fall, drawn per animation frame in
 * the window, and no frame at all once both bars rest; in the indicator (DESKTOP DK-F1), moved by
 * each pushed level with no frame and no timer. Pure code: no page, no device.
 */

import { describe, expect, test } from "bun:test";
import {
  ATTACK_MS,
  METER_FLOOR,
  meterStep,
  PushedMeters,
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

describe("[W3.18] SmoothMeters asks for frames only", () => {
  test("a level waiting for a frame starts no timer: a hidden window runs no step chain", () => {
    const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
    let timers = 0;
    globalThis.setTimeout = ((...a: Parameters<typeof setTimeout>) => {
      timers++;
      return real.setTimeout(...a);
    }) as typeof setTimeout;
    globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => {
      timers++;
      return real.setInterval(...a);
    }) as typeof setInterval;
    try {
      const frames: ((t: number) => void)[] = [];
      const drawn: number[] = [];
      const m = new SmoothMeters(
        (_ch, db) => drawn.push(db),
        (fn) => frames.push(fn),
        () => 0,
      );
      m.set({ mic: -20, call: -24 });
      // No frame comes (a hidden page): one frame is asked for, nothing else runs or draws.
      expect(frames.length).toBe(1);
      expect(timers).toBe(0);
      expect(drawn).toEqual([]);
    } finally {
      globalThis.setTimeout = real.setTimeout;
      globalThis.setInterval = real.setInterval;
    }
  });
});

describe("[DK-F1] PushedMeters", () => {
  function rig() {
    const drawn: { ch: string; db: number }[] = [];
    let clock = 0;
    const m = new PushedMeters(
      (ch, db) => drawn.push({ ch, db }),
      () => clock,
    );
    const last = (ch: string) => drawn.filter((d) => d.ch === ch).at(-1)?.db;
    return { m, drawn, last, advance: (ms: number) => (clock += ms) };
  }

  test("each pushed level is drawn at once: the first as it is, a louder one at once", () => {
    const r = rig();
    r.m.set({ mic: -20, call: -24 });
    expect(r.last("mic")).toBe(-20);
    expect(r.last("call")).toBe(-24);
    r.advance(250);
    r.m.set({ mic: -6, call: -24 });
    expect(r.last("mic")).toBe(-6);
    // A channel that did not change draws nothing new.
    expect(r.drawn.filter((d) => d.ch === "call").length).toBe(1);
  });

  test("a quieter level falls at the release rate over the time since the last push", () => {
    const r = rig();
    r.m.set({ mic: -10, call: -10 });
    r.advance(250);
    r.m.set({ mic: -60, call: -12 });
    expect(r.last("mic")).toBeCloseTo(-10 - RELEASE_DB_PER_S / 4, 5);
    expect(r.last("call")).toBe(-12);
    // Positive control: a bar set straight from the pushes would have dropped to the floor.
    expect(r.last("mic")).toBeGreaterThan(METER_FLOOR);
    r.advance(2000);
    r.m.set({ mic: -60, call: -12 });
    expect(r.last("mic")).toBe(METER_FLOOR);
  });

  test("reset empties both bars, and the next level is drawn as it is", () => {
    const r = rig();
    r.m.set({ mic: -10, call: -10 });
    r.m.reset();
    expect(r.drawn.slice(-2)).toEqual([
      { ch: "mic", db: METER_FLOOR },
      { ch: "call", db: METER_FLOOR },
    ]);
    r.m.set({ mic: -30, call: -40 });
    expect(r.last("mic")).toBe(-30);
    expect(r.last("call")).toBe(-40);
  });
});
