/**
 * The accurate final pass (finalize-worker.ts) against the fake engines: the whole-timeline rule,
 * channels by index, energy before models, diarization across parts, names carried over, the
 * halving of refused spans, re-runs, and the pass through a real Worker reading a WAV.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventDraft, LogEvent, Seg } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { LOCK_FILE } from "../src/core/log/writer.ts";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import { finalBudgetMs, finalizeCall, runFinalPass } from "../src/main/asr/finalize-worker.ts";
import { type LiveOut, LivePipeline } from "../src/main/asr/live-worker.ts";
import { MIN_SPAN_SECONDS } from "../src/main/asr/pad.ts";
import { GREEDY_NO_HOTWORDS } from "../src/main/asr/sherpa.ts";
import { CallManager } from "../src/main/call/manager.ts";
import { buildDecodeList } from "../src/main/vocab/decode-list.ts";
import { logOf, ManualClock, ofType, ScriptedEngine, until } from "./capture-helpers.ts";
import { concat, FakeModels, MemoryAudio, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { LogBuilder, T0, TZ, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A call log with the given parts, 10 minutes apart. */
function callLog(parts: number[], extra: (b: LogBuilder) => void = () => {}): LogEvent[] {
  const b = new LogBuilder();
  b.created();
  for (const p of parts) {
    b.partStarted(p, T0 + (p - 1) * 600_000);
    b.partEnded(p, p === parts.at(-1) ? "stop" : "restart");
  }
  extra(b);
  b.add({ type: "call.ended", reason: "stop" });
  return b.events;
}

async function run(
  events: LogEvent[],
  parts: Record<number, { mic: Float32Array; call: Float32Array }>,
  o: ConstructorParameters<typeof FakeModels>[0] = {},
  decode: ReturnType<typeof buildDecodeList> | null = null,
) {
  const models = new FakeModels(o);
  const out: EventDraft[] = [];
  const result = await runFinalPass(
    { events, audio: new MemoryAudio(parts), decode, pid: 4242 },
    models,
    (d) => out.push(d),
  );
  const segs = out.filter((d) => d.type === "seg" && d.text !== null) as Omit<Seg, "seq" | "t">[];
  return { models, out, result, segs, types: out.map((d) => d.type) };
}

const len = (x: Float32Array, n: number) =>
  concat(x, silence(Math.max(0, n / RATE - x.length / RATE)));

describe("channels and energy", () => {
  test("[T2.7, T4.17] Only channel 0 read: speech on the right channel only gives call lines", async () => {
    const call = concat(silence(0.5), speak(["hello", "world"], { voice: 1 }), silence(0.5));
    const r = await run(callLog([1]), { 1: { mic: silence(call.length / RATE), call } });
    expect(r.segs.map((s) => [s.ch, s.text])).toEqual([["call", "hello world"]]);
    expect(r.result.warning).toBeUndefined();
  });

  test("[T2.7, T4.17] a call channel with sound and no text gives final.done a warning", async () => {
    // A hum above the silence floor that the engine hears no words in.
    const hum = new Float32Array(2 * RATE);
    for (let i = 0; i < hum.length; i++) hum[i] = 0.01 * Math.sin((2 * Math.PI * 100 * i) / RATE);
    const r = await run(callLog([1]), { 1: { mic: silence(2), call: hum } });
    const done = r.out.find((d) => d.type === "final.done") as Extract<
      EventDraft,
      { type: "final.done" }
    >;
    expect(done.warning).toMatch(/call channel has sound/);
    // Positive control: the same part with words on the call channel has no warning.
    const ok = await run(callLog([1]), {
      1: { mic: silence(2), call: len(speak(["ok", "great"]), 2 * RATE) },
    });
    expect(
      (ok.out.find((d) => d.type === "final.done") as { warning?: string }).warning,
    ).toBeUndefined();
  });

  test("[T4.18] Empty audio still loads models: silent parts finish with no model loaded", async () => {
    const r = await run(callLog([1, 2]), {
      1: { mic: silence(3), call: silence(3) },
      2: { mic: silence(3), call: silence(3) },
    });
    expect(r.models.loads).toEqual({});
    expect(r.types).toEqual(["final.started", "final.part.done", "final.part.done", "final.done"]);
    // Positive control: one audible part loads the models.
    const loud = await run(callLog([1, 2]), {
      1: { mic: silence(3), call: silence(3) },
      2: { mic: len(speak(["ok"]), 3 * RATE), call: silence(3) },
    });
    expect(loud.models.loads["fake-parakeet"]).toBe(1);
  });

  test("[T4.18, F1.7] each model loads once for the whole pass, whatever the parts", async () => {
    const p = () => ({
      mic: len(speak(["hello", "world"]), 3 * RATE),
      call: len(speak(["we", "should"], { voice: 2 }), 3 * RATE),
    });
    const r = await run(callLog([1, 2, 3]), { 1: p(), 2: p(), 3: p() });
    expect(r.models.loads["fake-parakeet"]).toBe(1);
    expect(r.models.loads["fake-segmentation"]).toBe(1);
    expect(r.models.diarizers[0]?.calls).toBe(1);
  });
});

