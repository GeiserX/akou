/**
 * Whisper large-v3 and Canary-1b-v2 as `FinalEngine`s (docs/research/asr-architecture.md section
 * 2.3, ASR-8), on transcribe.cpp through its npm binding, `transcribe-cpp` 0.3.1 (koffi FFI over the
 * native library its per-platform package ships). Measured on 0.2.4 with the Q8_0 GGUFs of the
 * catalog (models.ts) under Bun 1.4.2 on an M4 Pro, in one process with sherpa-onnx-node loaded.
 * 0.3.1's typings keep every call and option used here; they add an `OutputRepetition` error, a
 * subclass of `OutputTruncated`, for a decode stopped because its output began repeating, which
 * fails one unit as a truncated output does. Nothing below was measured again on 0.3.1:
 *
 * - **The binding loads only when an engine does.** It is imported on the first `load`, so a
 *   machine or a test that never runs these engines never opens the native library.
 * - **Bun.** The package's README says Bun is not supported yet, for a crash in a finalizer. Load,
 *   decode and dispose worked in every run here; `unload` disposes the model inside a try, so a
 *   failing dispose costs the model's memory, never the Worker.
 * - **One Metal model at a time** (section 2.3): `load` and `unload` are explicit, so the pass can
 *   hold one engine at a time. `decode` loads on first use, and decodes run one after another.
 * - **The language is always forced when known**: `unit.lang`, else the first of the user's
 *   languages (`allowed`) the model hears. Forced, Whisper answers `language: ""`, so the
 *   hypothesis carries the forced code. With several allowed languages and none on the unit,
 *   Whisper detects instead, and an answer outside them is decoded again, forced into the first.
 * - **Canary is never left to choose**: with no language it translates into English (an AST run,
 *   measured on Spanish), so a Canary unit with no language it hears fails instead of decoding.
 * - **Canary's `pnc` flag is never sent.** A first look read the 0.2.4 flag as inverted (`off`
 *   punctuated 60 s of conversational Spanish, `on` did not). The source maps it right (`off`
 *   sends `<|nopnc|>`, and the GGUF's ids name the right tokens), and over twelve slices of that
 *   audio the effect was no inversion but noise: `on` gave the default's text every time, while
 *   `off` punctuated some slices, stripped others, cut one 20 s slice from 54 words to 8 and failed
 *   another (`OutputTruncated`). Clean synthetic speech came out the same under all three. So the
 *   engine keeps the model's default, the one setting that never lost a word; ROVER aligns words
 *   without their punctuation or case anyway.
 * - **Whisper takes the glossary as its initial prompt** (`family.initialPrompt`), the decode list
 *   joined by commas. transcribe.cpp keeps only its last 223 tokens, so the list is cut from the
 *   end here to keep the head, and a term holding `<|` is dropped: the library refuses a prompt
 *   with a special-token literal, which would fail every unit. Canary takes no prompt.
 * - **No confidences, no word times.** Whisper gives segment times only (`word` and `token`
 *   answer "unsupported timestamp granularity") and Canary none, and neither fills `words` or
 *   `tokens`. Words are the text split on whitespace, with no `conf` and no `t0`/`t1`: ROVER takes
 *   a fused word's times from the first engine that has them, and a segment's bounds given as a
 *   word's would beat the anchor's real word times. So every unit decodes with `timestamps: "none"`.
 * - **A native error fails one unit, never the Worker.** A refused decode (an unsupported language,
 *   a truncated output) throws a `TranscribeCppError` with code `unit_failed`, not `fatal`, so the
 *   pass halves the span or skips it as it does for Qwen. An engine that cannot load (no binding
 *   for this platform, a missing or corrupt file) throws `engine_unavailable`, `fatal`, as qwen.ts
 *   marks a llama-server that is down. A crash inside native code is no exception: it ends the
 *   whole process, a Worker's thread included, and only a separate process would contain it.
 */

import type {
  Backend,
  FamilyExtension,
  ModelOptions,
  TranscribeOptions,
  TranscriptionResult,
} from "transcribe-cpp";
import type { FinalEngine, FinalUnit, Hypothesis, WordHyp } from "./engine.ts";
import {
  CANARY_1B_V2,
  CANARY_1B_V2_FILE,
  modelFile,
  PARAKEET_LANGUAGES,
  WHISPER_LANGUAGES,
  WHISPER_LARGE_V3,
  WHISPER_LARGE_V3_FILE,
} from "./models.ts";

/** The model families this file runs. */
export type TranscribeFamily = "whisper" | "canary";

/** What the engine needs of a loaded model: transcribe-cpp's `TranscribeModel`, or a test's fake. */
export interface NativeModel {
  transcribe(pcm: Float32Array, opts?: TranscribeOptions): Promise<TranscriptionResult>;
  tokenize?(text: string): Int32Array;
  dispose(): void;
}

/** What the engine needs of the binding: transcribe-cpp itself, or a test's fake. */
export interface TranscribeBinding {
  load(path: string, opts?: ModelOptions): Promise<NativeModel>;
}

