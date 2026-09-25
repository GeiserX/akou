/**
 * The presets a client names instead of a model (docs/ux/SERVER.md section 8): `lite`, `fast`,
 * `best`, `fusion` and `auto`. Each names the model files its engine chain needs, so
 * `akou models pull <preset>` fetches exactly those before a server starts (SV-P3).
 *
 * Only Parakeet TDT 0.6B v3 is built, so only `fast` has an engine: the recognizer and the VAD that
 * gives the final pass its cut points. The other chains wait for the engine design (akou-q4t.1) and
 * say so instead of pulling something else. `auto` resolves to `fast` until hardware detection
 * (SV-R2) can pick `best` on a GPU or `lite` on a small arm64 board.
 */

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

export function presetModels(preset: Preset): PresetModels {
  switch (preset) {
    case "fast":
    case "auto":
      return { preset, models: [RECOGNIZER, "silero-vad"] };
    case "lite":
    case "best":
    case "fusion":
      return { preset, unavailable: WAITS_FOR_ENGINES };
  }
}
