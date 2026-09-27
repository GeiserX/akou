/**
 * DC-A1 and DC-A4: the dictation key's activation rule (src/core/dictation/activation.ts), the
 * port the fake helper runs of the Rust helper's `activation.rs`. These are the Rust tests' tables,
 * row for row, with the same 10 ms tick, so the fake sends what the real helper would.
 */

import { describe, expect, test } from "bun:test";
import {
  type Activation,
  ActivationMachine,
  type ActivationOut,
  isModifier,
  parseBinding,
} from "../src/core/dictation/activation.ts";

type Script = [number, boolean, string][];

/** Plays `[ms, down, key]` with a tick every 10 ms: the actions with their time, and the swallowed keys. */
function play(hotkey: string, mode: Activation, script: Script, untilMs: number) {
  const m = new ActivationMachine(parseBinding(hotkey), mode);
  const acts: [number, ActivationOut][] = [];
  const swallowed: Script = [];
  let i = 0;
  for (let ms = 0; ms <= untilMs; ms += 10) {
    const out: ActivationOut[] = [];
    while (i < script.length && (script[i] as Script[number])[0] <= ms) {
      const [at, down, key] = script[i] as Script[number];
      if (m.key({ at, key, down }, out)) swallowed.push([at, down, key]);
      i++;
    }
    m.tick(ms, out);
    for (const o of out) acts.push([ms, o]);
  }
  return { acts, swallowed, m };
}

const sessions = (acts: [number, ActivationOut][]) => acts.filter(([, a]) => a.type !== "key");

const RC = "RightCommand";

describe("DC-A1", () => {
  test("down and up at 800 ms is one push-to-talk session ending at the up", () => {
    const { acts, swallowed } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [800, false, RC],
      ],
      1000,
    );
    expect(sessions(acts)).toEqual([
      [300, { type: "start", at: 0 }],
      [800, { type: "end", reason: "release" }],
    ]);
    expect(swallowed).toEqual([]);
  });

  test("a 120 ms tap latches; a second tap at 3 s ends the one session", () => {
    const { acts } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [120, false, RC],
        [3000, true, RC],
        [3100, false, RC],
      ],
      3500,
    );
    expect(sessions(acts)).toEqual([
      [120, { type: "start", at: 0 }],
      [3000, { type: "end", reason: "tap" }],
    ]);
  });

  test("Right Command+C within 120 ms is a copy, not a session, and C passes through", () => {
    const { acts, swallowed } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [40, true, "C"],
        [80, false, "C"],
        [120, false, RC],
      ],
      500,
    );
    expect(sessions(acts)).toEqual([]);
    expect(swallowed).toEqual([]);
  });

  test("positive control: the same presses without C latch", () => {
    const { acts, m } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [120, false, RC],
      ],
      500,
    );
    expect(sessions(acts)).toEqual([[120, { type: "start", at: 0 }]]);
    expect(m.listening).toBe(true);
  });

  test("a 1 s hold with C at 800 ms ends as cancel and passes C through", () => {
    const { acts, swallowed } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [800, true, "C"],
        [850, false, "C"],
        [1000, false, RC],
      ],
      1200,
    );
    expect(sessions(acts)).toEqual([
      [300, { type: "start", at: 0 }],
      [800, { type: "end", reason: "cancel" }],
    ]);
    expect(swallowed).toEqual([]);
  });

  test("hold mode never latches and toggle mode always does", () => {
    const hold = play(
      "RightShift",
      "hold",
      [
        [0, true, "RightShift"],
        [100, false, "RightShift"],
      ],
      300,
    );
    expect(sessions(hold.acts)).toEqual([
      [100, { type: "start", at: 0 }],
      [100, { type: "end", reason: "release" }],
    ]);
    const toggle = play(
      "RightShift",
      "toggle",
      [
        [0, true, "RightShift"],
        [900, false, "RightShift"],
      ],
      1000,
    );
    expect(sessions(toggle.acts)).toEqual([[900, { type: "start", at: 0 }]]);
  });

  test("a chord starts at key-down and swallows only its own key", () => {
    const { acts, swallowed } = play(
      "Control+Shift+Space",
      "hold-or-toggle",
      [
        [0, true, "LeftControl"],
        [10, true, "LeftShift"],
        [20, true, "Space"],
        [500, true, "A"],
        [520, false, "A"],
        [900, false, "Space"],
      ],
      1000,
    );
    expect(sessions(acts)).toEqual([
      [20, { type: "start", at: 20 }],
      [900, { type: "end", reason: "release" }],
    ]);
    expect(swallowed).toEqual([
      [20, true, "Space"],
      [900, false, "Space"],
    ]);
  });

  test("key repeat of a held key starts nothing more", () => {
    const { acts } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [30, true, RC],
        [60, true, RC],
        [900, false, RC],
      ],
      1000,
    );
    expect(sessions(acts)).toEqual([
      [300, { type: "start", at: 0 }],
      [900, { type: "end", reason: "release" }],
    ]);
  });
});

