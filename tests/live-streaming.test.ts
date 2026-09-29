/**
 * The streaming live path (docs/research/asr-architecture.md section 3.1, ASR-4) against a fake
 * `LiveEngine` (tests/fixtures/asr-fake.ts): which engine a call runs, the causal gain, the line
 * cutter, the pipeline's lines and provisional view, and the host writing them to a call's log.
 * Nothing here loads a model: the real engines are measured by tests/live-nemotron.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LogEvent, Seg } from "../src/core/log/events.ts";
import type { LiveStream, LiveToken, ModelSpec } from "../src/main/asr/engine.ts";
import {
  chooseLiveEngine,
  LIVE_ENGINE_IDS,
  LIVE_ENGINES,
  type LiveChoice,
  type LiveEngineId,
} from "../src/main/asr/live-engines.ts";
import { CausalGain, StreamChannel } from "../src/main/asr/live-stream.ts";
import {
  type CallAccess,
  LiveAsr,
  type LiveOut,
  LivePipeline,
} from "../src/main/asr/live-worker.ts";
import { MODELS } from "../src/main/asr/models.ts";
import { MAX_GAIN, TARGET_PEAK } from "../src/main/asr/pad.ts";
import { onlineConfig, SherpaLiveEngine } from "../src/main/asr/sherpa.ts";
import { CallManager } from "../src/main/call/manager.ts";
import { ManualClock, ofType, ScriptedEngine } from "./capture-helpers.ts";
import { concat, FakeModels, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { TZ, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");
const LIVE: LiveChoice = { engine: "fake-nemotron", lang: "en" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

// ---------------------------------------------------------------------------
// Which engine a call runs

describe("[ASR-4] the live engine a call runs", () => {
  const all = () => true;
  const only =
    (...ids: LiveEngineId[]) =>
    (id: LiveEngineId) =>
      ids.includes(id);

  test("auto picks by the call's languages: English, Spanish, anything else", () => {
    expect(chooseLiveEngine("auto", ["en"], all).choice).toEqual({
      engine: "nemotron-en-560",
      lang: "en",
    });
    expect(chooseLiveEngine("auto", ["es"], all).choice).toEqual({
      engine: "nemotron-3.5-1120",
      lang: "es",
    });
    expect(chooseLiveEngine("auto", ["en", "es"], all).choice).toEqual({
      engine: "nemotron-3.5-560",
      lang: "auto",
    });
    expect(chooseLiveEngine("auto", [], all).choice).toEqual({
      engine: "nemotron-3.5-560",
      lang: "auto",
    });
    expect(chooseLiveEngine("auto", ["de"], all).choice).toEqual({
      engine: "nemotron-3.5-560",
      lang: "de",
    });
  });

  test("auto never picks an engine whose model is missing, and never one deaf to the languages", () => {
    expect(chooseLiveEngine("auto", ["en"], only("nemotron-3.5-560")).choice?.engine).toBe(
      "nemotron-3.5-560",
    );
    // Only the English model is here: a Spanish call, or one with no language set, gets Parakeet.
    const es = chooseLiveEngine("auto", ["es"], only("nemotron-en-560"));
    expect(es.choice).toBeNull();
    expect(es.note).toContain("akou models pull nemotron-3.5-1120");
    expect(chooseLiveEngine("auto", [], only("nemotron-en-560")).choice).toBeNull();
    expect(chooseLiveEngine("auto", ["en"], () => false).choice).toBeNull();
  });

  test("a named engine runs when present, and falls back to Parakeet, saying so, when not", () => {
    expect(chooseLiveEngine("nemotron-3.5-560", ["es"], all).choice).toEqual({
      engine: "nemotron-3.5-560",
      lang: "es",
    });
    expect(chooseLiveEngine("nemotron-en-560", ["es"], all).choice).toEqual({
      engine: "nemotron-en-560",
      lang: "en",
    });
    const gone = chooseLiveEngine("nemotron-3.5-1120", ["es"], only("nemotron-3.5-560"));
    expect(gone.choice).toBeNull();
    expect(gone.note).toContain("nemotron-3.5-1120 is not downloaded");
  });
});

describe("[ASR-4] the streaming models and how sherpa-onnx runs them", () => {
  test("every live engine is a catalog entry that serves live, on demand, with its four int8 files", () => {
    for (const id of LIVE_ENGINE_IDS) {
      const m = MODELS.find((x) => x.id === id);
      expect([id, m?.serves, m?.onDemand]).toEqual([id, ["live"], true]);
      expect(m?.files.map((f) => f.name).sort()).toEqual([
        "decoder.int8.onnx",
        "encoder.int8.onnx",
        "joiner.int8.onnx",
        "tokens.txt",
      ]);
    }
    expect(onlineConfig((n) => `/m/${n}`, 4)).toMatchObject({
      featConfig: { sampleRate: 16000, featureDim: 128 },
      modelConfig: { transducer: { encoder: "/m/encoder.int8.onnx" }, numThreads: 4 },
      decodingMethod: "greedy_search",
      enableEndpoint: 0,
    });
  });
});

/**
 * sherpa-onnx's OnlineRecognizer in miniature: a chunk is 0.56 s, and each chunk with sound in it
 * yields one token, timed at the chunk's start within the current segment.
 */