/**
 * The real binding, imported on first use so nothing opens the native library before a load. The
 * library's warnings and errors go to `log`, the app log, never to stderr (TRAPS "Harmless engine
 * noise on stderr"); its info and debug lines are dropped.
 */
export async function nativeBinding(
  log?: (level: "warn" | "error", msg: string) => void,
): Promise<TranscribeBinding> {
  const { TranscribeModel, setLogHandler } = await import("transcribe-cpp");
  setLogHandler((level, msg) => {
    // transcribe.h: 2 is WARN, 3 is ERROR.
    if (level === 2 || level === 3)
      log?.(level === 3 ? "error" : "warn", `transcribe.cpp: ${msg.trim()}`);
  });
  return { load: (path, opts) => TranscribeModel.load(path, opts) };
}

/** Whisper's prompt budget: `dec_max_target_positions / 2 - 1`, what transcribe.cpp keeps. */
export const WHISPER_PROMPT_TOKENS = 223;

/** The catalog's ISO codes Whisper names otherwise. */
const WHISPER_CODE: Readonly<Record<string, string>> = { jv: "jw" };
const ISO_CODE: Readonly<Record<string, string>> = { jw: "jv" };

export class TranscribeCppError extends Error {
  override name = "TranscribeCppError";
  constructor(
    message: string,
    readonly code: "engine_unavailable" | "unit_failed",
    readonly fatal: boolean,
  ) {
    super(message);
  }
}

export interface TranscribeCppOptions {
  /** The catalog id written into `seg.model` (`whisper-large-v3`, `canary-1b-v2`). */
  id: string;
  family: TranscribeFamily;
  /** The GGUF's path. */
  model: string;
  /** ISO codes the model hears (the catalog entry's `languages`). */
  languages: readonly string[];
  /** The user's languages (`asr.languages`): forced in this order when a unit has none. */
  allowed?: readonly string[];
  /** Default `auto`: Metal on Apple silicon, else Vulkan, else the CPU. */
  backend?: Backend;
  /** Test seam; default the real binding. */
  binding?: () => Promise<TranscribeBinding>;
  /** Aborts the decode in flight: its caller gave it up. */
  signal?: AbortSignal;
  log?(level: "info" | "warn" | "error", msg: string): void;
}

/** A tag's base code (`es-ES` is `es`). */
function base(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0] as string;
}

export class TranscribeCppEngine implements FinalEngine {
  readonly id: string;
  readonly features: FinalEngine["features"];
  private model: NativeModel | null = null;
  private loading: Promise<NativeModel> | null = null;
  /** Decodes run one after another on the one model. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: TranscribeCppOptions) {
    this.id = o.id;
    const whisper = o.family === "whisper";
    this.features = {
      confidence: false,
      timestamps: false,
      glossary: whisper,
      languageId: whisper,
    };
  }

  async load(): Promise<void> {
    await this.loaded();
  }

  async unload(): Promise<void> {
    // Never free the model under a decode that is still reading it.
    await this.queue;
    const pending = this.loading;
    this.loading = null;
    const m = this.model ?? (pending ? await pending.catch(() => null) : null);
    this.model = null;
    if (!m) return;
    try {
      m.dispose();
    } catch (err) {
      this.o.log?.("warn", `${this.id}: dispose failed: ${(err as Error).message}`);
    }
  }

  decode(unit: FinalUnit): Promise<Hypothesis> {
    const run = this.queue.then(() => this.decodeOne(unit));
    this.queue = run.catch(() => {});
    return run;
  }

  private loaded(): Promise<NativeModel> {
    if (this.model) return Promise.resolve(this.model);
    this.loading ??= (async () => {
      try {
        const binding = await (this.o.binding ?? (() => nativeBinding(this.o.log)))();
        const m = await binding.load(this.o.model, { backend: this.o.backend ?? "auto" });
        this.model = m;
        return m;
      } catch (err) {
        this.loading = null;
        throw new TranscribeCppError(
          `${this.id} is unavailable: ${(err as Error).message}`,
          "engine_unavailable",
          true,
        );
      }
    })();
    return this.loading;
  }

  /** The language this unit is forced into, or undefined for Whisper to detect it. */
  private language(unit: FinalUnit): string | undefined {
    if (unit.lang !== "auto") {
      const c = base(unit.lang);
      if (this.o.languages.includes(c)) return c;
      throw new TranscribeCppError(`${this.id} does not hear ${c}`, "unit_failed", false);
    }
    const allowed = this.allowed(unit);
    if (this.o.family === "whisper") return allowed.length === 1 ? allowed[0] : undefined;
    if (allowed[0]) return allowed[0];
    throw new TranscribeCppError(
      `${this.id} must be told the language (without one it translates into English): set the call's language or asr.languages to one it hears`,
      "unit_failed",
      false,
    );
  }

