/**
 * The word lists behind read-time vocabulary correction (docs/DESIGN.md section 5.4): a heard form
 * from a vocabulary file applies only when it is not a real word, and fuzzy matching never touches
 * a real word. The fold asks through `isDictionaryWord`; this module answers it.
 *
 * - One list per language in `dictionaries/<lang>.txt.gz`: the 50,000 most frequent words of the
 *   language, folded (lowercase, accents off) and sorted, one per line, gzip'ed. Built by
 *   `scripts/build-dictionaries.ts` from FrequencyWords (CC BY-SA 4.0, credited in NOTICE).
 * - A list is read the first time a call needs it and kept for the run; one predicate per language
 *   set, so every call over the same languages shares one function.
 * - Which lists a call reads: the `vocab.languages` setting (every bundled list when empty), plus
 *   any language the recognizer detected in the call that has a list.
 * - A list that cannot be read is reported and skipped. With none readable there is no predicate,
 *   and the fold falls back to call-scoped pairs only (the fail-safe state).
 *
 * The folder sits beside this module in the source tree and beside the bundled main process in the
 * app (`electrobun.config.ts` copies it to `bun/dictionaries`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Languages akou ships a list for. Add a code here and run `scripts/build-dictionaries.ts`. */
export const DICTIONARY_LANGUAGES = ["en", "es"] as const;

export const DICTIONARIES_DIR = join(import.meta.dir, "dictionaries");

const BUNDLED = new Set<string>(DICTIONARY_LANGUAGES);

/** The primary language subtag, lowercase: `es-ES` and Whisper's `<|es|>` both give `es`. */
export function languageCode(tag: string): string {
  return tag.replace(/[<|>]/g, "").trim().split(/[-_]/)[0]?.toLowerCase() ?? "";
}

/** Reads one language's list. Throws when the file is missing or unreadable. */
export function readWordList(lang: string, dir: string = DICTIONARIES_DIR): Set<string> {
  const bytes = readFileSync(join(dir, `${lang}.txt.gz`));
  const text = new TextDecoder().decode(Bun.gunzipSync(bytes));
  const words = new Set<string>();
  for (const w of text.split("\n")) if (w !== "") words.add(w);
  return words;
}

/**
 * The lists a call reads, sorted: the configured languages, or every bundled one when none are
 * configured, plus each detected language that has a list.
 */
export function callLanguages(configured: readonly string[], detected: Iterable<string>): string[] {
  const out = new Set<string>(
    configured.length > 0 ? configured.map(languageCode) : DICTIONARY_LANGUAGES,
  );
  for (const tag of detected) {
    const code = languageCode(tag);
    if (BUNDLED.has(code)) out.add(code);
  }
  return [...out].filter((l) => BUNDLED.has(l)).sort();
}

export type WordPredicate = (word: string) => boolean;

/** The lists of one run, loaded on first use, and one shared predicate per language set. */
export class Dictionaries {
  private readonly lists = new Map<string, Set<string> | null>();
  private readonly predicates = new Map<string, WordPredicate | undefined>();

  constructor(
    private readonly dir: string = DICTIONARIES_DIR,
    private readonly onError: (msg: string) => void = () => {},
  ) {}

  /** Languages whose list has been read. */
  loaded(): string[] {
    return [...this.lists].filter(([, s]) => s !== null).map(([l]) => l);
  }

  private list(lang: string): Set<string> | null {
    if (this.lists.has(lang)) return this.lists.get(lang) ?? null;
    let words: Set<string> | null = null;
    try {
      words = readWordList(lang, this.dir);
    } catch (err) {
      this.onError(`word list ${lang}: ${(err as Error).message}`);
    }
    this.lists.set(lang, words);
    return words;
  }

  /**
   * Is a folded word in any of these languages' lists? The same function for the same set, so a
   * view can tell nothing changed. Undefined when no list could be read.
   */
  predicate(langs: readonly string[]): WordPredicate | undefined {
    const key = [...new Set(langs)].sort().join(",");
    if (this.predicates.has(key)) return this.predicates.get(key);
    const sets = key
      .split(",")
      .filter((l) => l !== "")
      .map((l) => this.list(l))
      .filter((s): s is Set<string> => s !== null);
    const p: WordPredicate | undefined =
      sets.length === 0
        ? undefined
        : sets.length === 1
          ? (w) => (sets[0] as Set<string>).has(w)
          : (w) => sets.some((s) => s.has(w));
    this.predicates.set(key, p);
    return p;
  }
}