const CHUNK = 8960;
interface FakeOnlineStream {
  total: number;
  heard: number;
  /** `[from, to)` sample ranges with sound. */
  loud: [number, number][];
  tokens: string[];
  times: number[];
  start: number;
  blanks: number;
  options: Map<string, string>;
  acceptWaveform(o: { samples: Float32Array }): void;
  setOption(k: string, v: string): void;
}

class FakeOnline {
  decodes: number[] = [];
  resets = 0;
  made: FakeOnlineStream[] = [];
  createStream(): FakeOnlineStream {
    const s: FakeOnlineStream = {
      total: 0,
      heard: 0,
      loud: [],
      tokens: [],
      times: [],
      start: 0,
      blanks: 0,
      options: new Map(),
      acceptWaveform(o) {
        if (o.samples.some((v) => v !== 0)) s.loud.push([s.total, s.total + o.samples.length]);
        s.total += o.samples.length;
      },
      setOption(k, v) {
        s.options.set(k, v);
      },
    };
    this.made.push(s);
    return s;
  }
  isReady(s: FakeOnlineStream) {
    return s.total - s.heard * CHUNK >= CHUNK;
  }
  decode(s: FakeOnlineStream) {
    this.decodes.push(1);
    this.step(s);
  }
  decodeStreams(ss: FakeOnlineStream[]) {
    this.decodes.push(ss.length);
    for (const s of ss) this.step(s);
  }
  private step(s: FakeOnlineStream) {
    const [a, b] = [s.heard * CHUNK, (s.heard + 1) * CHUNK];
    if (s.loud.some(([f, t]) => f < b && t > a)) {
      s.tokens.push(` w${s.heard}`);
      s.times.push((s.heard * CHUNK) / RATE - s.start);
      s.blanks = 0;
    } else s.blanks += 7;
    s.heard++;
  }
  getResult(s: FakeOnlineStream) {
    return {
      tokens: [...s.tokens],
      timestamps: [...s.times],
      ys_probs: s.tokens.map(() => -0.1),
      start_time: s.start,
      num_trailing_blanks: s.blanks,
    };
  }
  reset(s: FakeOnlineStream) {
    this.resets++;
    s.start = (s.heard * CHUNK) / RATE;
    s.tokens = [];
    s.times = [];
  }
}

