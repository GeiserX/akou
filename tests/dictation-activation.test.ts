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
  parseExtraBinding,
  type ShortcutName,
} from "../src/core/dictation/activation.ts";

type Script = [number, boolean, string][];

/** Plays `[ms, down, key]` with a tick every 10 ms: the actions with their time, and the swallowed keys. */
function play(
  hotkey: string,
  mode: Activation,
  script: Script,
  untilMs: number,
  more: { draft?: string; shortcuts?: [ShortcutName, string][] } = {},
) {
  const m = new ActivationMachine(
    parseBinding(hotkey),
    mode,
    more.draft ? parseExtraBinding(more.draft) : null,
    (more.shortcuts ?? []).map(([n, k]) => [n, parseExtraBinding(k)]),
  );
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

const sessions = (acts: [number, ActivationOut][]) =>
  acts.filter(([, a]) => a.type === "start" || a.type === "end");

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

  test("Enter during a confirmed hold ends it as key and is swallowed; before HOLD_MS it is the interrupt rule", () => {
    const held = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [800, true, "Enter"],
        [850, false, "Enter"],
        [1000, false, RC],
      ],
      1200,
    );
    expect(sessions(held.acts)).toEqual([
      [300, { type: "start", at: 0 }],
      [800, { type: "end", reason: "key" }],
    ]);
    expect(held.acts).toContainEqual([800, { type: "key", name: "Enter" }]);
    expect(held.swallowed).toEqual([
      [800, true, "Enter"],
      [850, false, "Enter"],
    ]);
    // Positive control: the same Enter under HOLD_MS is a shortcut, not a session.
    const early = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [100, true, "Enter"],
        [150, false, "Enter"],
        [200, false, RC],
      ],
      500,
    );
    expect(sessions(early.acts)).toEqual([]);
    expect(early.swallowed).toEqual([]);
  });

  test("the hotkey's own Shift does not make Enter Shift+Enter", () => {
    const { acts } = play(
      "RightShift",
      "hold-or-toggle",
      [
        [0, true, "RightShift"],
        [800, true, "Enter"],
      ],
      900,
    );
    expect(acts).toContainEqual([800, { type: "key", name: "Enter" }]);
  });

  test("the Shift of a held chord does not make Enter Shift+Enter; a Shift pressed again in a latched chord session does", () => {
    const CSS = "Control+Shift+Space";
    const held = play(
      CSS,
      "hold-or-toggle",
      [
        [0, true, "LeftControl"],
        [10, true, "LeftShift"],
        [20, true, "Space"],
        [800, true, "Enter"],
      ],
      900,
    );
    expect(held.acts).toContainEqual([800, { type: "key", name: "Enter" }]);
    expect(held.acts).toContainEqual([800, { type: "end", reason: "key" }]);
    const latched = play(
      CSS,
      "hold-or-toggle",
      [
        [0, true, "LeftControl"],
        [10, true, "LeftShift"],
        [20, true, "Space"],
        [100, false, "Space"],
        [110, false, "LeftShift"],
        [120, false, "LeftControl"],
        [500, true, "LeftShift"],
        [520, true, "Enter"],
      ],
      600,
    );
    expect(latched.acts).toContainEqual([520, { type: "key", name: "Shift+Enter" }]);
    // A chord whose Shift has a side leaves the other Shift a Shift.
    const sided = play(
      "Control+RightShift+Space",
      "hold-or-toggle",
      [
        [0, true, "LeftControl"],
        [10, true, "RightShift"],
        [20, true, "Space"],
        [500, true, "LeftShift"],
        [520, true, "Enter"],
      ],
      600,
    );
    expect(sided.acts).toContainEqual([520, { type: "key", name: "Shift+Enter" }]);
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

describe("DC-A3: the helper says when a session latches", () => {
  const latches = (acts: [number, ActivationOut][]) =>
    acts.filter(([, a]) => a.type === "start" || a.type === "latched");
  const tap: Script = [
    [0, true, RC],
    [120, false, RC],
  ];

  test("a tap says latched right after its start; a push-to-talk hold never does", () => {
    expect(latches(play(RC, "hold-or-toggle", tap, 500).acts)).toEqual([
      [120, { type: "start", at: 0 }],
      [120, { type: "latched" }],
    ]);
    const held = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [800, false, RC],
      ],
      1000,
    );
    expect(held.acts.some(([, a]) => a.type === "latched")).toBe(false);
    expect(play(RC, "hold", tap, 500).acts.some(([, a]) => a.type === "latched")).toBe(false);
  });

  test("toggle always latches, and a chord let go before HOLD_MS latches", () => {
    const toggle = play(
      RC,
      "toggle",
      [
        [0, true, RC],
        [900, false, RC],
      ],
      1000,
    );
    expect(toggle.acts).toContainEqual([900, { type: "latched" }]);
    const chord = (up: number) =>
      play(
        "Control+Space",
        "hold-or-toggle",
        [
          [0, true, "LeftControl"],
          [10, true, "Space"],
          [up, false, "Space"],
        ],
        1000,
      ).acts;
    expect(chord(100)).toContainEqual([100, { type: "latched" }]);
    expect(chord(900).some(([, a]) => a.type === "latched")).toBe(false);
  });
});

