/**
 * Deterministic speech engines for CI (the `module` model spec). Nothing here is speech: a "word"
 * is a tone burst at the word's own frequency, and a "voice" is a quieter tone at the speaker's own
 * frequency mixed into every word that speaker says. The fake recognizer reads the word
 * frequencies back, the fake embedder and diarizers read the voice frequencies, and the fake VAD is
 * an energy detector with Silero-like hysteresis. The fake stream diarizer decides in steps with a
 * look-ahead, as Nemotron does live, so its answers come after the audio they are about. That is enough to drive every rule of the live
 * and final pipelines and to make each trap fail when its rule is broken.
 *
 * The fake recognizer keeps two engine behaviours the traps are about:
 * - a floor: a span shorter than 0.3 s comes back empty (hark's engines lost short words so);
 * - biasing: a word with a `heard` form is recognized as that form unless its term is in the
 *   stream's hotwords.
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import type { Channel } from "../../src/core/log/events.ts";
import type {
  DiarizedSpan,
  Diarizer,
  Embedder,
  FinalEngine,
  Hypothesis,
  LiveEngine,
  LiveStream,
  LiveToken,
  ModelSet,
  PreparedHotwords,
  Recognized,
  Recognizer,
  SpeakerTurn,
  StreamDiarizer,
  StreamListener,
  Vad,
  WordHyp,
} from "../../src/main/asr/engine.ts";
import type { FinalAudio } from "../../src/main/asr/finalize-worker.ts";
import { GREEDY_NO_HOTWORDS } from "../../src/main/asr/sherpa.ts";
import { DEFAULT_BOOST, type DecodeList, modelKind } from "../../src/main/vocab/decode-list.ts";

export const RATE = 16000;

/** The fake vocabulary: a spoken word, what the engine says unbiased, and the term that fixes it. */
export const WORDS: readonly { sound: string; heard?: string; term?: string }[] = [
  { sound: "yes" },
  { sound: "no" },
  { sound: "hello" },
  { sound: "world" },
  { sound: "we" },
  { sound: "should" },
  { sound: "move" },
  { sound: "the" },
  { sound: "build" },
  { sound: "to" },
  { sound: "new" },
  { sound: "box" },
  { sound: "thanks" },
  { sound: "meeting" },
  { sound: "today" },
  { sound: "deploy" },
  { sound: "hetzner", heard: "hetzna", term: "Hetzner" },
  { sound: "kubernetes", heard: "kubernetis", term: "Kubernetes" },
  { sound: "ok" },
  { sound: "great" },
  // A replacement's words (DC-U5): "example dot com" to example.com.
  { sound: "example" },
  { sound: "dot" },
  { sound: "com" },
  // A symbol alone as a dictation replacement (DC-U5): "at sign" to @.
  { sound: "at" },
  { sound: "sign" },
];

export const wordFreq = (i: number) => 300 + 60 * i;
export const voiceFreq = (v: number) => 2600 + 250 * v;
export const VOICES = 8;

export interface SpeakOptions {
  voice?: number;
  wordSeconds?: number;
  gapSeconds?: number;
  amp?: number;
}

/** Tone-coded speech: each word a burst at its frequency, the voice mixed in, gaps between. */
export function speak(words: readonly string[], o: SpeakOptions = {}): Float32Array {
  const wordS = o.wordSeconds ?? 0.25;
  const gapS = o.gapSeconds ?? 0.12;
  const amp = o.amp ?? 0.3;
  const voice = o.voice ?? 0;
  const wn = Math.round(wordS * RATE);
  const gn = Math.round(gapS * RATE);
  const out = new Float32Array(words.length * (wn + gn));
  words.forEach((w, k) => {
    const i = WORDS.findIndex((x) => x.sound === w);
    if (i < 0) throw new Error(`the fake engine has no word "${w}"`);
    const f = wordFreq(i);
    const fv = voiceFreq(voice);
    const base = k * (wn + gn);
    for (let n = 0; n < wn; n++) {
      const env = Math.min(1, n / 80, (wn - n) / 80);
      out[base + n] =
        env *
        (amp * Math.sin((2 * Math.PI * f * n) / RATE) +
          0.35 * amp * Math.sin((2 * Math.PI * fv * n) / RATE));
    }
  });
  return out;
}

