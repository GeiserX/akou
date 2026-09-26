/**
 * DC-A1: the dictation key's activation rule (src/core/dictation/activation.ts) over a fake key
 * source, by tables. The fake helper and the Rust helper run the same rule.
 */

import { describe, expect, test } from "bun:test";
import {
  type Activation,
  ActivationMachine,
  type ActivationOut,
  isModifier,
  type KeyInput,
} from "../src/core/dictation/activation.ts";

function run(keys: string[], presses: [number, string, boolean][], activation?: Activation) {
  const m = new ActivationMachine({ keys, activation: activation ?? "hold-or-toggle" });
  const out: ActivationOut[] = [];
  for (const [at, key, down] of presses) out.push(...m.feed({ at, key, down } as KeyInput));
  const sessions = out.filter((o) => o.type !== "key");
  const tap = out.filter((o) => o.type === "key");
  return { m, sessions, tap };
}

const RC = "RightCommand";

describe("DC-A1: hold-or-toggle", () => {
  test("down and up at 800 ms is one push-to-talk session ending at the up", () => {
    const { sessions, m } = run(
      [RC],
      [
        [0, RC, true],
        [800, RC, false],
      ],
    );
    expect(sessions).toEqual([
      { type: "start", at: 0 },
      { type: "end", at: 800, reason: "release" },
    ]);
    expect(m.active).toBe(false);
  });

  test("a 120 ms tap latches; a tap at 3 s ends one session of about 3 s", () => {
    const { sessions } = run(
      [RC],
      [
        [0, RC, true],
        [120, RC, false],
        [3000, RC, true],
        [3100, RC, false],
      ],
    );
    expect(sessions).toEqual([
      { type: "start", at: 0 },
      { type: "end", at: 3100, reason: "tap" },
    ]);
  });

  test("Right Command+C within 120 ms is a copy: no session is kept, and C passes through", () => {
    const { sessions, tap, m } = run(
      [RC],
      [
        [0, RC, true],
        [40, "C", true],
        [80, "C", false],
        [120, RC, false],
      ],
    );
    expect(sessions).toEqual([
      { type: "start", at: 0 },
      { type: "end", at: 40, reason: "interrupt" },
    ]);
    expect(m.active).toBe(false);
    // Nothing is swallowed: the modifier never, and C reaches the app.
    expect(tap.every((t) => t.type === "key" && !t.swallowed)).toBe(true);
  });

  test("positive control: the same presses without C latch", () => {
    const { sessions, m } = run(
      [RC],
      [
        [0, RC, true],
        [120, RC, false],
      ],
    );
    expect(sessions).toEqual([{ type: "start", at: 0 }]);
    expect(m.active).toBe(true);
  });

  test("a 1 s hold with C at 800 ms ends as an interrupt at C and passes C through", () => {
    const { sessions, tap } = run(
      [RC],
      [
        [0, RC, true],
        [800, "C", true],
        [850, "C", false],
        [1000, RC, false],
      ],
    );
    expect(sessions).toEqual([
      { type: "start", at: 0 },
      { type: "end", at: 800, reason: "interrupt" },
    ]);
    expect(tap).toContainEqual({ type: "key", key: "C", down: true, swallowed: false });
  });

  test("while latched, typing goes through and does not end the session", () => {
    const { sessions, m } = run(
      [RC],
      [
        [0, RC, true],
        [100, RC, false],
        [500, "A", true],
        [550, "A", false],
      ],
    );
    expect(sessions).toEqual([{ type: "start", at: 0 }]);
    expect(m.active).toBe(true);
  });

  test("while latched, Right Command+C is a shortcut, not the tap that ends it", () => {
    const { sessions, m } = run(
      [RC],
      [
        [0, RC, true],
        [100, RC, false],
        [900, RC, true],
        [940, "C", true],
        [980, "C", false],
        [1000, RC, false],
      ],
    );
    expect(sessions).toEqual([{ type: "start", at: 0 }]);
    expect(m.active).toBe(true);
  });

  test("key repeat of a held key starts nothing more", () => {
    const { sessions } = run(
      [RC],
      [
        [0, RC, true],
        [30, RC, true],
        [60, RC, true],
        [900, RC, false],
      ],
    );
    expect(sessions).toEqual([
      { type: "start", at: 0 },
      { type: "end", at: 900, reason: "release" },
    ]);
  });
});

describe("DC-A1: hold and toggle", () => {
  test("hold: a short press still ends at its release", () => {
    const { sessions } = run(
      [RC],
      [
        [0, RC, true],
        [100, RC, false],
      ],
      "hold",
    );
    expect(sessions.at(-1)).toEqual({ type: "end", at: 100, reason: "release" });
  });

  test("toggle: a long press latches too, and the next tap ends it", () => {
    const { sessions } = run(
      [RC],
      [
        [0, RC, true],
        [900, RC, false],
        [2000, RC, true],
        [2050, RC, false],
      ],
      "toggle",
    );
    expect(sessions).toEqual([
      { type: "start", at: 0 },
      { type: "end", at: 2050, reason: "tap" },
    ]);
  });
});

describe("DC-A1: a chord", () => {
  test("Control+Shift+Space starts when the chord is complete; only Space is swallowed", () => {
    const keys = ["Control", "Shift", "Space"];
    const { sessions, tap } = run(keys, [
      [0, "Control", true],
      [10, "Shift", true],
      [20, "Space", true],
      [900, "Space", false],
      [910, "Shift", false],
      [920, "Control", false],
    ]);
    expect(sessions).toEqual([
      { type: "start", at: 20 },
      { type: "end", at: 900, reason: "release" },
    ]);
    expect(
      tap.filter((t) => t.type === "key" && t.swallowed).map((t) => t.type === "key" && t.key),
    ).toEqual(["Space", "Space"]);
  });

  test("the interrupt rule is for a modifier-only key: another key during a chord hold passes and the session goes on", () => {
    const { sessions } = run(
      ["Control", "Shift", "Space"],
      [
        [0, "Control", true],
        [10, "Shift", true],
        [20, "Space", true],
        [400, "A", true],
        [450, "A", false],
        [900, "Space", false],
      ],
    );
    expect(sessions.at(-1)).toEqual({ type: "end", at: 900, reason: "release" });
  });
});

test("modifiers by name, either side", () => {
  expect(["RightCommand", "LeftOption", "RightControl", "Fn", "Shift"].every(isModifier)).toBe(
    true,
  );
  expect(["C", "Space", "Escape"].some(isModifier)).toBe(false);
});
