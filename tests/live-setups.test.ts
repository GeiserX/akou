/**
 * The live setups a user chooses between (`asr.live`, akou-chp.23, live-setups.ts): which one the
 * next call runs for each value, `auto` by memory and by the models on disk, never a setup whose
 * models are missing, and what the Models page and `GET /models` show of each. Memory and the
 * models on disk are injected; nothing here loads a model.
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
  UPGRADE_MIN_BYTES,
} from "../src/main/asr/live-setups.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { RECOGNIZER } from "../src/main/asr/models.ts";
import { validateSetting } from "../src/main/config/schema.ts";

const GB16 = 16 * 2 ** 30;
const GB8 = 8 * 2 ** 30;
const RUNTIME = "llama-server-test-build";
const EVERYTHING = new Set(["nemotron-en-560", RECOGNIZER, QWEN_ASR, RUNTIME]);

function ctx(o: Partial<LiveSetupContext> & { on?: ReadonlySet<string> } = {}): LiveSetupContext {
  const on = o.on ?? EVERYTHING;
  return {
    setting: "auto",
    engine: "auto",
    languages: ["en"],
    memoryBytes: GB16,
    present: (id) => on.has(id),
    runtime: RUNTIME,
    ...o,
  };
}

/** The in-call upgrade counted as built: how `auto` behaves once it is (ASR-7). */
const built = () => true;

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
    expect(chooseLiveSetup(ctx({ setting: "upgrade", built }))).toEqual({
      setup: "upgrade",
      choice: { engine: "nemotron-en-560", lang: "en" },
    });
  });

  test("auto picks upgrade on a 16 GB machine and nemotron on an 8 GB one, the rest the same", () => {
    expect(chooseLiveSetup(ctx({ built, memoryBytes: GB16 })).setup).toBe("upgrade");
    expect(chooseLiveSetup(ctx({ built, memoryBytes: GB8 })).setup).toBe("nemotron");
    // A 16 GB Linux box reports a little under 16 GiB.
    expect(chooseLiveSetup(ctx({ built, memoryBytes: 15.5 * 2 ** 30 })).setup).toBe("upgrade");
    expect(chooseLiveSetup(ctx({ built, memoryBytes: UPGRADE_MIN_BYTES - 1 })).setup).toBe(
      "nemotron",
    );
  });

  test("auto never picks a setup with a missing model", () => {
    for (const gone of [QWEN_ASR, RECOGNIZER, RUNTIME]) {
      const on = new Set([...EVERYTHING].filter((id) => id !== gone));
      expect([gone, chooseLiveSetup(ctx({ built, on })).setup]).toEqual([gone, "nemotron"]);
    }
    // No streaming model at all: Parakeet, whatever else is here.
    const none = new Set([RECOGNIZER, QWEN_ASR, RUNTIME]);
    expect(chooseLiveSetup(ctx({ built, on: none })).setup).toBe("parakeet");
    // An own llama-server needs no downloaded build.
    const own = new Set([...EVERYTHING].filter((id) => id !== RUNTIME));
    expect(chooseLiveSetup(ctx({ built, on: own, runtime: null })).setup).toBe("upgrade");
  });

  test("a named setup that cannot run falls back, and says why", () => {
    const noQwen = new Set([...EVERYTHING].filter((id) => id !== QWEN_ASR));
    const up = chooseLiveSetup(ctx({ setting: "upgrade", built, on: noQwen }));
    expect(up.setup).toBe("nemotron");
    expect(up.note).toContain(QWEN_ASR);
    const nem = chooseLiveSetup(ctx({ setting: "nemotron", on: new Set([RECOGNIZER]) }));
    expect(nem.setup).toBe("parakeet");
    expect(nem.note).toContain("nemotron-en-560");
    // Named on purpose, upgrade runs whatever the memory: `auto` is the one that asks for 16 GB.
    expect(chooseLiveSetup(ctx({ setting: "upgrade", built, memoryBytes: GB8 })).setup).toBe(
      "upgrade",
    );
  });

  test("until the in-call upgrade is built, auto runs nemotron and a call asked for upgrade says so", () => {
    expect(LIVE_SETUPS.upgrade.unavailable).toContain("not built yet");
    expect(chooseLiveSetup(ctx()).setup).toBe("nemotron");
    const asked = chooseLiveSetup(ctx({ setting: "upgrade" }));
    expect(asked.setup).toBe("nemotron");
    expect(asked.note).toContain("not built yet");
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
