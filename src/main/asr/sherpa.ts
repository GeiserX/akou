/**
 * The real engines (docs/DESIGN.md section 3): on sherpa-onnx-node, Parakeet TDT v3 for recognition
 * and Silero for voice activity; for speaker labels either Nemotron 3 Diarization through the
 * `akou-diarize` helper (`asr.diarizer` nemotron, the default) or TitaNet embeddings live and
 * pyannote plus TitaNet in the final pass (`embeddings`). Loaded only inside a Worker, lazily, each
 * model once per app run (the final pass's Nemotron helper once per pass).
 *
 * Decoding (`asr.parakeet.decoding`): greedy by default. Beam search (`modified_beam_search`) is the
 * only mode that takes hotwords, but on meeting audio it returns whole spans empty that greedy
 * decodes (14 of 200 AMI chunks in the benchmark, none under greedy). Greedy gets no `bpe.vocab`
 * and no hotwords; the vocabulary still applies at read time and in the post-call pass.
 *
 * Hotwords, with beam: sherpa-onnx fixes a recognizer's hotword tokenizer (`bpeVocab`) when it is
 * created, and a per-stream list is tokenized with it. The recognizer is therefore created with
 * `modelingUnit: "bpe"` and a canonical-pieces `bpe.vocab` for the current list (`bpe-vocab.ts`). A
 * later list whose pieces that file does not hold needs a new file and a new recognizer; `prepare`
 * does that once per such change and counts it as a load. Hotwords are never passed to a model that
 * is not a transducer: sherpa-onnx exits the process on that call.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  BpeTokenizer,
  buildBpeVocab,
  parseTokens,
  planHotwords,
  type ScoreVocab,
} from "../vocab/bpe-vocab.ts";
import { DEFAULT_BOOST, type DecodeList, hotwordsArg, modelKind } from "../vocab/decode-list.ts";
import {
  ASR_RATE,
  type DiarizedSpan,
  type Diarizer,
  type DiarizerKind,
  type Embedder,
  type LiveEngine,
  type LiveStream,
  type LiveToken,
  type ModelSet,
  type ParakeetDecoding,
  type PreparedHotwords,
  type Recognized,
  type Recognizer,
  type StreamDiarizer,
  type StreamListener,
  type Vad,
  type WordHyp,
} from "./engine.ts";
import { isLiveEngine, LIVE_ENGINES, type LiveEngineInfo } from "./live-engines.ts";
import { modelFile, NEMOTRON, NEMOTRON_FILE, RECOGNIZER } from "./models.ts";
import { DIARIZE_HELPER_NAME, NemotronDiarizer, NemotronStream } from "./nemotron.ts";

// biome-ignore lint/suspicious/noExplicitAny: sherpa-onnx-node ships no TypeScript types.
type Sherpa = any;

let sherpaModule: Sherpa | null = null;
function sherpa(): Sherpa {
  sherpaModule ??= createRequire(import.meta.url)("sherpa-onnx-node");
  return sherpaModule;
}

/** Logged at warn when a decode list meets a greedy recognizer, which takes no hotwords. */
export const GREEDY_NO_HOTWORDS =
  "greedy decoding takes no hotwords; the vocabulary applies when reading and after the call";

/** Silero keeps a copy of the open segment and re-copies it every window; bound it. */
const VAD_RESET_AFTER_SECONDS = 15;

/**
 * One recognizer. The guard in `decode` is the last line before sherpa-onnx, which exits the
 * process on hotwords to a non-transducer or on an empty hotword string, and has no use for them
 * under greedy decoding; exported for its test.
 */
export class SherpaRecognizer implements Recognizer {
  readonly kind;
  constructor(
    readonly model: string,
    private readonly rec: Sherpa,
    private readonly decoding: ParakeetDecoding,
  ) {
    this.kind = modelKind(model);
  }