export function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * RATE));
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function goertzel(x: Float32Array, from: number, to: number, f: number): number {
  const w = (2 * Math.PI * f) / RATE;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = (x[i] as number) + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/** Runs of 10 ms frames above the energy threshold, merged across gaps under 40 ms. */
export function bursts(x: Float32Array, threshold = 0.02): [number, number][] {
  const frame = RATE / 100;
  const runs: [number, number][] = [];
  let start = -1;
  for (let at = 0; at < x.length; at += frame) {
    let s = 0;
    const end = Math.min(x.length, at + frame);
    for (let i = at; i < end; i++) s += (x[i] as number) ** 2;
    const loud = Math.sqrt(s / Math.max(1, end - at)) > threshold;
    if (loud && start < 0) start = at;
    if (!loud && start >= 0) {
      runs.push([start, at]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, x.length]);
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < RATE * 0.04) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged.filter(([a, b]) => b - a >= RATE * 0.05);
}

function argmax(x: Float32Array, a: number, b: number, freqs: number[]): number {
  let best = 0;
  let bp = -1;
  freqs.forEach((f, i) => {
    const p = goertzel(x, a, b, f);
    if (p > bp) {
      bp = p;
      best = i;
    }
  });
  return best;
}

export interface FakeOptions {
  /** `fake-parakeet` (a transducer) or `fake-moonshine` (takes no hotwords). */
  model?: string;
  /** Each decode busy-waits this long (a slow machine). */
  slowMs?: number;
  /** Each recognizer load busy-waits this long (a big model on a slow disk). */
  loadMs?: number;
  /** Each speaker-label pass busy-waits this long. */
  diarizeMs?: number;
  /** Each speaker-label pass fails with this message, as a missing `akou-diarize` does. */
  diarizeFails?: string;
  /**
   * The recognizer reports its words, one per tone burst, timed into the span and with a
   * confidence, as sherpa-onnx does; by default it reports text only.
   */
  words?: boolean;
  /** A span longer than this is refused (throws), seconds. */
  refuseOver?: number;
  /** Terms the tokenization check would drop. */
  unencodable?: string[];
  /** Decodes like `asr.parakeet.decoding` greedy: no hotwords, whatever the list. */
  greedy?: boolean;
  /** The engine prints a warning on every decode. */
  noisy?: boolean;
  /** Consecutive loud windows before the fake VAD reports speech (Silero's min speech). */
  vadMinSpeechWindows?: number;
  /**
   * The first decode in any thread creates this file and then throws outside any handler, which
   * kills a Worker the way a native crash would. Later Workers find the file and run normally.
   * Real Worker only: in-thread it would kill the test runner.
   */
  crashOnceFile?: string;
  /** Each recognizer decode appends its sample count as a line here, for a test that counts them. */
  decodesFile?: string;
  /** `nemotron`: live labels from `FakeStreamDiarizer`. Default: embedding clusters. */
  diarizer?: "nemotron" | "embeddings";
  /** The fake stream diarizer's step and look-ahead, seconds (Nemotron live: 1.68 and 0.32). */
  streamStep?: number;
  streamLookahead?: number;
  /** The fake stream diarizer dies after this many seconds of audio. */
  streamDiesAfter?: number;
  /** The fake stream diarizer never decides anything and never answers a flush. */
  streamStuck?: boolean;
  /**
   * A span with no word in it comes back as this text instead of empty: an engine that invents a
   * sentence on noise, as Qwen3, Moonshine and Cohere did before sherpa-onnx 1.13.8 (SV-R5).
   */
  hallucinate?: string;
  /** The fake streaming engine's chunk, ms: how long after a word ends it is emitted (560). */
  liveTierMs?: number;
  /** Loading a streaming engine throws (a missing or broken model). */
  liveFails?: boolean;
  /** Pushing audio into a streaming engine's stream throws (a native decode error). */
  livePushFails?: boolean;
  /**
   * Each streaming engine load busy-waits this long, and the set then holds one engine at a time,
   * as sherpa's does: loading another lets the one before go.
   */
  liveLoadMs?: number;
  /** `release` takes this long before it lets go of the models, ms. */
  releaseMs?: number;
  /** The language a `createEngine` engine reports on `auto` (default `en`). */
  engineLang?: string;
  /** Ids of `createEngine` engines whose load fails. */
  engineLoadFails?: string[];
}

export interface DecodeCall {
  samples: number;
  hotwords: string | undefined;
  /** How many arguments the stream was created with, as sherpa-onnx would see it. */
  args: number;
}

/** Holds the thread, as a native call does. */
function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}

