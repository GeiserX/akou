/**
 * What the Record row's live panel shows (docs/ux/WINDOW.md W3.19, `src/ui/live-options.ts`),
 * without the DOM: each slot's models with the catalog's names and lines, which are downloaded,
 * the radio on what the next call runs (no Automatic row), the notes, and what the button and the
 * call header say. The browser suite (`tests/ui/live-picker.test.ts`) checks the same panel on the
 * real page.
 */

import { describe, expect, test } from "bun:test";
import type { LiveView, SlotEntry } from "../src/main/asr/live-setups.ts";
import type { ModelView } from "../src/main/server/model-store.ts";
import {
  buttonLabel,
  everyChoices,
  everyShort,
  liveChip,
  liveNote,
  reviewNote,
  runningLabel,
  sizeShort,
  slotRows,
} from "../src/ui/live-options.ts";

type State = ModelView["state"];
const none: ModelView["accuracy"] = { score: null, not_measured: "not measured" };

function row(
  id: string,
  name: string,
  lines: ModelView["lines"],
  state: State = "ready",
  o: Partial<ModelView> = {},
): ModelView {
  return {
    id,
    kind: "speech",
    job: id,
    name,
    short: null,
    lines,
    languages: null,
    streaming: false,
    after_call: false,
    from: [],
    state,
    bytes: state === "ready" ? 7e8 : 0,
    size: 7e8,
    last_used_at: null,
    evicts_at: null,
    default: false,
    in_use: false,
    accuracy: none,
    speed: none,
    measured: null,
    set_default: null,
    ...o,
  };
}

const NEM = "nemotron-3.5-560";
const STEADY = "nemotron-3.5-1120";
const PK = "parakeet-tdt-0.6b-v3-fp32";
const QWEN = "qwen3-asr-1.7b";
const RUNTIME = "llama-server-build";

function rows(states: Partial<Record<string, State>> = {}): ModelView[] {
  return [
    row(NEM, "Nemotron 3.5", { live: "Words appear as they are said." }, states[NEM]),
    row(STEADY, "Nemotron 3.5, 1 s", { live: "Waits about a second." }, states[STEADY]),
    row(PK, "Parakeet", { live: "Writes each sentence.", review: "Hears again." }, states[PK]),
    row(QWEN, "Qwen3-ASR", { review: "Rewrites the lines." }, states[QWEN], { short: "Qwen" }),
    row(RUNTIME, "", {}, states[RUNTIME], { size: 3e7 }),
  ];
}

const entry = (id: string, checked = false, models = [id], blocked: string | null = null) =>
  ({ id, models, checked, blocked }) satisfies SlotEntry;

function view(o: {
  setting?: string;
  live?: SlotEntry[];
  review?: SlotEntry[];
  reviewSetting?: string;
  next?: LiveView["review"]["next"];
  every?: number;
}): LiveView {
  return {
    setting: o.setting ?? "auto",
    next: "nemotron",
    note: null,
    running: null,
    runningId: null,
    setups: [],
    review: {
      setting: o.reviewSetting ?? "none",
      everySeconds: o.every ?? 60,
      next: o.next ?? null,
      running: null,
      choices: [],
    },
    advice: {},
    slots: {
      live: o.live ?? [entry(NEM, true), entry(STEADY), entry(PK)],
      review: o.review ?? [entry(QWEN, false, [QWEN, RUNTIME]), entry(PK)],
    },
  };
}

