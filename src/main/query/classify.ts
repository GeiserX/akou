/**
 * Question classification (docs/DESIGN.md section 5.4, step 2): regular expressions, no model,
 * well under a millisecond.
 *
 * | Class       | Triggers                                                    |
 * |-------------|-------------------------------------------------------------|
 * | `naming`    | "Speaker 2 is Ben", "c2 = Ben"                              |
 * | `time`      | "first 10 minutes", "around 15:40", "last 5 minutes", ...   |
 * | `now`       | "right now", "just said", "catch me up", "did I miss"       |
 * | `summary`   | "so far", "action items", "decisions", "topics"             |
 * | `follow-up` | a pronoun and no name ("and after that?")                   |
 * | `recall`    | everything else, the default                                |
 *
 * Checked in that order: naming is an instruction, a time window is a hard filter, and the rest
 * only weight the budget. A speaker named in the question boosts that speaker's turns and never
 * filters, because live labels can be wrong.
 *
 * A question about the asker ("Was my name mentioned?", the ask box preset) searches for the user's
 * own name: the words "my name" never occur in a transcript, the name does.
 */

import { foldText, tokenize } from "../../core/vocab/correct.ts";

export type Intent = "now" | "recall" | "summary" | "time" | "naming" | "follow-up";

export interface SpeakerRef {
  spk: string;
  label: string;
  name?: string;
}

export interface TimeWindow {
  from: number;
  to: number;
  /** How the window was asked for, for the analysis line. */
  said: string;
  /** For "around 15:40" and "ten minutes ago": the moment asked about, filled outward from. */
  anchor?: number;
  /** The window asked for lies wholly outside the call: `from` and `to` are the nearer edge. */
  empty?: true;
}

export interface Classification {
  intent: Intent;
  window?: TimeWindow;
  /** Speakers the question names; their turns get a 1.5 boost. */
  speakers: SpeakerRef[];
  /** Content words of the question, folded, stopwords removed. */
  terms: string[];
  /** For `naming`: the name to write with `speaker.name`. The caller writes it; no model runs. */
  naming?: { spk: string; name: string };
}

export interface ClassifyContext {
  tz: string;
  /** Wall time of the call's first part. */
  start?: number;
  /** "Now" for this call: the current time while live, the end of the call once it ended. */
  now: number;
  /** The call's speakers with their labels and names, to recognise them in the question. */
  roster: readonly SpeakerRef[];
  stopwords: ReadonlySet<string>;
  /** The user's name (`user.name` when the call was created), for questions about "me". */
  user?: string;
}

/** A question about the asker being named or talked about. */
const ABOUT_ME =
  /\b(my name|mention(?:s|ed)? me|(?:talk(?:s|ed|ing)?|ask(?:s|ed)?|said anything) about me|called me|asked me|(?:talk(?:s|ed|ing)?|spoke|speak(?:s|ing)?) to me)\b/i;
const ABOUT_ME_WORDS = new Set(["name", "mention", "mentions", "mentioned", "called", "asked"]);

/** The words to search for a question: the user's name first when it is about "me". */
export function searchText(question: string, user: string | undefined): string {
  return user && ABOUT_ME.test(question) ? `${user} ${question}` : question;
}

const MIN = 60_000;

