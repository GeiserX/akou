/**
 * The biasing gate of dictation (docs/ux/DICTATION.md DC-L7): does sending the learned words to
 * Qwen3-ASR as context, wrapped as `Technical terms: A, B, C.`, write more of them right without
 * writing them where they were not said? Run as the `biasing` stage of `scripts/eval/nightly.ts`
 * over FLEURS (public, CC-BY-4.0), which writes `docs/gates/dictation-biasing.json`.
 *
 * Every clip is decoded once per setting: no context (the baseline), the wrapped list at 10 and at
 * 24 terms (the cap the decoder and the remote route take), and the positive control. A clip's list
 * holds, in a fixed shuffled order:
 *
 * - its own terms: the proper nouns of its reference (capitalised, not opening a sentence) and its
 *   rare words (not in the language's word list). A term the answer writes is a hit.
 * - sound-alike names: a common word of the clip respelled as a name that sounds the same and is no
 *   word (`carry` as `Karry`), the learned word that could take a real word's place.
 * - distractors: other clips' terms, to fill the list.
 *
 * Generated silence and noise clips get distractors only. A listed term the answer writes that the
 * reference does not hold is a false insertion. The answer scored is the one the app inserts: one
 * that echoes the context (DC-E6) is decoded again with none. The ship rule at 24: more hits than
 * the baseline, and no more insertions. The control, the list said to be in the audio and repeated
 * with the clip's sentence carrying its sound-alike names, must break the insertion ceiling, or the
 * gate cannot see an insertion and fails.
 */

import { CONTEXT_WRAPPER } from "../../src/core/dictation/echo.ts";
import { englishKey, spanishKey } from "../../src/core/dictation/learn.ts";
import { normalizeText } from "./score.ts";

/** The list sizes the gate decodes at; the last is the default cap (`dictation.glossaryMax`). */
export const BIASING_SIZES = [10, 24] as const;

/** One clip of the gate: its reference, and the terms it was given. */
export interface BiasClip {
  id: string;
  lang: "en" | "es";
  /** The raw reference with its case; empty for silence and noise. */
  ref: string;
  /** Its own terms: hits when written. */
  terms: string[];
  /** Sound-alike names of its common words: insertions when written. */
  soundAlikes: string[];
}

/** The words of `s` as the scorer counts them. */
const toks = (s: string) => normalizeText(s);

/** Whether `term`'s words appear in `text`, in order, as whole words. */
export function holds(text: string, term: string): boolean {
  const hay = toks(text);
  const run = toks(term);
  if (run.length === 0) return false;
  for (let i = 0; i + run.length <= hay.length; i++) {
    if (run.every((w, k) => hay[i + k] === w)) return true;
  }
  return false;
}

/**
 * A reference's own terms: capitalised words that do not open a sentence (runs of them as one
 * name, "New York"), and words of four letters or more that `common` does not hold.
 */
export function ownTerms(ref: string, common: (w: string) => boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  };
  const words = ref.match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*|[.!?]/gu) ?? [];
  let opening = true;
  let name: string[] = [];
  const endName = () => {
    if (name.length > 0) add(name.join(" "));
    name = [];
  };
  for (const w of words) {
    if (/^[.!?]$/.test(w)) {
      endName();
      opening = true;
      continue;
    }
    const capital = /^\p{Lu}/u.test(w);
    if (capital && !opening && w.length >= 2 && w !== "I") name.push(w);
    else {
      endName();
      if (!capital && w.length >= 4 && !common(w.toLowerCase())) add(w);
    }
    opening = false;
  }
  endName();
  return out;
}

