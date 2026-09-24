/**
 * The word lists read-time vocabulary correction asks "is this a real word?" (docs/DESIGN.md
 * section 5.4), one per language, into `src/main/vocab/dictionaries/<lang>.txt.gz`:
 *
 *   bun scripts/build-dictionaries.ts            fetch the pinned lists and write every language
 *   bun scripts/build-dictionaries.ts --check    exit 1 unless the committed lists are what this writes
 *
 * `--check` compares the word lists, not the gzip bytes: another zlib build may compress the same
 * list to other bytes. The release runs it.
 *
 * Source: the 2018 top-50,000 lists of FrequencyWords (https://github.com/hermitdave/FrequencyWords),
 * word frequencies counted over the OpenSubtitles 2018 corpus. Its content is licensed CC BY-SA 4.0,
 * which Creative Commons declared one-way compatible with GPLv3; NOTICE credits it. The commit is
 * pinned, so a rebuild writes the same bytes.
 *
 * Each word is folded the way the fold compares words (`foldText`: lowercase, accents off), split
 * the way a transcript is split (`tokenize`: `don't` gives `don` and `t`), deduplicated and sorted,
 * one per line, then gzip'ed. To add a language, add its code to `DICTIONARY_LANGUAGES` in
 * `src/main/vocab/dictionary.ts` and run this script.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "../src/core/vocab/correct.ts";
import { DICTIONARIES_DIR, DICTIONARY_LANGUAGES } from "../src/main/vocab/dictionary.ts";

export const SOURCE_COMMIT = "525f9b560de45753a5ea01069454e72e9aa541c6";

export function sourceUrl(lang: string): string {
  return `https://raw.githubusercontent.com/hermitdave/FrequencyWords/${SOURCE_COMMIT}/content/2018/${lang}/${lang}_50k.txt`;
}

/** `word count` lines into the sorted, folded, deduplicated word list. */
export function wordList(source: string): string[] {
  const words = new Set<string>();
  for (const line of source.split("\n")) {
    const word = line.trim().split(" ")[0] ?? "";
    for (const t of tokenize(word)) words.add(t.folded);
  }
  return [...words].sort();
}

export function pack(words: readonly string[]): Uint8Array<ArrayBuffer> {
  return Bun.gzipSync(new TextEncoder().encode(`${words.join("\n")}\n`), { level: 9 });
}

/** The text a packed list holds. */
export function unpack(bytes: Uint8Array<ArrayBuffer>): string {
  return new TextDecoder().decode(Bun.gunzipSync(bytes));
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  mkdirSync(DICTIONARIES_DIR, { recursive: true });
  let stale = 0;
  for (const lang of DICTIONARY_LANGUAGES) {
    const res = await fetch(sourceUrl(lang));
    if (!res.ok) throw new Error(`${lang}: ${res.status} from ${sourceUrl(lang)}`);
    const words = wordList(await res.text());
    const bytes = pack(words);
    const path = join(DICTIONARIES_DIR, `${lang}.txt.gz`);
    if (check) {
      const same = existsSync(path) && unpack(readFileSync(path)) === unpack(bytes);
      if (!same) stale++;
      console.log(`${lang}: ${same ? "up to date" : "differs"} (${words.length} words)`);
    } else {
      writeFileSync(path, bytes);
      console.log(`${lang}: ${words.length} words, ${bytes.length} bytes -> ${path}`);
    }
  }
  if (stale > 0) process.exit(1);
}

if (import.meta.main) await main();