describe("[spike] VAD gating loses words", () => {
  // A short word after 0.8 s of silence that this VAD never reports (Silero missed "Thanks." so).
  const vadMissesShort = { vadMinSpeechWindows: 8 };
  const mic = concat(
    silence(0.3),
    speak(["we", "should", "move", "the", "build"]),
    silence(0.8),
    speak(["thanks"], { wordSeconds: 0.2 }),
    silence(1),
  );

  test("the final pass decodes the whole timeline, so the missed word is in the final layer", async () => {
    const r = await run(callLog([1]), { 1: { mic, call: silence(mic.length / RATE) } });
    expect(r.segs.map((s) => s.text).join(" ")).toBe("we should move the build thanks");
  });

  test("positive control: the VAD-cut live path loses it", () => {
    const models = new FakeModels(vadMissesShort);
    const out: LiveOut[] = [];
    const p = new LivePipeline(models, {}, (o) => out.push(o));
    for (let at = 0; at < mic.length; at += 320) p.audio(1, "mic", at, mic.subarray(at, at + 320));
    p.endPart(1);
    const text = out
      .map((o) => (o.type === "seg" ? o.text : ""))
      .join(" ")
      .trim();
    expect(text).toBe("we should move the build");
  });

  test("with this VAD too, the final layer keeps the word", async () => {
    const r = await run(
      callLog([1]),
      { 1: { mic, call: silence(mic.length / RATE) } },
      vadMissesShort,
    );
    expect(r.segs.map((s) => s.text).join(" ")).toContain("thanks");
  });
});

describe("[T1.9, T4.19] Short spans lose their words: the final path pads too", () => {
  test("a 0.2 s 'yes' alone in a part is transcribed", async () => {
    const mic = concat(silence(1), speak(["yes"], { wordSeconds: 0.2, gapSeconds: 0 }), silence(1));
    const r = await run(callLog([1]), { 1: { mic, call: silence(mic.length / RATE) } });
    expect(r.segs.map((s) => s.text)).toEqual(["yes"]);
    expect(r.models.calls.every((c) => c.samples >= MIN_SPAN_SECONDS * RATE)).toBe(true);
  });
});

