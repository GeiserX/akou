/**
 * Filler words left out of a dictation's inserted text (docs/ux/DICTATION.md DC-S7). Pure: the
 * text after the dictation vocabulary and the languages it may be in go in, the text to insert
 * comes out. History keeps what the engine heard; only the inserted text changes.
 *
 * - Hesitation sounds (`um`, `uh`, `erm`, `hmm`; Spanish `eh`, `mmm`) go wherever they stand,
 *   stretched forms (`umm`, `hmmm`) included.
 * - A filler that is also a word (Spanish `este`, "this") goes only when it stands alone, between
 *   punctuation or the text's edges: "Este, bueno, vale" loses it, "este libro" keeps it.
 * - Gated by language: a list applies only when the dictation is in its language. With no
 *   language known (Parakeet names none), the hesitation sounds that are no word in either list
 *   apply; `eh` and `este` wait for Spanish. `um` stays whenever Portuguese is in the list.
 * - The punctuation around a removed filler is mended: "the, uh, plan" becomes "the plan", "Um,
 *   so" becomes "So", and "plan, um." becomes "plan.".
 */

/** Hesitations that go wherever they stand, by language. */
const SOUNDS: Readonly<Record<string, RegExp>> = {
  en: /^(?:u+m+|u+h+|e+r+m+|h+m+)$/,
  es: /^(?:e+h+|m{2,})$/,
};

/** With no language known: the sounds that are no word in any list. */
const UNKNOWN = /^(?:u+m+|u+h+|e+r+m+|h+m+|m{2,})$/;

/** Words of a language that a sound list of another would take: Portuguese `um` is "a". */
const WORDS: Readonly<Record<string, RegExp>> = {
  pt: /^um$/,
};

/** Fillers that are also words, removed only when they stand alone. */
const ALONE: Readonly<Record<string, RegExp>> = {
  es: /^este$/,
};

interface Tok {
  /** The whitespace before the token. */
  sep: string;
  lead: string;
  core: string;
  trail: string;
}

const SPLIT = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su;
const ENDS_SENTENCE = /[.!?…]/;
const COMMA_LIKE = /[,;:]/;
const CLOSES = /[)\]}?!]/;

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /(\s*)(\S+)/g;
  for (const m of text.matchAll(re)) {
    const [, lead = "", core = "", trail = ""] = SPLIT.exec(m[2] as string) ?? [];
    out.push({ sep: m[1] as string, lead, core, trail });
  }
  return out;
}

/** The base language of a tag: `en-US` is `en`. */
function base(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0] as string;
}

/**
 * `text` without its fillers. `languages` is the dictation's language when the engine named one,
 * else the languages it may be in; empty when nothing is known.
 */
export function removeFillers(text: string, languages: readonly string[]): string {
  const langs = [...new Set(languages.map(base))];
  const sounds = langs.length === 0 ? [UNKNOWN] : langs.flatMap((l) => SOUNDS[l] ?? []);
  const alone = langs.flatMap((l) => ALONE[l] ?? []);
  if (sounds.length === 0 && alone.length === 0) return text;

  const toks = tokens(text);
  const kept: Tok[] = [];
  // Punctuation that opened a removed filler (`¿`, `(`), carried onto the next word kept.
  let carryLead = "";
  // A line break before a removed filler stays a line break.
  let carrySep: string | null = null;
  let capitalizeNext = false;
  toks.forEach((t, i) => {
    const word = t.core.toLowerCase();
    const prev = kept.at(-1);
    const prevTrail = prev?.trail ?? "";
    const isSound =
      word !== "" && sounds.some((re) => re.test(word)) && !langs.some((l) => WORDS[l]?.test(word));
    const standsAlone =
      t.trail !== "" &&
      (i === 0 || toks[i - 1]?.trail !== "" || prevTrail !== "") &&
      alone.some((re) => re.test(word));
    if (!isSound && !standsAlone) {
      const next = { ...t, lead: carryLead + t.lead };
      if (capitalizeNext) next.core = next.core.charAt(0).toUpperCase() + next.core.slice(1);
      if (carrySep !== null) next.sep = carrySep;
      if (kept.length === 0) next.sep = toks[0]?.sep ?? "";
      kept.push(next);
      carryLead = "";
      carrySep = null;
      capitalizeNext = false;
      return;
    }
    // The filler opened a sentence: the word after it opens it now.
    const opensSentence = !prev || ENDS_SENTENCE.test(prevTrail);
    if (opensSentence && /^\p{Lu}/u.test(t.core)) capitalizeNext = true;
    // An opening mark the filler closed itself ("(um)", "¿Este?") goes with it.
    if (!CLOSES.test(t.trail)) carryLead += t.lead;
    if (t.sep.includes("\n")) carrySep = t.sep;
    if (ENDS_SENTENCE.test(t.trail)) {
      // "plan, um." ends the sentence where the filler did; "hello. um." has ended it already.
      if (prev && !ENDS_SENTENCE.test(prevTrail))
        prev.trail = prevTrail.replace(/[,;:\s]+$/, "") + t.trail.replace(/^[,;:]+/, "");
    } else if (COMMA_LIKE.test(t.trail) && prev && COMMA_LIKE.test(prevTrail.slice(-1))) {
      // "the, uh, plan": the pause was the filler's, so its commas go with it.
      prev.trail = prevTrail.replace(/[,;:]+$/, "");
    }
  });
  return kept
    .map((t) => `${t.sep}${t.lead}${t.core}${t.trail}`)
    .join("")
    .trim();
}