export class FakeRecognizer implements Recognizer {
  readonly kind;
  readonly calls: DecodeCall[] = [];
  constructor(
    readonly model: string,
    private readonly o: FakeOptions,
  ) {
    this.kind = modelKind(model);
  }

  decode(samples: Float32Array, hotwords?: string): Recognized {
    this.calls.push({
      samples: samples.length,
      hotwords,
      args: hotwords === undefined ? 0 : 1,
    });
    if (this.o.decodesFile) appendFileSync(this.o.decodesFile, `${samples.length}\n`);
    if (hotwords !== undefined && this.kind !== "transducer") {
      // What sherpa-onnx does: log and exit the process. The test sees a throw instead.
      throw new Error("Only transducer models support contextual biasing.");
    }
    if (this.o.noisy) console.warn("fake-engine: harmless warning from the model");
    if (this.o.crashOnceFile && !existsSync(this.o.crashOnceFile)) {
      writeFileSync(this.o.crashOnceFile, "");
      setTimeout(() => {
        throw new Error("simulated worker crash");
      }, 0);
    }
    if (this.o.slowMs) {
      const end = performance.now() + this.o.slowMs;
      while (performance.now() < end) {}
    }
    if (this.o.refuseOver !== undefined && samples.length > this.o.refuseOver * RATE) {
      throw new Error("span too long for the fake engine");
    }
    // The engine floor: short spans lose their words.
    if (samples.length < 0.3 * RATE) return { text: "" };
    const biased = new Set(
      (hotwords ?? "")
        .split("/")
        .map((h) => h.replace(/\s+:\S+$/, "").trim())
        .filter(Boolean),
    );
    const freqs = WORDS.map((_, i) => wordFreq(i));
    const out: string[] = [];
    const words: WordHyp[] = [];
    for (const [a, b] of bursts(samples)) {
      const k = argmax(samples, a, b, freqs);
      // A sound that is no word (a hum between the word tones) gives no text.
      let energy = 0;
      for (let i = a; i < b; i++) energy += (samples[i] as number) ** 2;
      const tone = goertzel(samples, a, b, freqs[k] as number) / (energy * ((b - a) / 2));
      if (tone < 0.3) continue;
      const w = WORDS[k] as (typeof WORDS)[number];
      out.push(w.term && biased.has(w.term) ? w.term : (w.heard ?? w.sound));
      words.push({ w: out.at(-1) as string, t0: a / RATE, t1: b / RATE, conf: 0.9 });
    }
    if (out.length === 0 && this.o.hallucinate) return { text: this.o.hallucinate };
    return this.o.words ? { text: out.join(" "), words } : { text: out.join(" ") };
  }
}

export class FakeVad implements Vad {
  readonly windowSize = 512;
  private loud = 0;
  private quiet = 0;
  private speaking = false;
  constructor(private readonly minSpeech = 2) {}

  accept(window: Float32Array): boolean {
    let s = 0;
    for (let i = 0; i < window.length; i++) s += (window[i] as number) ** 2;
    const on = Math.sqrt(s / window.length) > 0.02;
    if (on) {
      this.loud++;
      this.quiet = 0;
      if (this.loud >= this.minSpeech) this.speaking = true;
    } else {
      this.quiet++;
      if (this.quiet >= 3) {
        this.speaking = false;
        this.loud = 0;
      }
    }
    return this.speaking;
  }

  reset(): void {
    this.loud = 0;
    this.quiet = 0;
    this.speaking = false;
  }
}

export class FakeEmbedder implements Embedder {
  readonly dim = VOICES;
  calls = 0;
  embed(samples: Float32Array): Float32Array {
    this.calls++;
    const v = new Float32Array(VOICES);
    for (const [a, b] of bursts(samples)) {
      for (let k = 0; k < VOICES; k++)
        v[k] = (v[k] as number) + goertzel(samples, a, b, voiceFreq(k));
    }
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < VOICES; k++) v[k] = (v[k] as number) / n;
    return v;
  }
}

