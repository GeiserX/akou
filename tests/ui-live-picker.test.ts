/**
 * What the Record row's live model menu lists (docs/ux/WINDOW.md W3.19, `src/ui/live-options.ts`),
 * without the DOM: the live models by name, a model that is not downloaded dim, never an
 * unavailable one, no Automatic line, the check on what `auto` resolves to, and the second pass's
 * choices and line. The browser suite (`tests/ui/live-picker.test.ts`) checks the same menu on the
 * real page.
 */

import { describe, expect, test } from "bun:test";
import type {
  LiveSetupView,
  LiveView,
  ReviewChoiceView,
  ReviewRun,
} from "../src/main/asr/live-setups.ts";
import {
  liveChecked,
  liveChip,
  liveNote,
  liveOptions,
  reviewChecked,
  reviewLabel,
  reviewNote,
  reviewOptions,
} from "../src/ui/live-options.ts";

type State = "ready" | "downloading" | "missing";
const none: LiveSetupView["accuracy"] = { score: null, not_measured: "not measured" };
const TITLES: Record<string, string> = {
  nemotron: "Nemotron 3.5",
  parakeet: "Parakeet",
  voxtral: "Voxtral Realtime",
};

function setup(id: LiveSetupView["id"], models: State[], unavailable: string | null = null) {
  return {
    id,
    title: TITLES[id] ?? id,
    what: id,
    plain: id,
    line: `${id} line`,
    unavailable,
    selected: false,
    running: false,
    models: models.map((state, i) => ({ id: `${id}-${i}`, state })),
    accuracy: none,
    latency: none,
    cores: none,
    memory: none,
  } satisfies LiveSetupView;
}

function choice(id: ReviewChoiceView["id"], models: State[], blocked: string | null = null) {
  return {
    id,
    title: "Qwen",
    what: id,
    plain: `${id} plain`,
    line: `${id} line`,
    models: models.map((state, i) => ({ id: `${id}-${i}`, state })),
    blocked,
  } satisfies ReviewChoiceView;
}

function view(
  setting: LiveView["setting"],
  next: LiveView["next"],
  s: { parakeet: State[]; nemotron: State[] },
  review: Partial<LiveView["review"]> = {},
): LiveView {
  return {
    setting,
    next,
    note: null,
    running: null,
    setups: [
      setup("nemotron", s.nemotron),
      setup("parakeet", s.parakeet),
      // Voxtral lists no models and is unavailable: never a line, whatever the disk holds.
      setup("voxtral", [], "not in this version"),
    ],
    review: {
      setting: "none",
      everySeconds: 60,
      next: null,
      running: null,
      choices: [choice("qwen", ["ready", "ready"])],
      ...review,
    },
  };
}

const ids = (v: LiveView) => liveOptions(v).map((o) => [o.id, o.title, o.ready]);

describe("W3.19: the live model menu's lines", () => {
  test("the models by name, Nemotron first, no Automatic line, never Voxtral", () => {
    const v = view("auto", "nemotron", { parakeet: ["ready"], nemotron: ["ready"] });
    expect(ids(v)).toEqual([
      ["nemotron", "Nemotron 3.5", true],
      ["parakeet", "Parakeet", true],
    ]);
    expect(liveOptions(v).map((o) => o.line)).toEqual(["nemotron line", "parakeet line"]);
  });

  test("a model not downloaded, or still downloading, is listed but cannot be picked", () => {
    const v = view("auto", "parakeet", { parakeet: ["ready"], nemotron: ["downloading"] });
    expect(ids(v)).toEqual([
      ["nemotron", "Nemotron 3.5", false],
      ["parakeet", "Parakeet", true],
    ]);
    expect(liveChecked(v, liveOptions(v))).toBe("parakeet");
  });

  test("nothing downloaded: no line at all", () => {
    const v = view("auto", "parakeet", { parakeet: ["missing"], nemotron: ["missing"] });
    expect(liveOptions(v)).toEqual([]);
    expect(liveChecked(v, liveOptions(v))).toBeNull();
    expect(liveNote(v, liveOptions(v))).toBeNull();
  });

  test("with auto the check sits on what auto resolves to; a named model on itself", () => {
    const both = { parakeet: ["ready"] as State[], nemotron: ["ready"] as State[] };
    const auto = view("auto", "nemotron", both);
    expect(liveChecked(auto, liveOptions(auto))).toBe("nemotron");
    const fell = view("auto", "parakeet", { ...both, nemotron: ["missing"] });
    expect(liveChecked(fell, liveOptions(fell))).toBe("parakeet");
    const named = view("parakeet", "parakeet", both);
    expect(liveChecked(named, liveOptions(named))).toBe("parakeet");
    expect(liveNote(named, liveOptions(named))).toBeNull();
  });

  test("a saved model that is not here checks nothing, with a note naming what runs", () => {
    const gone = view("nemotron", "parakeet", { parakeet: ["ready"], nemotron: ["missing"] });
    expect(liveChecked(gone, liveOptions(gone))).toBeNull();
    expect(liveNote(gone, liveOptions(gone))).toBe(
      "Nemotron 3.5 is not downloaded, so calls run Parakeet until it is.",
    );
  });
});

