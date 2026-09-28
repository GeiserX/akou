/**
 * From an edit to a learning candidate (docs/ux/DICTATION.md section 8.2, DC-L3). Pure: the text
 * akou inserted, the text the user left after fixing it, and what the engine said about each word
 * go in; the pairs worth asking about come out. Nothing here writes the vocabulary: a candidate is
 * only offered (the chip, DC-L4) until the user says Learn.
 *
 * 1. Both texts are NFC, compared in lower case with the original case kept, punctuation its own
 *    token.
 * 2. A word-level LCS diff; a deletion next to an insertion is a substitution, kept when each side
 *    has 1 to 3 words, so a two-word product name counts.
 * 3. Rejected: an edit that changed more than half the words (a rewrite), punctuation only, a
 *    number or a date, a fix under 3 characters, a pair already in the vocabulary or rejected, and
 *    a pair whose two sides are common words of the language ("why" to "what"). A change of case
 *    only is a replacement-only candidate, never a bias entry.
 * 4. A sound-alike score, `max(1 - lev(letters) / maxLen, 1 - lev(key) / maxLen)`, with the Double
 *    Metaphone key for English and a small Spanish key; both are tried when the language is
 *    neither. Proposed at 0.45, or 0.35 when the engine was unsure of the heard word (confidence
 *    under 0.5, or a second engine heard it differently).
 * 5. The audio check (`checkAudio`): the dictation decoded again with the fix as the only context
 *    term confirms the pair when the fix now stands where the heard form stood, and drops it
 *    otherwise. Only a local Qwen can run it (greedy Parakeet takes no context); without one the
 *    candidate is offered with `evidence: none`.
 */

import { doubleMetaphone } from "double-metaphone";
import { foldText } from "../vocab/correct.ts";
import type { LearnStatus } from "./events.ts";

/** The sound-alike score a pair needs. */
export const PROPOSE_AT = 0.45;
/** The score a pair needs when the engine was unsure of the heard word. */
export const PROPOSE_AT_UNSURE = 0.35;
/** A word the engine gave less confidence than this is one it was unsure of. */
export const LOW_CONFIDENCE = 0.5;
/** Words on each side of a substitution. */
export const MAX_HUNK_WORDS = 3;
/** An edit that changed more than this share of the words is a rewrite and teaches nothing. */
export const REWRITE_SHARE = 0.5;
/** A fix shorter than this, in letters and digits, is never learned. */
export const MIN_TERM_CHARS = 3;

export interface LearnInput {
  /** The text akou inserted. */
  inserted: string;
  /** The same text after the user fixed it. */
  edited: string;
  /** The engine's words for the inserted text, in order, where it gives them (Parakeet, Qwen). */
  words?: readonly { w: string; c: number }[];
  /** A second engine's text for the same audio, when two ran. */
  other?: string;
  /** The dictation's language, which picks the sound-alike key. */
  language: string | null;
  /** Is this lowercase, accent-folded word a common word of the language? */
  isCommonWord?: (word: string) => boolean;
  /** Is this pair in the vocabulary already? */
  known?: (heard: string, term: string) => boolean;
  /** Did the user say "Not a word" to this pair before? */
  rejected?: (heard: string, term: string) => boolean;
}

export interface Candidate {
  /** What the user wrote. */
  term: string;
  /** What akou inserted in its place. */
  heard: string;
  /** The sound-alike score, 0 to 1. */
  confidence: number;
  /** `audio`: a second decode with the fix as context heard it; `none`: no check ran. */
  evidence: "audio" | "none";
  /** A change of case only: learned as a replacement, never sent to the recognizer. */
  replacementOnly: boolean;
}

interface Tok {
  text: string;
  /** Lower case, for comparing. */
  key: string;
  start: number;
  end: number;
  word: boolean;
}

const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*|[^\s\p{L}\p{M}\p{N}]/gu;
const WORDISH = /[\p{L}\p{M}\p{N}]/u;

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  for (const m of s.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    out.push({
      text: m[0],
      key: m[0].toLowerCase(),
      start,
      end: start + m[0].length,
      word: WORDISH.test(m[0]),
    });
  }
  return out;
}