describe("speakers across the call", () => {
  test("diarization runs over all parts at once: one voice has one label in every part", async () => {
    const part = (v: number, w: string[]) => ({
      mic: silence(4),
      call: len(concat(silence(0.3), speak(w, { voice: v })), 4 * RATE),
    });
    const r = await run(callLog([1, 2]), {
      1: part(3, ["hello", "world"]),
      2: {
        mic: silence(6),
        call: len(
          concat(
            silence(0.3),
            speak(["we", "should"], { voice: 5 }),
            silence(1),
            speak(["ok"], { voice: 3 }),
          ),
          6 * RATE,
        ),
      },
    });
    const bySpk = r.segs.map((s) => [s.part, s.spk, s.text]);
    expect(bySpk).toEqual([
      [1, "s0", "hello world"],
      [2, "s1", "we should"],
      [2, "s0", "ok"],
    ]);
  });

  test("a diarizer that answers later (the Nemotron helper) with overlapping turns: each piece once, by who covers it", async () => {
    const call = concat(
      silence(0.3),
      speak(["hello", "world", "we"], { voice: 1 }),
      silence(0.8),
      speak(["ok", "great", "today"], { voice: 4 }),
      silence(0.5),
    );
    const t1 = 0.3 + (call.length / RATE - 0.3 - 0.8 - 0.5) / 2;
    const models = new FakeModels();
    let asked = 0;
    models.diarizer = () => ({
      process: async () => {
        asked++;
        await Bun.sleep(5);
        // The two turns overlap inside the pause between the voices.
        return [
          { speaker: 0, start: 0.2, end: t1 + 0.5 },
          { speaker: 1, start: t1 + 0.3, end: call.length / RATE },
        ];
      },
    });
    const out: EventDraft[] = [];
    const res = await runFinalPass(
      {
        events: callLog([1]),
        audio: new MemoryAudio({ 1: { mic: silence(call.length / RATE), call } }),
        decode: null,
      },
      models,
      (d) => out.push(d),
    );
    expect(res.ok).toBe(true);
    expect(asked).toBe(1);
    const segs = out.filter((d) => d.type === "seg") as Omit<Seg, "seq" | "t">[];
    expect(segs.map((x) => [x.spk, x.text])).toEqual([
      ["s0", "hello world we"],
      ["s1", "ok great today"],
    ]);
  });

  test("a diarizer that fails costs the speaker labels only: the final layer is written, unlabelled", async () => {
    const call = concat(silence(0.3), speak(["hello", "world"], { voice: 1 }), silence(0.5));
    const models = new FakeModels();
    // A helper that crashed, hung past its deadline or refused its model rejects its promise.
    models.diarizer = () => ({
      process: () => Promise.reject(new Error("akou-diarize gave no answer within 1 ms")),
    });
    const out: EventDraft[] = [];
    const logs: string[] = [];
    const res = await runFinalPass(
      {
        events: callLog([1]),
        audio: new MemoryAudio({ 1: { mic: silence(call.length / RATE), call } }),
        decode: null,
      },
      models,
      (d) => out.push(d),
      (level, msg) => logs.push(`${level}: ${msg}`),
    );
    expect(res.ok).toBe(true);
    expect(out.some((d) => d.type === "final.failed")).toBe(false);
    const segs = out.filter((d) => d.type === "seg") as Omit<Seg, "seq" | "t">[];
    expect(segs.map((x) => [x.ch, x.spk, x.text])).toEqual([["call", "s?", "hello world"]]);
    expect(out.at(-1)?.type).toBe("final.done");
    expect(logs.join("\n")).toContain("gave no answer within 1 ms");
  });

  test("final clusters take the live names: a map at 60 % overlap, else a suggestion", async () => {
    const events = callLog([1], (b) => {
      b.seg({
        id: "l000001",
        ch: "call",
        spk: "c2",
        a0: 0.3,
        a1: 1.1,
        w0: T0 + 300,
        w1: T0 + 1100,
        text: "hello world",
      });
      b.seg({
        id: "l000002",
        ch: "call",
        spk: "c1",
        a0: 2.2,
        a1: 2.5,
        w0: T0 + 2200,
        w1: T0 + 2500,
        text: "ok",
      });
      b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    });
    const call = concat(
      silence(0.3),
      speak(["hello", "world"], { voice: 1 }),
      silence(1.2),
      speak(["ok", "great", "today", "deploy"], { voice: 4 }),
      silence(0.5),
    );
    const r = await run(events, { 1: { mic: silence(call.length / RATE), call } });
    const maps = r.out.filter((d) => d.type === "speaker.map" || d.type === "speaker.suggest");
    expect(
      maps.map((m) => [m.type, (m as { final: string }).final, (m as { live: string }).live]),
    ).toEqual([
      ["speaker.map", "s0", "c2"],
      ["speaker.suggest", "s1", "c1"],
    ]);
    // Written to a log, the final line of s0 renders with the live name.
    const all = [...events];
    let seq = events.length;
    for (const d of r.out) all.push({ seq: ++seq, t: T0 + seq, ...d } as LogEvent);
    const view = fold(all);
    const line = view.lines("best").find((l) => l.text === "hello world");
    expect(line?.layer).toBe("final");
    expect(line?.speaker).toBe("Ben");
  });
});

