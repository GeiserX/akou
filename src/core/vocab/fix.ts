/**
 * Fix once, applied everywhere (docs/DESIGN.md section 5.4, "A fix on a line"): what one fixed line
 * teaches akou.
 *
 * - `fixPairs(before, after)` aligns the words of the line as it read with the words the person
 *   wrote, and returns each change as a pair: what was heard, what it should read.
 *   - Only real changes count. Punctuation is not a word, so an edit of punctuation alone gives no
 *     pair. A change of case alone gives one only when it adds a capital a sentence does not
 *     explain: never the capital at the start of a line or after `.`, `?` or `!`, unless the word
 *     has a capital inside it too (`iPhone`).
 *   - A word glued to the next by punctuation with no space (`Next.js`, `GPT-4`) is one word, so
 *     `next js` to `Next.js` is one pair. Neighbouring words that each only change case join too
 *     (`tech lead` to `Tech Lead`).
 *   - A word added or removed is an `insert` or `delete` pair with the word before it (`going` to
 *     `going to`), or the word after it at the line's start. A repeated word dropped (`the the`) is
 *     its own `delete` pair, so it never joins the replacement next to it.
 * - `pairKind` says what a pair is: a `term` a recognizer can be taught (a name, a product, a
 *   project, a jargon word), or a `rewording` that only this line needs.
 * - `spreads` says whether a term's heard form is safe to correct on every line of the call: a
 *   common word (`mark`, `go`) is not, so its fix stays on its line.
 *
 * Words are matched as whole words, case-insensitive and accent-folded (`tokenize`), so a pair
 * never reaches inside a longer word.
 */

import { SHORT_FORM_MAX, type Token, tokenize } from "./correct.ts";

export type PairOp = "replace" | "insert" | "delete";

export interface FixPair {
  /** The words as the line read, exactly as written there. */
  heard: string;
  /** The words as the person wrote them. */
  term: string;
  /** Index of the pair's first word in the fixed line: 0 is the start of the line. */
  at: number;
  /** Index of the pair's first word in the line as it read. */
  from: number;
  op: PairOp;
  /** An `insert`: the words the person added, the only part of the pair that can be a term. */
  added?: string;
  /** The first word of the term (of `added` for an insert) starts a sentence. */
  lead: boolean;
}

export type PairKind = "term" | "rewording";

/** A pair longer than this, on either side, is a rewording: no recognizer is taught a sentence. */
export const MAX_PAIR_WORDS = 4;

type IsWord = (word: string) => boolean;

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
const LOWER = /\p{Ll}/u;
const LETTER = /\p{L}/u;
/** What ends a sentence, or opens one in Spanish. */
const SENTENCE_MARK = /[.?!…¿¡]/u;

const tail = (w: string) => [...w].slice(1).join("");
/** A capital inside a word that also has small letters: `iPhone`, `GitHub`, not `OK`. */
const innerCapital = (w: string) => UPPER.test(tail(w)) && LOWER.test(w);
const allCaps = (w: string) => !LOWER.test(w) && UPPER.test(w);

/** Whether token `k` of `text` starts a sentence: the line's first word, or one after `.?!`. */
function sentenceStart(text: string, tokens: readonly Token[], k: number): boolean {
  if (k <= 0) return true;
  return SENTENCE_MARK.test(text.slice((tokens[k - 1] as Token).end, (tokens[k] as Token).start));
}

/** A change of case that adds a capital the sentence does not explain. */
function nameCasing(from: string, to: string, lead: boolean): boolean {
  if (from.toLowerCase() !== to.toLowerCase()) return false;
  const capitals = (s: string) => [...s].filter((c) => UPPER.test(c)).length;
  if (capitals(to) <= capitals(from)) return false;
  return !lead || UPPER.test(tail(to));
}

function span(text: string, tokens: readonly Token[], from: number, to: number): string {
  return text.slice((tokens[from] as Token).start, (tokens[to] as Token).end);
}

/** A change between the two lines: words `[i0, i1)` as heard became `[j0, j1)` as written. */
interface Edit {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
  /** Aligned words that changed spelling or case, rather than a gap between aligned words. */
  aligned: boolean;
}

function union(x: Edit, y: Edit): Edit {
  return {
    i0: Math.min(x.i0, y.i0),
    i1: Math.max(x.i1, y.i1),
    j0: Math.min(x.j0, y.j0),
    j1: Math.max(x.j1, y.j1),
    aligned: x.aligned && y.aligned,
  };
}

