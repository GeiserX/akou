/**
 * The presets a client names instead of a model (docs/ux/SERVER.md section 8): `lite`, `fast`,
 * `best`, `fusion` and `auto`. Each names the model files its engine chain needs, so
 * `akou models pull <preset>` fetches exactly those before a server starts (SV-P3).
 *
 * `fast`'s files are every model this machine's settings need (`modelsFor`): the recognizer starts
 * only once all of them are there, the speaker models included, so a smaller set would leave a
 * server that never transcribes. `best` is Qwen3-ASR-1.7B, the llama-server build that runs it on
 * this machine (none when `asr.llamaServer` names an own one), and the same VAD and speaker models,
 * without Parakeet. `lite` and `fusion` wait for their engines and say so instead of pulling
 * something else. `auto` resolves to `fast` until hardware detection (SV-R2) can pick `best` on a
 * GPU or `lite` on a small arm64 board.
 */

import { QWEN_ASR } from "./llama-catalog.ts";
import { RECOGNIZER } from "./models.ts";

export const PRESET_NAMES = ["lite", "fast", "best", "fusion", "auto"] as const;
export type Preset = (typeof PRESET_NAMES)[number];

export function isPreset(name: string): name is Preset {
  return (PRESET_NAMES as readonly string[]).includes(name);
}

/** The model ids a preset needs, or why it has none in this version. */
export type PresetModels =
  | { preset: Preset; models: readonly string[] }
  | { preset: Preset; unavailable: string };

const WAITS_FOR_ENGINES = "its engines wait for the engine design";

/**
 * `machine` is the ids of every model this machine's settings need, as `modelsFor` lists them;
 * `runtime` is the llama-server build `best` runs on here, or null for an own llama-server.
 */
export function presetModels(
  preset: Preset,
  machine: readonly string[],
  runtime: string | null = null,
): PresetModels {
  switch (preset) {
    case "fast":
    case "auto":
      return { preset, models: machine };
    case "best":
      return {
        preset,
        models: [
          ...new Set([
            QWEN_ASR,
            ...(runtime ? [runtime] : []),
            ...machine.filter((id) => id !== RECOGNIZER),
          ]),
        ],
      };
    case "lite":
    case "fusion":
      return { preset, unavailable: WAITS_FOR_ENGINES };
  }
}