describe("W3.19: the live panel's slots", () => {
  test("each slot lists its models by the catalog's name and line, no Automatic row", () => {
    const v = view({});
    const live = slotRows(v, rows({ [STEADY]: "missing" }), "live");
    expect(live.map((r) => [r.id, r.name, r.line, r.state, r.checked])).toEqual([
      [NEM, "Nemotron 3.5", "Words appear as they are said.", "ready", true],
      [STEADY, "Nemotron 3.5, 1 s", "Waits about a second.", "missing", false],
      [PK, "Parakeet", "Writes each sentence.", "ready", false],
    ]);
    expect(live.some((r) => r.id === "auto")).toBe(false);
    // The second pass takes each model's own line for that slot.
    expect(slotRows(v, rows(), "review").map((r) => [r.name, r.line])).toEqual([
      ["Qwen3-ASR", "Rewrites the lines."],
      ["Parakeet", "Hears again."],
    ]);
  });

  test("a model that needs two downloads is here only when both are, and its size is both", () => {
    const v = view({});
    const [qwen] = slotRows(v, rows({ [RUNTIME]: "missing" }), "review");
    expect([qwen?.state, qwen?.size]).toEqual(["missing", 7e8 + 3e7]);
    const [going] = slotRows(v, rows({ [QWEN]: "downloading" }), "review");
    expect(going?.state).toBe("downloading");
  });

  test("the button: the model the next call runs, and the second pass dim beside it", () => {
    expect(buttonLabel(view({}), rows())).toEqual({
      name: "Nemotron 3.5",
      extra: null,
      none: false,
    });
    const on = view({
      review: [entry(QWEN, true, [QWEN, RUNTIME]), entry(PK)],
      next: { model: "qwen", everySeconds: 120 },
    });
    expect(buttonLabel(on, rows())).toEqual({
      name: "Nemotron 3.5",
      extra: "+ Qwen 2 min",
      none: false,
    });
    // No live model downloaded: "no model".
    const bare = rows({ [NEM]: "missing", [STEADY]: "missing", [PK]: "missing" });
    expect(buttonLabel(view({ live: [entry(NEM), entry(STEADY), entry(PK)] }), bare)).toEqual({
      name: "no model",
      extra: null,
      none: true,
    });
  });

  test("a saved model that is not here: the note names what runs until it is", () => {
    const v = view({ setting: STEADY, live: [entry(NEM, true), entry(STEADY), entry(PK)] });
    expect(liveNote(v, rows({ [STEADY]: "missing" }))).toBe(
      "Nemotron 3.5, 1 s is not downloaded, so calls run Nemotron 3.5 until it is.",
    );
    expect(liveNote(view({}), rows())).toBeNull();
  });

  test("a saved second pass that cannot run says why; Off says nothing", () => {
    expect(reviewNote(view({ reviewSetting: QWEN }), rows({ [QWEN]: "missing" }))).toBe(
      "Qwen3-ASR is not downloaded, so calls run with no second pass until it is.",
    );
    const blocked = view({
      reviewSetting: "parakeet",
      review: [
        entry(QWEN, false, [QWEN, RUNTIME]),
        entry(PK, false, [PK], "Parakeet already writes the live lines."),
      ],
    });
    expect(reviewNote(blocked, rows())).toBe(
      "Parakeet is chosen, but calls run with no second pass: parakeet already writes the live lines.",
    );
    expect(reviewNote(view({}), rows())).toBeNull();
  });

  test("while a call records, the button and the header chip say what that call runs", () => {
    const live = {
      setup: "nemotron",
      engine: NEM,
      name: "Nemotron 3.5",
      review: { model: "qwen", everySeconds: 120 },
      reviewName: "Qwen",
    };
    expect(runningLabel(live)).toEqual({ name: "Nemotron 3.5", extra: "+ Qwen 2 min" });
    expect(liveChip(live)).toBe("Live: Nemotron 3.5 + Qwen 2 min");
    expect(liveChip({ setup: "parakeet", name: "Parakeet" })).toBe("Live: Parakeet");
    expect(liveChip({ setup: null })).toBeNull();
    expect([everyShort(60), everyShort(300), everyShort(90)]).toEqual(["1 min", "5 min", "90 s"]);
    expect([sizeShort(7.3e8), sizeShort(2.55e9), sizeShort(4e7)]).toEqual([
      "0.7 GB",
      "2.5 GB",
      "40 MB",
    ]);
  });

  test("an interval saved elsewhere (90 s, 10 min) shows as itself beside the three offered", () => {
    expect(everyChoices(120)).toEqual([60, 120, 300]);
    expect(everyChoices(90)).toEqual([60, 90, 120, 300]);
    expect(everyChoices(600)).toEqual([60, 120, 300, 600]);
  });
});
