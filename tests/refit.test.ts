import { describe, expect, test } from "bun:test";
import { REFIT_GAP_MS, Refit, type Size } from "../src/main/window/refit.ts";

/** A re-fit over a window of `win`, with a clock and a tick the test turns. */
function rig(win: Size | null = { width: 1280, height: 820 }) {
  let now = 10_000;
  let tick: (() => void) | null = null;
  const sizes: string[] = [];
  const logs: string[] = [];
  const r = new Refit({
    size: () => win,
    setSize: (w, h) => sizes.push(`${w}x${h}`),
    log: (m) => logs.push(m),
    now: () => now,
    later: (fn) => {
      tick = fn;
    },
  });
  return {
    r,
    sizes,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => {
      const fn = tick;
      tick = null;
      fn?.();
    },
  };
}

describe("[DK-M7] A webview left at its old size: the page reports its viewport and a mismatch re-fits it", () => {
  test("a page shorter than the window by more than a pixel nudges the window a point wider and back, once, with one log line", () => {
    const t = rig();
    expect(t.r.check({ width: 1280, height: 540, dpr: 2 })).toBe(true);
    expect(t.sizes).toEqual(["1281x820"]);
    t.tick();
    expect(t.sizes).toEqual(["1281x820", "1280x820"]);
    expect(t.logs).toEqual(["window re-fit: the page is 1280x540 at 2x in a window of 1280x820"]);
  });

  test("equal sizes, or a pixel of rounding, nudge nothing", () => {
    const t = rig();
    expect(t.r.check({ width: 1280, height: 820, dpr: 2 })).toBe(false);
    expect(t.r.check({ width: 1279, height: 821, dpr: 1 })).toBe(false);
    expect(t.sizes).toEqual([]);
    expect(t.logs).toEqual([]);
  });

  test("a second mismatch inside a second nudges nothing; after a second it does", () => {
    const t = rig();
    expect(t.r.check({ width: 1280, height: 540, dpr: 2 })).toBe(true);
    t.tick();
    t.advance(REFIT_GAP_MS - 1);
    expect(t.r.check({ width: 1000, height: 600, dpr: 2 })).toBe(false);
    expect(t.sizes).toEqual(["1281x820", "1280x820"]);
    t.advance(1);
    expect(t.r.check({ width: 1000, height: 600, dpr: 2 })).toBe(true);
    expect(t.sizes).toEqual(["1281x820", "1280x820", "1281x820"]);
  });

  test("no nudge starts while one is in flight, and a mismatch a nudge did not fix is not tried again", () => {
    const t = rig();
    expect(t.r.check({ width: 1280, height: 540, dpr: 2 })).toBe(true);
    t.advance(REFIT_GAP_MS * 5);
    // The second half has not run yet.
    expect(t.r.check({ width: 1000, height: 600, dpr: 2 })).toBe(false);
    t.tick();
    // The same pair after the nudge: it did not help, so it is left alone.
    expect(t.r.check({ width: 1280, height: 540, dpr: 2 })).toBe(false);
    expect(t.sizes).toEqual(["1281x820", "1280x820"]);
  });

  test("once the page fits again, the same mismatch coming back is nudged again", () => {
    const t = rig();
    expect(t.r.check({ width: 1280, height: 540, dpr: 2 })).toBe(true);
    t.tick();
    t.advance(REFIT_GAP_MS);
    expect(t.r.check({ width: 1280, height: 820, dpr: 2 })).toBe(false);
    // A later display change leaves it behind at the same size.
    expect(t.r.check({ width: 1280, height: 540, dpr: 2 })).toBe(true);
    expect(t.sizes).toEqual(["1281x820", "1280x820", "1281x820"]);
  });

  test("a closed window nudges nothing", () => {
    const t = rig(null);
    expect(t.r.check({ width: 1280, height: 540, dpr: 2 })).toBe(false);
    expect(t.sizes).toEqual([]);
  });
});
