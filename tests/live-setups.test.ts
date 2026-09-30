/**
 * The live models a user chooses between (`asr.live`, akou-chp.23, live-setups.ts) and the second
 * pass (`asr.review.*`): which model the next call runs for each value, `auto` by the models on
 * disk, never one whose models are missing; the second pass only when the user chose it, only on
 * Nemotron's lines, only with its models here and, for Qwen, a Mac that allows it; the old
 * `upgrade` value read as that pair; and what the Models page and `GET /models` show. The models
 * on disk are injected; nothing here loads a model.
 */

import { describe, expect, test } from "bun:test";
import {
  chooseLiveSetup,
  isLiveCallSetting,
  isLiveSetting,
  LIVE_SETTINGS,
  LIVE_SETUPS,
  type LiveSetupContext,
  legacyLive,
  liveView,
  QWEN_MIN_MEMORY_GB,
  qwenRoom,
  reviewModels,
  setupModels,
} from "../src/main/asr/live-setups.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { RECOGNIZER } from "../src/main/asr/models.ts";
import { legacyValues, validateSetting } from "../src/main/config/schema.ts";

const RUNTIME = "llama-server-test-build";
const EVERYTHING = new Set(["nemotron-en-560", RECOGNIZER, QWEN_ASR, RUNTIME]);
const ROOMY = { gpu: true, memoryGb: QWEN_MIN_MEMORY_GB };
const NEMOTRON = { engine: "nemotron-en-560", lang: "en" };

function ctx(o: Partial<LiveSetupContext> & { on?: ReadonlySet<string> } = {}): LiveSetupContext {
  const on = o.on ?? EVERYTHING;
  return {
    setting: "auto",
    engine: "auto",
    languages: ["en"],
    present: (id) => on.has(id),
    runtime: RUNTIME,
    ...o,
  };
}

describe("[akou-chp.23] the live model the next call runs", () => {
  test("each value runs its own model when its files are here", () => {
    expect(chooseLiveSetup(ctx({ setting: "parakeet" }))).toEqual({
      setup: "parakeet",
      choice: null,
      review: null,
    });
    expect(chooseLiveSetup(ctx({ setting: "nemotron" }))).toEqual({
      setup: "nemotron",
      choice: NEMOTRON,
      review: null,
    });
  });

  test("auto picks streaming Nemotron when it is here, else Parakeet, and never a second pass by itself", () => {
    expect(chooseLiveSetup(ctx({ machine: ROOMY }))).toEqual({
      setup: "nemotron",
      choice: NEMOTRON,
      review: null,
    });
    const none = new Set([RECOGNIZER, QWEN_ASR, RUNTIME]);
    expect(chooseLiveSetup(ctx({ on: none })).setup).toBe("parakeet");
    // Positive control: the same roomy Mac with Qwen's review chosen runs it.
    expect(chooseLiveSetup(ctx({ machine: ROOMY, review: "qwen" })).review).toEqual({
      model: "qwen",
      everySeconds: 60,
    });
  });

  test("a named Nemotron that is not here falls back to Parakeet, and says why", () => {
    const nem = chooseLiveSetup(ctx({ setting: "nemotron", on: new Set([RECOGNIZER]) }));
    expect(nem.setup).toBe("parakeet");
    expect(nem.note).toContain("nemotron-en-560");
  });

  test("voxtral is listed, never a value; upgrade is a call's old spelling, never a setting", () => {
    expect(LIVE_SETTINGS).toEqual(["auto", "parakeet", "nemotron"]);
    expect(isLiveSetting("voxtral")).toBe(false);
    expect(validateSetting("asr.live", "voxtral").ok).toBe(false);
    for (const v of LIVE_SETTINGS) expect(validateSetting("asr.live", v).ok).toBe(true);
    expect(isLiveSetting("upgrade")).toBe(false);
    expect(isLiveCallSetting("upgrade")).toBe(true);
    expect(isLiveCallSetting("voxtral")).toBe(false);
    expect(LIVE_SETUPS.voxtral.unavailable).toContain("real-time factor 1.0");
  });

  test("the models each live model and second pass loads here", () => {
    expect(setupModels("parakeet", ctx())).toEqual([RECOGNIZER]);
    expect(setupModels("nemotron", ctx({ languages: ["es"] }))).toEqual(["nemotron-3.5-1120"]);
    expect(setupModels("voxtral", ctx())).toEqual([]);
    expect(reviewModels("qwen", ctx())).toEqual([QWEN_ASR, RUNTIME]);
    // An own llama-server needs no downloaded build.
    expect(reviewModels("qwen", ctx({ runtime: null }))).toEqual([QWEN_ASR]);
    expect(reviewModels("parakeet", ctx())).toEqual([RECOGNIZER]);
  });
});

