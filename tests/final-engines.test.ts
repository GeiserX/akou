/**
 * The final pass over several engines (`asr.final.engines`, ASR-6 in
 * docs/research/asr-architecture.md section 9): every engine decodes every piece, confidence ROVER
 * fuses their words, the lines and `final.done` name the engines, and the pass keeps going when
 * one engine goes down or does not fit the memory budget.
 */

import { describe, expect, test } from "bun:test";
import type { EventDraft, LogEvent, Seg } from "../src/core/log/events.ts";
import { validateDraft } from "../src/core/log/events.ts";
import type { FinalEngine, FinalUnit, Hypothesis } from "../src/main/asr/engine.ts";
import { chooseFinalEngines } from "../src/main/asr/final-model.ts";
import { enginesWithinBudget, runFinalPass } from "../src/main/asr/finalize-worker.ts";
import type { LiveSetupContext } from "../src/main/asr/live-setups.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { shortModelName } from "../src/main/asr/model-text.ts";
import { RECOGNIZER } from "../src/main/asr/models.ts";
import { legacyValues, validateSetting } from "../src/main/config/schema.ts";
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

/**
 * An engine that hears the fake tones, then rewrites what it heard (`hear`): a stand-in for an
 * engine that gets some words wrong. `downAfter` decodes later it goes down (a fatal error).
 */
class FakeEngine implements FinalEngine {
  readonly features = { confidence: false, timestamps: false, glossary: false, languageId: false };
  readonly units: FinalUnit[] = [];
  loaded = 0;
  unloaded = 0;
  private readonly rec = new FakeRecognizer("fake", {});
  constructor(
    readonly id: string,
    private readonly o: {
      hear?: (words: string[]) => string[];
      downAfter?: number;
      memoryMb?: number;
    } = {},
  ) {}
  get memoryMb(): number | undefined {
    return this.o.memoryMb;
  }
  async load(): Promise<void> {
    this.loaded++;
  }
  async unload(): Promise<void> {
    this.unloaded++;
  }
  async decode(u: FinalUnit): Promise<Hypothesis> {
    if (this.o.downAfter !== undefined && this.units.length >= this.o.downAfter)
      throw Object.assign(new Error(`${this.id} is unavailable: the process exited`), {
        fatal: true,
      });
    this.units.push(u);
    const heard = this.rec.decode(u.samples).text.split(" ").filter(Boolean);
    const words = (this.o.hear ?? ((w) => w))(heard);
    return { engine: this.id, text: words.join(" "), words: words.map((w) => ({ w })), ms: 1 };
  }
}

/** Every word swapped for `x`: an engine that hears nothing right. */
const wrong = (ws: string[]) => ws.map(() => "x");

function ended(): LogEvent[] {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.partEnded(1, "stop");
  b.add({ type: "call.ended", reason: "stop" });
  return b.events;
}

/** 60 s of one part with three pieces: two on the mic, one on the call channel. */
function audio(): MemoryAudio {
  const mic = concat(silence(1), speak(["hello", "world"]), silence(30), speak(["thanks"]));
  const call = concat(silence(12), speak(["ok", "great"], { voice: 2 }), silence(30));
  const pad = (x: Float32Array) => concat(x, silence(60 - x.length / RATE));
  return new MemoryAudio({ 1: { mic: pad(mic), call: pad(call) } });
}

async function pass(engines: FinalEngine[], o: { budgetMb?: number } = {}) {
  const out: EventDraft[] = [];
  const logs: string[] = [];
  const models = new FakeModels();
  const result = await runFinalPass(
    {
      events: ended(),
      audio: audio(),
      decode: null,
      pid: 1,
      options: { memoryBudgetMb: o.budgetMb ?? 100_000 },
    },
    models,
    (d) => out.push(d),
    (level, msg) => logs.push(`${level}: ${msg}`),
    engines,
  );
  const segs = out.filter((d) => d.type === "seg" && d.text !== null) as Omit<Seg, "seq" | "t">[];
  const done = out.find((d) => d.type === "final.done") as Record<string, unknown> | undefined;
  return { out, logs, result, segs, done, models };
}

const TEXTS = ["hello world", "ok great", "thanks"];
const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);

