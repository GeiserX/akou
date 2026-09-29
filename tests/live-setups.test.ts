/**
 * The live setups a user chooses between (`asr.live`, akou-chp.23, live-setups.ts): which one the
 * next call runs for each value, `auto` by the models on disk and never the upgrade, never a setup
 * whose models are missing, and what the Models page and `GET /models` show of each. The models on
 * disk are injected; nothing here loads a model.
 */

import { describe, expect, test } from "bun:test";
import {
  chooseLiveSetup,
  isLiveSetting,
  LIVE_SETTINGS,
  LIVE_SETUPS,
  type LiveSetupContext,
  liveView,
  setupModels,
} from "../src/main/asr/live-setups.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { RECOGNIZER } from "../src/main/asr/models.ts";
import { validateSetting } from "../src/main/config/schema.ts";

const RUNTIME = "llama-server-test-build";
const EVERYTHING = new Set(["nemotron-en-560", RECOGNIZER, QWEN_ASR, RUNTIME]);

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

describe("[akou-chp.23] the live setup the next call runs", () => {
  test("each value runs its own setup when its models are here", () => {
    expect(chooseLiveSetup(ctx({ setting: "parakeet" }))).toEqual({
      setup: "parakeet",
      choice: null,
    });
    expect(chooseLiveSetup(ctx({ setting: "nemotron" }))).toEqual({
      setup: "nemotron",
      choice: { engine: "nemotron-en-560", lang: "en" },
    });
    expect(chooseLiveSetup(ctx({ setting: "upgrade" }))).toEqual({
      setup: "upgrade",
      choice: { engine: "nemotron-en-560", lang: "en" },
    });
  });

  test("auto picks streaming Nemotron, never the upgrade, even with every upgrade model here", () => {
    expect(chooseLiveSetup(ctx())).toEqual({
      setup: "nemotron",
      choice: { engine: "nemotron-en-560", lang: "en" },
    });
    // An own llama-server, which needs no downloaded build, changes nothing.
    expect(chooseLiveSetup(ctx({ runtime: null })).setup).toBe("nemotron");
    // Positive control: the same machine with the upgrade named runs it.
    expect(chooseLiveSetup(ctx({ setting: "upgrade" })).setup).toBe("upgrade");
  });

  test("auto never picks a setup with a missing model", () => {
    for (const gone of [QWEN_ASR, RECOGNIZER, RUNTIME]) {
      const on = new Set([...EVERYTHING].filter((id) => id !== gone));
      expect([gone, chooseLiveSetup(ctx({ on })).setup]).toEqual([gone, "nemotron"]);
    }
    // No streaming model at all: Parakeet, whatever else is here.
    const none = new Set([RECOGNIZER, QWEN_ASR, RUNTIME]);
    expect(chooseLiveSetup(ctx({ on: none })).setup).toBe("parakeet");
  });

  test("a named setup that cannot run falls back, and says why", () => {
    const noQwen = new Set([...EVERYTHING].filter((id) => id !== QWEN_ASR));
    const up = chooseLiveSetup(ctx({ setting: "upgrade", on: noQwen }));
    expect(up.setup).toBe("nemotron");
    expect(up.note).toContain(QWEN_ASR);
    const nem = chooseLiveSetup(ctx({ setting: "nemotron", on: new Set([RECOGNIZER]) }));
    expect(nem.setup).toBe("parakeet");
    expect(nem.note).toContain("nemotron-en-560");
    // An own llama-server needs no downloaded build.
    const own = new Set([...EVERYTHING].filter((id) => id !== RUNTIME));
    expect(chooseLiveSetup(ctx({ setting: "upgrade", on: own, runtime: null })).setup).toBe(
      "upgrade",
    );
  });

  test("[ASR-7] the upgrade is built: it is listed as available, and runs when named with its models here", () => {
    expect(LIVE_SETUPS.upgrade.unavailable).toBeUndefined();
    expect(chooseLiveSetup(ctx({ setting: "upgrade" }))).toEqual({
      setup: "upgrade",
      choice: { engine: "nemotron-en-560", lang: "en" },
    });
  });

  test("voxtral is listed, never a value: the setting and a call's start refuse it", () => {
    expect(LIVE_SETTINGS).toEqual(["auto", "parakeet", "nemotron", "upgrade"]);
    expect(isLiveSetting("voxtral")).toBe(false);
    expect(validateSetting("asr.live", "voxtral").ok).toBe(false);
    for (const v of LIVE_SETTINGS) expect(validateSetting("asr.live", v).ok).toBe(true);
    expect(LIVE_SETUPS.voxtral.unavailable).toContain("real-time factor 1.0");
  });

  test("the models each setup loads here", () => {
    expect(setupModels("parakeet", ctx())).toEqual([RECOGNIZER]);
    expect(setupModels("nemotron", ctx({ languages: ["es"] }))).toEqual(["nemotron-3.5-1120"]);
    expect(setupModels("upgrade", ctx())).toEqual([
      "nemotron-en-560",
      RECOGNIZER,
      QWEN_ASR,
      RUNTIME,
    ]);
    expect(setupModels("voxtral", ctx())).toEqual([]);
  });
});

describe("[akou-chp.23] what GET /models and the Models page show of each setup", () => {
  test("four rows with the measured bars, the next call's marked, missing models listed", () => {
    const on = new Set(["nemotron-en-560", RECOGNIZER]);
    const v = liveView(ctx({ on }), "parakeet", (id) => (on.has(id) ? "ready" : "missing"));
    expect(v.setting).toBe("auto");
    expect(v.next).toBe("nemotron");
    expect(v.running).toBe("parakeet");
    expect(v.setups.map((s) => s.id)).toEqual(["parakeet", "nemotron", "upgrade", "voxtral"]);
    const by = Object.fromEntries(v.setups.map((s) => [s.id, s]));
    expect(v.setups.filter((s) => s.selected).map((s) => s.id)).toEqual(["nemotron"]);
    expect(v.setups.filter((s) => s.running).map((s) => s.id)).toEqual(["parakeet"]);
    // Accuracy 100 - 2 x AMI WER; latency 100 - 50 x seconds; cores 100 - 50 x cores; memory 100 - 6.25 x GB.
    const bars = (id: string) =>
      (["accuracy", "latency", "cores", "memory"] as const).map((k) => by[id]?.[k].score);
    expect(bars("parakeet")).toEqual([28, 61, 53, 78]);
    expect(bars("nemotron")).toEqual([62, 77, 81, 86]);
    expect(bars("upgrade")).toEqual([73, 77, null, 19]);
    expect(bars("voxtral")).toEqual([null, null, null, null]);
    expect(by.upgrade?.models.filter((m) => m.state === "missing").map((m) => m.id)).toEqual([
      QWEN_ASR,
      RUNTIME,
    ]);
    expect(by.voxtral?.unavailable).toBeTruthy();
    expect(by.nemotron?.unavailable).toBeNull();
  });
});
