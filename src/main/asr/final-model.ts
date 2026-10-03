/**
 * The recognizer of the final pass on the desktop (`asr.final.model`): Qwen3-ASR on llama-server,
 * or Parakeet on sherpa-onnx. Speaker labels, cut points and the rest of the pass are the same
 * either way (finalize-worker.ts).
 *
 * `auto` picks Qwen whenever its model and its llama-server are downloaded, on any machine, and
 * Parakeet only when they are not. A model that is not downloaded never runs: the setting falls
 * back to the other model with a note, a run that names its model is refused, and with neither
 * downloaded no pass runs. With Qwen the pass never needs Parakeet on disk: the model set loads its
 * recognizer only when asked to decode, and the VAD and speaker labels are models of their own.
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
  /** The recognizer the pass runs, or null when neither is downloaded. */
  model: FinalModel | null;
  /** Why the pass does not run the model the setting prefers, or why it cannot run at all. */
  note?: string;
}

/** Qwen's files and llama-server build that are not on disk. */
function qwenMissing(c: LiveSetupContext): string[] {
  return reviewModels("qwen", c).filter((m) => !c.present(m));
}

/**
 * The recognizer the next final pass runs for `setting`, never one whose files are missing. `auto`
 * and `qwen` prefer Qwen, `parakeet` prefers Parakeet; the preferred one runs when it is
 * downloaded, else the other with a note saying why, else none. A run that names its model
 * (`akou finalize --model`) takes no substitute: the host refuses it when `model` differs.
 */
export function chooseFinalModel(setting: string, c: LiveSetupContext): FinalChoice {
  const want = finalModelOf(setting) ?? "qwen";
  const missing = qwenMissing(c);
  const why: Record<FinalModel, string | null> = {
    qwen:
      missing.length > 0
        ? `Qwen is not downloaded (needs ${missing.join(", ")}; \`akou models pull <id>\`)`
        : null,
    parakeet: c.present(RECOGNIZER)
      ? null
      : `Parakeet is not downloaded (\`akou models pull ${RECOGNIZER}\`)`,
  };
  if (why[want] === null) return { model: want };
  const other: FinalModel = want === "qwen" ? "parakeet" : "qwen";
  if (why[other] === null) return { model: other, note: why[want] as string };
  return { model: null, note: `${why[want]}, and ${why[other]}` };
}
