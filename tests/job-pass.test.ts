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
import { NemotronDiarizer } from "../src/main/asr/nemotron.ts";
import { jobModels, jobWarnings } from "../src/main/server/jobs.ts";
import { concat, FakeModels, MemoryAudio, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { roomNoise } from "./fixtures/audio.ts";
import { LogBuilder, T0 } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

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

  test("[akou-5an.99] a line outside every turn takes the nearest turn's speaker, never `s?`", async () => {
    const x = concat(
      silence(0.3),
      speak(["hello", "world"], { voice: 1 }),
      silence(3),
      speak(["ok"], { voice: 4 }),
      silence(0.3),
    );
    const models = new FakeModels();
    // The one turn ends well over a second before "ok": on a call that line would be `s?`.
    models.diarizer = () => ({ process: async () => [{ speaker: 1, start: 0, end: 1 }] });
    const r = await runJobPass({ samples: x, diarize: true, decode: null }, models);
    expect(r.segments.map((s) => [s.speaker, s.text])).toEqual([
      ["s1", "hello world"],
      ["s1", "ok"],
    ]);
  });

  test("[akou-5an.99] a speaker model that finds no turns, or fails, leaves every speaker null", async () => {
    const x = concat(silence(0.3), speak(["hello", "world"]), silence(0.5));
    for (const process of [
      async () => [],
      () => Promise.reject(new Error("akou-diarize gave no answer")),
    ]) {
      const models = new FakeModels();
      models.diarizer = () => ({ process });
      const r = await runJobPass({ samples: x, diarize: true, decode: null }, models);
      expect(r.segments.map((s) => [s.speaker, s.text])).toEqual([[null, "hello world"]]);
    }
  });

  test("[akou-5an.109] the speaker helper missing: speakers says why, a warning, no speaker model named", async () => {
    const x = concat(silence(0.3), speak(["hello", "world"]), silence(0.5));
    const models = new FakeModels();
    const missing = join(import.meta.dir, "fixtures", "no-such-akou-diarize");
    models.diarizer = () =>
      new NemotronDiarizer({ command: [missing], model: "nemotron.onnx", threads: 1 });
    const r = await runJobPass({ samples: x, diarize: true, decode: null }, models);
    expect(r.text).toBe("hello world");
    expect(r.speakers.asked).toBe(true);
    expect(r.speakers.labelled).toBe(false);
    expect(r.speakers.error).not.toBeNull();
    expect(jobWarnings(r)).toEqual([expect.stringContaining(r.speakers.error as string)]);
    const ran = r.speakers.asked && r.speakers.error === null;
    expect(jobModels("fake-parakeet", ran, "nemotron")).toEqual(["fake-parakeet", "silero-vad"]);
    // Positive control: a speaker model that answers labels the lines, and warns of nothing.
    const ok = await job(concat(silence(0.3), speak(["hello", "world"]), silence(0.5)), {}, true);
    expect(ok.result.speakers).toEqual({ asked: true, labelled: true, error: null });
    expect(jobWarnings(ok.result)).toEqual([]);
  });

  test("[akou-5an.24.1] words are timed into the file across pieces and halved spans, with confidences", async () => {
    const x = concat(silence(1), speak(["hello", "world"]), silence(2), speak(["ok", "great"]));
    const { result } = await job(x, { words: true });
    expect(result.words.map((w) => w.w)).toEqual(["hello", "world", "ok", "great"]);
    // "hello" starts about one second in, "ok" about 1 + 0.74 + 2 s in: file times, not piece times.
    expect(result.words[0]?.s).toBeCloseTo(1, 1);
    expect(result.words[2]?.s).toBeCloseTo(3.74, 1);
    for (const w of result.words) expect(w.c).toBe(0.9);
    // A refused span halved: the halves' words keep their own times.
    const many = Array.from({ length: 70 }, (_, i) => (i % 2 ? "hello" : "world"));
    const halved = await job(speak(many, { gapSeconds: 0.05 }), { refuseOver: 12, words: true });
    expect(halved.result.words.length).toBe(70);
    const starts = halved.result.words.map((w) => w.s as number);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts.at(-1)).toBeGreaterThan(20);
    // Positive control: an engine that gives no words gives none, and no confidence.
    expect((await job(x)).result.words).toEqual([]);
  });

  test("[akou-5an.24.1] a span the engine still refuses at the floor is listed as skipped", async () => {
    const x = concat(silence(0.3), speak(["hello", "world"]), silence(0.5));
    const { result } = await job(x, { refuseOver: 0.2 });
    expect(result.text).toBe("");
    expect(result.skipped).toEqual([
      { s: expect.any(Number), e: expect.any(Number), error: "span too long for the fake engine" },
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

  test("the samples move into the Worker, so a job's audio is not held twice", async () => {
    const w = new JobWorker({ kind: "module", path: FAKE, model: "fake-parakeet", options: {} });
    cleanups.push(() => w.close());
    const samples = concat(speak(["ok"]), silence(0.5));
    expect(samples.length).toBeGreaterThan(0);
    const r = await w.run({ samples, diarize: false, decode: null });
    expect(r.segments.map((s) => s.text)).toEqual(["ok"]);
    // Transferred, not cloned: the caller's buffer is detached.
    expect(samples.length).toBe(0);
  });
});

describe("[akou-5an.100] speakers on or off, the same words", () => {
  // Three turns of two voices over room noise, which keeps every sliver above the silence floor,
  // and an engine that hears a filler in a piece with no word, as Parakeet and Qwen do. Word gaps
  // of 0.05 s keep the fake VAD on through a phrase, so the only pauses are the ones between turns.
  const A = ["hello", "world", "we"];
  const B = ["ok", "great", "today"];
  const talk = concat(
    silence(0.6),
    speak(A, { voice: 1, gapSeconds: 0.05 }),
    silence(0.6),
    speak(B, { voice: 4, gapSeconds: 0.05 }),
    silence(0.6),
    speak(["thanks"], { voice: 1, gapSeconds: 0.05 }),
    silence(0.6),
  );
  const x = mix(roomNoise(talk.length / RATE, 3, 0.006), talk);
  // The phrases sit at 0.6 to 1.5, 2.1 to 3.0 and 3.6 to 3.9 s. The turns as Nemotron places
  // them: each edge a frame or two into the pause, and one 50 ms inside the last word of a turn.
  const turns = [
    { speaker: 0, start: 0.45, end: 1.62 },
    { speaker: 1, start: 1.98, end: 2.9 },
    { speaker: 0, start: 3.5, end: 4.05 },
  ];
  const FILLER = "Yeah.";
  const withSpeakers = (options: { snapSeconds?: number } = {}) => {
    const models = new FakeModels({ hallucinate: FILLER });
    models.diarizer = () => ({ process: () => turns });
    return runJobPass({ samples: x, diarize: true, decode: null, options }, models);
  };

  test("a diarized job carries the plain job's words, labelled, and nothing else", async () => {
    const plain = await job(x, { hallucinate: FILLER });
    expect(plain.text).toBe("hello world we ok great today thanks");
    const r = await withSpeakers();
    expect(r.segments.map((s) => [s.speaker, s.text])).toEqual([
      ["s0", "hello world we"],
      ["s1", "ok great today"],
      ["s0", "thanks"],
    ]);
    expect(r.text).toBe(plain.text);
  });

  test("positive control: cut at the edges as they stand, the diarized job gains words", async () => {
    const r = await withSpeakers({ snapSeconds: 0 });
    expect(r.text).not.toBe("hello world we ok great today thanks");
    expect(r.text.split(" ").length).toBeGreaterThan(7);
  });

  test("a short reply with no pause before it keeps its own line and label", async () => {
    // B answers "ok" 50 ms after A's last word, too soon for the VAD to hear a pause, then a
    // pause, then A again. B's turn starts 60 ms late, inside "ok", so its start edge has no
    // pause in reach and cuts at the quietest window near it, the 50 ms gap. A's end edge snaps
    // forward into the pause after "ok"; B's own edges reach under half its turn, so they never
    // follow it there and swallow the reply into A's line.
    const quick = mix(
      roomNoise(3.1, 5, 0.006),
      concat(
        silence(0.3),
        speak(["hello", "world", "we"], { voice: 1, gapSeconds: 0.05 }),
        speak(["ok"], { voice: 4, gapSeconds: 0.05 }),
        silence(0.7),
        speak(["thanks"], { voice: 1, gapSeconds: 0.05 }),
        silence(0.6),
      ),
    );
    // The phrases sit at 0.3 to 1.15 (A), 1.2 to 1.45 (B) and 2.2 to 2.45 s (A); the job trims
    // nothing, so these are the diarizer's times too.
    const models = new FakeModels({ hallucinate: FILLER });
    models.diarizer = () => ({
      process: () => [
        { speaker: 0, start: 0.2, end: 1.17 },
        { speaker: 1, start: 1.26, end: 1.48 },
        { speaker: 0, start: 2.15, end: 2.6 },
      ],
    });
    const plain = await job(quick, { hallucinate: FILLER });
    expect(plain.text).toBe("hello world we ok thanks");
    const r = await runJobPass({ samples: quick, diarize: true, decode: null }, models);
    expect(r.segments.map((s) => [s.speaker, s.text])).toEqual([
      ["s0", "hello world we"],
      ["s1", "ok"],
      ["s0", "thanks"],
    ]);
    expect(r.text).toBe(plain.text);
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
