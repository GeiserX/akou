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

/**
 * Memory an engine of the final pass holds while it runs, MB, for the pass's budget
 * (`FinalOptions.memoryBudgetMb`): Qwen about 3 GB (DESIGN 3.3), Parakeet with its model set about
 * 2.7 GB (engine.ts, `ModelSet.release`).
 */
export const FINAL_ENGINE_MEMORY_MB: Readonly<Record<string, number>> = {
  [QWEN_ASR]: 3000,
  [RECOGNIZER]: 2700,
};

/** An engine's memory for the budget: its own figure, else the table's, else nothing. */
export function finalEngineMemoryMb(e: { id: string; memoryMb?: number }): number {
  return e.memoryMb ?? FINAL_ENGINE_MEMORY_MB[e.id] ?? 0;
}

/** An engine of `asr.final.engines` a pass left out, and why: `final.done`'s `dropped`. */
export interface DroppedEngine {
  engine: string;
  reason: string;
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

/**
 * The engines a pass over `asr.final.engines` runs, in the list's order, each at most once, and
 * the ones left out because they are not downloaded. Empty `models` when none is here.
 */
export function chooseFinalEngines(
  list: readonly string[],
  c: LiveSetupContext,
): { models: FinalModel[]; dropped: DroppedEngine[] } {
  const models: FinalModel[] = [];
  const dropped: DroppedEngine[] = [];
  for (const v of list) {
    const m = finalModelOf(v);
    if (!m || models.includes(m) || dropped.some((d) => d.engine === finalModelId(m))) continue;
    const missing = m === "qwen" ? qwenMissing(c) : c.present(RECOGNIZER) ? [] : [RECOGNIZER];
    if (missing.length === 0) models.push(m);
    else
      dropped.push({ engine: finalModelId(m), reason: `not downloaded (${missing.join(", ")})` });
  }
  return { models, dropped };
}
