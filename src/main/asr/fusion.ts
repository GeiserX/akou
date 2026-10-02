/**
 * The N-engine final pass, as names and settings (docs/research/asr-architecture.md sections 4 and
 * 5, ASR-6): which engines the pass can run, the `fusion` preset's list, the fusers that are built,
 * and the model id a fused result carries, `rover-conf(<id>,<id>,...)`. The pass itself is
 * `runEngines` in finalize-worker.ts.
 *
 * A fused model id is an ordinary model value: a job names it in `model`, the job keeps it as its
 * model, and the model store reads the engines back out of it (`fusionParts`) to know which files
 * the job needs. The order of the ids is the order the fuser breaks ties in.
 */

import type { FuserId, FusionEngineSpec, LlamaEngineSpec, ModelSpec } from "./engine.ts";
import { QWEN_ASR } from "./llama-catalog.ts";
import {
  CANARY_1B_V2,
  MODELS,
  type ModelSpecEntry,
  RECOGNIZER,
  WHISPER_LARGE_V3,
} from "./models.ts";

/** The fusers the pass runs (`asr.fusion`); the LLM fusers (ASR-9) are not built. */
export const BUILT_FUSERS = ["first", "rover-freq", "rover-conf"] as const;
export type BuiltFuser = (typeof BUILT_FUSERS)[number];

/** Every fuser the design names, built or not, so a named but unbuilt one gets a clear refusal. */
export const FUSERS: readonly FuserId[] = [
  "first",
  "rover-freq",
  "rover-conf",
  "llm-pick",
  "llm-free",
];

/** The engines the pass can run, one runtime each: sherpa-onnx, llama-server, transcribe-cpp. */
export const FUSION_ENGINES: readonly string[] = [
  QWEN_ASR,
  WHISPER_LARGE_V3,
  RECOGNIZER,
  CANARY_1B_V2,
];

/**
 * The `fusion` preset's engines, in priority order. Three, because two leave ROVER with no
 * tie-breaker: with two engines each candidate of a disputed column has one vote, so confidence
 * alone decides, and Whisper reports none. This trio is what the benchmark measured: 7.97 pooled
 * WER, against 8.63 for the best single engine, Qwen with the language set. Canary-1b-v2
 * (`canary-1b-v2`) can be added through `asr.final.engines`; four and five engines measured 8.05
 * and 7.98 pooled, no better, and each costs its own decode.
 */
export const FUSION_DEFAULT: readonly string[] = [QWEN_ASR, WHISPER_LARGE_V3, RECOGNIZER];

export function isBuiltFuser(v: string): v is BuiltFuser {
  return (BUILT_FUSERS as readonly string[]).includes(v);
}

/** Why a fuser cannot run, or null when it can. */
export function fuserRefusal(v: string): string | null {
  if (isBuiltFuser(v)) return null;
  if ((FUSERS as readonly string[]).includes(v)) {
    return `${v} fuses through a provider, which is not built in this version; use rover-conf`;
  }
  return `is one of ${BUILT_FUSERS.join(", ")}`;
}

/** Why an engine list cannot run, or null when it can: known ids, no repeats. */
export function enginesRefusal(ids: readonly string[]): string | null {
  const unknown = ids.filter((id) => !FUSION_ENGINES.includes(id));
  if (unknown.length > 0) {
    return `${unknown.join(", ")} cannot run in the final pass; the engines are ${FUSION_ENGINES.join(", ")}`;
  }
  if (new Set(ids).size !== ids.length) return "names an engine twice";
  return null;
}

/** The model id of a fused pass: the fuser and the engines, in their order. */
export function fusionModelId(fuser: string, engines: readonly string[]): string {
  return `${fuser}(${engines.join(",")})`;
}

/** The fuser and the engines a fused model id names, or null for any other model value. */
export function fusionParts(v: string): { fuser: string; engines: string[] } | null {
  const m = /^([a-z][a-z-]*)\(([^()]*)\)$/.exec(v.trim());
  if (!m || !(FUSERS as readonly string[]).includes(m[1] as string)) return null;
  const engines = (m[2] as string)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { fuser: m[1] as string, engines };
}

/** The engines a job on `model` runs: a fused id's engines, else the model itself. */
export function engineIds(model: string): string[] {
  return fusionParts(model)?.engines ?? [model];
}

/**
 * The fusion preset's list as the settings make it: `asr.final.engines` when it names any, else
 * the preset's three, and `asr.fusion`.
 */
export function fusionChoice(s: {
  readonly "asr.final.engines"?: readonly string[];
  readonly "asr.fusion"?: string;
}): { fuser: string; engines: readonly string[] } {
  const named = s["asr.final.engines"] ?? [];
  return {
    fuser: s["asr.fusion"] ?? "rover-conf",
    engines: named.length > 0 ? named : FUSION_DEFAULT,
  };
}

/**
 * About how much memory an engine holds while it is loaded, MB (2^20 bytes): its files in the
 * catalog and a fifth more. An estimate, for the pass's memory budget (`asr.memoryBudgetMb`); the
 * engines run one at a time, so the budget is held against each engine alone. Undefined for an id
 * the catalog does not have.
 */
export function engineMemoryMb(id: string, catalog: readonly ModelSpecEntry[]): number | undefined {
  const m = catalog.find((x) => x.id === id);
  if (!m) return undefined;
  const bytes = m.files.reduce((n, f) => n + f.size, 0);
  return Math.round((bytes * 1.2) / 2 ** 20);
}

/** The memory budget, MB: the setting, or 60 % of this machine's memory when it is 0. */
export function memoryBudgetMb(setting: number, totalBytes: number): number {
  return setting > 0 ? setting : Math.floor((0.6 * totalBytes) / 2 ** 20);
}

/**
 * The model spec of a fused job (ASR-6): `base` (the model set for the VAD, the speaker labels and
 * Parakeet) and each engine of `ids` on its own runtime, as the real catalog says: Qwen on
 * llama-server (`llama`), Whisper and Canary on transcribe-cpp, else the model set's recognizer.
 * With `module` (a test's model set) the transcribe-cpp engines are that module's `createEngine`.
 */
export function fusionSpec(
  base: ModelSpec,
  fuser: BuiltFuser,
  ids: readonly string[],
  o: {
    /** For the memory estimates. */
    catalog: readonly ModelSpecEntry[];
    modelsDir: string;
    /** `asr.languages`. */
    languages: readonly string[];
    llama(id: string): LlamaEngineSpec;
    module?: { path: string; options?: unknown };
    budgetMb: number;
  },
): ModelSpec {
  const engines = ids.map((id): FusionEngineSpec => {
    const memoryMb = engineMemoryMb(id, o.catalog);
    const runtime = MODELS.find((m) => m.id === id)?.runtime;
    if (runtime === "llama-server") return { ...o.llama(id), memoryMb };
    if (runtime === "transcribe-cpp") {
      return o.module
        ? { kind: "module", path: o.module.path, engine: id, options: o.module.options, memoryMb }
        : {
            kind: "transcribe-cpp",
            engine: id,
            modelsDir: o.modelsDir,
            languages: o.languages,
            memoryMb,
          };
    }
    return { kind: "recognizer", engine: id, memoryMb };
  });
  return { ...base, fusion: { fuser, engines, memoryBudgetMb: o.budgetMb } };
}