describe("DC-A6: mouse buttons 3 to 5 as the dictation key", () => {
  test("Mouse3 to Mouse5 bind as a button alone; the left and right buttons are refused", () => {
    expect(parseBinding("Mouse4")).toEqual({ kind: "chord", mods: [], key: "Mouse4" });
    expect(parseBinding("mouse5")).toEqual({ kind: "chord", mods: [], key: "Mouse5" });
    expect(parseBinding("Mouse3").kind).toBe("chord");
    expect(() => parseBinding("Mouse1")).toThrow(/left button/);
    expect(() => parseBinding("Mouse2")).toThrow(/right button/);
    expect(() => parseBinding("Control+Mouse1")).toThrow(/left button/);
    expect(parseBinding("Control+Mouse4")).toMatchObject({ kind: "chord", key: "Mouse4" });
    expect(() => parseBinding("Mouse6")).toThrow(/every app/);
    expect(() => parseBinding("WheelUp")).toThrow(/every app/);
  });

  test("a button held runs a session from its down to its up, and both are swallowed", () => {
    const { acts, swallowed } = play(
      "Mouse4",
      "hold-or-toggle",
      [
        [0, true, "Mouse4"],
        [900, false, "Mouse4"],
      ],
      1000,
    );
    expect(sessions(acts)).toEqual([
      [0, { type: "start", at: 0 }],
      [900, { type: "end", reason: "release" }],
    ]);
    expect(swallowed).toEqual([
      [0, true, "Mouse4"],
      [900, false, "Mouse4"],
    ]);
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

describe("DC-O1: the press the pill's dot follows", () => {
  const presses = (acts: [number, ActivationOut][]) =>
    acts.filter(([, a]) => a.type === "arm" || a.type === "disarm" || a.type === "start");

  test("a modifier arms at its down and starts at the hold; another key during it disarms", () => {
    const held = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [800, false, RC],
      ],
      1000,
    );
    expect(presses(held.acts)).toEqual([
      [0, { type: "arm", at: 0 }],
      [300, { type: "start", at: 0 }],
    ]);
    const shortcut = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [40, true, "C"],
        [80, false, "C"],
        [100, false, RC],
      ],
      500,
    );
    expect(presses(shortcut.acts)).toEqual([
      [0, { type: "arm", at: 0 }],
      [40, { type: "disarm" }],
    ]);
  });

  test("a chord arms and starts at once; the door's start arms too", () => {
    const chord = play(
      "Control+Shift+Space",
      "hold-or-toggle",
      [
        [0, true, "LeftControl"],
        [10, true, "LeftShift"],
        [20, true, "Space"],
        [500, false, "Space"],
      ],
      600,
    );
    expect(presses(chord.acts)).toEqual([
      [20, { type: "arm", at: 20 }],
      [20, { type: "start", at: 20 }],
    ]);
    const m = new ActivationMachine(parseBinding(RC), "hold-or-toggle");
    const out: ActivationOut[] = [];
    m.start(5, out);
    expect(out).toEqual([{ type: "arm", at: 5 }, { type: "start", at: 5 }, { type: "latched" }]);
  });
});

