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
  type ModelSet,
  type ParakeetDecoding,
  type PreparedHotwords,
  type Recognized,
  type Recognizer,
  type StreamDiarizer,
  type StreamListener,
  type Vad,
} from "./engine.ts";
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
    const r = this.rec.getResult(s) as { text?: string; lang?: string };
    const lang = r.lang?.replace(/[<|>]/g, "") || undefined;
    return lang ? { text: (r.text ?? "").trim(), lang } : { text: (r.text ?? "").trim() };
  }
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

export class SherpaModels implements ModelSet {
  readonly recognizerModel = RECOGNIZER;
  readonly loads: Record<string, number> = {};
  private rec: { r: SherpaRecognizer; vocab: ScoreVocab | null } | null = null;
  private tok: BpeTokenizer | null = null;
  private tokens: Set<string> | null = null;
  private emb: SherpaEmbedder | null = null;
  private dia: Diarizer | null = null;
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

  streamDiarizer(listener: StreamListener): StreamDiarizer | null {
    if (this.diarizerKind !== "nemotron") return null;
    const s = new NemotronStream(this.nemotron(), listener);
    this.count(NEMOTRON);
    return s;
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