export class FakeDiarizer implements Diarizer {
  calls = 0;
  constructor(
    private readonly busyMs = 0,
    private readonly fails?: string,
  ) {}
  process(samples: Float32Array): DiarizedSpan[] {
    this.calls++;
    busyWait(this.busyMs);
    if (this.fails !== undefined) throw new Error(this.fails);
    const freqs = Array.from({ length: VOICES }, (_, k) => voiceFreq(k));
    const spans: DiarizedSpan[] = [];
    // Clusters are numbered by first appearance, as sherpa-onnx numbers them.
    const ids = new Map<number, number>();
    for (const [a, b] of bursts(samples)) {
      const voice = argmax(samples, a, b, freqs);
      if (!ids.has(voice)) ids.set(voice, ids.size);
      const speaker = ids.get(voice) as number;
      const last = spans[spans.length - 1];
      if (last && last.speaker === speaker && a / RATE - last.end < 0.5) last.end = b / RATE;
      else spans.push({ start: a / RATE, end: b / RATE, speaker });
    }
    return spans;
  }
}

/**
 * A stream diarizer in the shape of Nemotron live: audio is held until a step plus its look-ahead
 * has arrived, then the step is decided (each burst's voice, numbered by first appearance in the
 * stream) and reported. The stream carries across pushes until `reset`.
 */
export class FakeStreamDiarizer implements StreamDiarizer {
  private held: Float32Array[] = [];
  private heldStart = 0;
  private pos = 0;
  private decided = 0;
  private ids = new Map<number, number>();
  resets = 0;
  pushed = 0;
  closed = false;
  private dead = false;

  constructor(
    private readonly listener: StreamListener,
    private readonly o: FakeOptions,
  ) {}

  private get step(): number {
    return Math.round((this.o.streamStep ?? 1.68) * RATE);
  }

  private get look(): number {
    return Math.round((this.o.streamLookahead ?? 0.32) * RATE);
  }

  private audio(from: number, to: number): Float32Array {
    const all = concat(...this.held);
    return all.subarray(from - this.heldStart, to - this.heldStart);
  }

  private decide(to: number): void {
    if (to <= this.decided) return;
    const x = this.audio(this.decided, to);
    const freqs = Array.from({ length: VOICES }, (_, k) => voiceFreq(k));
    const turns: SpeakerTurn[] = [];
    for (const [a, b] of bursts(x)) {
      const voice = argmax(x, a, b, freqs);
      if (!this.ids.has(voice)) this.ids.set(voice, this.ids.size);
      turns.push({
        speaker: this.ids.get(voice) as number,
        start: this.decided + a,
        end: this.decided + b,
      });
    }
    this.decided = to;
    this.held = [this.audio(to, this.pos).slice()];
    this.heldStart = to;
    this.listener.turns(turns, to);
  }

  push(samples: Float32Array): void {
    if (this.dead || this.closed) return;
    this.pushed += samples.length;
    this.held.push(samples.slice());
    this.pos += samples.length;
    if (this.o.streamDiesAfter !== undefined && this.pos > this.o.streamDiesAfter * RATE) {
      this.dead = true;
      this.listener.dead("fake diarizer died");
      return;
    }
    if (this.o.streamStuck) return;
    while (this.pos - this.decided >= this.step + this.look) this.decide(this.decided + this.step);
  }

  flush(): Promise<void> {
    if (this.dead) return Promise.reject(new Error("fake diarizer died"));
    if (this.o.streamStuck) return new Promise<void>(() => {});
    this.decide(this.pos);
    return Promise.resolve();
  }

