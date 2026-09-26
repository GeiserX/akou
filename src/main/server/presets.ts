/**
 * The presets a client names instead of a model (docs/ux/SERVER.md section 8), in the order of the
 * table there. Two are built: `fast` over Parakeet TDT 0.6B v3 on sherpa-onnx, and `best` over
 * Qwen3-ASR-1.7B on llama-server (with Nemotron speaker labels when a job asks for them). `lite`,
 * `fusion` and `auto`'s hardware choice are listed as unavailable (SV-R1); their other engine ids
 * are provisional, as the design says.
 */

import { QWEN_ASR } from "../asr/llama-catalog.ts";
import { RECOGNIZER } from "../asr/models.ts";

export const PRESET_NAMES = ["lite", "fast", "best", "fusion", "auto"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface Preset {
  name: PresetName;
  /** The engine chain the design asks for; the first is the recognizer a job runs. */
  engines: readonly string[];
  hardware: string;
  /** `measured` only where a number was measured on a reference box. */
  speed: "measured" | "estimated";
  /** Built at all: false until its engines exist, whatever is installed. */
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
    engines: [QWEN_ASR],
    hardware:
      "a GPU: Apple silicon (Metal, akou run natively), NVIDIA (CUDA), Intel or AMD (Vulkan); runs on the CPU, slowly",
    speed: "estimated",
    built: true,
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
