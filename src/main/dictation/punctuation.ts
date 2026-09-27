/**
 * The spoken punctuation lists in force (DC-S6): the shipped ones, with `dictation-punctuation.json`
 * in the config folder laid over them, as a file in `templates/` replaces a shipped template. A
 * language in the file replaces that language's list whole; a new language adds one.
 *
 * ```json
 * { "en": { "comma": ",", "full stop": ".", "new line": "\n" } }
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type PunctuationLists, SPOKEN_PUNCTUATION } from "../../core/dictation/punctuation.ts";

export const PUNCTUATION_FILE = "dictation-punctuation.json";

/** The lists for a dictation; throws, naming the file, when the user's file cannot be used. */
export function loadPunctuation(configDir: string): PunctuationLists {
  const path = join(configDir, PUNCTUATION_FILE);
  if (!existsSync(path)) return SPOKEN_PUNCTUATION;
  let o: unknown;
  try {
    o = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${PUNCTUATION_FILE}: ${(err as Error).message}`);
  }
  const bad = () =>
    new Error(`${PUNCTUATION_FILE}: expected {"<language>": {"<phrase>": "<mark>"}}`);
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw bad();
  const out: Record<string, Readonly<Record<string, string>>> = { ...SPOKEN_PUNCTUATION };
  for (const [lang, list] of Object.entries(o)) {
    if (typeof list !== "object" || list === null || Array.isArray(list)) throw bad();
    if (!Object.values(list).every((m) => typeof m === "string")) throw bad();
    out[lang.toLowerCase()] = list as Record<string, string>;
  }
  return out;
}