describe("W3.19: the second pass in the menu", () => {
  const both = { parakeet: ["ready"] as State[], nemotron: ["ready"] as State[] };
  const run = (model: ReviewRun["model"], everySeconds = 120): ReviewRun => ({
    model,
    everySeconds,
  });

  test("Off, then Qwen; its line names the model and how often", () => {
    const off = view("auto", "nemotron", both);
    expect(reviewOptions(off).map((o) => [o.id, o.title, o.state])).toEqual([
      ["none", "Off", "ready"],
      ["qwen", "Qwen", "ready"],
    ]);
    expect(reviewLabel(off)).toBe("Off");
    expect(reviewChecked(off, reviewOptions(off))).toBe("none");
    const on = view("auto", "nemotron", both, { setting: "qwen", next: run("qwen") });
    expect(reviewLabel(on)).toBe("Qwen, every 2 min");
    expect(reviewChecked(on, reviewOptions(on))).toBe("qwen");
  });

  test("Qwen not downloaded is dim with Get, and chosen it checks nothing and says calls run without it", () => {
    const v = view("auto", "nemotron", both, {
      setting: "qwen",
      choices: [choice("qwen", ["ready", "missing"])],
    });
    const o = reviewOptions(v);
    expect(o.map((x) => [x.id, x.state])).toEqual([
      ["none", "ready"],
      ["qwen", "missing"],
    ]);
    expect(reviewChecked(v, o)).toBeNull();
    expect(reviewNote(v, o)).toBe(
      "Qwen is not downloaded, so calls run with no second pass until it is.",
    );
    expect(reviewLabel(v)).toBe("Off");
  });

  test("Qwen the Mac is not offered on is dim with the reason; chosen anyway it runs, and keeps its check", () => {
    const why = "Needs 16 GB of memory; this computer has 8 GB.";
    const offered = view("auto", "nemotron", both, { choices: [choice("qwen", ["ready"], why)] });
    expect(reviewOptions(offered)[1]).toEqual({
      id: "qwen",
      title: "Qwen",
      line: why,
      state: "blocked",
      why,
    });
    const chosen = view("auto", "nemotron", both, {
      setting: "qwen",
      next: run("qwen"),
      choices: [choice("qwen", ["ready"], why)],
    });
    expect(reviewChecked(chosen, reviewOptions(chosen))).toBe("qwen");
    expect(reviewNote(chosen, reviewOptions(chosen))).toBeNull();
    expect(reviewLabel(chosen)).toBe("Qwen, every 2 min");
  });

  test("the call header's chip: the model by name, and the second pass when on", () => {
    expect(liveChip({ setup: "nemotron", engine: "nemotron-3.5-560" })).toBe("Live: Nemotron 3.5");
    expect(
      liveChip({
        setup: "nemotron",
        engine: "nemotron-en-560",
        review: { model: "qwen", everySeconds: 120 },
      }),
    ).toBe("Live: Nemotron English, Qwen every 2 min");
    expect(liveChip({ setup: "parakeet", engine: null })).toBe("Live: Parakeet");
    expect(liveChip({ setup: null })).toBeNull();
  });
});