  decode(samples: Float32Array, hotwords?: string): Recognized {
    if (hotwords !== undefined && (this.kind !== "transducer" || hotwords === "")) {
      throw new Error(`refusing hotwords for ${this.model}: sherpa-onnx would exit the process`);
    }
    if (hotwords !== undefined && this.decoding !== "beam") {
      throw new Error(`refusing hotwords for ${this.model}: greedy decoding takes none`);
    }
    const s = hotwords === undefined ? this.rec.createStream() : this.rec.createStream(hotwords);
    s.acceptWaveform({ samples, sampleRate: ASR_RATE });
    this.rec.decode(s);
    const r = this.rec.getResult(s) as SherpaResult & { text?: string; lang?: string };
    const lang = r.lang?.replace(/[<|>]/g, "") || undefined;
    const out: Recognized = { text: (r.text ?? "").trim(), words: sherpaWords(r) };
    if (lang) out.lang = lang;
    return out;
  }
}

/** The per-token fields of a sherpa-onnx offline result (`OfflineRecognitionResult`). */
export interface SherpaResult {
  tokens?: readonly string[];
  /** Seconds into the decoded span, one per token. */
  timestamps?: readonly number[];
  /** Seconds each token lasts; transducers with durations (Parakeet TDT) report them. */
  durations?: readonly number[];
  /** Natural log-probability of each token. */
  ys_log_probs?: readonly number[];
}

/**
 * Words from sherpa-onnx tokens, the way the ASR benchmark derived them: a token with a leading
 * space starts a word, and a word's confidence is exp of the lowest log-probability of its tokens,
 * clipped at 0 (a hotword boost can lift a log-probability above it). A word starts at its first
 * token and ends where its last token's duration ends, else where the next word begins.
 */
export function sherpaWords(r: SherpaResult): WordHyp[] {
  const tokens = r.tokens ?? [];
  const words: { w: string; from: number; to: number }[] = [];
  tokens.forEach((t, i) => {
    const last = words.at(-1);
    if (last && !t.startsWith(" ")) {
      last.w += t;
      last.to = i;
    } else words.push({ w: t.trim(), from: i, to: i });
  });
  const ts = r.timestamps;
  const lps = r.ys_log_probs;
  return words.map(({ w, from, to }, k) => {
    const out: WordHyp = { w };
    if (lps && lps.length === tokens.length) {
      out.conf = Math.exp(Math.min(0, ...lps.slice(from, to + 1)));
    }
    if (ts && ts.length === tokens.length) {
      out.t0 = ts[from] as number;
      const d = r.durations?.length === tokens.length ? r.durations[to] : undefined;
      const next = words[k + 1];
      out.t1 = d !== undefined ? (ts[to] as number) + d : next ? (ts[next.from] as number) : ts[to];
    }
    return out;
  });
}

class SherpaVad implements Vad {
  readonly windowSize = 512;
  private speechWindows = 0;
  constructor(private readonly vad: Sherpa) {}

  accept(window: Float32Array): boolean {
    this.vad.acceptWaveform(window);
    const detected = this.vad.isDetected() as boolean;
    while (!this.vad.isEmpty()) this.vad.pop();
    this.speechWindows = detected ? this.speechWindows + 1 : 0;
    if (this.speechWindows * this.windowSize > VAD_RESET_AFTER_SECONDS * ASR_RATE) {
      this.vad.reset();
      this.speechWindows = 0;
    }
    return detected;
  }

  reset(): void {
    this.vad.reset();
    this.speechWindows = 0;
  }
}

class SherpaEmbedder implements Embedder {
  readonly dim: number;
  constructor(private readonly ex: Sherpa) {
    this.dim = ex.dim as number;
  }

  embed(samples: Float32Array): Float32Array {
    const s = this.ex.createStream();
    s.acceptWaveform({ samples, sampleRate: ASR_RATE });
    s.inputFinished();
    if (!this.ex.isReady(s)) return new Float32Array(this.dim);
    return Float32Array.from(this.ex.compute(s, false) as Float32Array);
  }
}

class SherpaDiarizer implements Diarizer {
  constructor(private readonly sd: Sherpa) {}
  process(samples: Float32Array): DiarizedSpan[] {
    return (this.sd.process(samples) as DiarizedSpan[]).map((s) => ({
      start: s.start,
      end: s.end,
      speaker: s.speaker,
    }));
  }
}