describe("[ASR-4] the sherpa-onnx live stream", () => {
  const info = LIVE_ENGINES["nemotron-3.5-560"];
  const loud = (seconds: number) => new Float32Array(Math.round(seconds * RATE)).fill(0.1);
  const quiet = (seconds: number) => new Float32Array(Math.round(seconds * RATE));

  test("a flush's padding takes no time on the caller's timeline, and the language reaches the stream", () => {
    const rec = new FakeOnline();
    const engine = new SherpaLiveEngine("nemotron-3.5-560", rec, info);
    const s = engine.open("es");
    expect(s.push(loud(1.12)).map((t) => t.t)).toEqual([0, 0.56]);
    expect(s.flush()).toEqual([]);
    // 1.56 s of padding sit on the stream at 1.12 s; the caller's next audio is at 1.12 s too. A
    // chunk that straddles the padding's end is placed where the padding sits, never inside it.
    const after = s.push(loud(1.12));
    expect(after.map((t) => t.t)).toEqual([1.12, 1.24]);
    expect(after.every((t) => t.conf > 0.9 && t.conf <= 1)).toBe(true);
    expect(rec.made[0]?.options.get("language")).toBe("es");
    engine.open("auto");
    expect(rec.made[1]?.options.has("language")).toBe(false);
  });

  test("the two channels' ready chunks decode in one batch; a channel that stops holds the other back at most 0.25 s", () => {
    const rec = new FakeOnline();
    const engine = new SherpaLiveEngine("nemotron-3.5-560", rec, info);
    const [mic, call] = [engine.open("auto"), engine.open("auto")];
    for (let k = 0; k < 20; k++) {
      mic.push(loud(0.1));
      call.push(loud(0.1));
    }
    expect(rec.decodes.length).toBeGreaterThan(0);
    expect(rec.decodes.every((n) => n === 2)).toBe(true);
    // The call channel goes silent (no audio at all): the mic decodes alone after its wait.
    rec.decodes = [];
    const got: LiveToken[] = [];
    for (let k = 0; k < 20; k++) got.push(...mic.push(loud(0.1)));
    expect(rec.decodes).toContain(1);
    expect(got.length).toBeGreaterThan(0);
  });

  test("a long result is reset at a pause, and no token is lost or repeated across the reset", () => {
    const rec = new FakeOnline();
    const engine = new SherpaLiveEngine("nemotron-3.5-560", rec, info);
    const s = engine.open("auto");
    const got: LiveToken[] = [];
    for (let k = 0; k < 3; k++) {
      got.push(...s.push(loud(0.56 * 450)));
      got.push(...s.push(quiet(0.56 * 2)));
    }
    expect(rec.resets).toBeGreaterThanOrEqual(2);
    expect(got.length).toBe(1350);
    expect(new Set(got.map((t) => t.text)).size).toBe(1350);
    // Times keep increasing across each reset.
    for (let i = 1; i < got.length; i++) {
      expect((got[i] as LiveToken).t).toBeGreaterThan((got[i - 1] as LiveToken).t);
    }
  });
});

// ---------------------------------------------------------------------------
// The causal gain

