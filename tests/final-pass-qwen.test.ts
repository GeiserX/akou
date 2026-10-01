/**
 * The desktop final pass on Qwen (`asr.final.model`): which recognizer `auto` picks, the pass
 * through a `FinalEngine` (the call's language and decode list reach it, Parakeet never loads,
 * the model is named in the log), a Qwen that stays down failing the pass instead of falling back,
 * and how far a pass on Qwen is as it decodes.
 */

import { describe, expect, test } from "bun:test";
import type { EventDraft, LogEvent, Seg } from "../src/core/log/events.ts";
import type { FinalEngine, FinalUnit, Hypothesis } from "../src/main/asr/engine.ts";
import { chooseFinalModel } from "../src/main/asr/final-model.ts";
import { runFinalPass } from "../src/main/asr/finalize-worker.ts";
import type { LiveSetupContext } from "../src/main/asr/live-setups.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { RECOGNIZER } from "../src/main/asr/models.ts";
import { legacyValues, validateSetting } from "../src/main/config/schema.ts";
import type { DecodeList } from "../src/main/vocab/decode-list.ts";
import {
  concat,
  FakeModels,
  FakeRecognizer,
  MemoryAudio,
  RATE,
  silence,
  speak,
} from "./fixtures/asr-fake.ts";
import { LogBuilder, T0 } from "./helpers.ts";

const RUNTIME = "llama-server-test-build";

function ctx(
  o: { missing?: string[]; gpu?: boolean; memoryGb?: number; runtime?: string | null } = {},
): LiveSetupContext {
  const missing = new Set(o.missing ?? []);
  return {
    setting: "auto",
    engine: "auto",
    languages: ["en"],
    present: (id) => !missing.has(id),
    runtime: o.runtime === undefined ? RUNTIME : o.runtime,
    machine: { gpu: o.gpu ?? true, memoryGb: o.memoryGb ?? 24 },
  };
}

describe("asr.final.model", () => {
  test("auto picks Qwen whenever it and its llama-server are downloaded, on any machine", () => {
    expect(chooseFinalModel("auto", ctx())).toEqual({ model: "qwen" });
    // No GPU and little memory: still Qwen. The owner wants Qwen after every call it can run on.
    expect(chooseFinalModel("auto", ctx({ gpu: false, memoryGb: 8 }))).toEqual({ model: "qwen" });
    // An own llama-server (no build to download): Qwen's model alone decides.
    expect(chooseFinalModel("auto", ctx({ runtime: null }))).toEqual({ model: "qwen" });
    for (const [why, c] of [
      ["no Qwen model", ctx({ missing: [QWEN_ASR] })],
      ["no llama-server build", ctx({ missing: [RUNTIME] })],
    ] as const) {
      const choice = chooseFinalModel("auto", c);
      expect({ why, model: choice.model }).toEqual({ why, model: "parakeet" });
      expect(choice.note ?? "").not.toBe("");
    }
  });

  test("a named Qwen runs on any machine, never when it is not downloaded; Parakeet by name is Parakeet", () => {
    expect(chooseFinalModel("qwen", ctx({ gpu: false, memoryGb: 8 }))).toEqual({ model: "qwen" });
    expect(chooseFinalModel(QWEN_ASR, ctx())).toEqual({ model: "qwen" });
    const missing = chooseFinalModel("qwen", ctx({ missing: [QWEN_ASR] }));
    expect(missing.model).toBe("parakeet");
    expect(missing.note).toContain(QWEN_ASR);
    expect(chooseFinalModel("parakeet", ctx())).toEqual({ model: "parakeet" });
    expect(chooseFinalModel(RECOGNIZER, ctx())).toEqual({ model: "parakeet" });
  });

  test("the short names are read as the ids, and anything else is refused", () => {
    expect(legacyValues({ "asr.final.model": "qwen" })).toEqual({ "asr.final.model": QWEN_ASR });
    expect(legacyValues({ "asr.final.model": "parakeet" })).toEqual({
      "asr.final.model": RECOGNIZER,
    });
    expect(validateSetting("asr.final.model", "auto").ok).toBe(true);
    expect(validateSetting("asr.final.model", "whisper").ok).toBe(false);
  });
});

/** Qwen as the pass sees it: a `FinalEngine` that hears the fake tones, or one that is down. */
class FakeQwen implements FinalEngine {
  readonly id = QWEN_ASR;
  readonly features = { confidence: true, timestamps: false, glossary: true, languageId: true };
  readonly units: FinalUnit[] = [];
  private readonly rec = new FakeRecognizer("fake-qwen", {});
  constructor(private readonly down?: Error) {}
  async load(): Promise<void> {}
  async unload(): Promise<void> {}
  async decode(u: FinalUnit): Promise<Hypothesis> {
    this.units.push(u);
    if (this.down) throw this.down;
    return { engine: this.id, text: this.rec.decode(u.samples).text, words: [], ms: 1, lang: "es" };
  }
}

