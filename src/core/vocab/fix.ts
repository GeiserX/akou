/**
 * Fix once, applied everywhere (docs/DESIGN.md section 5.4, "A fix on a line"): what one fixed line
 * teaches akou.
 *
 * - `fixPairs(before, after)` aligns the words of the line as it read with the words the person
 *   wrote, and returns each replaced run as a pair: what was heard, what it should read. Only real
 *   replacements count. Punctuation is not a word, so an edit of punctuation alone gives no pair;
 *   a change of case alone gives one only when it makes a name (`vercel` to `Vercel` inside the
 *   line, `iphone` to `iPhone`), never for the capital at the start of a line. A word added or
 *   removed is a pair with the word before it (`going` to `going to`).
 * - `pairKind` says what a pair is: a `term` a recognizer can be taught (a name, a product, a
 *   project, a jargon word: a word with a digit, a capital a sentence does not explain, or a word the
 *   dictionary does not know), or a `rewording` of common words that only this line needs.
 *
 * Words are matched as whole words, case-insensitive and accent-folded (`tokenize`), so a pair
 * never reaches inside a longer word.
 */

import { type Token, tokenize } from "./correct.ts";

export interface FixPair {
  /** The words as the line read, exactly as written there. */
  heard: string;
  /** The words as the person wrote them. */
  term: string;
  /** Index of the pair's first word in the fixed line: 0 is the start of the line. */
  at: number;
}

export type PairKind = "term" | "rewording";

/** A pair longer than this, on either side, is a rewording: no recognizer is taught a sentence. */
export const MAX_PAIR_WORDS = 4;

/** The indexes of a longest common subsequence of two folded word lists, in order. */
function align(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = len[i] as number[];
    const next = len[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if ((len[i + 1]?.[j] as number) >= (len[i]?.[j + 1] as number)) i++;
    else j++;
  }
  return out;
}

const UPPER = /\p{Lu}/u;

/** `vercel` to `Vercel` inside a line, or `iphone` to `iPhone`: a name's casing, not a sentence's. */
function nameCasing(from: string, to: string, at: number): boolean {
  if (from.toLowerCase() !== to.toLowerCase()) return false;
  const capitals = (s: string) => [...s].filter((c) => UPPER.test(c)).length;
  if (capitals(to) <= capitals(from)) return false;
  return at > 0 || UPPER.test([...to].slice(1).join(""));
}

function span(text: string, tokens: readonly Token[], from: number, to: number): string {
  return text.slice((tokens[from] as Token).start, (tokens[to] as Token).end);
}

/**
 * The pairs a fix makes: `before` is the line as it read, `after` as the person wrote it. Empty
 * when nothing but punctuation or a sentence's capital changed.
 */
export function fixPairs(before: string, after: string): FixPair[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length === 0 || b.length === 0) return [];
  const anchors = align(
    a.map((t) => t.folded),
    b.map((t) => t.folded),
  );
  const out: FixPair[] = [];
  const gap = (i0: number, i1: number, j0: number, j1: number) => {
    // [i0, i1) of the line as it read became [j0, j1) of the line as written.
    if (i1 > i0 && j1 > j0) {
      out.push({ heard: span(before, a, i0, i1 - 1), term: span(after, b, j0, j1 - 1), at: j0 });
      return;
    }
    if (i1 === i0 && j1 === j0) return;
    // A word added or removed goes with the word before it, or after it at the line's start.
    if (i0 > 0 && j0 > 0) {
      out.push({
        heard: span(before, a, i0 - 1, i1 - 1),
        term: span(after, b, j0 - 1, j1 - 1),
        at: j0 - 1,
      });
    } else if (i1 < a.length && j1 < b.length) {
      out.push({ heard: span(before, a, i0, i1), term: span(after, b, j0, j1), at: j0 });
    }
  };
  let pi = 0;
  let pj = 0;
  for (const [i, j] of anchors) {
    gap(pi, i, pj, j);
    const from = before.slice((a[i] as Token).start, (a[i] as Token).end);
    const to = after.slice((b[j] as Token).start, (b[j] as Token).end);
    // The same word folded: an accent is a real spelling fix, a capital only when it makes a name.
    const accent = from.toLowerCase() !== to.toLowerCase();
    if (from !== to && (accent || nameCasing(from, to, j))) {
      out.push({ heard: from, term: to, at: j });
    }
    pi = i + 1;
    pj = j + 1;
  }
  gap(pi, a.length, pj, b.length);
  return out;
}

/**
 * Whether a pair teaches a term or rewords common words. `isDictionaryWord` takes a folded word;
 * without it only a digit or a name's capital makes a term.
 */
export function pairKind(p: FixPair, isDictionaryWord?: (word: string) => boolean): PairKind {
  const heard = tokenize(p.heard);
  const term = tokenize(p.term);
  if (term.length === 0 || term.length > MAX_PAIR_WORDS || heard.length > MAX_PAIR_WORDS) {
    return "rewording";
  }
  for (const [k, t] of term.entries()) {
    const raw = p.term.slice(t.start, t.end);
    if (/\p{N}/u.test(raw)) return "term";
    if (UPPER.test(raw) && (p.at + k > 0 || UPPER.test([...raw].slice(1).join("")))) return "term";
    if (isDictionaryWord && !isDictionaryWord(t.folded)) return "term";
  }
  return "rewording";
}