describe("[ASR-6] the final pass over several engines", () => {
  test("1 to 5 engines: each decodes every piece, the words are fused and the lines named", async () => {
    for (let n = 1; n <= 5; n++) {
      const engines = ids(n).map((id) => new FakeEngine(id));
      const r = await pass(engines);
      const name = n === 1 ? "e1" : `rover-conf(${ids(n).join(",")})`;
      expect({ n, ok: r.result.ok }).toEqual({ n, ok: true });
      expect({ n, lines: r.segs.map((s) => [s.text, s.model]) }).toEqual({
        n,
        lines: TEXTS.map((t) => [t, name]),
      });
      for (const e of engines)
        expect({ n, id: e.id, units: e.units.length }).toEqual({ n, id: e.id, units: 3 });
      expect({ n, done: r.done?.model }).toEqual({ n, done: name });
      // Parakeet, the model set's recognizer, never loads when engines are given.
      expect(r.models.loads["fake-parakeet"]).toBeUndefined();
      // `final.done` names the engines only for a pass given several.
      if (n === 1) expect(r.done).not.toHaveProperty("engines");
      else expect(r.done).toMatchObject({ engines: ids(n), dropped: [] });
    }
  });

  test("the vote decides: two engines that agree outvote one that hears wrong, wherever it is", async () => {
    for (const at of [0, 1, 2]) {
      const engines = ids(3).map((id, i) => new FakeEngine(id, i === at ? { hear: wrong } : {}));
      const r = await pass(engines);
      expect({ at, texts: r.segs.map((s) => s.text) }).toEqual({ at, texts: TEXTS });
    }
    // The control: the wrong engine alone writes its own words, so the vote above did the work.
    const alone = await pass([new FakeEngine("e1", { hear: wrong })]);
    expect(alone.segs.map((s) => s.text)).toEqual(["x x", "x x", "x"]);
    // And with two engines that disagree, the first one breaks the tie.
    const tie = await pass([new FakeEngine("e1"), new FakeEngine("e2", { hear: wrong })]);
    expect(tie.segs.map((s) => s.text)).toEqual(TEXTS);
    const tie2 = await pass([new FakeEngine("e1", { hear: wrong }), new FakeEngine("e2")]);
    expect(tie2.segs.map((s) => s.text)).toEqual(["x x", "x x", "x"]);
  });

  test("an engine that goes down mid-pass is dropped; the rest finish the pass", async () => {
    const engines = [
      new FakeEngine("e1"),
      new FakeEngine("e2", { downAfter: 1 }),
      new FakeEngine("e3"),
    ];
    const r = await pass(engines);
    expect(r.result.ok).toBe(true);
    expect(r.segs.map((s) => s.text)).toEqual(TEXTS);
    // The first piece was fused from all three, the rest from the two left.
    expect(r.segs.map((s) => s.model)).toEqual([
      "rover-conf(e1,e2,e3)",
      "rover-conf(e1,e3)",
      "rover-conf(e1,e3)",
    ]);
    expect(r.done).toMatchObject({ model: "rover-conf(e1,e3)", engines: ["e1", "e3"] });
    const dropped = r.done?.dropped as { engine: string; reason: string }[];
    expect(dropped.map((d) => d.engine)).toEqual(["e2"]);
    expect(dropped[0]?.reason).toContain("failed during the pass");
    expect(dropped[0]?.reason).toContain("the process exited");
    expect(engines[1]?.unloaded).toBe(1);
    expect(r.logs.some((l) => l.startsWith("error: e2 failed"))).toBe(true);
    // The event as written is one the log takes.
    expect(validateDraft(r.done)).toMatchObject({ ok: true });
  });

  test("the last engine left going down still fails the pass, as one engine always did", async () => {
    const one = await pass([new FakeEngine("e1", { downAfter: 1 })]);
    expect(one.result.ok).toBe(false);
    expect(one.out.at(-1)).toMatchObject({ type: "final.failed", step: "decode" });
    const both = await pass([
      new FakeEngine("e1", { downAfter: 1 }),
      new FakeEngine("e2", { downAfter: 2 }),
    ]);
    expect(both.result.ok).toBe(false);
    expect(both.out.map((d) => d.type)).not.toContain("final.done");
    // Nothing of a failed pass reaches the log as lines: the previous layer stays whole.
    expect(both.segs).toEqual([]);
  });

  test("over the memory budget: engines leave from the end of the list, the first always runs", async () => {
    const engines = [
      new FakeEngine("e1", { memoryMb: 3000 }),
      new FakeEngine("e2", { memoryMb: 2700 }),
      new FakeEngine("e3", { memoryMb: 1700 }),
    ];
    const r = await pass(engines, { budgetMb: 6000 });
    expect(r.result.ok).toBe(true);
    expect(r.segs.map((s) => s.model)).toEqual(Array(3).fill("rover-conf(e1,e2)"));
    expect(engines[2]?.loaded).toBe(0);
    expect(engines[2]?.units).toEqual([]);
    expect(r.done).toMatchObject({ model: "rover-conf(e1,e2)", engines: ["e1", "e2"] });
    const dropped = r.done?.dropped as { engine: string; reason: string }[];
    expect(dropped).toEqual([
      {
        engine: "e3",
        reason:
          "over the memory budget: with the engines before it the pass needs about 7400 MB, the budget is 6000 MB",
      },
    ]);
    // A budget below the first engine alone still runs it, alone.
    const tight: Parameters<typeof enginesWithinBudget>[2] = [];
    expect(enginesWithinBudget(engines, 100, tight).map((e) => e.id)).toEqual(["e1"]);
    expect(tight.map((d) => d.engine)).toEqual(["e3", "e2"]);
    // The control: the same list under a budget that holds it runs all three.
    const roomy = await pass(
      engines.map((e) => new FakeEngine(e.id, { memoryMb: e.memoryMb })),
      {
        budgetMb: 7400,
      },
    );
    expect(roomy.done).toMatchObject({ engines: ["e1", "e2", "e3"], dropped: [] });
  });

  test("engines the host left out (not downloaded) are in final.done's dropped too", async () => {
    const out: EventDraft[] = [];
    await runFinalPass(
      {
        events: ended(),
        audio: audio(),
        decode: null,
        pid: 1,
        dropped: [{ engine: "e9", reason: "not downloaded (e9)" }],
      },
      new FakeModels(),
      (d) => out.push(d),
      () => {},
      [new FakeEngine("e1")],
    );
    expect(out.at(-1)).toMatchObject({
      type: "final.done",
      model: "e1",
      engines: ["e1"],
      dropped: [{ engine: "e9", reason: "not downloaded (e9)" }],
    });
  });
});

