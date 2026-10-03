/**
 * The names and the one plain line per slot of the models a person picks for a call: the live
 * transcript (`live`) and the second pass (`review`). The catalog entries (models.ts,
 * llama-catalog.ts) take theirs from here, and `GET /models` hands them to the live panel and the
 * Models page, so every place says the same words. No imports, so the window's bundle can take it.
 *
 * The claims rest on the catalog and the measurements (docs/research/asr-architecture.md): the
 * language counts are each model's list; "fewer errors on spoken Spanish" for the 1120 ms tier is
 * the bp set (semi-spontaneous Spanish), 5.91 % WER against 7.19 at 560 ms, while read Spanish
 * (FLEURS) scores the same at both tiers; no tier retracts a word once written, so neither the
 * name ("1 s", its chunk) nor the line claims steadier words; "mixed in one call" is Nemotron 3.5,
 * the one engine measured to switch language mid-stream.
 */

export interface ModelText {
  /** Its name where a person picks it: the live panel, the Models page, the call header. */
  name: string;
  /** A shorter name for tight places, the Record row's button; absent: `name`. */
  short?: string;
  /** One plain line per slot it can fill. */
  lines: { live?: string; review?: string };
}

export const MODEL_TEXT: Readonly<Record<string, ModelText>> = {
  "nemotron-3.5-560": {
    name: "Nemotron 3.5",
    lines: { live: "Words appear as they are said. 35 languages, mixed in one call." },
  },
  "nemotron-3.5-1120": {
    name: "Nemotron 3.5, 1 s",
    lines: {
      live: "Waits about a second before writing. Fewer errors on spoken Spanish. 35 languages.",
    },
  },
  "nemotron-en-560": {
    name: "Nemotron English",
    lines: { live: "Words appear as they are said. English only." },
  },
  // The other chunk sizes: named by how long each waits before it writes, as "1 s" above, every
  // line in one shape. Their accuracy in akou is not measured, and the lines say so rather than
  // guess; the 80 ms tiers ran slower than real time in a smoke test on a busy machine, so they
  // say they can fall behind.
  "nemotron-3.5-80": {
    name: "Nemotron 3.5, 80 ms",
    lines: {
      live: "Writes after 80 ms. Not timed yet: on a slow machine the transcript can fall behind. Accuracy not measured yet. 35 languages.",
    },
  },
  "nemotron-3.5-160": {
    name: "Nemotron 3.5, 160 ms",
    lines: { live: "Writes after 160 ms. Accuracy not measured yet. 35 languages." },
  },
  "nemotron-3.5-320": {
    name: "Nemotron 3.5, 320 ms",
    lines: { live: "Writes after 320 ms. Accuracy not measured yet. 35 languages." },
  },
  "nemotron-en-80": {
    name: "Nemotron English, 80 ms",
    lines: {
      live: "Writes after 80 ms. Not timed yet: on a slow machine the transcript can fall behind. Accuracy not measured yet. English only.",
    },
  },
  "nemotron-en-160": {
    name: "Nemotron English, 160 ms",
    lines: { live: "Writes after 160 ms. Accuracy not measured yet. English only." },
  },
  "nemotron-en-1120": {
    name: "Nemotron English, 1 s",
    lines: { live: "Writes after about 1 s. Accuracy not measured yet. English only." },
  },
  "parakeet-tdt-0.6b-v3-fp32": {
    name: "Parakeet",
    lines: {
      live: "Writes each sentence when the speaker pauses. 25 European languages.",
      review: "Hears the last minutes again, whole sentences at a time. 25 European languages.",
    },
  },
  "qwen3-asr-1.7b": {
    name: "Qwen3-ASR",
    short: "Qwen",
    lines: { review: "Hears the last minutes again and rewrites the lines. 30 languages." },
  },
  // Engines of the final pass only (transcribe-cpp): no live or review slot, so no line.
  "whisper-large-v3": { name: "Whisper large-v3", short: "Whisper", lines: {} },
  "canary-1b-v2": { name: "Canary 1B v2", short: "Canary", lines: {} },
};

/** Settings values by their model's name. */
const VALUE_NAMES: Readonly<Record<string, string>> = {
  nemotron: "Nemotron",
  parakeet: "Parakeet",
  qwen: "Qwen3-ASR",
  voxtral: "Voxtral Realtime",
  none: "Off",
};

/** A model's name by its catalog id, or by a setting's value (`nemotron`, `qwen`); else as given. */
export function liveModelName(id: string): string {
  return MODEL_TEXT[id]?.name ?? VALUE_NAMES[id] ?? id;
}

/** The short name, for the Record row's button: `Qwen` for Qwen3-ASR. */
export function shortModelName(id: string): string {
  return MODEL_TEXT[id]?.short ?? liveModelName(id);
}

/** How often a second pass reviews, in words: `every 2 min`, `every 90 s`. */
export function everyText(seconds: number): string {
  return seconds % 60 === 0 ? `every ${seconds / 60} min` : `every ${seconds} s`;
}
