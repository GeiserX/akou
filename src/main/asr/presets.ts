/**
 * The presets a client names instead of a model (docs/ux/SERVER.md section 8): `lite`, `fast`,
 * `best`, `fusion` and `auto`. Each names the model files its engine chain needs, so
 * `akou models pull <preset>` fetches exactly those before a server starts (SV-P3).
 *
 * `fast`'s files are every model this machine's settings need (`modelsFor`): the recognizer starts
 * only once all of them are there, the speaker models included, so a smaller set would leave a
 * server that never transcribes. `best` is Qwen3-ASR-1.7B, the llama-server build that runs it on
 * this machine (none when `asr.llamaServer` names an own one), and the same VAD and speaker models,
 * without Parakeet. `fusion` is every engine of its list (`asr.final.engines`, else Qwen3-ASR,
 * Whisper large-v3 and Parakeet), the llama-server build when Qwen is among them, and the same VAD
 * and speaker models; transcribe-cpp, which runs Whisper and Canary, ships with akou and is never a
 * download. `lite` waits for its engines and says so instead of pulling something else. `auto` is
 * resolved before it gets here (`autoChoice` in server/model-store.ts, SV-R2) to the preset a job
 * that names no model would run; given unresolved, it is `fast`.
 */

import { FUSION_DEFAULT } from "./fusion.ts";
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
 * `runtime` is the llama-server build `best` runs on here, or null for an own llama-server;
 * `fusion` is the `fusion` preset's engines as the settings make them (`fusionChoice`).
 */
export function presetModels(
  preset: Preset,
  machine: readonly string[],
  runtime: string | null = null,
  fusion: readonly string[] = FUSION_DEFAULT,
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
    case "fusion":
      return {
        preset,
        models: [
          ...new Set([
            ...fusion,
            ...(runtime && fusion.includes(QWEN_ASR) ? [runtime] : []),
            ...machine.filter((id) => id !== RECOGNIZER || fusion.includes(RECOGNIZER)),
          ]),
        ],
      };
    case "lite":
      return { preset, unavailable: WAITS_FOR_ENGINES };
  }
}