type Op =
  | { kind: "same"; a: number; b: number }
  | { kind: "del"; a: number }
  | { kind: "ins"; b: number };

/** The word-level LCS diff of two token lists, compared by key. */
function diff(a: readonly Tok[], b: readonly Tok[]): Op[] {
  const ka = a.map((t) => t.key);
  const kb = b.map((t) => t.key);
  const n = ka.length;
  const m = kb.length;
  // lcs(i, j): the longest common run of a[i..] and b[j..], row-major in one flat array.
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] as number;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        ka[i] === kb[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) ops.push({ kind: "same", a: i++, b: j++ });
    else if (at(i + 1, j) >= at(i, j + 1)) ops.push({ kind: "del", a: i++ });
    else ops.push({ kind: "ins", b: j++ });
  }
  while (i < n) ops.push({ kind: "del", a: i++ });
  while (j < m) ops.push({ kind: "ins", b: j++ });
  return ops;
}

interface Hunk {
  from: Tok[];
  to: Tok[];
}

/** Runs of changes between unchanged tokens, and each unchanged token whose case changed. */
function hunks(a: readonly Tok[], b: readonly Tok[]): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk = { from: [], to: [] };
  const flush = () => {
    if (cur.from.length > 0 || cur.to.length > 0) out.push(cur);
    cur = { from: [], to: [] };
  };
  for (const op of diff(a, b)) {
    if (op.kind === "same") {
      flush();
      const x = a[op.a] as Tok;
      const y = b[op.b] as Tok;
      if (x.text !== y.text) out.push({ from: [x], to: [y] });
    } else if (op.kind === "del") cur.from.push(a[op.a] as Tok);
    else cur.to.push(b[op.b] as Tok);
  }
  flush();
  return out;
}

/** The text of a hunk's side from its first word to its last, as written, or "" with no word. */
function span(s: string, toks: readonly Tok[]): string {
  const words = toks.filter((t) => t.word);
  if (words.length === 0) return "";
  return s.slice((words[0] as Tok).start, (words.at(-1) as Tok).end);
}

/** Letters and digits only, lower case and without accents. */
function letters(s: string): string {
  return foldText(s).replace(/[^\p{L}\p{N}]/gu, "");
}

export function levenshtein(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[y.length] as number;
}