/** The Rust tests' DC-A5 and DC-S3 tables, row for row. */
describe("DC-A5 and DC-S3: the other keys", () => {
  const FIX: [ShortcutName, string] = ["fixLast", "Shift+RightCommand"];
  const presses = (acts: [number, ActivationOut][]) => acts.filter(([, a]) => a.type !== "key");

  test("Shift then the dictation key is fix last at the release, held short or long", () => {
    for (const up of [150, 900]) {
      const { acts, swallowed } = play(
        RC,
        "hold-or-toggle",
        [
          [0, true, "LeftShift"],
          [50, true, RC],
          [up, false, RC],
          [up + 50, false, "LeftShift"],
        ],
        1200,
        { shortcuts: [FIX] },
      );
      expect(presses(acts)).toEqual([[up, { type: "shortcut", name: "fixLast" }]]);
      expect(swallowed).toEqual([]);
    }
  });

  test("the dictation key then Shift is the interrupt; unbound, Shift then the key dictates", () => {
    const { acts } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, RC],
        [50, true, "LeftShift"],
        [150, false, RC],
        [200, false, "LeftShift"],
      ],
      1000,
      { shortcuts: [FIX] },
    );
    expect(presses(acts)).toEqual([
      [0, { type: "arm", at: 0 }],
      [50, { type: "disarm" }],
    ]);
    const control = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, "LeftShift"],
        [50, true, RC],
        [150, false, RC],
      ],
      1000,
    );
    expect(sessions(control.acts)).toEqual([[150, { type: "start", at: 50 }]]);
  });

  test("another key during fix last's press is the interrupt", () => {
    const { acts, swallowed } = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, "LeftShift"],
        [50, true, RC],
        [100, true, "4"],
        [120, false, "4"],
        [150, false, RC],
      ],
      1000,
      { shortcuts: [FIX] },
    );
    expect(presses(acts)).toEqual([]);
    expect(swallowed).toEqual([]);
  });

  test("paste last as a chord counts at its key-down and is swallowed; unbound it passes", () => {
    const script: Script = [
      [0, true, "LeftControl"],
      [10, true, "LeftShift"],
      [20, true, "V"],
      [60, false, "V"],
      [80, false, "LeftShift"],
      [90, false, "LeftControl"],
    ];
    const bound = play(RC, "hold-or-toggle", script, 500, {
      shortcuts: [FIX, ["pasteLast", "Control+Shift+V"]],
    });
    expect(presses(bound.acts)).toEqual([[20, { type: "shortcut", name: "pasteLast" }]]);
    expect(bound.swallowed).toEqual([
      [20, true, "V"],
      [60, false, "V"],
    ]);
    const unbound = play(RC, "hold-or-toggle", script, 500, { shortcuts: [FIX] });
    expect(presses(unbound.acts)).toEqual([]);
    expect(unbound.swallowed).toEqual([]);
  });

  test("the draft key presses like the dictation key and says draft first", () => {
    const starts = (acts: [number, ActivationOut][]) =>
      acts.filter(([, a]) => a.type === "draft" || a.type === "start" || a.type === "end");
    const tap = (key: string): Script => [
      [0, true, key],
      [120, false, key],
      [3000, true, key],
      [3080, false, key],
    ];
    const more = { draft: "RightOption", shortcuts: [FIX] };
    expect(starts(play(RC, "hold-or-toggle", tap("RightOption"), 3200, more).acts)).toEqual([
      [120, { type: "draft" }],
      [120, { type: "start", at: 0 }],
      [3000, { type: "end", reason: "tap" }],
    ]);
    const hold: Script = [
      [0, true, "RightOption"],
      [800, false, "RightOption"],
    ];
    expect(starts(play(RC, "hold-or-toggle", hold, 1000, more).acts)).toEqual([
      [300, { type: "draft" }],
      [300, { type: "start", at: 0 }],
      [800, { type: "end", reason: "release" }],
    ]);
    expect(starts(play(RC, "hold-or-toggle", tap(RC), 3200, more).acts)).toEqual([
      [120, { type: "start", at: 0 }],
      [3000, { type: "end", reason: "tap" }],
    ]);
    const chord = play(
      RC,
      "hold-or-toggle",
      [
        [0, true, "LeftControl"],
        [10, true, "LeftShift"],
        [20, true, "D"],
        [900, false, "D"],
      ],
      1000,
      { draft: "Control+Shift+D", shortcuts: [FIX] },
    );
    expect(starts(chord.acts)).toEqual([
      [20, { type: "draft" }],
      [20, { type: "start", at: 20 }],
      [900, { type: "end", reason: "release" }],
    ]);
    expect(chord.swallowed).toEqual([
      [20, true, "D"],
      [900, false, "D"],
    ]);
  });

  test("the other keys read a modifier after the held ones; the dictation key does not", () => {
    expect(parseExtraBinding("Shift+RightCommand")).toEqual({
      kind: "chord",
      mods: [["Shift", "Either"]],
      key: "RightCommand",
    });
    expect(() => parseExtraBinding("Shift+Command")).toThrow();
    expect(() => parseExtraBinding("Shift+RightShift")).toThrow();
    expect(parseExtraBinding("Control+Shift+Period")).toEqual(parseBinding("Control+Shift+Period"));
    expect(() => parseBinding("Shift+RightCommand")).toThrow();
  });
});
