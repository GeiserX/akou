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
import { type MergedEntry, termKey, upsertEntry, type VocabFile } from "../vocab/files.ts";

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

/** A pair the user taught while dictating (DC-L4): the fix, the form heard, the dictation. */
export interface LearnedPair {
  term: string;
  heard: string;
  id: string;
}

const sameForm = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether `heard` to `term` is in the vocabulary already: nothing to learn then. */
export function knowsPair(entries: readonly MergedEntry[], heard: string, term: string): boolean {
  return entries.some(
    (e) => termKey(e.term) === termKey(term) && e.heard.some((h) => sameForm(h, heard)),
  );
}

/**
 * The file with a learned pair (DC-L6): the term's `scope: dictation` entry gains the heard form,
 * or a new one is written, confirmed, with `source: dictation:<id>`. A term the file holds for
 * calls is refused: its heard forms reach call transcripts, so a dictation fix there would too.
 */
export function learnPair(file: VocabFile, p: LearnedPair, today: string): VocabFile {
  const e = file.entries.find((x) => termKey(x.term) === termKey(p.term));
  if (e && e.entryScope !== "dictation") {
    throw new Error(`"${p.term}" is a word for calls too: add "${p.heard}" to it in the editor`);
  }
  if (e) {
    if (e.heard.some((h) => sameForm(h, p.heard))) return file;
    return upsertEntry(file, { ...e, heard: [...e.heard, p.heard] });
  }
  return upsertEntry(file, {
    term: p.term,
    heard: [p.heard],
    source: `dictation:${p.id}`,
    confirmed: true,
    added_at: today,
    entryScope: "dictation",
  });
}

/**
 * The file without a learned pair (Undo): the heard form leaves the term's dictation entry, and an
 * entry that Learn made for this dictation goes when it has no heard form left.
 */
export function unlearnPair(file: VocabFile, p: LearnedPair): VocabFile {
  const e = file.entries.find(
    (x) => termKey(x.term) === termKey(p.term) && x.entryScope === "dictation",
  );
  if (!e) return file;
  const heard = e.heard.filter((h) => !sameForm(h, p.heard));
  if (heard.length === 0 && e.source === `dictation:${p.id}`) {
    return { ...file, entries: file.entries.filter((x) => x !== e) };
  }
  return upsertEntry(file, { ...e, heard });
}