describe("[ASR-7] the second pass the next call runs", () => {
  test("the chosen model and interval, on Nemotron's lines", () => {
    expect(chooseLiveSetup(ctx({ review: "parakeet", everySeconds: 120 }))).toEqual({
      setup: "nemotron",
      choice: NEMOTRON,
      review: { model: "parakeet", everySeconds: 120 },
    });
    expect(
      chooseLiveSetup(ctx({ review: "qwen", everySeconds: 300, machine: ROOMY })).review,
    ).toEqual({ model: "qwen", everySeconds: 300 });
    // `none` and no choice at all: no second pass.
    expect(chooseLiveSetup(ctx({ review: "none", machine: ROOMY })).review).toBeNull();
  });

  test("an interval out of bounds is kept inside them", () => {
    expect(chooseLiveSetup(ctx({ review: "parakeet", everySeconds: 5 })).review?.everySeconds).toBe(
      30,
    );
    expect(
      chooseLiveSetup(ctx({ review: "parakeet", everySeconds: 9999 })).review?.everySeconds,
    ).toBe(600);
  });

  test("neither reviews a call whose live model is Parakeet, and the note says so in plain words", () => {
    for (const review of ["qwen", "parakeet"]) {
      const c = chooseLiveSetup(ctx({ setting: "parakeet", review, machine: ROOMY }));
      expect([review, c.setup, c.review]).toEqual([review, "parakeet", null]);
      expect(c.note).toMatch(/Parakeet/);
    }
    // Nemotron not downloaded: the call falls back to Parakeet, and so has no second pass.
    const fell = chooseLiveSetup(ctx({ review: "parakeet", on: new Set([RECOGNIZER]) }));
    expect([fell.setup, fell.review]).toEqual(["parakeet", null]);
  });

  test("Qwen's review needs its models and runtime: a missing one says which, and the call runs none", () => {
    const cases: [string, LiveSetupContext, string][] = [
      [
        "no Qwen",
        ctx({
          review: "qwen",
          machine: ROOMY,
          on: new Set([...EVERYTHING].filter((id) => id !== QWEN_ASR)),
        }),
        QWEN_ASR,
      ],
      [
        "no runtime",
        ctx({
          review: "qwen",
          machine: ROOMY,
          on: new Set([...EVERYTHING].filter((id) => id !== RUNTIME)),
        }),
        RUNTIME,
      ],
    ];
    for (const [name, c, why] of cases) {
      const got = chooseLiveSetup(c);
      expect([name, got.setup, got.review]).toEqual([name, "nemotron", null]);
      expect([name, got.note]).toEqual([name, expect.stringContaining(why)]);
    }
  });

  test("a Mac with no GPU for Qwen or too little memory is told why the menus do not offer it, and a Qwen chosen anyway runs", () => {
    const cases: [string, LiveSetupContext, string][] = [
      ["cpu", ctx({ review: "qwen", machine: { ...ROOMY, gpu: false } }), "processor"],
      [
        "memory",
        ctx({ review: "qwen", machine: { ...ROOMY, memoryGb: QWEN_MIN_MEMORY_GB - 0.1 } }),
        "GB of memory",
      ],
    ];
    for (const [name, c, why] of cases) {
      expect([name, qwenRoom(c)]).toEqual([name, expect.stringContaining(why)]);
      expect([name, chooseLiveSetup(c).review?.model]).toEqual([name, "qwen"]);
      const view = liveView(c, null, () => "ready");
      expect([name, view.review.choices.find((x) => x.id === "qwen")?.blocked]).toEqual([
        name,
        expect.stringContaining(why),
      ]);
    }
    expect(qwenRoom(ctx({ machine: ROOMY }))).toBeNull();
    // Nothing known of the machine (the CLI's view): not held against it.
    expect(qwenRoom(ctx())).toBeNull();
  });

  test("Parakeet's pass runs only when Parakeet hears every one of the call's languages", () => {
    const on = new Set([...EVERYTHING, "nemotron-3.5-560"]);
    const run = (languages: string[]) =>
      chooseLiveSetup(ctx({ on, review: "parakeet", languages, engine: "nemotron-3.5-560" }));
    expect(run(["en", "es"]).review?.model).toBe("parakeet");
    const ja = run(["en", "ja"]);
    expect([ja.review, ja.note]).toEqual([
      null,
      expect.stringContaining("Parakeet does not hear ja."),
    ]);
    // Any language: nothing says which utterances Parakeet could hear, so it does not run.
    const any = run([]);
    expect([any.review, any.note]).toEqual([
      null,
      expect.stringContaining("name this call's languages in Settings"),
    ]);
    // Any language, but the live model hears English only: every utterance is English.
    expect(
      chooseLiveSetup(ctx({ on, review: "parakeet", languages: [], engine: "nemotron-en-560" }))
        .review?.model,
    ).toBe("parakeet");
    // Qwen hears them all: the same call reviews with it.
    expect(
      chooseLiveSetup(ctx({ on, review: "qwen", languages: ["ja"], engine: "nemotron-3.5-560" }))
        .review?.model,
    ).toBe("qwen");
    // The views say why, downloaded or not.
    const v = liveView(
      ctx({ on, languages: ["ja"], engine: "nemotron-3.5-560" }),
      null,
      () => "ready",
    );
    expect(v.review.choices.find((c) => c.id === "parakeet")?.blocked).toBe(
      "Parakeet does not hear ja.",
    );
  });

  test("the old `upgrade` is Nemotron with Qwen's second pass, for a call and in a file or a PATCH", () => {
    expect(legacyLive("upgrade", undefined)).toEqual({ live: "nemotron", review: "qwen" });
    // A call that names its own review keeps it.
    expect(legacyLive("upgrade", "parakeet")).toEqual({ live: "nemotron", review: "parakeet" });
    expect(legacyLive("parakeet", undefined)).toEqual({ live: "parakeet", review: undefined });
    expect(legacyValues({ "asr.live": "upgrade", "asr.languages": ["en"] })).toEqual({
      "asr.live": "nemotron",
      "asr.review.model": "qwen",
      "asr.languages": ["en"],
    });
    expect(legacyValues({ "asr.live": "upgrade", "asr.review.model": "none" })).toEqual({
      "asr.live": "nemotron",
      "asr.review.model": "none",
    });
    // Control: anything else goes through untouched.
    const same = { "asr.live": "auto" };
    expect(legacyValues(same)).toBe(same);
  });
});

