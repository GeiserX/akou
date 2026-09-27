/**
 * Spoken punctuation (docs/ux/DICTATION.md DC-S6), behind `dictation.spokenPunctuation`, which is
 * off until the DC-L7 nightly measures it. Pure: the text to insert, the engine's words and the
 * languages go in, the text with the spoken marks replaced comes out. History keeps the raw text.
 *
 * "punto", "coma", "period" and "point" are ordinary words ("ese es el punto", "the period
 * ended"), so a phrase from the list is replaced only when it stands alone:
 *
 * - With word times (Parakeet), when there is a pause of at least `PAUSE_SECONDS` before it and
 *   one after it, or it ends the utterance. A phrase that opens the utterance is never replaced:
 *   there is nothing for the mark to follow.
 * - With no word times (Qwen, the remote), only at the very end of the utterance.
 *
 * The text may have been changed by the vocabulary since the decode, so a phrase is matched in the
 * text by its place among the same phrase's occurrences in the words; when the two counts differ
 * that phrase is left alone. Matching ignores case, accents and the engine's own punctuation.
 */

/** Phrase to mark, by language: `comma` → `,`, `new line` → a newline. */
export type PunctuationLists = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The shipped lists; `dictation-punctuation.json` in the config folder replaces a language's. */
export const SPOKEN_PUNCTUATION: PunctuationLists = {
  en: {
    comma: ",",
    period: ".",
    "question mark": "?",
    "new line": "\n",
    "new paragraph": "\n\n",
  },
  es: {
    coma: ",",
    punto: ".",
    "signo de interrogación": "?",
    "nueva línea": "\n",
    "nuevo párrafo": "\n\n",
  },
};

/** The silence around a phrase that makes it a mark rather than a word, seconds. */
export const PAUSE_SECONDS = 0.3;

/** Word times are sums of floats: a gap of exactly the pause may come out a hair under it. */
const EPSILON = 1e-6;

export interface TimedWord {
  w: string;
  s: number;
  e: number;
}

interface Tok {
  sep: string;
  lead: string;
  core: string;
  trail: string;
}

const SPLIT = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su;
const MARKS = /[,.;:!?…]+$/u;

/** Lower case, no accents, letters and digits only: how a word is compared. */
function norm(w: string): string {
  return w
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/(\s*)(\S+)/g)) {
    const [, lead = "", core = "", trail = ""] = SPLIT.exec(m[2] as string) ?? [];
    out.push({ sep: m[1] as string, lead, core, trail });
  }
  return out;
}

const base = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0] as string;

/** The phrases that apply, longest first, each as its normalized words. */
function phrases(
  languages: readonly string[],
  lists: PunctuationLists,
): { words: string[]; mark: string }[] {
  const langs = [...new Set(languages.map(base))].filter((l) => lists[l]);
  // No language known: every list applies. A known language with no list replaces nothing.
  const use = languages.length === 0 ? Object.keys(lists) : langs;
  const out = use.flatMap((l) =>
    Object.entries(lists[l] ?? {}).map(([p, mark]) => ({
      words: p.split(/\s+/).map(norm).filter(Boolean),
      mark,
    })),
  );
  return out.filter((p) => p.words.length > 0).sort((a, b) => b.words.length - a.words.length);
}

/** Where `phrase` occurs in `seq`, left to right, never overlapping one taken by a longer phrase. */
function occurrences(
  seq: readonly string[],
  phrase: readonly string[],
  taken: Set<number>,
): number[] {
  const at: number[] = [];
  for (let i = 0; i + phrase.length <= seq.length; i++) {
    if (phrase.every((p, k) => seq[i + k] === p && !taken.has(i + k))) {
      at.push(i);
      i += phrase.length - 1;
    }
  }
  return at;
}

/**
 * `text` with the spoken marks that stand alone replaced. `words` are the engine's timed words
 * (empty when it gives none); `languages` the dictation's language, or the ones it may be in.
 */
export function spokenPunctuation(
  text: string,
  words: readonly TimedWord[],
  languages: readonly string[],
  lists: PunctuationLists = SPOKEN_PUNCTUATION,
): string {
  const toks = tokens(text);
  const seq = toks.map((t) => norm(t.core));
  const wseq = words.map((w) => norm(w.w));
  // Replacements by the index of their first token: [end token, mark].
  const hits = new Map<number, [number, string]>();
  const taken = new Set<number>();
  const wtaken = new Set<number>();
  for (const p of phrases(languages, lists)) {
    const inText = occurrences(seq, p.words, taken);
    const n = p.words.length;
    for (const i of inText) for (let k = 0; k < n; k++) taken.add(i + k);
    let chosen: number[];
    if (words.length === 0) {
      // No times: only a phrase that ends the utterance, after at least one word.
      const last = inText.at(-1);
      chosen = last !== undefined && last > 0 && last + n === seq.length ? [last] : [];
    } else {
      const inWords = occurrences(wseq, p.words, wtaken);
      for (const i of inWords) for (let k = 0; k < n; k++) wtaken.add(i + k);
      if (inWords.length !== inText.length) continue;
      chosen = inText.filter((_, k) => {
        const i = inWords[k] as number;
        const before = words[i - 1];
        const after = words[i + n];
        const first = words[i] as TimedWord;
        const lastW = words[i + n - 1] as TimedWord;
        return (
          before !== undefined &&
          first.s - before.e >= PAUSE_SECONDS - EPSILON &&
          (after === undefined || after.s - lastW.e >= PAUSE_SECONDS - EPSILON)
        );
      });
    }
    for (const i of chosen) hits.set(i, [i + n, p.mark]);
  }
  if (hits.size === 0) return text;

  const out: Tok[] = [];
  let pendingSep: string | null = null;
  let capitalize = false;
  for (let i = 0; i < toks.length; i++) {
    const hit = hits.get(i);
    if (hit) {
      const [end, mark] = hit;
      const prev = out.at(-1);
      if (mark.includes("\n")) {
        pendingSep = mark;
      } else if (prev) {
        prev.trail = prev.trail.replace(MARKS, "") + mark;
      }
      capitalize = mark !== ",";
      i = end - 1;
      continue;
    }
    const t = { ...(toks[i] as Tok) };
    if (pendingSep !== null) t.sep = pendingSep;
    if (capitalize) t.core = t.core.charAt(0).toUpperCase() + t.core.slice(1);
    pendingSep = null;
    capitalize = false;
    out.push(t);
  }
  const body = out.map((t) => `${t.sep}${t.lead}${t.core}${t.trail}`).join("");
  // A line break that ends the utterance is kept: the user asked for it.
  return (pendingSep !== null ? body + pendingSep : body).replace(/^\s+/, "");
}
