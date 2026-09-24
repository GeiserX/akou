/**
 * Ranked candidate words (`POST /vocab/suggest`, `akou vocab suggest`, `akou_vocab_suggest`): the
 * words in a call or a text that look like names, products or projects, ranked by frequency times
 * rarity, for an agent to propose to the user. Nothing here writes: a suggestion is a candidate for
 * a proposal, and a proposal is inert until the user approves it.
 *
 * akou carries no dictionary, so rarity is read from the word's shape: a capital letter where a
 * sentence does not start, mixed case (`GitHub`, `iOS`), letters with digits (`k3s`), length. A run
 * of capitalised words (`Neutral Base`) is one candidate. Stopwords, known terms and rejected terms
 * are never suggested.
 */

import { termKey } from "./files.ts";

export interface Suggestion {
  term: string;
  count: number;
  /** Frequency times rarity. */
  score: number;
  rarity: number;
  /** Line ids it occurs in, when the source was a call. */
  lines?: string[];
}

export interface SuggestSource {
  text: string;
  id?: string;
}

const WORD = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’.-]*[\p{L}\p{M}\p{N}]|[\p{L}\p{N}]/gu;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const DIGIT = /\p{N}/u;
const SENTENCE_END = /[.!?:;]\s*$/;

/** How unusual a single word looks, 0 when it looks like an everyday word. */
export function rarityOf(word: string, sentenceStart: boolean): number {
  let r = 0;
  const first = word[0] ?? "";
  const rest = word.slice(1);
  if (UPPER.test(rest) && LOWER.test(word))
    r += 2; // GitHub, iOS
  else if (UPPER.test(first) && !sentenceStart) r += 2; // a capital mid-sentence
  if (DIGIT.test(word) && /\p{L}/u.test(word)) r += 1; // k3s
  if (word.length >= 3 && word === word.toUpperCase() && /\p{L}/u.test(word)) r += 1; // SDK
  if ([...word].length >= 8) r += 0.5;
  return r;
}

export function suggestTerms(
  sources: readonly SuggestSource[],
  o: {
    known: readonly string[];
    rejected: readonly string[];
    stopwords: ReadonlySet<string>;
    k: number;
  },
): Suggestion[] {
  const skip = new Set([...o.known, ...o.rejected].map(termKey));
  const found = new Map<string, Suggestion & { forms: Map<string, number> }>();
  const add = (form: string, rarity: number, id: string | undefined) => {
    const key = termKey(form);
    if (key === "" || skip.has(key)) return;
    let s = found.get(key);
    if (!s) {
      s = { term: form, count: 0, score: 0, rarity, forms: new Map() };
      found.set(key, s);
    }
    s.count++;
    s.rarity = Math.max(s.rarity, rarity);
    s.forms.set(form, (s.forms.get(form) ?? 0) + 1);
    if (id !== undefined) {
      s.lines ??= [];
      if (!s.lines.includes(id)) s.lines.push(id);
    }
  };
  for (const src of sources) {
    let run = { words: [] as string[], rarity: 0 };
    const flush = () => {
      if (run.words.length > 1) add(run.words.join(" "), run.rarity + 1, src.id);
      run = { words: [], rarity: 0 };
    };
    let prevEnd = 0;
    for (const m of src.text.matchAll(WORD)) {
      const word = m[0];
      const at = m.index ?? 0;
      const between = src.text.slice(prevEnd, at);
      const sentenceStart = prevEnd === 0 || SENTENCE_END.test(between);
      prevEnd = at + word.length;
      const folded = termKey(word);
      const stop = o.stopwords.has(folded) || [...folded].length < 3;
      const rarity = stop ? 0 : rarityOf(word, sentenceStart);
      // A run of capitalised words, one space apart, is one name. "Then" at a sentence start
      // does not open one.
      const nameLike = UPPER.test(word[0] ?? "") && !stop && !(sentenceStart && rarity === 0);
      if (!nameLike || (run.words.length > 0 && between !== " ")) flush();
      if (nameLike) {
        run.words.push(word);
        run.rarity = Math.max(run.rarity, rarity);
      }
      if (!stop) add(word, rarity, src.id);
    }
    flush();
  }
  // Every occurrence counts, but only a word that looked unusual somewhere is a candidate.
  return [...found.values()]
    .filter((s) => s.rarity > 0)
    .map(({ forms, ...s }) => {
      // The spelling used most often is the one shown.
      const term = [...forms].sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.term;
      return { ...s, term, score: Math.round(s.count * s.rarity * 100) / 100 };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, o.k);
}
