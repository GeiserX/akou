/**
 * The presets a client names instead of a model (docs/ux/SERVER.md section 8), in the order of the
 * table there. Only Parakeet TDT 0.6B v3 is built, so until the engine registry exists (akou-q4t.1)
 * `fast` runs over it and the other four are listed as unavailable (SV-R1). Every other engine id
 * here is provisional, as the design says.
 */

import { RECOGNIZER } from "../asr/models.ts";

export const PRESET_NAMES = ["lite", "fast", "best", "fusion", "auto"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface Preset {
  name: PresetName;
  /** The engine chain the design asks for; only `fast`'s is built. */
  engines: readonly string[];
  hardware: string;
  /** `measured` only where a number was measured on a reference box. */
  speed: "measured" | "estimated";
  /** Built at all: false until the engine registry lands, whatever is installed. */
  built: boolean;
}

export const PRESETS: readonly Preset[] = [
  {
    name: "lite",
    engines: ["silero-vad", "parakeet-tdt-0.6b-v3-int8", "nemotron-3.5-asr-streaming-0.6b"],
    hardware: "arm64 boards, N100-class x64",
    speed: "estimated",
    built: false,
  },
  {
    name: "fast",
    engines: [RECOGNIZER],
    hardware: "any x64 CPU, the default on CPU",
    speed: "measured",
    built: true,
  },
  {
    name: "best",
    engines: ["qwen3-asr-1.7b", "whisper-large-v3"],
    hardware: "CUDA, or Apple silicon through the native app",
    speed: "estimated",
    built: false,
  },
  {
    name: "fusion",
    engines: ["parakeet-tdt-0.6b-v3", "qwen3-asr-1.7b", "whisper-large-v3-turbo", "canary-1b-v2"],
    hardware: "CUDA, or an overnight CPU run",
    speed: "estimated",
    built: false,
  },
  {
    name: "auto",
    engines: [],
    hardware: "everyone who did not choose",
    speed: "estimated",
    built: false,
  },
];