describe("[ASR-4] the causal gain", () => {
  const tone = (amp: number, seconds: number) =>
    Float32Array.from(
      { length: Math.round(seconds * RATE) },
      (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / RATE),
    );
  const peakOf = (x: Float32Array) => x.reduce((p, v) => Math.max(p, Math.abs(v)), 0);

  test("a quiet voice is raised toward -3 dBFS, at most +20 dB, and a loud one never clips", () => {
    const g = new CausalGain();
    const quiet = g.apply(tone(0.004, 1));
    // 0.004 wants +45 dB: the cap holds it at +20 dB.
    expect(peakOf(quiet.subarray(RATE / 2))).toBeCloseTo(0.004 * MAX_GAIN, 3);
    const mid = new CausalGain().apply(tone(0.1, 1));
    expect(peakOf(mid.subarray(RATE / 2))).toBeCloseTo(TARGET_PEAK, 2);
    // Instant attack: a sudden loud passage is never pushed past the target.
    const jump = g.apply(tone(0.9, 0.5));
    expect(peakOf(jump)).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  test("it releases over seconds, so a pause after a loud word does not snap the gain up", () => {
    const g = new CausalGain();
    g.apply(tone(0.7, 0.5));
    const after = g.apply(tone(0.1, 1));
    // One second after, the follower still remembers most of the loud peak.
    expect(peakOf(after.subarray(RATE / 2))).toBeLessThan(0.1 * 1.5);
    // Positive control: with a release of 50 ms, the same quiet passage is raised about +17 dB.
    const fast = new CausalGain(RATE, 0.05);
    fast.apply(tone(0.7, 0.5));
    expect(peakOf(fast.apply(tone(0.1, 1)).subarray(RATE / 2))).toBeGreaterThan(0.1 * 5);
  });
});

// ---------------------------------------------------------------------------
// The line cutter, fed scripted tokens

/** A stream that returns scripted tokens by the time they become due, with the given lag. */
class ScriptedStream implements LiveStream {
  private pos = 0;
  private next = 0;
  constructor(
    private readonly tokens: LiveToken[],
    private readonly lag = 0.56,
  ) {}
  push(samples: Float32Array): LiveToken[] {
    this.pos += samples.length;
    return this.due(this.pos / RATE - this.lag);
  }
  /** Everything pushed so far, and nothing after it. */
  flush(): LiveToken[] {
    return this.due(this.pos / RATE);
  }
  close(): void {}
  private due(until: number): LiveToken[] {
    const out: LiveToken[] = [];
    while (this.next < this.tokens.length && (this.tokens[this.next] as LiveToken).t <= until)
      out.push(this.tokens[this.next++] as LiveToken);
    return out;
  }
}

const tok = (text: string, t: number): LiveToken => ({ text, t, conf: 1 });

function drive(sc: StreamChannel, seconds: number, part = 1, start = 0) {
  const lines = [];
  const step = RATE / 10;
  for (let at = 0; at < seconds * RATE; at += step) {
    lines.push(...sc.push(part, start + at, new Float32Array(step)));
  }
  return lines;
}

describe("[ASR-4] lines cut from streaming tokens", () => {
  const o = { pause: 0.7, window: 12, tierMs: 560 };

  test("a gap of 0.7 s between tokens closes a line; a shorter one does not", () => {
    const sc = new StreamChannel(
      new ScriptedStream([
        tok(" we", 1),
        tok(" sho", 1.3),
        tok("uld", 1.3),
        tok(" move", 1.8),
        tok(" the", 3),
        tok(" build", 3.4),
      ]),
      o,
    );
    const lines = [...drive(sc, 6), ...sc.flush()];
    expect(lines.map((l) => l.text)).toEqual(["we should move", "the build"]);
    const [a, b] = lines;
    expect(a?.from).toBe(Math.round((1 - 0.3) * RATE));
    // The first line ends before the second starts: no audio in two lines.
    expect(a?.to as number).toBeLessThanOrEqual(b?.from as number);
    // A 0.9 s gap from an engine that answers fast: the gap closes the line, before silence would.
    const quick = new StreamChannel(
      new ScriptedStream([tok(" ok", 1), tok(" great", 1.9), tok(" thanks", 2.2)], 0.1),
      o,
    );
    expect([...drive(quick, 4), ...quick.flush()].map((l) => l.text)).toEqual([
      "ok",
      "great thanks",
    ]);
  });

  test("silence closes the open line once the pause and the engine's chunk have passed", () => {
    const sc = new StreamChannel(new ScriptedStream([tok(" hello", 1), tok(" world", 1.4)]), o);
    const early = drive(sc, 1.4 + 0.56 + 0.5);
    expect(early).toEqual([]);
    expect(sc.open()?.text).toBe("hello world");
    const later = drive(sc, 1.5, 1, Math.round(2.46 * RATE));
    expect(later.map((l) => l.text)).toEqual(["hello world"]);
    expect(sc.open()).toBeNull();
  });

  test("an engine that answers 1.4 s behind the audio never has a word split across lines", () => {
    const sc = new StreamChannel(
      new ScriptedStream([tok(" re", 1), tok("search", 1.3), tok(" ers", 1.6)], 1.4),
      o,
    );
    const lines = [...drive(sc, 5), ...sc.flush()];
    expect(lines.map((l) => l.text)).toEqual(["research ers"]);
  });

  test("unbroken speech is cut at the 12 s window, only before a word, and no token is lost", () => {
    const tokens: LiveToken[] = [];
    // "day" at 12.55 s is the first token past the window, 12.05 s after the line began; the cut
    // waits for the next word, " to" at 12.65 s.
    for (let k = 0; 0.5 + 0.45 * k < 20; k++) {
      tokens.push(tok(" to", 0.5 + 0.45 * k), tok("day", 0.85 + 0.45 * k));
    }
    const sc = new StreamChannel(new ScriptedStream(tokens), o);
    const lines = [...drive(sc, 21), ...sc.flush()];
    expect(lines.length).toBe(2);
    expect(((lines[0]?.to as number) - (lines[0]?.from as number)) / RATE).toBeLessThanOrEqual(
      12.5,
    );
    const words = lines.flatMap((l) => l.text.split(" "));
    expect(words.every((w) => w === "today")).toBe(true);
    expect(words.length).toBe(tokens.length / 2);
  });

  test("Chinese, Japanese and Thai tokens carry no space, and still break at a gap and at 12 s", () => {
    const secs = (l: { from: number; to: number }) => (l.to - l.from) / RATE;
    // A 0.9 s gap between two Japanese words, from an engine that answers fast: the gap closes
    // the first line, before silence would.
    const gap = new StreamChannel(
      new ScriptedStream([tok("こんにち", 1), tok("は", 1.3), tok("ありがとう", 2.2)], 0.1),
      o,
    );
    expect([...drive(gap, 5), ...gap.flush()].map((l) => l.text)).toEqual([
      "こんにちは",
      "ありがとう",
    ]);
    // 30 s of unbroken Chinese and Thai: every line within the window, no token lost.
    const tokens: LiveToken[] = [];
    for (let k = 0; 0.5 + 0.3 * k < 30; k++)
      tokens.push(tok(k % 2 ? "今天" : "สวัสดี", 0.5 + 0.3 * k));
    const sc = new StreamChannel(new ScriptedStream(tokens), o);
    const lines = [...drive(sc, 31), ...sc.flush()];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(secs(l)).toBeLessThanOrEqual(12.5);
    expect(lines.map((l) => l.text).join("")).toBe(tokens.map((t) => t.text).join(""));
    // A script the cutter does not know as space-less still breaks a second past the window.
    const pieces: LiveToken[] = [];
    for (let k = 0; 0.5 + 0.3 * k < 30; k++) pieces.push(tok("ab", 0.5 + 0.3 * k));
    const other = new StreamChannel(new ScriptedStream(pieces), o);
    const long = [...drive(other, 31), ...other.flush()];
    expect(long.length).toBeGreaterThanOrEqual(3);
    for (const l of long) expect(secs(l)).toBeLessThanOrEqual(14);
    expect(long.map((l) => l.text).join("")).toBe("ab".repeat(pieces.length));
  });

  test("a line maps back to the part and file position its audio came from", () => {
    const sc = new StreamChannel(new ScriptedStream([tok(" ok", 1), tok(" great", 3.2)]), o);
    drive(sc, 2, 1, 0);
    const first = sc.flush();
    expect(first.map((l) => [l.part, l.text])).toEqual([[1, "ok"]]);
    // Part 2 starts at file position 0 again; the stream's own timeline carries on.
    const second = [...drive(sc, 3, 2, 0), ...sc.flush()];
    expect(second.map((l) => [l.part, l.text])).toEqual([[2, "great"]]);
    expect(second[0]?.from).toBe(Math.round((3.2 - 2 - 0.3) * RATE));
  });
});

// ---------------------------------------------------------------------------
// The pipeline with a fake streaming engine

function pipeline(o: ConstructorParameters<typeof FakeModels>[0] = {}) {
  const models = new FakeModels(o);
  const out: LiveOut[] = [];
  const p = new LivePipeline(
    models,
    {},
    (x) => out.push(x),
    () => 0,
  );
  const segs = () => out.filter((x): x is Extract<LiveOut, { type: "seg" }> => x.type === "seg");
  const shown = () =>
    out.filter((x): x is Extract<LiveOut, { type: "provisional" }> => x.type === "provisional");
  return { models, out, p, segs, shown };
}

function feed(p: LivePipeline, ch: "mic" | "call", audio: Float32Array, part = 1, step = 1600) {
  for (let at = 0; at < audio.length; at += step) {
    p.audio(part, ch, at, audio.subarray(at, Math.min(audio.length, at + step)));
  }
}

const noSpeakers = { centroids: [], merges: [], unmerged: [], ids: [] };

describe("[ASR-4] the live pipeline on a streaming engine", () => {
  test("lines come from the stream, written with the engine's id, and no word is ever taken back", async () => {
    const { p, segs, shown } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE });
    feed(
      p,
      "mic",
      concat(
        silence(0.5),
        speak(["we", "should", "move", "the", "build"]),
        silence(1.5),
        speak(["to", "the", "new", "box"]),
        silence(2),
      ),
    );
    await p.endPart(1);
    expect(segs().map((s) => [s.text, s.model, s.spk])).toEqual([
      ["we should move the build", "fake-nemotron", "you"],
      ["to the new box", "fake-nemotron", "you"],
    ]);
    // Every provisional line extends the one before it until its line is written, and the line
    // written holds every word shown: nothing shown is ever withdrawn.
    const views = shown();
    expect(views.length).toBeGreaterThan(4);
    for (let i = 1; i < views.length; i++) {
      const [a, b] = [views[i - 1], views[i]] as { a0: number; text: string }[];
      if (a && b && a.a0 === b.a0) expect(b.text.startsWith(a.text)).toBe(true);
    }
    for (const v of views) {
      expect(segs().some((s) => s.text.startsWith(v.text) && Math.abs(s.a0 - v.a0) < 1e-9)).toBe(
        true,
      );
    }
  });

  test("a word shows about one engine chunk after it is said, well before its line closes", async () => {
    const { p, out } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE });
    const words = speak(["hello", "world", "we", "should", "move"]);
    const audio = concat(silence(0.5), words, silence(2));
    let fed = 0;
    let shownAt = -1;
    for (let at = 0; at < audio.length; at += 160) {
      p.audio(1, "mic", at, audio.subarray(at, at + 160));
      fed = at + 160;
      if (shownAt < 0 && out.some((x) => x.type === "provisional")) shownAt = fed;
    }
    // "hello" ends at 0.75 s; the fake engine's chunk is 0.56 s.
    expect(shownAt / RATE).toBeGreaterThan(0.75 + 0.56);
    expect(shownAt / RATE).toBeLessThan(0.75 + 0.56 + 0.2);
  });

  test("audio skipped mid-line closes the line and starts a new one after the gap", async () => {
    const { p, segs } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE });
    const a = concat(silence(0.3), speak(["hello", "world"]));
    feed(p, "mic", a);
    const later = Math.round(30 * RATE);
    const b = concat(speak(["thanks"]), silence(2));
    for (let at = 0; at < b.length; at += 1600)
      p.audio(1, "mic", later + at, b.subarray(at, at + 1600));
    await p.endPart(1);
    const s = segs();
    expect(s.map((x) => x.text)).toEqual(["hello world", "thanks"]);
    expect(s[1]?.a0 as number).toBeGreaterThanOrEqual(30 - 0.31);
  });

  test("a line still open when the call ends is written by the flush", async () => {
    const { p, segs } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE });
    feed(p, "call", concat(silence(0.3), speak(["deploy", "the", "build"], { voice: 1 })));
    expect(segs()).toEqual([]);
    await p.flush();
    expect(segs().map((s) => [s.text, s.spk])).toEqual([["deploy the build", "c1"]]);
  });

  test("call lines still get speaker labels from the stream diarizer", async () => {
    const { p, segs } = pipeline({ diarizer: "nemotron" });
    await p.beginCall({ ...noSpeakers, live: LIVE });
    feed(
      p,
      "call",
      concat(
        silence(0.3),
        speak(["hello", "world", "we", "should"], { voice: 1 }),
        silence(1.5),
        speak(["move", "the", "build", "today"], { voice: 4 }),
        silence(2),
      ),
    );
    await p.endPart(1);
    expect(segs().map((s) => [s.text, s.spk])).toEqual([
      ["hello world we should", "c1"],
      ["move the build today", "c2"],
    ]);
  });

  test("an engine that does not load leaves the call on the recognizer, and says so", async () => {
    const { p, segs, out } = pipeline({ liveFails: true });
    await p.beginCall({ ...noSpeakers, live: LIVE });
    feed(p, "mic", concat(silence(0.3), speak(["hello", "world"]), silence(1)));
    await p.endPart(1);
    expect(segs().map((s) => [s.text, s.model])).toEqual([["hello world", "fake-parakeet"]]);
    expect(
      out.some((x) => x.type === "log" && x.level === "error" && x.msg.includes("did not load")),
    ).toBe(true);
  });

  test("one stream per channel for the whole call, parts included; a new call opens new ones", async () => {
    const { p, models } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE });
    feed(p, "mic", concat(speak(["ok"]), silence(1)), 1);
    await p.endPart(1);
    feed(p, "mic", concat(speak(["great"]), silence(1)), 2);
    await p.endPart(2);
    const engine = models.liveEngines[0];
    expect(models.liveEngines.length).toBe(1);
    expect(engine?.streams.length).toBe(2);
    await p.beginCall({ ...noSpeakers, live: LIVE });
    expect(engine?.streams.length).toBe(4);
    expect(engine?.streams.slice(0, 2).every((s) => s.closed)).toBe(true);
    expect(models.loads["fake-nemotron"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The host: the choice is asked per call

describe("[ASR-4] the host asks for the live engine when a call starts", () => {
  test("a changed choice applies from the next call; the running call keeps its engine", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const clock = new ManualClock();
    const engine = new ScriptedEngine(clock);
    const events: LogEvent[] = [];
    let choice: LiveChoice | null = LIVE;
    let asr: LiveAsr | null = null;
    const mgr = new CallManager({
      root: t.dir,
      engine,
      clock,
      tz: TZ,
      user: "Ana",
      budgets: { stallMs: 1e12, flushMs: 60_000 },
      onEvent: (id, e) => {
        events.push(e);
        asr?.onEvent(id, e);
      },
      onPacket: (id, part, pk, ingest) => asr?.onPacket(id, part, pk, ingest),
      beforeEnd: (id) => asr?.flush(id) ?? Promise.resolve(),
    });
    const spec: ModelSpec = { kind: "module", path: FAKE, model: "fake-parakeet", options: {} };
    asr = new LiveAsr(
      { models: spec, inThread: true, clock, liveEngine: () => choice },
      (id) => mgr.controller(id) as CallAccess | undefined,
    );
    const a = asr;
    cleanups.push(async () => {
      await mgr.quit();
      await a.close();
    });
    await a.ready;
    const call = async (word: string) => {
      engine.onStart = (s) => s.capturing();
      const res = await mgr.start({ workspace: "work", title: word });
      if (!res.ok) throw new Error(res.error);
      engine.onStart = null;
      const audio = concat(silence(0.5), speak([word]), silence(2));
      engine.last.play(audio, silence(audio.length / RATE));
      // Changed mid-call: this call keeps what it started with.
      choice = choice ? null : LIVE;
      await mgr.stop();
    };
    await call("hello");
    await call("thanks");
    const segs = ofType(events, "seg") as Seg[];
    expect(segs.map((s) => [s.text, s.model])).toEqual([
      ["hello", "fake-nemotron"],
      ["thanks", "fake-parakeet"],
    ]);
  });
});