function similarity(a: string, b: string): number {
  const max = Math.max([...a].length, [...b].length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

/**
 * A small Spanish sound key: b and v, ll and y, c before e or i, z and s sound alike, h is silent,
 * qu and a hard c are k, a soft g is j, and a doubled letter is one.
 */
export function spanishKey(s: string): string {
  const w = letters(s)
    .replace(/ch/g, "C")
    .replace(/ll/g, "y")
    .replace(/qu/g, "k")
    .replace(/gu(?=[ei])/g, "g")
    .replace(/g(?=[ei])/g, "j")
    .replace(/c(?=[ei])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/v/g, "b")
    .replace(/h/g, "")
    .replace(/x/g, "ks");
  return w.replace(/(.)\1+/g, "$1").toUpperCase();
}

/** The English sound key: the primary Double Metaphone code of the letters. */
export function englishKey(s: string): string {
  return doubleMetaphone(letters(s))[0];
}

/** How alike two spellings sound, 0 to 1: the better of the letters and the language's key. */
export function soundAlike(heard: string, term: string, language: string | null): number {
  const lang = (language ?? "").toLowerCase().split(/[-_]/)[0];
  const keys =
    lang === "en" ? [englishKey] : lang === "es" ? [spanishKey] : [englishKey, spanishKey];
  let best = similarity(letters(heard), letters(term));
  for (const key of keys) best = Math.max(best, similarity(key(heard), key(term)));
  return best;
}

/** The confidence the engine gave each word token of `text`, or undefined where it gave none. */
function confidences(
  text: readonly Tok[],
  words: readonly { w: string; c: number }[] | undefined,
): (number | undefined)[] {
  const flat: { key: string; c: number }[] = [];
  for (const w of words ?? [])
    for (const t of tokens(w.w)) if (t.word) flat.push({ key: t.key, c: w.c });
  let k = 0;
  return text.map((t) => {
    if (!t.word) return undefined;
    const w = flat[k++];
    return w && w.key === t.key ? w.c : undefined;
  });
}

function containsRun(hay: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0) return false;
  for (let i = 0; i + run.length <= hay.length; i++) {
    if (run.every((w, k) => hay[i + k] === w)) return true;
  }
  return false;
}

const wordKeys = (s: string) =>
  tokens(s)
    .filter((t) => t.word)
    .map((t) => t.key);

/** The candidates an edit yields before the audio check, each with `evidence: none`. */
export function candidates(input: LearnInput): Candidate[] {
  const a = tokens(input.inserted.normalize("NFC"));
  const b = tokens(input.edited.normalize("NFC"));
  const found = hunks(a, b);
  const wordsIn = a.filter((t) => t.word).length;
  const changed = found.reduce(
    (n, h) =>
      h.from.length === 1 && h.to.length === 1 && h.from[0]?.key === h.to[0]?.key
        ? n
        : n + Math.max(h.from.filter((t) => t.word).length, h.to.filter((t) => t.word).length),
    0,
  );
  if (wordsIn === 0 || changed / wordsIn > REWRITE_SHARE) return [];

  const conf = confidences(a, input.words);
  const other = input.other !== undefined ? wordKeys(input.other.normalize("NFC")) : undefined;
  const common = input.isCommonWord;
  const out: Candidate[] = [];
  for (const h of found) {
    const fromWords = h.from.filter((t) => t.word);
    const toWords = h.to.filter((t) => t.word);
    // A pure insertion or deletion, or punctuation only, is not a mishearing.
    if (fromWords.length === 0 || toWords.length === 0) continue;
    if (fromWords.length > MAX_HUNK_WORDS || toWords.length > MAX_HUNK_WORDS) continue;
    const heard = span(input.inserted.normalize("NFC"), h.from);
    const term = span(input.edited.normalize("NFC"), h.to);
    if (/\p{N}/u.test(heard) || /\p{N}/u.test(term)) continue;
    if ([...letters(term)].length < MIN_TERM_CHARS) continue;
    if (input.known?.(heard, term) || input.rejected?.(heard, term)) continue;
    const folded = (toks: readonly Tok[]) => toks.map((t) => foldText(t.text));
    if (common && folded(fromWords).every(common) && folded(toWords).every(common)) continue;
    if (heard.toLowerCase() === term.toLowerCase()) {
      out.push({ term, heard, confidence: 1, evidence: "none", replacementOnly: true });
      continue;
    }
    const unsure =
      fromWords.some((t) => {
        const c = conf[a.indexOf(t)];
        return c !== undefined && c < LOW_CONFIDENCE;
      }) ||
      (other !== undefined &&
        !containsRun(
          other,
          fromWords.map((t) => t.key),
        ));
    const score = soundAlike(heard, term, input.language);
    if (score < (unsure ? PROPOSE_AT_UNSURE : PROPOSE_AT)) continue;
    out.push({
      term,
      heard,
      confidence: Math.round(score * 1000) / 1000,
      evidence: "none",
      replacementOnly: false,
    });
  }
  return out;
}

/**
 * Decodes the dictation's whole audio again with these terms as the only context, and answers the
 * text. A local Qwen does it; no word times are needed.
 */
export type Redecode = (glossary: readonly string[]) => Promise<string>;

/**
 * The audio check (step 6): with a `redecode`, the pair is confirmed (`evidence: audio`) when the
 * second decode holds the fix and no longer the heard form, and dropped (null) otherwise. With
 * none, or when it fails, the candidate stands with `evidence: none`. A replacement-only candidate
 * is a change of case the audio cannot tell, so it is never checked.
 *
 * An answer that is the fix and nothing else is the recognizer reading its context aloud: a
 * candidate always comes from a longer dictation (an edit of more than half the words is a
 * rewrite), so the answer proves nothing either way and the candidate stands with `evidence: none`.
 */
export async function checkAudio(
  c: Candidate,
  redecode: Redecode | null,
): Promise<Candidate | null> {
  if (!redecode || c.replacementOnly) return { ...c, evidence: "none" };
  let text: string;
  try {
    text = await redecode([c.term]);
  } catch {
    return { ...c, evidence: "none" };
  }
  const got = wordKeys(text.normalize("NFC"));
  const term = wordKeys(c.term.normalize("NFC"));
  const heard = wordKeys(c.heard.normalize("NFC"));
  if (got.length === term.length && containsRun(got, term)) return { ...c, evidence: "none" };
  return containsRun(got, term) && !containsRun(got, heard) ? { ...c, evidence: "audio" } : null;
}

/** Every candidate of an edit, each through the audio check. */
export async function learn(input: LearnInput, redecode: Redecode | null): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const c of candidates(input)) {
    const checked = await checkAudio(c, redecode);
    if (checked) out.push(checked);
  }
  return out;
}

