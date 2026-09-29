/**
 * The streaming engines of the live transcript (docs/research/asr-architecture.md section 3.1):
 * which Nemotron runs a call, picked by `asr.live.engine` and the call's languages
 * (`asr.languages`), and only ever one whose model files are on disk.
 *
 * | Languages          | Engine              | Why                                                    |
 * |--------------------|---------------------|--------------------------------------------------------|
 * | only `en`          | `nemotron-en-560`   | the English model beats the multilingual one on calls  |
 * | only `es`          | `nemotron-3.5-1120` | the 1120 ms tier is better on Spanish speech           |
 * | anything else      | `nemotron-3.5-560`  | the one engine measured to switch language mid-stream  |
 *
 * `auto` falls back to another downloaded Nemotron that hears the languages, and to Parakeet (the
 * VAD windows re-decoded offline, `choice: null`) when none is on disk. A choice is made when a call
 * starts, so a change applies from the next call and a running call keeps its engine.
 */

import { NEMOTRON_35_LANGUAGES } from "./models.ts";

export interface LiveEngineInfo {
  /** The model's chunk, milliseconds: how far behind the audio a word can come. */
  tierMs: number;
  languages: readonly string[];
  /** Takes the stream's `language` option (Nemotron 3.5); the English model takes none. */
  multilingual: boolean;
}

export const LIVE_ENGINES = {
  "nemotron-en-560": { tierMs: 560, languages: ["en"], multilingual: false },
  "nemotron-3.5-560": { tierMs: 560, languages: NEMOTRON_35_LANGUAGES, multilingual: true },
  "nemotron-3.5-1120": { tierMs: 1120, languages: NEMOTRON_35_LANGUAGES, multilingual: true },
} as const satisfies Record<string, LiveEngineInfo>;

export type LiveEngineId = keyof typeof LIVE_ENGINES;
export const LIVE_ENGINE_IDS = Object.keys(LIVE_ENGINES) as LiveEngineId[];
/** The values of `asr.live.engine`. */
export const LIVE_ENGINE_SETTINGS = ["auto", ...LIVE_ENGINE_IDS] as const;

export function isLiveEngine(id: string): id is LiveEngineId {
  return Object.hasOwn(LIVE_ENGINES, id);
}

/** The streaming engine a call runs, and the language its streams are told (`auto` for any). */
export interface LiveChoice {
  engine: string;
  lang: string;
}

/** The language an engine's streams are told for these call languages. */
export function streamLanguage(engine: LiveEngineId, languages: readonly string[]): string {
  const e: LiveEngineInfo = LIVE_ENGINES[engine];
  if (!e.multilingual) return e.languages[0] as string;
  const [only] = languages;
  return languages.length === 1 && only && e.languages.includes(only) ? only : "auto";
}

/** The engine the call's languages ask for, whatever is on disk (the table at the top). */
export function engineForLanguages(languages: readonly string[]): LiveEngineId {
  if (languages.length === 1 && languages[0] === "en") return "nemotron-en-560";
  if (languages.length === 1 && languages[0] === "es") return "nemotron-3.5-1120";
  return "nemotron-3.5-560";
}

/**
 * The live engine of the next call. `present` says whether an engine's model files are on disk.
 * Null means Parakeet, with `note` saying why when a streaming engine was wanted.
 */
export function chooseLiveEngine(
  setting: string,
  languages: readonly string[],
  present: (id: LiveEngineId) => boolean,
): { choice: LiveChoice | null; note?: string } {
  const pick = (engine: LiveEngineId) => ({
    choice: { engine, lang: streamLanguage(engine, languages) },
  });
  const missing = (engine: LiveEngineId) =>
    `the live model ${engine} is not downloaded (\`akou models pull ${engine}\`); live lines come from Parakeet`;
  if (isLiveEngine(setting))
    return present(setting) ? pick(setting) : { choice: null, note: missing(setting) };
  const wanted = engineForLanguages(languages);
  // No languages set means any: only a multilingual engine hears that.
  const hears = (id: LiveEngineId) => {
    const e: LiveEngineInfo = LIVE_ENGINES[id];
    return languages.length === 0
      ? e.multilingual
      : languages.every((l) => e.languages.includes(l));
  };
  const order = [wanted, "nemotron-3.5-560", "nemotron-3.5-1120", "nemotron-en-560"] as const;
  for (const id of order) if (hears(id) && present(id)) return pick(id);
  return { choice: null, note: missing(wanted) };
}
