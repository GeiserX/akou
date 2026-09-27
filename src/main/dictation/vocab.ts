/**
 * The vocabulary a dictation's text goes through before it is inserted (docs/ux/DICTATION.md
 * DC-L6): the same files as calls, read as one list (the global file and `vocab.extraFiles`, since
 * a dictation belongs to no workspace), with one difference. An entry with `scope: dictation` is
 * the user's own fix taught while dictating, so its heard forms always apply, the way a call's own
 * `vocab.add` does; a plain file entry keeps the call rule (a heard form that is a dictionary word
 * or 3 characters or shorter is inert). Whole word, case-insensitive, longest form first, and the
 * raw text stays in the log beside the result.
 */

import { correctText, type VocabRule } from "../../core/vocab/correct.ts";
import type { MergedEntry } from "../vocab/files.ts";

/** The rules dictation applies: every confirmed entry, dictation-scoped ones as `dictation`. */
export function dictationRules(entries: readonly MergedEntry[]): VocabRule[] {
  return entries
    .filter((e) => e.confirmed)
    .map((e) => ({
      term: e.term,
      heard: e.heard,
      scope: e.entryScope === "dictation" ? "dictation" : "file",
    }));
}

/** A dictation's text after its vocabulary. */
export function correctDictation(
  raw: string,
  entries: readonly MergedEntry[],
  isDictionaryWord: ((word: string) => boolean) | undefined,
): string {
  return correctText(raw, dictationRules(entries), { isDictionaryWord }).text;
}