describe("DC-A4", () => {
  const latch: Script = [
    [0, true, RC],
    [100, false, RC],
  ];
  const withLatch = (extra: Script) => play(RC, "hold-or-toggle", [...latch, ...extra], 2000);

  test("in a session Escape cancels, Enter ends as key, Shift+Enter is reported; all swallowed", () => {
    const esc = withLatch([
      [500, true, "Escape"],
      [550, false, "Escape"],
    ]);
    expect(esc.acts).toContainEqual([500, { type: "key", name: "Escape" }]);
    expect(esc.acts).toContainEqual([500, { type: "end", reason: "cancel" }]);
    expect(esc.swallowed.length).toBe(2);
    const enter = withLatch([
      [500, true, "Enter"],
      [550, false, "Enter"],
    ]);
    expect(enter.acts).toContainEqual([500, { type: "end", reason: "key" }]);
    const shift = withLatch([
      [500, true, "LeftShift"],
      [520, true, "Enter"],
      [540, false, "Enter"],
      [560, false, "LeftShift"],
    ]);
    expect(shift.acts).toContainEqual([520, { type: "key", name: "Shift+Enter" }]);
    expect(shift.swallowed).toEqual([
      [520, true, "Enter"],
      [540, false, "Enter"],
    ]);
  });

  test("positive control: with no session the same keys pass", () => {
    const { acts, swallowed } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, "Escape"],
        [10, false, "Escape"],
        [20, true, "Enter"],
        [30, false, "Enter"],
      ],
      100,
    );
    expect(acts).toEqual([]);
    expect(swallowed).toEqual([]);
  });

  test("until the insert settles Enter is swallowed and the key starts nothing; after 8 s both pass", () => {
    const { acts, swallowed } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [800, false, RC],
        [1000, true, "Enter"],
        [1010, false, "Enter"],
        [1500, true, RC],
        [1600, false, RC],
        [9000, true, "Enter"],
        [9010, false, "Enter"],
      ],
      9100,
    );
    expect(acts).toContainEqual([1000, { type: "key", name: "Enter" }]);
    expect(acts).toContainEqual([1500, { type: "key", name: RC }]);
    expect(sessions(acts).length).toBe(2);
    expect(swallowed).toEqual([
      [1000, true, "Enter"],
      [1010, false, "Enter"],
    ]);
  });

  test("settled releases the keys at once", () => {
    const m = new ActivationMachine(parseBinding(RC), "hold-or-toggle");
    const out: ActivationOut[] = [];
    m.start(0, out);
    m.end("tap", 1, out);
    expect(m.key({ at: 2, key: "Enter", down: true }, out)).toBe(true);
    expect(m.key({ at: 3, key: "Enter", down: false }, out)).toBe(true);
    m.settled();
    expect(m.key({ at: 4, key: "Enter", down: true }, out)).toBe(false);
  });
});

test("bindings: a side-specific modifier or a chord, as the helper reads them", () => {
  expect(parseBinding("RightCommand")).toEqual({ kind: "modifier", key: "RightCommand" });
  expect(parseBinding("Control+Shift+Space")).toMatchObject({ kind: "chord", key: "Space" });
  expect(() => parseBinding("Shift")).toThrow(/needs a side/);
  expect(() => parseBinding("C")).toThrow(/every app/);
  expect(["RightCommand", "LeftOption", "RightControl", "Fn", "Shift"].every(isModifier)).toBe(
    true,
  );
  expect(["C", "Space", "Escape", "RightFn"].some(isModifier)).toBe(false);
});
