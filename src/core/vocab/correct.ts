/**
 * Read-time vocabulary correction (docs/DESIGN.md section 5.4, "Vocabulary, applied when reading").
 *
 * Rules, in the order they are tried at each word:
 * 1. A heard form matches as a whole word (or a whole run of words), case-insensitive and
 *    accent-folded. Call-scoped pairs are tried before file pairs, longer forms before shorter.
 * 2. A heard form that is a dictionary word, or 3 characters or shorter, is skipped unless the
 *    pair is call-scoped. Without a dictionary, akou cannot tell, so only call-scoped pairs apply.
 * 3. Terms without heard forms, and speaker names, are fuzzy-matched: Jaro-Winkler >= 0.92 on
 *    tokens of 4 or more characters. A dictionary word is never fuzzy-corrected, so without a
 *    dictionary there is no fuzzy matching at all. Each word of 4 or more characters in a speaker
 *    name is its own fuzzy term (`Anika Ruiz` corrects `Anikaa` to `Anika`). A vocabulary term of
 *    several words is not split: its words on their own are often ordinary words (`Visual
 *    Studio`), so such a term needs heard forms to correct anything.
 *
 * The raw text is never changed; the caller gets the corrected text, the annotated form for packs
 * and exports (`Anika (heard: "annika")`) and the list of corrections.
 */

export type RuleScope = "call" | "file" | "name";

export interface VocabRule {
  term: string;
  /** Mishearings to replace. Empty means the term is fuzzy-matched instead. */
  heard: readonly string[];
  /** `call` for a `vocab.add`, `file` for the vocabulary files, `name` for a speaker name. */
  scope: RuleScope;
  /** When set, the rule applies only to these segment ids. */
  segs?: readonly string[];
}

export interface CorrectOptions {
  /** Id of the segment being corrected, for rules restricted to some segments. */
  segId?: string;
  /** Is this lowercase, accent-folded word a dictionary word? */
  isDictionaryWord?: (word: string) => boolean;
}

export interface Correction {
  term: string;
  /** The raw text that was replaced, exactly as the recognizer wrote it. */
  heard: string;
  /** Span in the raw text. */
  start: number;
  end: number;
  kind: "heard" | "fuzzy";
  scope: RuleScope;
}

export interface CorrectResult {
  /** Corrected text: the term in place of each mishearing. */
  text: string;
  /** Corrected text with each replacement shown as `Term (heard: "x")`, for packs and exports. */
  annotated: string;
  corrections: Correction[];
}

export const FUZZY_THRESHOLD = 0.92;
export const FUZZY_MIN_CHARS = 4;
/** Heard forms this short are skipped unless call-scoped. */
export const SHORT_FORM_MAX = 3;

export interface Token {
  /** Folded form: lowercase, accents removed. */
  folded: string;
  start: number;
  end: number;
}

/**
 * Combining marks that sit on a Latin, Greek or Cyrillic letter are accents: dropping them keeps
 * the word. In other scripts a mark often is the word: Devanagari vowel signs, for example, tell
 * "किताब" (book) from "कतब", so those marks are kept.
 */
const ACCENT_ON_ALPHABET = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu;

/**
 * Lowercase and strip accents, so "Café" and "cafe" compare equal. Only marks on Latin, Greek and
 * Cyrillic letters are stripped; marks in other scripts carry meaning and stay.
 */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(ACCENT_ON_ALPHABET, "$1").toLowerCase().normalize("NFC");
}

/** Marks are part of a word: decomposed accents (NFD) and Indic vowel signs must not split it. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/** Maximal runs of letters, combining marks and digits; everything else separates words. */
export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(WORD)) {
    const start = m.index ?? 0;
    out.push({ folded: foldText(m[0]), start, end: start + m[0].length });
  }
  return out;
}

function charLength(s: string): number {
  return [...s].length;
}

/** Jaro-Winkler similarity over code points, prefix scale 0.1, prefix up to 4. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const s1 = [...a];
  const s2 = [...b];
  if (s1.length === 0 || s2.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array<boolean>(s1.length).fill(false);
  const m2 = new Array<boolean>(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true;
      m2[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro =
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < s1.length && prefix < s2.length && s1[prefix] === s2[prefix]) {
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Whether a heard form may be applied at read time. Call-scoped pairs always may. Any other pair
 * is skipped when the form is 3 characters or shorter, when every word of it is a dictionary word,
 * or when there is no dictionary to ask.
 */
export function heardFormApplies(
  form: string,
  scope: RuleScope,
  isDictionaryWord: ((word: string) => boolean) | undefined,
): boolean {
  const words = tokenize(form).map((t) => t.folded);
  if (words.length === 0) return false;
  if (scope === "call") return true;
  if (charLength(words.join(" ")) <= SHORT_FORM_MAX) return false;
  if (!isDictionaryWord) return false;
  return !words.every((w) => isDictionaryWord(w));
}