/** Folds `e` into the edits it overlaps on either side. */
function absorb(edits: Edit[], e: Edit): Edit[] {
  let merged = e;
  const rest: Edit[] = [];
  for (const x of edits) {
    const overlaps =
      (x.j0 < merged.j1 && x.j1 > merged.j0) ||
      (x.i0 < merged.i1 && x.i1 > merged.i0) ||
      (x.j0 === x.j1 && x.j0 > merged.j0 && x.j0 < merged.j1);
    if (overlaps) merged = union(merged, x);
    else rest.push(x);
  }
  rest.push(merged);
  return rest.sort((p, q) => p.j0 - q.j0 || p.i0 - q.i0);
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
  let edits: Edit[] = [];
  const aOf = new Map<number, number>();
  let pi = 0;
  let pj = 0;
  for (const [i, j] of anchors) {
    if (i > pi || j > pj) edits.push({ i0: pi, i1: i, j0: pj, j1: j, aligned: false });
    aOf.set(j, i);
    const from = span(before, a, i, i);
    const to = span(after, b, j, j);
    // The same word folded: an accent is a real spelling fix, a capital only when it makes a name.
    const accent = from.toLowerCase() !== to.toLowerCase();
    if (from !== to && (accent || nameCasing(from, to, sentenceStart(after, b, j)))) {
      edits.push({ i0: i, i1: i + 1, j0: j, j1: j + 1, aligned: true });
    }
    pi = i + 1;
    pj = j + 1;
  }
  if (pi < a.length || pj < b.length) {
    edits.push({ i0: pi, i1: a.length, j0: pj, j1: b.length, aligned: false });
  }

  // A word glued by punctuation with no space (`Next.js`, `GPT-4`) is one word: a change to any
  // part of it, or to the glue, is a change of the whole. An apostrophe is not glue (`Vercel's`).
  const glued = (k: number) => {
    const sep = after.slice((b[k - 1] as Token).end, (b[k] as Token).start);
    return sep !== "" && !/\s/u.test(sep) && !/^['’]$/u.test(sep);
  };
  for (let c0 = 0; c0 < b.length; ) {
    let c1 = c0 + 1;
    while (c1 < b.length && glued(c1)) c1++;
    if (c1 - c0 >= 2) {
      const ids: number[] = [];
      for (let k = c0; k < c1; k++) {
        const i = aOf.get(k);
        if (i !== undefined) ids.push(i);
      }
      const whole =
        ids.length === c1 - c0 && ids.every((i, k) => k === 0 || i === (ids[k - 1] as number) + 1);
      if (whole) {
        const d0 = ids[0] as number;
        const d1 = (ids.at(-1) as number) + 1;
        if (span(before, a, d0, d1 - 1) !== span(after, b, c0, c1 - 1)) {
          edits = absorb(edits, { i0: d0, i1: d1, j0: c0, j1: c1, aligned: true });
        }
      } else if (edits.some((x) => x.j0 < c1 && x.j1 > c0)) {
        const i0 = Math.min(
          ...ids,
          ...edits.filter((x) => x.j0 < c1 && x.j1 > c0).map((x) => x.i0),
        );
        const i1 = Math.max(
          ...ids.map((i) => i + 1),
          ...edits.filter((x) => x.j0 < c1 && x.j1 > c0).map((x) => x.i1),
        );
        edits = absorb(edits, { i0, i1, j0: c0, j1: c1, aligned: false });
      }
    }
    c0 = c1;
  }

  // Neighbouring words that each changed in place join: `tech lead` to `Tech Lead`.
  const joined: Edit[] = [];
  for (const e of edits) {
    const prev = joined.at(-1);
    if (
      prev?.aligned &&
      e.aligned &&
      prev.i1 === e.i0 &&
      prev.j1 === e.j0 &&
      /^\s+$/u.test(after.slice((b[prev.j1 - 1] as Token).end, (b[e.j0] as Token).start))
    ) {
      joined[joined.length - 1] = union(prev, e);
    } else joined.push(e);
  }

  const out: FixPair[] = [];
  const lead = (j: number) => sentenceStart(after, b, j);
  for (const e of joined) {
    let { i0 } = e;
    const { i1, j0, j1 } = e;
    if (i1 > i0 && j1 > j0) {
      // A repeated word dropped next to a replacement (`the the versal` to `the Vercel`) is its
      // own pair, so the replacement's heard form is only `versal`.
      while (!e.aligned && i1 - i0 > j1 - j0 && i0 > 0 && j0 > 0) {
        if ((a[i0] as Token).folded !== (a[i0 - 1] as Token).folded) break;
        out.push({
          heard: span(before, a, i0 - 1, i0),
          term: span(after, b, j0 - 1, j0 - 1),
          at: j0 - 1,
          from: i0 - 1,
          op: "delete",
          lead: lead(j0 - 1),
        });
        i0++;
      }
      out.push({
        heard: span(before, a, i0, i1 - 1),
        term: span(after, b, j0, j1 - 1),
        at: j0,
        from: i0,
        op: "replace",
        lead: lead(j0),
      });
      continue;
    }
    const op: PairOp = j1 > j0 ? "insert" : "delete";
    const added = op === "insert" ? { added: span(after, b, j0, j1 - 1), lead: lead(j0) } : null;
    // A word added or removed goes with the word before it, or after it at the line's start.
    if (i0 > 0 && j0 > 0) {
      out.push({
        heard: span(before, a, i0 - 1, i1 - 1),
        term: span(after, b, j0 - 1, j1 - 1),
        at: j0 - 1,
        from: i0 - 1,
        op,
        lead: lead(j0 - 1),
        ...added,
      });
    } else if (i1 < a.length && j1 < b.length) {
      out.push({
        heard: span(before, a, i0, i1),
        term: span(after, b, j0, j1),
        at: j0,
        from: i0,
        op,
        lead: lead(j0),
        ...added,
      });
    }
  }
  return out;
}

/**
 * The start offsets of the words of `before` that `after` writes back exactly as they were, case
 * included: the words a person left, or put back, as heard.
 */
export function keptWords(before: string, after: string): Set<number> {
  const a = tokenize(before);
  const b = tokenize(after);
  const out = new Set<number>();
  for (const [i, j] of align(
    a.map((t) => t.folded),
    b.map((t) => t.folded),
  )) {
    if (span(before, a, i, i) === span(after, b, j, j)) out.add((a[i] as Token).start);
  }
  return out;
}

/** The pair changes only case or accents: `vercel` to `Vercel`, `next js` to `Next.js`. */
export function sameWords(p: Pick<FixPair, "heard" | "term">): boolean {
  const f = (s: string) =>
    tokenize(s)
      .map((t) => t.folded)
      .join(" ");
  return f(p.heard) === f(p.term);
}

/**
 * Whether a pair teaches a term or rewords common words. `isDictionaryWord` takes a folded word.
 *
 * With a dictionary, a term has a word the dictionary does not know (`Vercel`, `GPT`), a capital
 * inside a word (`iPhone`), or, when its spelling changed, a capital a sentence does not explain
 * on a word not all in capitals (`mark` to `Marc`). A change of case alone on a dictionary word
 * (`go` to `Go`, `will` to `Will`), capitals on a common word (`okay` to `OK`), digits alone
 * (`three` to `3`) and removed words are rewordings. Without a dictionary, akou cannot tell a
 * common word, so a digit next to letters or any capital a sentence does not explain makes a term.
 */
export function pairKind(p: FixPair, isDictionaryWord?: IsWord): PairKind {
  if (p.op === "delete") return "rewording";
  const text = p.op === "insert" ? (p.added ?? "") : p.term;
  const term = tokenize(text);
  const heard = tokenize(p.heard);
  if (term.length === 0 || term.length > MAX_PAIR_WORDS || heard.length > MAX_PAIR_WORDS) {
    return "rewording";
  }
  if (!LETTER.test(text)) return "rewording";
  const caseOnly = p.op === "replace" && sameWords(p);
  for (const [k, t] of term.entries()) {
    const w = text.slice(t.start, t.end);
    const lead = k === 0 ? p.lead : sentenceStart(text, term, k);
    if (innerCapital(w)) return "term";
    if (isDictionaryWord) {
      if (LETTER.test(w) && !isDictionaryWord(t.folded)) return "term";
      if (!caseOnly && !lead && UPPER.test(w) && !allCaps(w)) return "term";
    } else {
      if (/\p{N}/u.test(w) && LETTER.test(w)) return "term";
      if (!lead && UPPER.test(w)) return "term";
    }
  }
  return "rewording";
}

/**
 * Whether a term's heard form may be corrected on every line of the call, not only the fixed one.
 * Yes for a run of words (`verse all`), a change of case or accents alone of a term (only that
 * exact spelling is corrected: `vercel`), and a single word longer than 3 characters the
 * dictionary does not know (`versal`). No for a common word (`mark` to `Marc`): the other lines
 * that say `mark` most likely mean it.
 */
export function spreads(p: FixPair, isDictionaryWord?: IsWord): boolean {
  const heard = tokenize(p.heard);
  if (heard.length === 0) return false;
  if (heard.length >= 2) return true;
  if (sameWords(p)) return true;
  const w = heard[0] as Token;
  if ([...w.folded].length <= SHORT_FORM_MAX) return false;
  return !isDictionaryWord?.(w.folded);
}
