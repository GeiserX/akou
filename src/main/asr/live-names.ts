/**
 * The names of the live models and the second pass, as the live menu, the call header, the Models
 * page and `akou models list` give them. No imports, so the window's bundle can take it.
 */

/** Each streaming Nemotron by its model, so the name says which one runs. */
const MODEL_NAMES: Readonly<Record<string, string>> = {
  "nemotron-en-560": "Nemotron English",
  "nemotron-3.5-560": "Nemotron 3.5",
  "nemotron-3.5-1120": "Nemotron 3.5",
  "parakeet-tdt-0.6b-v3-fp32": "Parakeet",
  "qwen3-asr-1.7b": "Qwen",
};

/** Settings values by their model's name. */
const VALUE_NAMES: Readonly<Record<string, string>> = {
  nemotron: "Nemotron",
  parakeet: "Parakeet",
  qwen: "Qwen",
  voxtral: "Voxtral Realtime",
  none: "Off",
};

/** A model's name by its catalog id, or by a setting's value (`nemotron`, `qwen`); else as given. */
export function liveModelName(id: string): string {
  return MODEL_NAMES[id] ?? VALUE_NAMES[id] ?? id;
}

/** How often a second pass reviews, in words: `every 2 min`, `every 90 s`. */
export function everyText(seconds: number): string {
  return seconds % 60 === 0 ? `every ${seconds / 60} min` : `every ${seconds} s`;
}