describe("refused spans and re-runs", () => {
  const talk = (seconds: number) => {
    const words = Array.from({ length: Math.floor(seconds / 0.37) }, (_, i) =>
      i % 2 ? "ok" : "great",
    );
    return concat(silence(0.2), speak(words), silence(0.2));
  };

  test("a span the engine refuses is halved; halves it accepts are kept", async () => {
    const mic = talk(28);
    const r = await run(
      callLog([1]),
      { 1: { mic, call: silence(mic.length / RATE) } },
      { refuseOver: 20 },
    );
    expect(r.result.skipped).toEqual([]);
    const words = r.segs.flatMap((s) => (s.text as string).split(" "));
    expect(words.length).toBeGreaterThanOrEqual(Math.floor(28 / 0.37));
  });

  test("halving stops at 20 s: the smallest failing pieces are skipped and listed", async () => {
    const mic = talk(28);
    const r = await run(
      callLog([1]),
      { 1: { mic, call: silence(mic.length / RATE) } },
      { refuseOver: 10 },
    );
    const done = r.out.find((d) => d.type === "final.done") as Extract<
      EventDraft,
      { type: "final.done" }
    >;
    expect(done.skipped).toHaveLength(2);
    for (const s of done.skipped as { a0: number; a1: number; ch: string }[]) {
      expect(s.ch).toBe("mic");
      expect(s.a1 - s.a0).toBeLessThanOrEqual(20);
    }
  });

  test("a re-run retracts the previous final lines and numbers after them", async () => {
    const mic = concat(silence(0.3), speak(["hello", "world"]), silence(0.5));
    const events = callLog([1], (b) => {
      b.seg({ id: "f000001", layer: "final", ch: "mic", spk: "you", text: "old text" });
      b.add({ type: "final.part.done", part: 1 });
    });
    const r = await run(events, { 1: { mic, call: silence(mic.length / RATE) } });
    const retract = r.out.find((d) => d.type === "seg" && d.id === "f000001");
    expect(retract).toMatchObject({ rev: 2, text: null });
    expect(r.segs.map((s) => s.id)).toEqual(["f000002"]);
  });

  test("a re-run that fails keeps the previous final layer whole: no retraction, no partial layer", async () => {
    const mic = concat(silence(0.3), speak(["hello", "world"]), silence(0.5));
    const call = silence(mic.length / RATE);
    const events = callLog([1, 2], (b) => {
      for (const part of [1, 2]) {
        b.seg({ id: `f00000${part}`, part, layer: "final", ch: "mic", spk: "you", text: "old" });
        b.add({ type: "final.part.done", part });
      }
    });
    // Fails after part 1 is decoded: the VAD for part 2 cannot load.
    class FailOnPart2 extends FakeModels {
      private vads = 0;
      override vad() {
        if (++this.vads > 1) throw new Error("vad load failed");
        return super.vad();
      }
    }
    const out: EventDraft[] = [];
    const result = await runFinalPass(
      { events, audio: new MemoryAudio({ 1: { mic, call }, 2: { mic, call } }), decode: null },
      new FailOnPart2(),
      (d) => out.push(d),
    );
    expect(result.ok).toBe(false);
    expect(out.filter((d) => d.type === "seg")).toEqual([]);
    expect(out.filter((d) => d.type === "final.part.done")).toEqual([]);
    expect(out.at(-1)).toMatchObject({ type: "final.failed", step: "decode" });
    // Positive control: the same re-run that succeeds retracts both old lines and writes new ones.
    const ok = await run(events, { 1: { mic, call }, 2: { mic, call } });
    const retracted = ok.out.filter((d) => d.type === "seg" && d.text === null);
    expect(retracted.map((d) => (d as { id: string }).id)).toEqual(["f000001", "f000002"]);
    expect(ok.segs.map((s) => s.id)).toEqual(["f000003", "f000004"]);
  });

  test("under greedy decoding a non-empty decode list is logged at warn, and vocab.used is empty", async () => {
    const mic = concat(silence(0.3), speak(["deploy", "to", "hetzner"]), silence(0.5));
    const decode = buildDecodeList({
      model: "fake-parakeet",
      callVocab: [],
      names: ["Hetzner"],
      files: [],
    });
    const logs: string[] = [];
    const out: EventDraft[] = [];
    await runFinalPass(
      {
        events: callLog([1]),
        audio: new MemoryAudio({ 1: { mic, call: silence(mic.length / RATE) } }),
        decode,
      },
      new FakeModels({ greedy: true }),
      (d) => out.push(d),
      (level, msg) => logs.push(`${level}: ${msg}`),
    );
    expect(out.find((d) => d.type === "vocab.used")).toMatchObject({ entries: [] });
    expect(logs).toContain(`warn: ${GREEDY_NO_HOTWORDS}`);
  });

  test("the decode list in force is recorded as vocab.used and biases the final pass", async () => {
    const mic = concat(silence(0.3), speak(["deploy", "to", "hetzner"]), silence(0.5));
    const decode = buildDecodeList({
      model: "fake-parakeet",
      callVocab: [],
      names: ["Hetzner"],
      files: [],
    });
    const r = await run(callLog([1]), { 1: { mic, call: silence(mic.length / RATE) } }, {}, decode);
    expect(r.out.find((d) => d.type === "vocab.used")).toMatchObject({ entries: ["Hetzner"] });
    expect(r.segs.map((s) => s.text)).toEqual(["deploy to Hetzner"]);
    // The order the log gets: started, the vocabulary, lines, the part, then the call.
    expect(r.types.filter((t) => t !== "seg")).toEqual([
      "final.started",
      "vocab.used",
      "final.part.done",
      "final.done",
    ]);
  });
});

