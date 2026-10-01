/**
 * The speech models the chosen setups use (model-set.ts): Parakeet only when a setup uses it, so a
 * Mac that runs Nemotron live and Qwen after the call never needs it; `auto` keeps what is on disk,
 * so an upgrade asks for no new download; and `modelsFor` with that list is the helpers plus
 * exactly those. Nothing here touches a file: what is on disk is injected.
 */

import { describe, expect, test } from "bun:test";
import type { ModelSet } from "../src/main/asr/engine.ts";
import { LivePipeline } from "../src/main/asr/live-worker.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import {
  chosenModels,
  intendedFinal,
  keptModels,
  type ModelSetContext,
  type ModelSetSettings,
} from "../src/main/asr/model-set.ts";
import { MODELS, modelsFor, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { createModels } from "./fixtures/asr-fake.ts";

const BUILD = "llama-server-b11200-darwin-arm64-metal";
const ROOMY = { gpu: true, memoryGb: 24 };
const SETTINGS: ModelSetSettings = {
  "asr.live": "auto",
  "asr.live.engine": "auto",
  "asr.languages": ["en", "es"],
  "asr.review.model": "none",
  "asr.final.model": "auto",
  "dictation.enabled": true,
  "dictation.engine": "auto",
  "dictation.final": "live",
};

function ctx(
  on: readonly string[],
  o: { settings?: Partial<ModelSetSettings>; machine?: ModelSetContext["machine"] | null } = {},
): ModelSetContext {
  return {
    settings: { ...SETTINGS, ...o.settings },
    present: (id) => on.includes(id),
    catalog: MODELS.map((m) => m.id),
    runtime: BUILD,
    ...(o.machine === null ? {} : { machine: o.machine ?? ROOMY }),
  };
}

const HELPERS = ["silero-vad", NEMOTRON, "titanet-small"];
const OWNER = [...HELPERS, "nemotron-3.5-560", QWEN_ASR, BUILD];

describe("the chosen setups' models: Parakeet only when a setup uses it", () => {
  test("a Mac with Nemotron live and Qwen after the call needs no Parakeet, whether or not Parakeet is there", () => {
    expect(chosenModels(ctx(OWNER))).toEqual(["nemotron-3.5-560", QWEN_ASR, BUILD]);
    expect(chosenModels(ctx([...OWNER, RECOGNIZER]))).toEqual([
      "nemotron-3.5-560",
      QWEN_ASR,
      BUILD,
    ]);
    // Named outright, the same.
    expect(
      chosenModels(
        ctx(OWNER, { settings: { "asr.final.model": QWEN_ASR, "asr.live": "nemotron-3.5-560" } }),
      ),
    ).toEqual(["nemotron-3.5-560", QWEN_ASR, BUILD]);
  });

  test("a fresh Mac with room downloads Nemotron for its languages and Qwen, not Parakeet", () => {
    expect(chosenModels(ctx([]))).toEqual(["nemotron-3.5-560", QWEN_ASR, BUILD]);
    expect(chosenModels(ctx([], { settings: { "asr.languages": ["es"] } }))[0]).toBe(
      "nemotron-3.5-1120",
    );
  });

  test("auto keeps what is on disk: an upgraded Mac with Parakeet and no Qwen needs nothing new", () => {
    const upgraded = [...HELPERS, RECOGNIZER];
    expect(chosenModels(ctx(upgraded))).toEqual([RECOGNIZER]);
    expect(chosenModels(ctx([...upgraded, "nemotron-3.5-560"]))).toEqual([
      "nemotron-3.5-560",
      RECOGNIZER,
    ]);
  });

  test("a named Nemotron that is not here keeps Parakeet while Parakeet is here, and is fetched when neither is", () => {
    const settings = { "asr.live": "nemotron-en-560" };
    expect(chosenModels(ctx([...HELPERS, RECOGNIZER], { settings }))[0]).toBe(RECOGNIZER);
    expect(chosenModels(ctx([...HELPERS, RECOGNIZER, "nemotron-en-560"], { settings }))[0]).toBe(
      "nemotron-en-560",
    );
    expect(chosenModels(ctx(HELPERS, { settings }))[0]).toBe("nemotron-en-560");
  });

  test("a machine with no room for Qwen runs Parakeet after the call, and Parakeet writes the live lines until Nemotron is here", () => {
    for (const machine of [{ gpu: false, memoryGb: 64 }, { gpu: true, memoryGb: 8 }, null]) {
      expect(intendedFinal(ctx([], { machine }))).toBe("parakeet");
      expect(chosenModels(ctx([], { machine }))).toEqual([RECOGNIZER]);
      // Qwen downloaded anyway: the final pass runs it on any machine, so it is what is kept.
      expect(intendedFinal(ctx(OWNER, { machine }))).toBe("qwen");
    }
  });

  test("Parakeet is needed again the moment the live model or the final pass names it", () => {
    const named: [Partial<ModelSetSettings>, string[]][] = [
      [{ "asr.final.model": RECOGNIZER }, ["nemotron-3.5-560", RECOGNIZER]],
      [{ "asr.live": "parakeet" }, [RECOGNIZER, QWEN_ASR, BUILD]],
    ];
    for (const [settings, want] of named)
      expect({ settings, got: chosenModels(ctx(OWNER, { settings })) }).toEqual({
        settings,
        got: want,
      });
  });

  test("the second pass's and dictation's Parakeet is kept while chosen, but a call never waits for it", () => {
    const kept: [Partial<ModelSetSettings>, string[]][] = [
      [{ "asr.review.model": "parakeet" }, ["nemotron-3.5-560", QWEN_ASR, BUILD, RECOGNIZER]],
      [{ "dictation.engine": "fast" }, ["nemotron-3.5-560", QWEN_ASR, BUILD, RECOGNIZER]],
      [{ "dictation.final": "parakeet" }, ["nemotron-3.5-560", QWEN_ASR, BUILD, RECOGNIZER]],
    ];
    for (const [settings, want] of kept) {
      expect({ settings, got: keptModels(ctx(OWNER, { settings })) }).toEqual({
        settings,
        got: want,
      });
      expect(chosenModels(ctx(OWNER, { settings }))).toEqual(["nemotron-3.5-560", QWEN_ASR, BUILD]);
    }
    // Dictation off: its choice keeps nothing.
    expect(
      keptModels(
        ctx(OWNER, { settings: { "dictation.enabled": false, "dictation.engine": "fast" } }),
      ),
    ).toEqual(["nemotron-3.5-560", QWEN_ASR, BUILD]);
  });

  test("a catalog without the chosen models falls back to Parakeet rather than asking for what it does not hold", () => {
    const small: ModelSetContext = { ...ctx([]), catalog: [RECOGNIZER, ...HELPERS] };
    expect(chosenModels(small)).toEqual([RECOGNIZER]);
  });
});

describe("modelsFor with the chosen models: the helpers and exactly those", () => {
  test("Parakeet is left out when no setup uses it, and Qwen and Nemotron are in when one does", () => {
    const set = (chosen?: readonly string[]) =>
      modelsFor({ "asr.diarizer": "nemotron" }, "darwin-arm64", MODELS, chosen).map((m) => m.id);
    expect(set(["nemotron-3.5-560", QWEN_ASR, BUILD])).toEqual([
      "silero-vad",
      NEMOTRON,
      "titanet-small",
      "nemotron-3.5-560",
      QWEN_ASR,
      BUILD,
    ]);
    // Positive control: without a chosen list, today's set, Parakeet first and no Qwen.
    expect(set()).toEqual([RECOGNIZER, "silero-vad", NEMOTRON, "titanet-small"]);
    expect(set([RECOGNIZER])).toEqual(set());
  });
});

describe("the live Worker with no Parakeet on disk", () => {
  /** The fake set, with Parakeet's files there or not: loading it then throws, as sherpa would. */
  function withoutParakeet(here: boolean): { models: ModelSet; loads: () => number } {
    const base = createModels();
    let loads = 0;
    const models: ModelSet = Object.assign(Object.create(base) as ModelSet, {
      recognizerHere: () => here,
      prepare: (list: Parameters<ModelSet["prepare"]>[0]) => {
        loads++;
        if (!here) throw new Error("parakeet-tdt-0.6b-v3-fp32/encoder.onnx: no such file");
        return base.prepare(list);
      },
    });
    return { models, loads: () => loads };
  }

  test("a call's decode list and a dictation's warm-up load Parakeet only when its files are here", () => {
    const gone = withoutParakeet(false);
    const p = new LivePipeline(gone.models, {}, () => {});
    expect(() => p.setDecodeList(null, 1)).not.toThrow();
    expect(() => p.warmDictation(null, false)).not.toThrow();
    expect(gone.loads()).toBe(0);
    // Positive control: with its files here it loads ahead of time, as before.
    const here = withoutParakeet(true);
    const q = new LivePipeline(here.models, {}, () => {});
    q.setDecodeList(null, 1);
    q.warmDictation(null, false);
    expect(here.loads()).toBeGreaterThan(0);
  });
});
