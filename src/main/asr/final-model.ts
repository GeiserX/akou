/**
 * The recognizer of the final pass on the desktop (`asr.final.model`): Qwen3-ASR on llama-server,
 * or Parakeet on sherpa-onnx. Speaker labels, cut points and the rest of the pass are the same
 * either way (finalize-worker.ts).
 *
 * `auto` picks Qwen whenever its model and its llama-server are downloaded, on any machine, and
 * Parakeet only when they are not. A named Qwen is the same, but says why when it cannot run. A
 * model that is not downloaded never runs. With Qwen the pass never needs Parakeet on disk: the
 * model set loads its recognizer only when asked to decode, and the VAD and speaker labels are
 * models of their own.
 */

import { type LiveSetupContext, reviewModels } from "./live-setups.ts";
import { QWEN_ASR } from "./llama-catalog.ts";
import { shortModelName } from "./model-text.ts";
import { RECOGNIZER } from "./models.ts";

/** The recognizers a final pass runs. */
export type FinalModel = "qwen" | "parakeet";

/**
 * The values of `asr.final.model`: `auto` or a model's id. The short names `qwen` and `parakeet`
 * are read as the ids and saved that way (`legacyValues`), and `akou finalize --model` takes them.
 */
export const FINAL_MODELS: readonly string[] = ["auto", QWEN_ASR, RECOGNIZER];

/** What a value of `asr.final.model` (or `akou finalize --model`) names; null for `auto`. */
export function finalModelOf(v: string | undefined): FinalModel | null {
  if (v === "qwen" || v === QWEN_ASR) return "qwen";
  if (v === "parakeet" || v === RECOGNIZER) return "parakeet";
  return null;
}

/** The catalog id a final pass decodes with. */
export function finalModelId(m: FinalModel): string {
  return m === "qwen" ? QWEN_ASR : RECOGNIZER;
}

/** A model id by its short name, as the window and `akou status` say it: `Qwen`, `Parakeet`. */
export function finalModelName(id: string | undefined): string | undefined {
  return id ? shortModelName(id) : undefined;
}

export interface FinalChoice {
  model: FinalModel;
  /** Why the pass does not run what was asked for, or why `auto` did not pick Qwen. */
  note?: string;
}

/** Qwen's files and llama-server build that are not on disk. */
function qwenMissing(c: LiveSetupContext): string[] {
  return reviewModels("qwen", c).filter((m) => !c.present(m));
}

/**
 * The recognizer the next final pass runs for `setting`: Qwen whenever it is downloaded (`auto`
 * or named), else Parakeet. Never one whose files are missing.
 */
export function chooseFinalModel(setting: string, c: LiveSetupContext): FinalChoice {
  if (finalModelOf(setting) === "parakeet") return { model: "parakeet" };
  const missing = qwenMissing(c);
  if (missing.length > 0) {
    return {
      model: "parakeet",
      note: `Qwen is not downloaded (needs ${missing.join(", ")}; \`akou models pull <id>\`)`,
    };
  }
  return { model: "qwen" };
}