describe("[akou-chp.23] what GET /models and the Models page show", () => {
  test("three models with the measured bars and their names, the next call's marked, missing models listed", () => {
    const on = new Set(["nemotron-en-560", RECOGNIZER]);
    const v = liveView(ctx({ on }), { setup: "parakeet", review: null }, (id) =>
      on.has(id) ? "ready" : "missing",
    );
    expect(v.setting).toBe("auto");
    expect(v.next).toBe("nemotron");
    expect(v.auto).toBe("nemotron");
    expect(v.running).toBe("parakeet");
    expect(v.setups.map((s) => [s.id, s.title])).toEqual([
      ["nemotron", "Nemotron English"],
      ["parakeet", "Parakeet"],
      ["voxtral", "Voxtral Realtime"],
    ]);
    // The name follows the Nemotron the languages pick.
    const es = liveView(ctx({ languages: ["es"] }), null, () => "ready");
    expect(es.setups[0]?.title).toBe("Nemotron 3.5");
    const by = Object.fromEntries(v.setups.map((s) => [s.id, s]));
    expect(v.setups.filter((s) => s.selected).map((s) => s.id)).toEqual(["nemotron"]);
    expect(v.setups.filter((s) => s.running).map((s) => s.id)).toEqual(["parakeet"]);
    // Accuracy 100 - 2 x AMI WER; latency 100 - 50 x seconds; cores 100 - 50 x cores; memory 100 - 6.25 x GB.
    const bars = (id: string) =>
      (["accuracy", "latency", "cores", "memory"] as const).map((k) => by[id]?.[k].score);
    expect(bars("parakeet")).toEqual([28, 61, 53, 78]);
    expect(bars("nemotron")).toEqual([62, 77, 81, 86]);
    expect(bars("voxtral")).toEqual([null, null, null, null]);
    expect(by.voxtral?.unavailable).toBeTruthy();
    expect(by.nemotron?.unavailable).toBeNull();
  });

  test("the second pass: its setting, the one the next call runs, and each choice with what stops it", () => {
    const on = new Set(["nemotron-en-560", RECOGNIZER]);
    const v = liveView(
      ctx({ on, review: "qwen", everySeconds: 120, machine: ROOMY }),
      { setup: "nemotron", review: { model: "parakeet", everySeconds: 60 } },
      (id) => (on.has(id) ? "ready" : "missing"),
    );
    expect(v.review.setting).toBe("qwen");
    expect(v.review.everySeconds).toBe(120);
    // Qwen is not downloaded: the next call runs none, and says why.
    expect(v.review.next).toBeNull();
    expect(v.note).toContain(QWEN_ASR);
    expect(v.review.running).toEqual({ model: "parakeet", everySeconds: 60 });
    const by = Object.fromEntries(v.review.choices.map((c) => [c.id, c]));
    expect(v.review.choices.map((c) => [c.id, c.title])).toEqual([
      ["qwen", "Qwen"],
      ["parakeet", "Parakeet"],
    ]);
    // Missing models are listed as models, not as a reason.
    expect(by.qwen?.models.map((m) => m.state)).toEqual(["missing", "missing"]);
    expect(by.qwen?.blocked).toBeNull();
    expect(by.parakeet?.blocked).toBeNull();
    // A Mac with too little memory: Qwen's reason in words.
    const small = liveView(ctx({ machine: { gpu: true, memoryGb: 8 } }), null, () => "ready");
    expect(small.review.choices.find((c) => c.id === "qwen")?.blocked).toBe(
      "Needs 16 GB of memory; this computer has 8 GB.",
    );
    // With Parakeet live and Qwen not downloaded, the reason still shows: no download would help.
    const pkMissing = liveView(
      ctx({ setting: "parakeet", on: new Set([RECOGNIZER]) }),
      null,
      (id) => (id === RECOGNIZER ? "ready" : "missing"),
    );
    expect(pkMissing.review.choices[0]?.blocked).toBe(
      "It reviews Nemotron's lines; the live model is Parakeet.",
    );
    // With Parakeet live, Parakeet's pass says why it is not offered.
    const pk = liveView(ctx({ setting: "parakeet" }), null, () => "ready");
    expect(pk.review.choices.find((c) => c.id === "parakeet")?.blocked).toBe(
      "Parakeet already writes the live lines.",
    );
  });
});