export interface SherpaSpec {
  dir: string;
  cacheDir: string;
  threads?: number;
  diarizer?: DiarizerKind;
  /** Default `greedy`, the setting's default. */
  decoding?: ParakeetDecoding;
  diarizeHelper?: readonly string[];
}

/**
 * Writes `bpe-<hash>.vocab` under `dir` and returns its path. The live and the final-pass Workers
 * can write the same file while the other creates a recognizer from it, and sherpa-onnx exits the
 * process on a torn file. So a file that already holds these bytes is left alone, and any other
 * write goes to a unique temporary file renamed into place.
 */
export function writeBpeVocab(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const path = join(dir, `bpe-${hash}.vocab`);
  const holds = () => existsSync(path) && readFileSync(path, "utf8") === text;
  if (holds()) return path;
  const tmp = join(dir, `.bpe-${hash}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    // Windows refuses a rename over a file another Worker has open; that writer's bytes are ours.
    if (!holds()) throw err;
  }
  return path;
}

/**
 * The Parakeet recognizer's sherpa-onnx config. Greedy has no hotword score and no `bpe.vocab`;
 * beam search biases toward the decode list at the constant boost. Exported for its test.
 */
export function recognizerConfig(
  file: (name: string) => string,
  threads: number,
  mode: { decoding: "greedy" } | { decoding: "beam"; bpeVocab: string },
): Record<string, unknown> {
  const featConfig = { sampleRate: ASR_RATE, featureDim: 80 };
  const modelConfig = {
    transducer: {
      encoder: file("encoder.onnx"),
      decoder: file("decoder.onnx"),
      joiner: file("joiner.onnx"),
    },
    tokens: file("tokens.txt"),
    numThreads: threads,
    provider: "cpu",
    debug: 0,
    modelType: "nemo_transducer",
  };
  if (mode.decoding === "greedy") {
    return { featConfig, modelConfig, decodingMethod: "greedy_search" };
  }
  return {
    featConfig,
    modelConfig: { ...modelConfig, modelingUnit: "bpe", bpeVocab: mode.bpeVocab },
    decodingMethod: "modified_beam_search",
    maxActivePaths: 4,
    hotwordsScore: DEFAULT_BOOST,
  };
}

// ---------------------------------------------------------------------------
// Streaming Nemotron, the live pass (docs/research/asr-architecture.md section 3.1)

/** Silence pushed behind the audio on a flush, beyond the engine's chunk, seconds. */
const FLUSH_EXTRA_SECONDS = 1;
/**
 * A stream's result holds every token since its last reset and is read as JSON after each decode,
 * so it is reset at a pause once it holds this many: one reset every few minutes of speech. The
 * encoder's state carries across a reset; only the decoder's context starts over.
 */
const RESET_TOKENS = 400;
/** Blank frames at the end of the result that make a pause safe to reset at. */
const RESET_BLANKS = 8;
/** How much of its own audio a ready stream waits for the other channel's chunk. */
export const BATCH_WAIT_SECONDS = 0.25;

/** The sherpa-onnx config of a streaming Nemotron (int8, greedy, no endpointing). */
export function onlineConfig(
  file: (name: string) => string,
  threads: number,
): Record<string, unknown> {
  return {
    featConfig: { sampleRate: ASR_RATE, featureDim: 128 },
    modelConfig: {
      transducer: {
        encoder: file("encoder.int8.onnx"),
        decoder: file("decoder.int8.onnx"),
        joiner: file("joiner.int8.onnx"),
      },
      tokens: file("tokens.txt"),
      numThreads: threads,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
    enableEndpoint: 0,
  };
}

interface OnlineResult {
  tokens?: readonly string[];
  /** Seconds from `start_time`, one per token. */
  timestamps?: readonly number[];
  /** Natural log-probability of each token. */
  ys_probs?: readonly number[];
  start_time?: number;
  num_trailing_blanks?: number;
}

/**
 * One `OnlineRecognizer` shared by the call's streams. The channels' audio arrives interleaved,
 * so a stream whose chunk is ready waits for the other's, and both decode in one batch
 * (`decodeStreams`): two channels cost less than two. A stream waits at most `BATCH_WAIT_SECONDS`
 * of its own audio for a stream that has stopped sending.
 */
export class SherpaLiveEngine implements LiveEngine {
  readonly tierMs: number;
  readonly languages: readonly string[];
  private readonly streams = new Set<SherpaLiveStream>();

  constructor(
    readonly id: string,
    private readonly rec: Sherpa,
    private readonly info: LiveEngineInfo,
  ) {
    this.tierMs = info.tierMs;
    this.languages = info.languages;
  }

  open(lang: string): LiveStream {
    const s = this.rec.createStream();
    if (this.info.multilingual && lang !== "auto") s.setOption("language", lang);
    const ls = new SherpaLiveStream(this, this.rec, s);
    this.streams.add(ls);
    return ls;
  }

  /**
   * Decodes the ready streams together once every open stream is ready, or once one has waited
   * `BATCH_WAIT_SECONDS`; `all` (a flush) decodes whatever is ready now.
   */
  decodeReady(all = false): void {
    const wait = Math.round(BATCH_WAIT_SECONDS * ASR_RATE);
    for (;;) {
      const open = [...this.streams];
      const ready = open.filter((x) => this.rec.isReady(x.s));
      if (ready.length === 0) return;
      for (const x of ready) x.readyAt ??= x.pushed;
      const waited = ready.some((x) => x.pushed - (x.readyAt as number) >= wait);
      if (!all && ready.length < open.length && !waited) return;
      if (ready.length === 1) this.rec.decode((ready[0] as SherpaLiveStream).s);
      else this.rec.decodeStreams(ready.map((x) => x.s));
      for (const x of ready) {
        x.dirty = true;
        x.readyAt = null;
      }
    }
  }

  forget(s: SherpaLiveStream): void {
    this.streams.delete(s);
  }
}

class SherpaLiveStream implements LiveStream {
  dirty = false;
  /** `pushed` when this stream last found a chunk ready and undecoded, else null. */
  readyAt: number | null = null;
  /** Tokens of the current result already returned. */
  private seen = 0;
  /** Samples the caller pushed, and samples the stream holds (the caller's plus flush padding). */
  pushed = 0;
  private held = 0;
  /** Flush padding: `len` samples at `at` on the stream, at `caller` on the caller's timeline. */
  private readonly pads: { at: number; len: number; caller: number }[] = [];

  constructor(
    private readonly engine: SherpaLiveEngine,
    private readonly rec: Sherpa,
    readonly s: Sherpa,
  ) {}

  push(samples: Float32Array): LiveToken[] {
    this.s.acceptWaveform({ samples, sampleRate: ASR_RATE });
    this.pushed += samples.length;
    this.held += samples.length;
    this.engine.decodeReady();
    return this.collect();
  }

  flush(): LiveToken[] {
    const len = Math.round((this.engine.tierMs / 1000 + FLUSH_EXTRA_SECONDS) * ASR_RATE);
    this.s.acceptWaveform({ samples: new Float32Array(len), sampleRate: ASR_RATE });
    this.pads.push({ at: this.held, len, caller: this.pushed });
    this.held += len;
    this.engine.decodeReady(true);
    this.dirty = true;
    return this.collect();
  }

  close(): void {
    this.engine.forget(this);
  }

  /** Seconds on the stream to seconds on the caller's timeline: padding takes no caller time. */
  private callerTime(seconds: number): number {
    const x = Math.round(seconds * ASR_RATE);
    let shift = 0;
    for (const p of this.pads) {
      if (x >= p.at + p.len) shift += p.len;
      else if (x >= p.at) return p.caller / ASR_RATE;
      else break;
    }
    return (x - shift) / ASR_RATE;
  }

  private collect(): LiveToken[] {
    if (!this.dirty) return [];
    this.dirty = false;
    const r = this.rec.getResult(this.s) as OnlineResult;
    const tokens = r.tokens ?? [];
    const out: LiveToken[] = [];
    for (let i = this.seen; i < tokens.length; i++) {
      const t = (r.start_time ?? 0) + (r.timestamps?.[i] ?? 0);
      const lp = r.ys_probs?.[i];
      out.push({
        text: tokens[i] as string,
        t: this.callerTime(t),
        conf: lp === undefined ? 1 : Math.exp(Math.min(0, lp)),
      });
    }
    this.seen = tokens.length;
    if (tokens.length >= RESET_TOKENS && (r.num_trailing_blanks ?? 0) >= RESET_BLANKS) {
      this.rec.reset(this.s);
      this.seen = 0;
    }
    return out;
  }
}

export class SherpaModels implements ModelSet {
  readonly recognizerModel = RECOGNIZER;
  readonly loads: Record<string, number> = {};
  private rec: { r: SherpaRecognizer; vocab: ScoreVocab | null } | null = null;
  private tok: BpeTokenizer | null = null;
  private tokens: Set<string> | null = null;
  private emb: SherpaEmbedder | null = null;
  private dia: Diarizer | null = null;
  private live: SherpaLiveEngine | null = null;
  private readonly threads: number;
  readonly diarizerKind: DiarizerKind;
  readonly decoding: ParakeetDecoding;

  constructor(private readonly spec: SherpaSpec) {
    this.threads = spec.threads ?? 2;
    this.diarizerKind = spec.diarizer ?? "nemotron";
    this.decoding = spec.decoding ?? "greedy";
  }

  private nemotron() {
    return {
      command: this.spec.diarizeHelper?.length ? this.spec.diarizeHelper : [DIARIZE_HELPER_NAME],
      model: this.file(NEMOTRON, NEMOTRON_FILE),
      threads: this.threads,
    };
  }

  private count(model: string): void {
    this.loads[model] = (this.loads[model] ?? 0) + 1;
  }

  private file(id: string, name: string): string {
    return modelFile(this.spec.dir, id, name);
  }

  private tokenizer(): { tok: BpeTokenizer; tokens: Set<string> } {
    this.tok ??= BpeTokenizer.fromJson(
      JSON.parse(readFileSync(this.file(RECOGNIZER, "tokenizer.json"), "utf8")),
    );
    this.tokens ??= parseTokens(readFileSync(this.file(RECOGNIZER, "tokens.txt"), "utf8"));
    return { tok: this.tok, tokens: this.tokens };
  }

  private loadRecognizer(terms: readonly string[]): {
    r: SherpaRecognizer;
    vocab: ScoreVocab | null;
  } {
    const built = this.decoding === "beam" ? buildBpeVocab(this.tokenizer().tok, terms) : null;
    const file = (name: string) => this.file(RECOGNIZER, name);
    const config = built
      ? recognizerConfig(file, this.threads, {
          decoding: "beam",
          bpeVocab: writeBpeVocab(this.spec.cacheDir, built.text),
        })
      : recognizerConfig(file, this.threads, { decoding: "greedy" });
    // Drop the previous recognizer before creating the next, so two never sit in memory at once.
    this.rec = null;
    Bun.gc(true);
    const rec = new (sherpa().OfflineRecognizer)(config);
    this.count(RECOGNIZER);
    return {
      r: new SherpaRecognizer(RECOGNIZER, rec, this.decoding),
      vocab: built?.pieces ?? null,
    };
  }

  prepare(list: DecodeList | null): PreparedHotwords {
    if (this.decoding === "greedy") {
      // Greedy takes no hotwords: nothing is tokenized, and `vocab.used` records an empty list.
      this.rec ??= this.loadRecognizer([]);
      return {
        recognizer: this.rec.r,
        arg: undefined,
        entries: [],
        dropped: [],
        warnings: list?.entries.length ? [GREEDY_NO_HOTWORDS] : [],
        checks: [],
      };
    }
    const entries =
      list && modelKind(list.model) === "transducer" && modelKind(RECOGNIZER) === "transducer"
        ? list.entries
        : [];
    const { tok, tokens } = this.tokenizer();
    const plan = planHotwords(
      tok,
      tokens,
      this.rec?.vocab ?? null,
      entries.map((e) => e.term),
    );
    if (!this.rec || plan.reload) this.rec = this.loadRecognizer(plan.reload ?? []);
    const keep = new Set(plan.keep);
    const kept = entries.filter((e) => keep.has(e.term));
    const arg = hotwordsArg({ model: RECOGNIZER, entries: kept, dropped: [], warnings: [] });
    return {
      recognizer: this.rec.r,
      arg: arg === "" ? undefined : arg,
      entries: kept.map((e) => (e.boost === DEFAULT_BOOST ? e.term : `${e.term} :${e.boost}`)),
      dropped: plan.dropped,
      warnings: [],
      checks: plan.checks,
    };
  }

  vad(): Vad {
    const v = new (sherpa().Vad)(
      {
        sileroVad: {
          model: this.file("silero-vad", "silero_vad.onnx"),
          threshold: 0.5,
          minSpeechDuration: 0.1,
          minSilenceDuration: 0.1,
          maxSpeechDuration: 30,
          windowSize: 512,
        },
        sampleRate: ASR_RATE,
        debug: false,
        numThreads: 1,
      },
      VAD_RESET_AFTER_SECONDS * 2,
    );
    this.count("silero-vad");
    return new SherpaVad(v);
  }

  embedder(): Embedder {
    if (!this.emb) {
      this.emb = new SherpaEmbedder(
        new (sherpa().SpeakerEmbeddingExtractor)({
          model: this.file("titanet-small", "nemo_en_titanet_small.onnx"),
          numThreads: this.threads,
          debug: 0,
        }),
      );
      this.count("titanet-small");
    }
    return this.emb;
  }

  liveEngine(id: string): LiveEngine {
    if (this.live?.id === id) return this.live;
    if (!isLiveEngine(id)) throw new Error(`no live engine is called ${id}`);
    // Drop the previous engine before loading the next, so two never sit in memory at once.
    this.live = null;
    Bun.gc(true);
    const rec = new (sherpa().OnlineRecognizer)(
      onlineConfig((name) => this.file(id, name), this.threads),
    );
    this.count(id);
    this.live = new SherpaLiveEngine(id, rec, LIVE_ENGINES[id]);
    return this.live;
  }

  streamDiarizer(listener: StreamListener): StreamDiarizer | null {
    if (this.diarizerKind !== "nemotron") return null;
    const s = new NemotronStream(this.nemotron(), listener);
    this.count(NEMOTRON);
    return s;
  }

  async release(): Promise<void> {
    this.rec = null;
    this.emb = null;
    this.dia = null;
    this.live = null;
    // Bun runs a collected object's native finalizer on a later turn of the event loop, and what
    // one finalizer lets go of waits for the next collection: on Bun 1.4.2 the first collection
    // freed under a quarter of a pass's memory and the second the rest. Four leave room.
    for (let i = 0; i < 4; i++) {
      Bun.gc(true);
      await Bun.sleep(0);
    }
  }

  diarizer(): Diarizer {
    if (!this.dia && this.diarizerKind === "nemotron") {
      this.dia = new NemotronDiarizer(this.nemotron(), () => this.count(NEMOTRON));
    } else if (!this.dia) {
      this.dia = new SherpaDiarizer(
        new (sherpa().OfflineSpeakerDiarization)({
          segmentation: {
            pyannote: { model: this.file("pyannote-segmentation-3.0", "model.onnx") },
            numThreads: this.threads,
            debug: 0,
          },
          embedding: {
            model: this.file("titanet-small", "nemo_en_titanet_small.onnx"),
            numThreads: this.threads,
            debug: 0,
          },
          clustering: { numClusters: -1, threshold: 0.5 },
          minDurationOn: 0.2,
          minDurationOff: 0.5,
        }),
      );
      this.count("pyannote-segmentation-3.0");
    }
    return this.dia;
  }
}
