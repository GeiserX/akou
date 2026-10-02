/**
 * The presets a client names instead of a model (docs/ux/SERVER.md section 8, SV-R1), in the order
 * of the table there, each with its engines, its speaker model and how it joins its engines. Three
 * are built: `fast` over Parakeet TDT 0.6B v3 on sherpa-onnx, `best` over Qwen3-ASR-1.7B on
 * llama-server, and `fusion`, which runs Qwen3-ASR, Whisper large-v3 and Parakeet over the same
 * pieces and joins their words by confidence ROVER (ASR-6). `lite` and `auto`'s hardware choice are
 * listed as unavailable; `lite`'s engine ids are provisional, as the design says.
 */

import { FUSION_DEFAULT } from "../asr/fusion.ts";
import { QWEN_ASR } from "../asr/llama-catalog.ts";
import { NEMOTRON, RECOGNIZER } from "../asr/models.ts";

export const PRESET_NAMES = ["lite", "fast", "best", "fusion", "auto"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface Preset {
  name: PresetName;
  /**
   * The engines, registry ids, in priority order. A single-engine preset's job runs the first; the
   * `fusion` preset runs them all, and `asr.final.engines` overrides its list.
   */
  engines: readonly string[];
  /**
   * The speaker model a job that asks for `diarize` runs, with `asr.diarizer` at its default
   * (`nemotron`); `embeddings` swaps it for pyannote and TitaNet on every preset.
   */
  diarizer: string;
  /** How the engines' words are joined (`asr.fusion` overrides it for `fusion`); null for one. */
  fusion: "rover-conf" | null;
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
    diarizer: NEMOTRON,
    fusion: null,
    hardware: "arm64 boards, N100-class x64",
    speed: "estimated",
    built: false,
  },
  {
    name: "fast",
    engines: [RECOGNIZER],
    diarizer: NEMOTRON,
    fusion: null,
    hardware: "any x64 CPU, the default on CPU",
    speed: "measured",
    built: true,
  },
  {
    name: "best",
    engines: [QWEN_ASR],
    diarizer: NEMOTRON,
    fusion: null,
    hardware:
      "a GPU: Apple silicon (Metal, akou run natively), NVIDIA (CUDA), Intel or AMD (Vulkan); runs on the CPU, slowly",
    speed: "estimated",
    built: true,
  },
  {
    name: "fusion",
    engines: FUSION_DEFAULT,
    diarizer: NEMOTRON,
    fusion: "rover-conf",
    hardware: "a GPU, as for best: every engine decodes the whole file, one after another",
    speed: "estimated",
    built: true,
  },
  {
    name: "auto",
    engines: [],
    diarizer: NEMOTRON,
    fusion: null,
    hardware: "everyone who did not choose",
    speed: "estimated",
    built: false,
  },
];