/** One pair's offers so far, from the dictation log (DC-L4). */
export interface PairHistory {
  /** How many times the same fix was proposed. */
  proposed: number;
  /** Not a word: never proposed again. */
  rejected: boolean;
}

/** The key of a pair: the same fix whatever its case. */
export function pairKey(heard: string, term: string): string {
  return `${heard.normalize("NFC").toLowerCase()}\u0000${term.normalize("NFC").toLowerCase()}`;
}

/** Every pair's history from the log's `dictation.learn` events, by `pairKey`. */
export function pairHistory(
  events: readonly { type: string; heard?: string; term?: string; status?: string }[],
): Map<string, PairHistory> {
  const out = new Map<string, PairHistory>();
  for (const e of events) {
    if (e.type !== "dictation.learn" || e.heard === undefined || e.term === undefined) continue;
    const k = pairKey(e.heard, e.term);
    const h = out.get(k) ?? { proposed: 0, rejected: false };
    if (e.status === "proposed") h.proposed++;
    if (e.status === "rejected") h.rejected = true;
    out.set(k, h);
  }
  return out;
}

/**
 * Whether a proposal is put to the user (DC-L4): the first time a fix is seen, and once more at
 * the third identical fix after the first was let go; never after Not a word. A learned pair never
 * gets here, since it is in the vocabulary.
 */
export function shouldAsk(h: PairHistory | undefined): boolean {
  if (!h) return true;
  return !h.rejected && (h.proposed === 0 || h.proposed === 2);
}

/**
 * One fix taught while dictating, as the words to review list it (DC-L5): the pair, its latest
 * status, the evidence it was offered with, and the dictation that last had it.
 */
export interface ReviewPair {
  term: string;
  heard: string;
  status: LearnStatus;
  evidence: "audio" | "none";
  /** The dictation whose `dictation.learn` last spoke of the pair. */
  id: string;
  /** Epoch ms of that event. */
  at: number;
}

/**
 * Every pair the dictation log's `dictation.learn` events name, at its latest status, newest
 * first: `proposed` and `ignored` still wait for an answer, `accepted` and `rejected` were given
 * one. A deleted dictation's events are gone from the log, and so are its pairs.
 *
 * With `known`, the vocabulary as it is now: an `accepted` pair it no longer holds (removed in the
 * editor) waits again as `ignored`, so it can be accepted once more.
 */
export function reviewPairs(
  events: readonly {
    type: string;
    id: string;
    t: number;
    term?: string;
    heard?: string;
    status?: string;
    evidence?: string;
  }[],
  known?: (heard: string, term: string) => boolean,
): ReviewPair[] {
  const out = new Map<string, ReviewPair>();
  for (const e of events) {
    if (e.type !== "dictation.learn" || e.term === undefined || e.heard === undefined) continue;
    const k = pairKey(e.heard, e.term);
    out.delete(k);
    out.set(k, {
      term: e.term,
      heard: e.heard,
      status: e.status as LearnStatus,
      evidence: e.evidence === "audio" ? "audio" : "none",
      id: e.id,
      at: e.t,
    });
  }
  const rows = [...out.values()].reverse();
  if (!known) return rows;
  return rows.map((p) =>
    p.status === "accepted" && !known(p.heard, p.term) ? { ...p, status: "ignored" } : p,
  );
}