interface Matcher {
  words: string[];
  term: string;
  scope: RuleScope;
}

interface FuzzyTerm {
  folded: string;
  term: string;
  scope: RuleScope;
}

const SCOPE_RANK: Record<RuleScope, number> = { call: 0, file: 1, name: 2 };

function ruleApplies(rule: VocabRule, segId: string | undefined): boolean {
  if (rule.term.trim() === "") return false;
  if (!rule.segs) return true;
  return segId !== undefined && rule.segs.includes(segId);
}

export function correctText(
  raw: string,
  rules: readonly VocabRule[],
  opts: CorrectOptions = {},
): CorrectResult {
  const tokens = tokenize(raw);
  const isDict = opts.isDictionaryWord;
  const matchers: Matcher[] = [];
  const fuzzy: FuzzyTerm[] = [];

  for (const rule of rules) {
    if (!ruleApplies(rule, opts.segId)) continue;
    const termKey = tokenize(rule.term)
      .map((t) => t.folded)
      .join(" ");
    if (rule.heard.length === 0 || rule.scope === "name") {
      // Fuzzy matching is per token. A name contributes each of its words; a vocabulary term
      // takes part only when it is a single word.
      if (rule.scope === "name") {
        for (const t of tokenize(rule.term)) {
          if (charLength(t.folded) < FUZZY_MIN_CHARS) continue;
          fuzzy.push({ folded: t.folded, term: rule.term.slice(t.start, t.end), scope: "name" });
        }
      } else if (!termKey.includes(" ")) {
        fuzzy.push({ folded: foldText(rule.term), term: rule.term, scope: rule.scope });
      }
      continue;
    }
    for (const form of rule.heard) {
      if (!heardFormApplies(form, rule.scope, isDict)) continue;
      const words = tokenize(form).map((t) => t.folded);
      // A heard form equal to the term (apart from case or accents) corrects nothing.
      if (words.join(" ") === termKey) continue;
      matchers.push({ words, term: rule.term, scope: rule.scope });
    }
  }
  matchers.sort(
    (a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || b.words.length - a.words.length,
  );

  const corrections: Correction[] = [];
  let i = 0;
  while (i < tokens.length) {
    const hit = matchers.find((m) => matchesAt(tokens, i, m.words));
    if (hit) {
      const first = tokens[i] as Token;
      const last = tokens[i + hit.words.length - 1] as Token;
      corrections.push({
        term: hit.term,
        heard: raw.slice(first.start, last.end),
        start: first.start,
        end: last.end,
        kind: "heard",
        scope: hit.scope,
      });
      i += hit.words.length;
      continue;
    }
    const tok = tokens[i] as Token;
    const best = isDict ? bestFuzzy(tok.folded, fuzzy, isDict) : undefined;
    if (best) {
      corrections.push({
        term: best.term,
        heard: raw.slice(tok.start, tok.end),
        start: tok.start,
        end: tok.end,
        kind: "fuzzy",
        scope: best.scope,
      });
    }
    i++;
  }

  return { ...render(raw, corrections), corrections };
}

function matchesAt(tokens: readonly Token[], i: number, words: readonly string[]): boolean {
  if (i + words.length > tokens.length) return false;
  for (let k = 0; k < words.length; k++) {
    if (tokens[i + k]?.folded !== words[k]) return false;
  }
  return true;
}

function bestFuzzy(
  folded: string,
  terms: readonly FuzzyTerm[],
  isDict: (word: string) => boolean,
): FuzzyTerm | undefined {
  if (terms.length === 0 || charLength(folded) < FUZZY_MIN_CHARS) return undefined;
  if (isDict(folded)) return undefined;
  let best: FuzzyTerm | undefined;
  let bestScore = FUZZY_THRESHOLD;
  for (const t of terms) {
    // Already the term apart from case or accents: nothing was misheard.
    if (t.folded === folded) return undefined;
    const score = jaroWinkler(folded, t.folded);
    if (score >= bestScore && (best === undefined || score > bestScore)) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

function render(
  raw: string,
  corrections: readonly Correction[],
): { text: string; annotated: string } {
  let text = "";
  let annotated = "";
  let at = 0;
  for (const c of corrections) {
    const between = raw.slice(at, c.start);
    text += between + c.term;
    annotated += `${between}${formatCorrection(c.term, c.heard)}`;
    at = c.end;
  }
  text += raw.slice(at);
  annotated += raw.slice(at);
  return { text, annotated };
}

/** The one rendering of a correction for packs and exports. */
export function formatCorrection(term: string, heard: string): string {
  return `${term} (heard: ${JSON.stringify(heard)})`;
}