  reset(): void {
    this.resets++;
    this.held = [];
    this.heldStart = 0;
    this.pos = 0;
    this.decided = 0;
    this.ids.clear();
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeModels implements ModelSet {
  readonly loads: Record<string, number> = {};
  readonly recognizerModel: string;
  readonly recognizers: FakeRecognizer[] = [];
  readonly embedders: FakeEmbedder[] = [];
  readonly diarizers: FakeDiarizer[] = [];
  readonly streams: FakeStreamDiarizer[] = [];
  readonly liveEngines: FakeLiveEngine[] = [];
  private rec: FakeRecognizer | null = null;
  /** Terms the loaded recognizer's hotword file covers (sherpa-onnx fixes it at load). */
  private covered = new Set<string>();
  /** Finished `release` calls. */
  releases = 0;

  constructor(readonly o: FakeOptions = {}) {
    this.recognizerModel = o.model ?? "fake-parakeet";
  }

  private count(m: string): void {
    this.loads[m] = (this.loads[m] ?? 0) + 1;
    if (m === this.recognizerModel) busyWait(this.o.loadMs ?? 0);
  }

  prepare(list: DecodeList | null): PreparedHotwords {
    if (this.o.greedy) {
      if (!this.rec) {
        this.rec = new FakeRecognizer(this.recognizerModel, this.o);
        this.recognizers.push(this.rec);
        this.count(this.recognizerModel);
      }
      const warnings = list?.entries.length ? [GREEDY_NO_HOTWORDS] : [];
      return {
        recognizer: this.rec,
        arg: undefined,
        entries: [],
        dropped: [],
        warnings,
        checks: [],
      };
    }
    // No model-kind filter here on purpose: the pipelines must keep a list away from a model that
    // takes none, whatever the model set hands them.
    const entries = list ? list.entries : [];
    const bad = new Set(this.o.unencodable ?? []);
    const kept = entries.filter((e) => !bad.has(e.term));
    const dropped = entries
      .filter((e) => bad.has(e.term))
      .map((e) => ({ term: e.term, reason: "pieces not in the model: <unk>" }));
    if (!this.rec || kept.some((e) => !this.covered.has(e.term))) {
      this.rec = new FakeRecognizer(this.recognizerModel, this.o);
      this.recognizers.push(this.rec);
      this.covered = new Set(kept.map((e) => e.term));
      this.count(this.recognizerModel);
    }
    const arg = kept
      .map((e) => (e.boost === DEFAULT_BOOST ? e.term : `${e.term} :${e.boost}`))
      .join("/");
    return {
      recognizer: this.rec,
      arg: arg === "" ? undefined : arg,
      entries: kept.map((e) => (e.boost === DEFAULT_BOOST ? e.term : `${e.term} :${e.boost}`)),
      dropped,
      warnings: [],
      checks: [],
    };
  }

  vad(): Vad {
    this.count("fake-vad");
    return new FakeVad(this.o.vadMinSpeechWindows ?? 2);
  }

  embedder(): Embedder {
    const e = new FakeEmbedder();
    this.embedders.push(e);
    this.count("fake-embedding");
    return e;
  }

  streamDiarizer(listener: StreamListener): StreamDiarizer | null {
    if (this.o.diarizer !== "nemotron") return null;
    const d = new FakeStreamDiarizer(listener, this.o);
    this.streams.push(d);
    this.count("fake-nemotron");
    return d;
  }

  liveEngine(id: string): LiveEngine {
    const had = this.liveEngines.find((e) => e.id === id);
    if (had) return had;
    if (this.o.liveFails) throw new Error(`fake: no model files for ${id}`);
    if (this.o.liveLoadMs !== undefined) {
      this.liveEngines.length = 0;
      busyWait(this.o.liveLoadMs);
    }
    const e = new FakeLiveEngine(id, this.o.liveTierMs ?? 560, this.o.livePushFails);
    this.liveEngines.push(e);
    this.count(id);
    return e;
  }

  async release(): Promise<void> {
    await Bun.sleep(this.o.releaseMs ?? 0);
    this.rec = null;
    this.covered.clear();
    this.releases++;
  }

  diarizer(): Diarizer {
    const d = new FakeDiarizer(this.o.diarizeMs, this.o.diarizeFails);
    this.diarizers.push(d);
    this.count("fake-segmentation");
    return d;
  }

  /** Every decode call across reloads. */
  get calls(): DecodeCall[] {
    return this.recognizers.flatMap((r) => r.calls);
  }
}

/** The `module` model spec entry point. */
/** Every model set this module created in this thread, newest last (in-thread tests look inside). */
export const created: FakeModels[] = [];

export function createModels(options: FakeOptions = {}, model?: string): ModelSet {
  const m = new FakeModels({ ...options, model: model ?? options.model });
  created.push(m);
  return m;
}

/**
 * An engine of a fusion list that the test module stands in for (`createEngine`, the module kind of
 * `FusionEngineSpec`): Whisper or Canary on transcribe-cpp in the app. It hears the fake words as
 * the fake recognizer does and, as they do, gives neither word times nor confidences. Its load
 * fails when its id is in `engineLoadFails`.
 */
export function createEngine(options: FakeOptions = {}, engine = "fake-engine"): FinalEngine {
  const rec = new FakeRecognizer(engine, { ...options, words: false });
  return {
    id: engine,
    features: { confidence: false, timestamps: false, glossary: true, languageId: true },
    load: async () => {
      if (options.engineLoadFails?.includes(engine)) throw new Error(`${engine} would not load`);
    },
    unload: async () => {},
    decode: async (u) => {
      const t = performance.now();
      const text = rec.decode(u.samples).text;
      const h: Hypothesis = {
        engine,
        text,
        words: text
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => ({ w })),
        ms: performance.now() - t,
      };
      if (text !== "") h.lang = u.lang === "auto" ? (options.engineLang ?? "en") : u.lang;
      return h;
    },
  };
}

/** In-memory parts for the final pass: `parts[part] = { mic, call }`. */
export class MemoryAudio implements FinalAudio {
  constructor(
    readonly parts: Record<number, { mic: Float32Array; call: Float32Array }>,
    /** `length` blocks the thread this long, as a read stuck in a native call would. */
    private readonly hangMs = 0,
  ) {}
  length(part: number): number {
    if (this.hangMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.hangMs);
    const p = this.parts[part];
    return p ? Math.max(p.mic.length, p.call.length) : 0;
  }
  read(part: number, ch: Channel, from: number, n: number): Float32Array {
    const p = this.parts[part];
    if (!p) return new Float32Array(0);
    const src = p[ch];
    const out = new Float32Array(Math.max(0, Math.min(n, this.length(part) - from)));
    out.set(src.subarray(from, Math.min(src.length, from + out.length)));
    return out;
  }
}

/** The `module` audio spec entry point. */
export function createAudio(o: {
  parts: Record<number, { mic: Float32Array; call: Float32Array }>;
  hangMs?: number;
}) {
  return new MemoryAudio(o.parts, o.hangMs);
}

// ---------------------------------------------------------------------------
// A streaming engine in the shape of Nemotron live

/** The tone word of a burst, or null for a sound that is no word (as the fake recognizer rules). */
function toneWord(x: Float32Array, a: number, b: number): string | null {
  const freqs = WORDS.map((_, i) => wordFreq(i));
  const k = argmax(x, a, b, freqs);
  let energy = 0;
  for (let i = a; i < b; i++) energy += (x[i] as number) ** 2;
  if (goertzel(x, a, b, freqs[k] as number) / (energy * ((b - a) / 2)) < 0.3) return null;
  return (WORDS[k] as (typeof WORDS)[number]).sound;
}

/**
 * One stream: a word is emitted once its burst has ended and the engine's chunk has passed, with
 * the burst's start as its time and a leading space, as sherpa-onnx gives Nemotron's tokens. A
 * token, once returned, is never returned again or changed.
 */
export class FakeLiveStream implements LiveStream {
  private held: Float32Array[] = [];
  private heldStart = 0;
  private pos = 0;
  /** Everything before this is decided. */
  private doneTo = 0;
  readonly tokens: LiveToken[] = [];
  closed = false;