const NOW =
  /\b(right now|just now|just said|(what|who) is (he|she|they|it|someone|somebody) (saying|talking)|what('s| is) (being said|happening|going on)|catch me up|did i miss|what did i miss|currently|at the moment)\b/i;
const SUMMARY =
  /\b(so far|action items?|to-?dos?|decisions?|decided|topics?|summar(y|ise|ize)|recap|next steps|overview|key points)\b/i;
const FOLLOW_UP_START = /^\s*(and|then|so|but|what about|how about|why|and then|after that)\b/i;
const PRONOUN = /\b(he|she|they|him|her|them|it|that|this|those|these|his|their)\b/i;

const NAMING = [
  /^\s*(?:speaker\s*(\d+)|c(\d+))\s*(?:is called|is named|is|=|:)\s*(.+?)\s*[.!]?\s*$/i,
  /^\s*(.+?)\s+is\s+(?:speaker\s*(\d+)|c(\d+))\s*[.!]?\s*$/i,
];

/** "Speaker 2 is Ben" or "Ben is speaker 2": the id and the name, or null. */
export function parseNaming(question: string): { spk: string; name: string } | null {
  const a = NAMING[0]?.exec(question);
  if (a) {
    const name = cleanName(a[3] as string);
    if (name) return { spk: `c${a[1] ?? a[2]}`, name };
  }
  const b = NAMING[1]?.exec(question);
  if (b) {
    const name = cleanName(b[1] as string);
    if (name) return { spk: `c${b[2] ?? b[3]}`, name };
  }
  return null;
}

function cleanName(s: string): string | null {
  const name = s.replace(/^["'“‘]|["'”’]$/g, "").trim();
  // A name is a few words, not a sentence.
  if (name === "" || name.split(/\s+/).length > 4 || /[?]/.test(name)) return null;
  return name;
}

// ---------------------------------------------------------------------------
// Time windows

const NUM_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  few: 3,
  couple: 2,
};

const AMOUNT =
  "(\\d+|a few|a couple of|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)";
const UNIT = "(minutes?|mins?|hours?|hrs?|h)";
const CLOCK = "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?";

function amount(s: string): number {
  const k = s
    .toLowerCase()
    .replace(/^a (few|couple of)$/, "$1")
    .replace(/ of$/, "");
  return /^\d+$/.test(k) ? Number(k) : (NUM_WORDS[k] ?? 1);
}

function unitMs(u: string): number {
  return /^h/i.test(u) ? 60 * MIN : MIN;
}

/**
 * The epoch time of a local wall-clock time on the call's day, in the call's zone. Of the
 * candidates on the day before, the day and the day after, the one nearest the call wins, so
 * "since 23:50" on a call that crossed midnight lands on the right day.
 */
export function localClockToEpoch(
  hh: number,
  mm: number,
  tz: string,
  near: { from: number; to: number },
): number {
  const day = localDate(near.from, tz);
  let best = Number.NaN;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const delta of [-1, 0, 1]) {
    const w = zonedToEpoch(day.y, day.m, day.d + delta, hh, mm, tz);
    const dist = w < near.from ? near.from - w : w > near.to ? w - near.to : 0;
    if (dist < bestDist) {
      best = w;
      bestDist = dist;
    }
  }
  return best;
}

function localDate(w: number, tz: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(w));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function zoneOffsetMs(w: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(w));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return asUtc - Math.floor(w / MIN) * MIN;
}

function zonedToEpoch(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset across a zone change.
  let w = guess - zoneOffsetMs(guess, tz);
  w = guess - zoneOffsetMs(w, tz);
  return w;
}

function clockValue(h: string, m: string | undefined, ampm: string | undefined): [number, number] {
  let hh = Number(h);
  const mm = m ? Number(m) : 0;
  if (ampm) {
    const pm = ampm.toLowerCase() === "pm";
    if (hh === 12) hh = pm ? 12 : 0;
    else if (pm) hh += 12;
  }
  return [hh, mm];
}

/** A time window named in the question, or undefined. */
export function parseWindow(question: string, ctx: ClassifyContext): TimeWindow | undefined {
  const q = question.toLowerCase();
  const start = ctx.start ?? ctx.now;
  const span = { from: start, to: ctx.now };
  const at = (h: string, m: string | undefined, ap: string | undefined) => {
    const [hh, mm] = clockValue(h, m, ap);
    if (hh > 23 || mm > 59) return undefined;
    // A bare number is only a time with a colon or am/pm: "3 things" is not 03:00.
    if (m === undefined && ap === undefined) return undefined;
    return localClockToEpoch(hh, mm, ctx.tz, span);
  };

  let m = new RegExp(`\\bfirst ${AMOUNT} ${UNIT}`).exec(q);
  if (m) {
    const len = amount(m[1] as string) * unitMs(m[2] as string);
    return { from: start, to: start + len, said: m[0] };
  }
  m = new RegExp(`\\b(?:last|past|previous) ${AMOUNT} ${UNIT}`).exec(q);
  if (m) {
    const len = amount(m[1] as string) * unitMs(m[2] as string);
    return { from: ctx.now - len, to: ctx.now, said: m[0] };
  }
  m = new RegExp(`\\b${AMOUNT} ${UNIT} ago\\b`).exec(q);
  if (m) {
    const t = ctx.now - amount(m[1] as string) * unitMs(m[2] as string);
    return { from: t - 3 * MIN, to: t + 3 * MIN, said: m[0], anchor: t };
  }
  m = new RegExp(`\\bbetween ${CLOCK} and ${CLOCK}`).exec(q);
  if (m) {
    // "between 3 and 4pm": each clock takes the other's am or pm when it has none.
    const a = at(m[1] as string, m[2], m[3] ?? m[6]);
    const b = at(m[4] as string, m[5], m[6] ?? m[3]);
    if (a !== undefined && b !== undefined && b > a) return { from: a, to: b, said: m[0] };
  }
  m = new RegExp(`\\b(?:since|after|from) ${CLOCK}`).exec(q);
  if (m) {
    const a = at(m[1] as string, m[2], m[3]);
    if (a !== undefined) return { from: a, to: ctx.now, said: m[0] };
  }
  m = new RegExp(`\\b(?:before|until|till) ${CLOCK}`).exec(q);
  if (m) {
    const b = at(m[1] as string, m[2], m[3]);
    if (b !== undefined) return { from: start, to: b, said: m[0] };
  }
  m = new RegExp(`\\b(?:around|about|at|near) ${CLOCK}`).exec(q);
  if (m) {
    const t = at(m[1] as string, m[2], m[3]);
    if (t !== undefined) return { from: t - 5 * MIN, to: t + 5 * MIN, said: m[0], anchor: t };
  }
  if (/\b(at the (start|beginning)|in the beginning|start of the call)\b/.test(q)) {
    return { from: start, to: start + 5 * MIN, said: "the start" };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Speakers named in the question

export function findSpeakers(question: string, roster: readonly SpeakerRef[]): SpeakerRef[] {
  const folded = ` ${tokenize(question)
    .map((t) => t.folded)
    .join(" ")} `;
  const out: SpeakerRef[] = [];
  for (const r of roster) {
    const forms = new Set<string>();
    if (r.name) {
      forms.add(foldText(r.name));
      // "Ben" finds "Ben Ortiz".
      const first = tokenize(r.name)[0]?.folded;
      if (first && first.length >= 3) forms.add(first);
    }
    const n = /^c(\d+)$/.exec(r.spk);
    if (n) {
      forms.add(`speaker ${n[1]}`);
      forms.add(r.spk);
    }
    // The user is found by name only; "you" in a question is the asker, not a speaker.
    if (r.spk === "you" && !r.name) forms.add(foldText(r.label));
    if ([...forms].some((f) => f && folded.includes(` ${f} `))) out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------

export function classify(question: string, ctx: ClassifyContext): Classification {
  const speakers = findSpeakers(question, ctx.roster);
  const nameWords = new Set<string>();
  for (const s of speakers) {
    for (const t of tokenize(`${s.name ?? ""} ${s.label} ${s.spk}`)) nameWords.add(t.folded);
  }
  nameWords.add("speaker");
  const terms = [
    ...new Set(
      tokenize(question)
        .map((t) => t.folded)
        .filter((w) => !ctx.stopwords.has(w) && !nameWords.has(w)),
    ),
  ];

  const naming = parseNaming(question);
  if (naming) return { intent: "naming", speakers, terms, naming };

  if (ctx.user && ABOUT_ME.test(question)) {
    const me = tokenize(ctx.user).map((t) => t.folded);
    const rest = terms.filter((t) => !ABOUT_ME_WORDS.has(t) && !me.includes(t));
    terms.splice(0, terms.length, ...me, ...rest);
  }

  const window = clampToCall(parseWindow(question, ctx), ctx);
  if (window) return { intent: "time", window, speakers, terms: withoutTimeWords(terms) };

  if (NOW.test(question)) return { intent: "now", speakers, terms };
  if (SUMMARY.test(question)) return { intent: "summary", speakers, terms };

  const words = tokenize(question).length;
  if (
    speakers.length === 0 &&
    words <= 8 &&
    (FOLLOW_UP_START.test(question) || (PRONOUN.test(question) && terms.length <= 1))
  ) {
    return { intent: "follow-up", speakers, terms };
  }
  return { intent: "recall", speakers, terms };
}

/**
 * A window reaching past the call is cut to the call, so the pack never names a time outside it.
 * A window wholly outside the call becomes an empty one at the nearer edge, marked `empty`.
 */
function clampToCall(w: TimeWindow | undefined, ctx: ClassifyContext): TimeWindow | undefined {
  if (!w) return w;
  const start = ctx.start ?? w.from;
  const from = Math.max(w.from, start);
  const to = Math.min(w.to, ctx.now);
  if (from < to) return { ...w, from, to };
  const edge = w.from >= ctx.now ? ctx.now : start;
  const { anchor: _a, ...rest } = w;
  return { ...rest, from: edge, to: edge, empty: true };
}

const TIME_WORDS = new Set([
  "first",
  "last",
  "past",
  "previous",
  "minute",
  "minutes",
  "min",
  "mins",
  "hour",
  "hours",
  "ago",
  "since",
  "around",
  "between",
  "before",
  "after",
  "until",
  "am",
  "pm",
  "start",
  "beginning",
]);

function withoutTimeWords(terms: readonly string[]): string[] {
  return terms.filter((t) => !TIME_WORDS.has(t) && !/^\d+$/.test(t));
}