/** Spellings that may sound like `w`, in the order they are tried. */
function respellings(w: string, lang: "en" | "es"): string[] {
  const rules: [RegExp, string][] =
    lang === "en"
      ? [
          [/^c(?=[aou])/, "k"],
          [/c(?=[aou])/, "k"],
          [/ph/, "f"],
          [/^f/, "ph"],
          [/ck/, "k"],
          [/ee/, "ea"],
          [/ea/, "ee"],
          [/y$/, "ie"],
          [/ie$/, "y"],
          [/s(?=[aeiouy]|$)/, "z"],
          [/z/, "s"],
          [/k/, "c"],
          [/([bdglmnprt])\1/, "$1"],
        ]
      : [
          [/v/, "b"],
          [/b/, "v"],
          [/ll/, "y"],
          [/y(?=[aeiou])/, "ll"],
          [/c(?=[ei])/, "z"],
          [/z/, "s"],
          [/s/, "z"],
          [/qu(?=[ei])/, "k"],
          [/^(?=[aeiou])/, "h"],
          [/^h/, ""],
        ];
  const out: string[] = [];
  for (const [re, by] of rules) {
    const r = w.replace(re, by);
    if (r !== w && !out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * A name that sounds like the common word `w` and is no word of `common`: `w` respelled, with the
 * same sound key as `w` (Double Metaphone in English, the Spanish key in Spanish) and capitalised.
 * Null when no respelling keeps the sound.
 */
export function soundAlikeName(
  w: string,
  lang: "en" | "es",
  common: (w: string) => boolean,
): string | null {
  const key = lang === "en" ? englishKey : spanishKey;
  const want = key(w);
  for (const r of respellings(w.toLowerCase(), lang)) {
    if (r.length < 3 || common(r) || key(r) !== want) continue;
    return r[0]?.toUpperCase() + r.slice(1);
  }
  return null;
}

/** A small seeded generator (mulberry32), so every night builds the same lists. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Clip `c`'s list of `size` terms: its own terms and sound-alikes first (at most a third of the
 * list each), then distractors from `pool` that `c`'s reference does not hold, shuffled by `seed`.
 * The 24-term list holds the 10-term one.
 */
export function listFor(
  c: BiasClip,
  size: number,
  pool: readonly string[],
  seed: number,
): string[] {
  const third = Math.max(1, Math.floor(size / 3));
  const picked = [...c.terms.slice(0, third), ...c.soundAlikes.slice(0, third)];
  const seen = new Set(picked.map((t) => t.toLowerCase()));
  const draw = rng(seed);
  const order = pool.map((t) => ({ t, k: draw() })).sort((a, b) => a.k - b.k);
  for (const { t } of order) {
    if (picked.length >= size) break;
    if (seen.has(t.toLowerCase()) || holds(c.ref, t)) continue;
    seen.add(t.toLowerCase());
    picked.push(t);
  }
  const shuffle = rng(seed ^ size);
  return picked
    .map((t) => ({ t, k: shuffle() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);
}

/** What one setting scored over the gate's clips. */
export interface BiasScore {
  /** Own terms written. */
  hits: number;
  /** Own terms listed. */
  terms: number;
  /** Listed terms written where the reference does not hold them, over every clip. */
  insertions: number;
  /** Of those, sound-alike names on speech clips. */
  soundAlikeInsertions: number;
  /** Of those, on silence and noise. */
  noiseInsertions: number;
  /** Answers that echoed the context, out of `answers`. */
  echoes: number;
  answers: number;
  /** Each insertion as `<clip id>: <term>`, so a reader can check it against the clip. */
  inserted: string[];
}

/**
 * Scores one setting. `answers` holds each clip's inserted text, and `listed` the list each clip
 * was scored against (its 24-term list for the baseline, so a term the engine writes unprompted
 * counts against the baseline as it would against the list).
 */
export function score(
  clips: readonly BiasClip[],
  answers: readonly string[],
  listed: readonly (readonly string[])[],
  echoed: readonly boolean[],
): BiasScore {
  const s: BiasScore = {
    hits: 0,
    terms: 0,
    insertions: 0,
    soundAlikeInsertions: 0,
    noiseInsertions: 0,
    inserted: [],
    echoes: echoed.filter(Boolean).length,
    answers: answers.length,
  };
  clips.forEach((c, i) => {
    const hyp = answers[i] ?? "";
    const list = listed[i] ?? [];
    const own = new Set(c.terms.map((t) => t.toLowerCase()));
    for (const t of list) {
      if (own.has(t.toLowerCase())) {
        s.terms++;
        if (holds(hyp, t)) s.hits++;
      } else if (holds(hyp, t) && !holds(c.ref, t)) {
        s.insertions++;
        s.inserted.push(`${c.id}: ${t}`);
        if (c.ref === "") s.noiseInsertions++;
        else if (c.soundAlikes.includes(t)) s.soundAlikeInsertions++;
      }
    }
  });
  return s;
}

/** The ship rule (DC-L7) at the default cap, and whether the control saw an insertion. */
export function verdict(
  baseline: BiasScore,
  atCap: BiasScore,
  control: BiasScore,
): { pass: boolean; controlBreaks: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const controlBreaks = control.insertions > baseline.insertions;
  if (!controlBreaks)
    reasons.push(
      `the control wrote ${control.insertions} insertions against the baseline's ${baseline.insertions}: the gate cannot see one`,
    );
  if (atCap.hits <= baseline.hits)
    reasons.push(`hits did not rise: ${atCap.hits} against the baseline's ${baseline.hits}`);
  if (atCap.insertions > baseline.insertions)
    reasons.push(
      `insertions rose: ${atCap.insertions} against the baseline's ${baseline.insertions}`,
    );
  return { pass: reasons.length === 0, controlBreaks, reasons };
}

/** Clips per language the gate decodes; with the silence and noise, four settings each. */
export const BIAS_CLIPS = 40;

/** How many references of a language hold each word, from which common and known words come. */
export function vocabulary(refs: readonly string[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const r of refs) for (const w of new Set(toks(r))) n.set(w, (n.get(w) ?? 0) + 1);
  return n;
}

/** A word held by this many references or more is common: it is no learned term. */
export const COMMON_IN = 2;
/** A word shorter than this is never a rare term: the learned words worth biasing are long. */
export const RARE_MIN_CHARS = 8;

/**
 * The gate's clip for a reference: its own terms (proper nouns, and words of `RARE_MIN_CHARS` or
 * more that fewer than `COMMON_IN` references of the whole test set hold), and sound-alike names of
 * its common words that no reference holds.
 */
export function biasClip(
  id: string,
  lang: "en" | "es",
  ref: string,
  vocab: ReadonlyMap<string, number>,
): BiasClip {
  const common = (w: string) => (vocab.get(w) ?? 0) >= COMMON_IN;
  const rare = (w: string) => w.length >= RARE_MIN_CHARS && !common(w);
  const known = (w: string) => vocab.has(w);
  const terms = ownTerms(ref, (w) => !rare(w));
  const inTerms = new Set(terms.flatMap(toks));
  const soundAlikes: string[] = [];
  for (const w of new Set(toks(ref))) {
    if (w.length < 4 || !common(w) || inTerms.has(w)) continue;
    const name = soundAlikeName(w, lang, known);
    if (name && !soundAlikes.includes(name)) soundAlikes.push(name);
  }
  return { id, lang, ref, terms, soundAlikes };
}

/** The context the app sends Qwen (DC-L7): the list wrapped, as one system turn. */
export function wrapped(list: readonly string[]): string[] {
  return list.length === 0 ? [] : [`${CONTEXT_WRAPPER} ${list.join(", ")}.`];
}

/**
 * The positive control: the same list said to be in the audio, three times over, and the clip's own
 * sentence with its sound-alike names in place of the words they sound like. A setting this heavy
 * must write listed names that were not said, or the gate cannot see an insertion. The list alone,
 * however often it is repeated, moved Qwen3-ASR to no insertion at all on the first run.
 */
export function overweighted(list: readonly string[], c?: BiasClip): string[] {
  const l = list.join(", ");
  let said = c?.ref ?? "";
  for (const name of c?.soundAlikes ?? []) {
    const k = name.toLowerCase();
    said = said.replace(/[\p{L}\p{M}'’-]+/gu, (w) => (soundsAs(w, k, c?.lang ?? "en") ? name : w));
  }
  return [
    `The speaker says every one of these words, and each of them more than once: ${l}. ${l}. ${l}.${said ? ` The speaker says: ${said}` : ""}`,
  ];
}

/** Whether `w` is the common word the sound-alike `name` (lower case) was made from. */
function soundsAs(w: string, name: string, lang: "en" | "es"): boolean {
  const lw = w.toLowerCase();
  if (lw === name || lw.length < 4) return false;
  return respellings(lw, lang).includes(name);
}

export const BIASING_ABOUT =
  "Dictation's biasing gate (docs/ux/DICTATION.md DC-L7), by `bun scripts/eval/nightly.ts --only biasing --biasing-out <this file>`: Qwen3-ASR decoding FLEURS clips, silence and noise with no context (`none`), with each clip's list of learned terms wrapped as `Technical terms: A, B, C.` at 10 and 24 terms, and with the positive control (`control`: the 24 terms said to be in the audio, three times, then the clip's own sentence with its sound-alike names in place of the words they sound like). A hit is a clip's own term written; an insertion is a listed term written where the reference does not hold it. The answer scored is the one the app inserts: one that echoes its context is decoded again with none (`echoes`). The ship rule at 24: more hits than `none` and no more insertions; the control must insert more than `none`.";