describe("after Stop, through the call's writer", () => {
  function callRig() {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const clock = new ManualClock();
    const engine = new ScriptedEngine(clock);
    const mgr = new CallManager({ root: t.dir, engine, clock, tz: TZ, budgets: { stallMs: 1e12 } });
    cleanups.push(() => mgr.quit());
    return { dir: t.dir, clock, engine, mgr };
  }

  const spec = (o = {}): ModelSpec => ({
    kind: "module",
    path: FAKE,
    model: "fake-parakeet",
    options: o,
  });

  test("a real Worker reads the part's WAV by channel and appends the final layer after call.ended", async () => {
    const r = callRig();
    r.engine.onStart = (s) => s.capturing();
    const res = await r.mgr.start({ workspace: "work" });
    if (!res.ok) throw new Error(res.error);
    const mic = concat(silence(0.3), speak(["hello", "world"]), silence(2));
    const call = concat(silence(1.4), speak(["ok", "great"], { voice: 2 }), silence(0.5));
    r.engine.last.play(mic, call);
    await r.mgr.stop();
    const wav = join(res.folder, "audio", "part-001.wav");
    writeFileSync(wav, stereoWav(mic, call));
    const c = r.mgr.controller(res.call);
    if (!c) throw new Error("no controller");
    const pass = finalizeCall(c, {
      models: spec(),
      audio: { kind: "wav", files: { 1: wav } },
    });
    // The pass is in the log before finalizeCall returns, so `akou finalize --force && akou wait`
    // never reads the earlier final.done as this pass's.
    expect(c.view.final.state).toBe("running");
    const out = await pass;
    expect(out.ok).toBe(true);
    expect(out.loads["fake-parakeet"]).toBe(1);
    const view = c.view;
    const types = view.lines("final").map((l) => [l.ch, l.text]);
    expect(types).toEqual([
      ["mic", "hello world"],
      ["call", "ok great"],
    ]);
    expect(view.final.state).toBe("done");
    expect(view.parts()[0]?.finalDone).toBe(true);
    const e = await logOf(res.folder);
    const ended = ofType(e, "call.ended")[0]?.seq as number;
    expect((ofType(e, "final.done")[0]?.seq as number) > ended).toBe(true);
    expect(ofType(e, "final.started")).toHaveLength(1);
  }, 20_000);

  test("a pass stuck in a native call is stopped at its budget: final.failed, the writer released", async () => {
    const r = callRig();
    r.engine.onStart = (s) => s.capturing();
    const res = await r.mgr.start({ workspace: "work" });
    if (!res.ok) throw new Error(res.error);
    r.engine.last.audio(2);
    await r.mgr.stop();
    const c = r.mgr.controller(res.call);
    if (!c) throw new Error("no controller");
    let settled = false;
    const p = finalizeCall(c, {
      models: spec(),
      audio: {
        kind: "module",
        path: FAKE,
        options: { parts: { 1: { mic: silence(2), call: silence(2) } }, hangMs: 20_000 },
      },
      clock: r.clock,
      budgetMs: 60_000,
    }).then((x) => {
      settled = true;
      return x;
    });
    await until(() => existsSync(join(res.folder, LOCK_FILE)), 5_000, "the held writer");
    await r.clock.advance(59_999);
    expect(settled).toBe(false);
    await r.clock.advance(1);
    const out = await p;
    expect(out).toMatchObject({ ok: false });
    expect(c.view.final.state).toBe("failed");
    const failed = ofType(await logOf(res.folder), "final.failed");
    expect(failed).toMatchObject([{ step: "timeout" }]);
    expect(existsSync(join(res.folder, LOCK_FILE))).toBe(false);
  }, 20_000);

  test("the default budget is half the call's length, never under a minute", () => {
    const events = (seconds: number[]) => {
      const b = new LogBuilder();
      b.created({ id: "01J8Z6Q4M2VX0K7B3D4E5F6G7Q" });
      seconds.forEach((s, i) => {
        b.partStarted(i + 1, T0 + i * 3_600_000);
        b.partEnded(i + 1, "stop", s);
      });
      return b.events;
    };
    expect(finalBudgetMs(events([30]))).toBe(60_000);
    expect(finalBudgetMs(events([3600, 1800]))).toBe(2_700_000);
  });

  test("a pass that cannot start writes final.failed and never throws", async () => {
    const r = callRig();
    r.engine.onStart = (s) => s.capturing();
    const res = await r.mgr.start({ workspace: "work" });
    if (!res.ok) throw new Error(res.error);
    await r.mgr.stop();
    const c = r.mgr.controller(res.call);
    if (!c) throw new Error("no controller");
    const out = await finalizeCall(c, {
      models: spec(),
      audio: { kind: "wav", files: { 1: join(res.folder, "missing.wav") } },
      inThread: true,
    });
    expect(out.ok).toBe(false);
    expect(c.view.final.state).toBe("failed");
  });
});