  constructor(
    private readonly tierSeconds: number,
    readonly lang: string,
  ) {}

  push(samples: Float32Array): LiveToken[] {
    this.held.push(samples.slice());
    this.pos += samples.length;
    return this.decide(this.pos - Math.round(this.tierSeconds * RATE), false);
  }

  flush(): LiveToken[] {
    return this.decide(this.pos, true);
  }

  close(): void {
    this.closed = true;
  }

  private decide(limit: number, all: boolean): LiveToken[] {
    if (limit <= this.heldStart) return [];
    const buf = concat(...this.held);
    const out: LiveToken[] = [];
    // A burst still sounding at `limit` waits: it may go on.
    let keep = all ? this.pos : Math.max(this.heldStart, limit - Math.round(0.1 * RATE));
    for (const [a, b] of bursts(buf)) {
      const from = this.heldStart + a;
      const to = this.heldStart + b;
      if (from < this.doneTo) continue;
      if (!all && to >= limit) {
        keep = Math.min(keep, from);
        break;
      }
      const w = toneWord(buf, a, b);
      this.doneTo = to;
      if (!w) continue;
      out.push({ text: ` ${w}`, t: from / RATE, conf: 1 });
    }
    this.held = [buf.subarray(keep - this.heldStart).slice()];
    this.heldStart = keep;
    this.tokens.push(...out);
    return out;
  }
}

export class FakeLiveEngine implements LiveEngine {
  readonly languages = ["en"];
  readonly streams: FakeLiveStream[] = [];
  constructor(
    readonly id: string,
    readonly tierMs: number,
    private readonly pushFails = false,
  ) {}

  open(lang: string): LiveStream {
    const s = new FakeLiveStream(this.tierMs / 1000, lang);
    if (this.pushFails)
      s.push = () => {
        throw new Error("fake: the stream's decode failed");
      };
    this.streams.push(s);
    return s;
  }
}
