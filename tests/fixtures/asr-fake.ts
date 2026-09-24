/**
 * Deterministic speech engines for CI (the `module` model spec). Nothing here is speech: a "word"
 * is a tone burst at the word's own frequency, and a "voice" is a quieter tone at the speaker's own
 * frequency mixed into every word that speaker says. The fake recognizer reads the word
 * frequencies back, the fake embedder and diarizer read the voice frequencies, and the fake VAD is
 * an energy detector with Silero-like hysteresis. That is enough to drive every rule of the live
 * and final pipelines and to make each trap fail when its rule is broken.
 *
 * The fake recognizer keeps two engine behaviours the traps are about:
 * - a floor: a span shorter than 0.3 s comes back empty (hark's engines lost short words so);
 * - biasing: a word with a `heard` form is recognized as that form unless its term is in the
 *   stream's hotwords.
 */

import { existsSync, writeFileSync } from "node:fs";
import type { Channel } from "../../src/core/log/events.ts";
import type {
  DiarizedSpan,
  Diarizer,
  Embedder,
  ModelSet,
  PreparedHotwords,
  Recognizer,
  Vad,
} from "../../src/main/asr/engine.ts";
import type { FinalAudio } from "../../src/main/asr/finalize-worker.ts";
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
  /** A span longer than this is refused (throws), seconds. */
  refuseOver?: number;
  /** Terms the tokenization check would drop. */
  unencodable?: string[];
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
}

export interface DecodeCall {
  samples: number;
  hotwords: string | undefined;
  /** How many arguments the stream was created with, as sherpa-onnx would see it. */
  args: number;
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

  decode(samples: Float32Array, hotwords?: string): { text: string } {
    this.calls.push({
      samples: samples.length,
      hotwords,
      args: hotwords === undefined ? 0 : 1,
    });
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
    for (const [a, b] of bursts(samples)) {
      const k = argmax(samples, a, b, freqs);
      // A sound that is no word (a hum between the word tones) gives no text.
      let energy = 0;
      for (let i = a; i < b; i++) energy += (samples[i] as number) ** 2;
      if (goertzel(samples, a, b, freqs[k] as number) / (energy * ((b - a) / 2)) < 0.3) continue;
      const w = WORDS[k] as (typeof WORDS)[number];
      out.push(w.term && biased.has(w.term) ? w.term : (w.heard ?? w.sound));
    }
    return { text: out.join(" ") };
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
  process(samples: Float32Array): DiarizedSpan[] {
    this.calls++;
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

export class FakeModels implements ModelSet {
  readonly loads: Record<string, number> = {};
  readonly recognizerModel: string;
  readonly recognizers: FakeRecognizer[] = [];
  readonly embedders: FakeEmbedder[] = [];
  readonly diarizers: FakeDiarizer[] = [];
  private rec: FakeRecognizer | null = null;
  /** Terms the loaded recognizer's hotword file covers (sherpa-onnx fixes it at load). */
  private covered = new Set<string>();

  constructor(readonly o: FakeOptions = {}) {
    this.recognizerModel = o.model ?? "fake-parakeet";
  }

  private count(m: string): void {
    this.loads[m] = (this.loads[m] ?? 0) + 1;
  }

  prepare(list: DecodeList | null): PreparedHotwords {
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
      warnings: dropped.map((d) => `hotword "${d.term}" dropped: ${d.reason}`),
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

  diarizer(): Diarizer {
    const d = new FakeDiarizer();
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