function ended(): LogEvent[] {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.partEnded(1, "stop");
  b.add({ type: "call.ended", reason: "stop" });
  return b.events;
}

/** 60 s of one part: words early and late on both channels, so the pass has several pieces. */
function audio(): MemoryAudio {
  const mic = concat(silence(1), speak(["hello", "world"]), silence(30), speak(["thanks"]));
  const call = concat(silence(12), speak(["ok", "great"], { voice: 2 }), silence(30));
  const pad = (x: Float32Array) => concat(x, silence(60 - x.length / RATE));
  return new MemoryAudio({ 1: { mic: pad(mic), call: pad(call) } });
}

const LIST: DecodeList = {
  model: QWEN_ASR,
  entries: [{ term: "akou", boost: 1.5, tier: 1, source: "call" }],
  dropped: [],
  warnings: [],
};

async function pass(engine: FakeQwen | undefined, language?: string) {
  const models = new FakeModels();
  const out: EventDraft[] = [];
  const moved: [number, number][] = [];
  const result = await runFinalPass(
    {
      events: ended(),
      audio: audio(),
      decode: LIST,
      pid: 1,
      language,
      progress: (d, t) => moved.push([d, t]),
    },
    models,
    (d) => out.push(d),
    () => {},
    engine,
  );
  const segs = out.filter((d) => d.type === "seg" && d.text !== null) as Omit<Seg, "seq" | "t">[];
  return { models, out, result, segs, moved };
}

describe("the final pass on Qwen", () => {
  test("every piece goes to Qwen with the call's language and word list; Parakeet never loads", async () => {
    const qwen = new FakeQwen();
    const r = await pass(qwen, "es");
    expect(r.result.ok).toBe(true);
    expect(r.segs.map((s) => [s.ch, s.text, s.model])).toEqual([
      ["mic", "hello world", QWEN_ASR],
      ["call", "ok great", QWEN_ASR],
      ["mic", "thanks", QWEN_ASR],
    ]);
    expect(r.models.loads["fake-parakeet"]).toBeUndefined();
    expect(qwen.units.length).toBeGreaterThanOrEqual(3);
    for (const u of qwen.units) expect([u.lang, u.glossary]).toEqual(["es", ["akou"]]);
    const types = r.out.map((d) => d.type);
    expect(r.out[types.indexOf("final.started")]).toMatchObject({ model: QWEN_ASR });
    expect(r.out[types.indexOf("vocab.used")]).toMatchObject({
      model: QWEN_ASR,
      entries: ["akou"],
    });
    expect(r.out.at(-1)).toMatchObject({ type: "final.done", model: QWEN_ASR, languages: ["es"] });
  });

  test("Parakeet, the control: the same call writes Parakeet's lines and names it", async () => {
    const r = await pass(undefined);
    expect(r.segs.map((s) => s.model)).toEqual(["fake-parakeet", "fake-parakeet", "fake-parakeet"]);
    expect(r.models.loads["fake-parakeet"]).toBe(1);
    expect(r.out.at(-1)).toMatchObject({ type: "final.done", model: "fake-parakeet" });
  });

  test("a Qwen that stays down fails the pass and says so; no Parakeet line takes its place", async () => {
    const down = Object.assign(new Error(`${QWEN_ASR} is unavailable: connection refused`), {
      fatal: true,
    });
    const r = await pass(new FakeQwen(down));
    expect(r.result).toMatchObject({ ok: false, model: QWEN_ASR });
    expect(r.segs).toEqual([]);
    expect(r.models.loads["fake-parakeet"]).toBeUndefined();
    expect(r.out.map((d) => d.type)).not.toContain("final.done");
    expect(r.out.at(-1)).toMatchObject({
      type: "final.failed",
      step: "decode",
      error: `${QWEN_ASR} is unavailable: connection refused`,
    });
  });

  test("how far it is: seconds of the call, from 0 to the whole call, moving inside the one part", async () => {
    const r = await pass(new FakeQwen());
    const total = 60;
    expect(r.moved[0]).toEqual([0, total]);
    expect(r.moved.at(-1)?.[0]).toBeCloseTo(total, 3);
    for (const [, t] of r.moved) expect(t).toBeCloseTo(total, 3);
    const done = r.moved.map(([d]) => d);
    expect(done).toEqual([...done].sort((a, b) => a - b));
    // Figures strictly inside the pass, not just its start and end (a one-part call would sit at
    // "0 of 1 part" until the end).
    const inside = r.moved.filter(([d]) => d > 1 && d < total - 1);
    expect(inside.length).toBeGreaterThanOrEqual(2);
  });
});