  /** The user's languages this model hears, in their order: the unit's (a job's), else the engine's. */
  private allowed(unit: FinalUnit): string[] {
    const out: string[] = [];
    const listed = unit.allowed?.length ? unit.allowed : (this.o.allowed ?? []);
    for (const c of listed.map(base)) {
      if (this.o.languages.includes(c) && !out.includes(c)) out.push(c);
    }
    return out;
  }

  /** The last glossary and its prompt: a pass hands every unit the same list. */
  private lastPrompt: { glossary: readonly string[]; prompt: string | undefined } | null = null;

  /** Whisper's initial prompt: the glossary's head, within the tokens transcribe.cpp keeps. */
  private prompt(m: NativeModel, glossary: readonly string[]): string | undefined {
    if (this.lastPrompt?.glossary === glossary) return this.lastPrompt.prompt;
    const terms = glossary.map((t) => t.trim()).filter((t) => t !== "" && !t.includes("<|"));
    let prompt = "";
    for (const t of terms) {
      const next = prompt ? `${prompt}, ${t}` : t;
      // The library prepends a space before it tokenizes the prompt.
      if (m.tokenize && m.tokenize(` ${next}`).length > WHISPER_PROMPT_TOKENS) break;
      prompt = next;
    }
    this.lastPrompt = { glossary, prompt: prompt || undefined };
    return this.lastPrompt.prompt;
  }

  private async decodeOne(unit: FinalUnit): Promise<Hypothesis> {
    const forced = this.language(unit);
    if (unit.samples.length === 0) return { engine: this.id, text: "", words: [], ms: 0 };
    const m = await this.loaded();
    const t = performance.now();
    let family: FamilyExtension | undefined;
    if (this.o.family === "whisper") {
      const initialPrompt = this.prompt(m, unit.glossary);
      if (initialPrompt) family = { kind: "whisper", initialPrompt };
    }
    let r = await this.run(m, unit.samples, forced, family);
    let lang = forced ?? (r.language ? (ISO_CODE[r.language] ?? r.language) : undefined);
    // Whisper chose a language the user does not speak: decode again, forced into theirs.
    const allowed = this.allowed(unit);
    if (!forced && lang && allowed.length > 0 && !allowed.includes(lang)) {
      this.o.log?.(
        "info",
        `${this.id}: heard ${lang}, outside ${allowed.join(" ")}; forcing ${allowed[0]}`,
      );
      lang = allowed[0] as string;
      r = await this.run(m, unit.samples, lang, family);
    }
    const text = r.text.trim();
    const words: WordHyp[] = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => ({ w }));
    const h: Hypothesis = { engine: this.id, text, words, ms: performance.now() - t };
    if (lang) h.lang = lang;
    return h;
  }

  /** One native decode; any refusal is one failed unit. */
  private async run(
    m: NativeModel,
    samples: Float32Array,
    lang: string | undefined,
    family: FamilyExtension | undefined,
  ): Promise<TranscriptionResult> {
    const opts: TranscribeOptions = { timestamps: "none" };
    if (lang) opts.language = this.o.family === "whisper" ? (WHISPER_CODE[lang] ?? lang) : lang;
    if (family) opts.family = family;
    if (this.o.signal) opts.signal = this.o.signal;
    let r: TranscriptionResult;
    try {
      r = await m.transcribe(samples, opts);
    } catch (err) {
      if (this.o.signal?.aborted) throw new Error(`${this.id}: the decode was given up`);
      const e = err as Error;
      throw new TranscribeCppError(
        `${this.id} refused the unit: ${e.name}: ${e.message}`,
        "unit_failed",
        false,
      );
    }
    if (r.aborted) throw new Error(`${this.id}: the decode was given up`);
    if (r.truncated) {
      throw new TranscribeCppError(
        `${this.id} refused the unit: its output was truncated`,
        "unit_failed",
        false,
      );
    }
    return r;
  }
}

/** The catalog's transcribe-cpp engines: their family, file and languages. */
export const TRANSCRIBE_CPP_ENGINES: Readonly<
  Record<string, { family: TranscribeFamily; file: string; languages: readonly string[] }>
> = {
  [WHISPER_LARGE_V3]: {
    family: "whisper",
    file: WHISPER_LARGE_V3_FILE,
    languages: WHISPER_LANGUAGES,
  },
  [CANARY_1B_V2]: { family: "canary", file: CANARY_1B_V2_FILE, languages: PARAKEET_LANGUAGES },
};

/**
 * The engine for a catalog id, its file under the models folder (`<dir>/<id>/<file>`). Throws for
 * an id that is not a transcribe-cpp engine.
 */
export function createTranscribeCppEngine(
  id: string,
  dir: string,
  o: Omit<TranscribeCppOptions, "id" | "family" | "model" | "languages"> = {},
): TranscribeCppEngine {
  const e = TRANSCRIBE_CPP_ENGINES[id];
  if (!e) throw new Error(`${id} is not a transcribe-cpp engine`);
  return new TranscribeCppEngine({
    ...o,
    id,
    family: e.family,
    model: modelFile(dir, id, e.file),
    languages: e.languages,
  });
}
