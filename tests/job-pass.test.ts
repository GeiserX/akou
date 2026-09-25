/**
 * The mono path of the final pass (docs/ux/SERVER.md SV-J7) and the silence guards of a job
 * (SV-R5), against the fake engines: a job has one channel and no "you", its lines carry a speaker
 * label only when it asks for speakers, and the VAD cut points, the whole-timeline rule and the
 * span halving are the call pass's own. Room noise gives empty text, even from an engine that
 * invents a sentence on noise.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EventDraft, LogEvent, Seg } from "../src/core/log/events.ts";
import {
  JOB_TRIM_PAD_SECONDS,
  JobWorker,
  runFinalPass,
  runJobPass,
} from "../src/main/asr/finalize-worker.ts";
import { concat, FakeModels, MemoryAudio, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { LogBuilder, T0 } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Seeded broadband noise at about -41 dBFS RMS: above the silence floor, under the VAD. */
export function roomNoise(seconds: number, seed = 7, amp = 0.015): Float32Array {
  let a = seed >>> 0;
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = amp * (2 * (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 1);
  }
  return out;
}

function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

async function job(
  samples: Float32Array,
  o: ConstructorParameters<typeof FakeModels>[0] = {},
  diarize = false,
) {
  const models = new FakeModels(o);
  const result = await runJobPass({ samples, diarize, decode: null }, models);
  return { models, result, text: result.segments.map((s) => s.text).join(" ") };
}

describe("SV-J7: a mono path through the finalize worker", () => {
  test("a mono job transcribes, every speaker is null, and no line is `you`", async () => {
    const x = concat(silence(0.5), speak(["hello", "world"]), silence(1), speak(["ok", "great"]));
    const { result, text } = await job(x);
    expect(text).toBe("hello world ok great");
    expect(result.segments.length).toBeGreaterThan(0);
    for (const s of result.segments) {
      expect(s.speaker).toBeNull();
      expect(s.speaker).not.toBe("you");
      expect(s.e).toBeGreaterThan(s.s);
    }
    expect(result.duration_s).toBeCloseTo(x.length / RATE, 3);
  });

  test("positive control: the same audio on a call's mic channel comes back as `you`", async () => {
    const x = concat(silence(0.5), speak(["hello", "world"]), silence(1));
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.partEnded(1, "stop");
    b.add({ type: "call.ended", reason: "stop" });
    const out: EventDraft[] = [];
    await runFinalPass(
      {
        events: b.events as LogEvent[],
        audio: new MemoryAudio({ 1: { mic: x, call: silence(x.length / RATE) } }),
        decode: null,
      },
      new FakeModels(),
      (d) => out.push(d),
    );
    const segs = out.filter((d) => d.type === "seg" && d.text !== null) as Seg[];
    expect(segs.map((s) => s.spk)).toEqual(["you"]);
  });

  test("with diarize a two-speaker clip is labelled with two speakers", async () => {
    const x = concat(
      silence(0.4),
      speak(["hello", "world"], { voice: 1 }),
      silence(1.2),
      speak(["ok", "great"], { voice: 4 }),
      silence(1.2),
      speak(["thanks"], { voice: 1 }),
      silence(0.4),
    );
    const { result, models } = await job(x, {}, true);
    expect(models.diarizers.length).toBe(1);
    const by = result.segments.map((s) => [s.speaker, s.text]);
    expect(by).toEqual([
      ["s0", "hello world"],
      ["s1", "ok great"],
      ["s0", "thanks"],
    ]);
  });

  test("without diarize no diarizer runs", async () => {
    const { models } = await job(concat(speak(["hello"]), silence(0.5)));
    expect(models.diarizers.length).toBe(0);
  });

  test("a word the VAD misses between two runs of speech is still decoded (whole timeline)", async () => {
    // The fake VAD needs 20 loud windows (0.64 s) before it calls anything speech, so the lone
    // 0.4 s "yes" never reaches it; the pieces cover it anyway.
    const x = concat(
      speak(["hello", "world", "we", "should", "move"], { gapSeconds: 0.05 }),
      silence(0.8),
      speak(["yes"], { wordSeconds: 0.4 }),
      silence(0.8),
      speak(["the", "build", "to", "new", "box"], { gapSeconds: 0.05 }),
    );
    const { text } = await job(x, { vadMinSpeechWindows: 20 });
    expect(text).toContain("yes");
  });

  test("a span the engine refuses is halved, as in the call pass", async () => {
    const words = Array.from({ length: 70 }, (_, i) => (i % 2 ? "hello" : "world"));
    const x = speak(words, { gapSeconds: 0.05 });
    const { result, models } = await job(x, { refuseOver: 12 });
    expect(result.skipped).toEqual([]);
    expect(models.calls.length).toBeGreaterThan(2);
    expect(result.segments.map((s) => s.text).join(" ")).toContain("hello world");
  });

  test("the pass runs in the finalize Worker and a stereo call still runs there too", async () => {
    const w = new JobWorker({ kind: "module", path: FAKE, model: "fake-parakeet", options: {} });
    cleanups.push(() => w.close());
    const r = await w.run({
      samples: concat(silence(0.3), speak(["deploy", "today"]), silence(0.5)),
      diarize: false,
      decode: null,
    });
    expect(r.segments.map((s) => s.text)).toEqual(["deploy today"]);
    // A second job reuses the loaded models: the Worker loads them once.
    await w.run({ samples: concat(speak(["ok"]), silence(0.5)), diarize: false, decode: null });
    expect(w.loads()["fake-parakeet"]).toBe(1);
  });
});

describe("SV-R5: silence and hallucination guards on every job", () => {
  const INVENTED = "thank you for watching";

  test("ten seconds of room noise give empty text, even from an engine that invents on noise", async () => {
    const { result, models } = await job(roomNoise(10), { hallucinate: INVENTED });
    expect(result.segments).toEqual([]);
    expect(result.text).toBe("");
    // Nothing was decoded, so nothing could be invented.
    expect(models.calls.length).toBe(0);
  });

  test("positive control: the inventing engine does invent when handed the noise", async () => {
    const models = new FakeModels({ hallucinate: INVENTED });
    const hw = models.prepare(null);
    expect(hw.recognizer.decode(roomNoise(10)).text).toBe(INVENTED);
  });

  test("leading and trailing noise are trimmed, so speech in noise gives only the words", async () => {
    const x = mix(
      roomNoise(8),
      concat(silence(3), speak(["hello", "world"], { amp: 0.4 }), silence(3)),
    );
    const { text, models } = await job(x, { hallucinate: INVENTED });
    expect(text).toBe("hello world");
    // The engine saw the speech and its pad, never the three seconds of noise on either side.
    const speech = speak(["hello", "world"]).length / RATE;
    const decoded = models.calls.reduce((n, c) => n + c.samples, 0) / RATE;
    expect(decoded).toBeLessThan(speech + 2 * JOB_TRIM_PAD_SECONDS + 0.2);
  });

  test("digital silence loads no model at all", async () => {
    const { result, models } = await job(silence(10));
    expect(result.segments).toEqual([]);
    expect(Object.keys(models.loads)).toEqual([]);
  });
});