describe("[ASR-6] asr.final.engines", () => {
  const ctx = (missing: string[] = []): LiveSetupContext => ({
    setting: "auto",
    engine: "auto",
    languages: [],
    present: (id) => !missing.includes(id),
    runtime: "llama-server-test-build",
  });

  test("the listed models that are here run in order; a missing one is left out with why", () => {
    expect(chooseFinalEngines([QWEN_ASR, RECOGNIZER], ctx())).toEqual({
      models: ["qwen", "parakeet"],
      dropped: [],
    });
    expect(chooseFinalEngines(["parakeet", "qwen", QWEN_ASR], ctx())).toEqual({
      models: ["parakeet", "qwen"],
      dropped: [],
    });
    expect(chooseFinalEngines([QWEN_ASR, RECOGNIZER], ctx([RECOGNIZER]))).toEqual({
      models: ["qwen"],
      dropped: [{ engine: RECOGNIZER, reason: `not downloaded (${RECOGNIZER})` }],
    });
    const none = chooseFinalEngines([QWEN_ASR], ctx(["llama-server-test-build"]));
    expect(none.models).toEqual([]);
    expect(none.dropped[0]?.reason).toBe("not downloaded (llama-server-test-build)");
  });

  test("the setting takes the ids and the short names, and nothing else", () => {
    expect(validateSetting("asr.final.engines", [QWEN_ASR, RECOGNIZER]).ok).toBe(true);
    expect(validateSetting("asr.final.engines", []).ok).toBe(true);
    expect(validateSetting("asr.final.engines", ["whisper"]).ok).toBe(false);
    expect(legacyValues({ "asr.final.engines": ["qwen", "parakeet"] })).toEqual({
      "asr.final.engines": [QWEN_ASR, RECOGNIZER],
    });
  });

  test("a fused pass reads by its engines' short names", () => {
    expect(shortModelName(`rover-conf(${QWEN_ASR},${RECOGNIZER})`)).toBe("Qwen + Parakeet");
    expect(shortModelName(QWEN_ASR)).toBe("Qwen");
  });
});
