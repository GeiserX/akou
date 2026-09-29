/**
 * Confidence ROVER (docs/research/asr-architecture.md section 5, ASR-3): any number of engines'
 * hypotheses of one unit become one, word by word, with no provider.
 *
 * A port of the benchmark's fusion code (`build`, `vote`, `regions`), which follows Fiscus 1997:
 *
 * - **build**: the first hypothesis is the base of a word network, one column per word. Each next
 *   hypothesis is aligned into it by edit distance: a word matches a column that already holds it,
 *   a column it skips gets an empty slot, and a word it adds opens a new column that is empty for
 *   every earlier engine. The traceback prefers a match, then a skipped column, then an added word.
 * - **vote**: in each column every candidate (a word, or no word) scores
 *   `alpha x engines that wrote it / engines + (1 - alpha) x its highest confidence`. No word scores
 *   the null confidence; a word with no confidence scores the default confidence when its engine
 *   reports none at all, else 1. Ties go to the candidate of the earliest engine, so engine order
 *   is priority. A column won by no word writes nothing.
 * - **regions**: the network split into agreed words and runs of columns where engines differ, the
 *   input the LLM fusers (ASR-9) take.
 *
 * The constants are the benchmark's, tuned leave-one-set-out: alpha 0.4, null 0.5, default 0.7
 * (`rover-conf`, pooled 7.98 at five engines). `rover-freq` is the same vote at alpha 1, majority
 * alone; it degrades past three engines and is never the default. With two engines every alpha
 * below 1 gives the same output: each candidate of a disputed column has one vote, so confidence
 * decides.
 *
 * Words align by the benchmark's key: NFKC, lowercase, apostrophes removed, other punctuation a
 * space. A word whose key has several parts ("well-known", "3.5") takes one column per part, as
 * another engine's "well known" does; the punctuation stays on the part before it, and parts of one
 * word that all win from the same engine join back into that word. A fused word takes its spelling
 * from the earliest engine that wrote it, the highest confidence among those that did, and the
 * first times one of them has. A word that is only punctuation joins the word before it.
 *
 * One difference from the benchmark: it gave the default confidence to an engine that reported
 * none across a whole set; here the rule is per hypothesis, so a unit where a confidence-reporting
 * engine happens to return none scores its words at the default, not 1.
 */

import type { Provider } from "../llm/provider.ts";
import type { Fuser, Hypothesis, WordHyp } from "./engine.ts";

export interface RoverParams {
  /** Weight of the vote count against the confidence, 0 to 1. */
  alpha: number;
  /** The score of no word in a column. */
  nullConf: number;
  /** The confidence of every word of an engine that reports none. */
  defaultConf: number;
}

/** The benchmark's tuned constants (section 5). */
export const ROVER_CONF: Readonly<RoverParams> = { alpha: 0.4, nullConf: 0.5, defaultConf: 0.7 };
/** Frequency ROVER: the vote count alone. */
export const ROVER_FREQ: Readonly<RoverParams> = { ...ROVER_CONF, alpha: 1 };

/** One engine's words as the network sees them: keys, and a confidence or null per word. */
export interface NetInput {
  words: readonly string[];
  conf: readonly (number | null | undefined)[];
}

/** One engine's slot in a column: its word and confidence, or null where it has no word here. */
export interface Slot {
  w: string | null;
  c: number | null;
  /** The word's index in the engine's input, -1 for no word. */
  i: number;
}

/** One column of the network: a slot per engine, in engine order. */
export type Column = readonly Slot[];

const NONE: Slot = { w: null, c: null, i: -1 };

/** The word network of any number of hypotheses (the benchmark's `build`). */
export function build(hyps: readonly NetInput[]): Column[] {
  const first = hyps[0];
  if (!first) return [];
  let cols: Slot[][] = first.words.map((w, i) => [{ w, c: first.conf[i] ?? null, i }]);
  for (let s = 1; s < hyps.length; s++) {
    const h = hyps[s] as NetInput;
    const n = cols.length;
    const m = h.words.length;
    const has = cols.map((col) => new Set(col.map((x) => x.w)));
    const sub = (i: number, j: number) =>
      (has[i] as Set<string | null>).has(h.words[j] as string) ? 0 : 1;
    const dl = (i: number) => ((has[i] as Set<string | null>).has(null) ? 0 : 1);
    const D: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    const at = (i: number, j: number) => (D[i] as number[])[j] as number;
    for (let i = 1; i <= n; i++) (D[i] as number[])[0] = at(i - 1, 0) + dl(i - 1);
    for (let j = 1; j <= m; j++) (D[0] as number[])[j] = j;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        (D[i] as number[])[j] = Math.min(
          at(i - 1, j - 1) + sub(i - 1, j - 1),
          at(i - 1, j) + dl(i - 1),
          at(i, j - 1) + 1,
        );
      }
    }
    const ops: ["m" | "d" | "i", number, number][] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && at(i, j) === at(i - 1, j - 1) + sub(i - 1, j - 1)) {
        ops.push(["m", --i, --j]);
      } else if (i > 0 && at(i, j) === at(i - 1, j) + dl(i - 1)) {
        ops.push(["d", --i, -1]);
      } else {
        ops.push(["i", -1, --j]);
      }
    }
    const slot = (b: number): Slot => ({ w: h.words[b] as string, c: h.conf[b] ?? null, i: b });
    const next: Slot[][] = [];
    for (const [op, a, b] of ops.reverse()) {
      if (op === "m") next.push([...(cols[a] as Slot[]), slot(b)]);
      else if (op === "d") next.push([...(cols[a] as Slot[]), NONE]);
      else next.push([...new Array<Slot>(s).fill(NONE), slot(b)]);
    }
    cols = next;
  }
  return cols;
}

/**
 * The winner of each column (the benchmark's `vote`): the engine index of the earliest engine that
 * wrote the winning word, or -1 when no word wins. `defaultConf[s]` is the confidence of engine
 * `s`'s words that carry none.
 */
export function vote(
  cols: readonly Column[],
  params: RoverParams,
  defaultConf: readonly number[],
): number[] {
  const { alpha, nullConf } = params;
  return cols.map((col) => {
    const cand = new Map<string | null, { n: number; c: number; s: number }>();
    col.forEach((x, s) => {
      const cc = x.w === null ? nullConf : (x.c ?? defaultConf[s] ?? 1);
      const e = cand.get(x.w);
      if (e) {
        e.n += 1;
        e.c = Math.max(e.c, cc);
        e.s = Math.min(e.s, s);
      } else cand.set(x.w, { n: 1, c: cc, s });
    });
    let best: { w: string | null; score: number; s: number } | null = null;
    for (const [w, e] of cand) {
      const score = (alpha * e.n) / col.length + (1 - alpha) * e.c;
      if (!best || score > best.score || (score === best.score && e.s < best.s)) {
        best = { w, score, s: e.s };
      }
    }
    return best && best.w !== null ? best.s : -1;
  });
}

/** The fused words of a network, as keys. */
export function voteWords(
  cols: readonly Column[],
  params: RoverParams,
  defaultConf: readonly number[],
): string[] {
  const out: string[] = [];
  vote(cols, params, defaultConf).forEach((s, k) => {
    if (s >= 0) out.push((cols[k] as Column)[s]?.w as string);
  });
  return out;
}

export type Region = { agreed: string } | { differ: Column[] };

/** Agreed words and runs of columns where engines differ (the benchmark's `regions`). */
export function regions(cols: readonly Column[]): Region[] {
  const out: Region[] = [];
  let cur: Column[] | null = null;
  for (const col of cols) {
    const w = col[0]?.w ?? null;
    if (col.every((x) => x.w === w)) {
      if (cur) out.push({ differ: cur });
      cur = null;
      if (w !== null) out.push({ agreed: w });
    } else {
      cur ??= [];
      cur.push(col);
    }
  }
  if (cur) out.push({ differ: cur });
  return out;
}

/**
 * A word's alignment key, the benchmark's `norm`: NFKC, lowercase, apostrophes removed, other
 * punctuation a space. Several parts are separated by one space.
 */
export function wordKey(w: string): string {
  return w
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

/** A character where a word's key splits: punctuation or space, not an apostrophe. */
const splits = (c: string) => wordKey(c) === "" && !/^['’]+$/.test(c.normalize("NFKC"));

/**
 * A word's spelling cut where its key splits, the punctuation staying on the piece before the cut
 * (a leading one on the first piece). When the cuts do not line up with the key's parts, the parts
 * themselves.
 */
function pieces(w: string, keys: readonly string[]): string[] {
  const out: string[] = [];
  let cur = "";
  let cut = false;
  for (const c of w) {
    if (splits(c)) {
      cur += c;
      cut = wordKey(cur) !== "";
    } else {
      if (cut) {
        out.push(cur);
        cur = "";
      }
      cur += c;
      cut = false;
    }
  }
  if (cur) out.push(cur);
  return out.length === keys.length ? out : [...keys];
}

/** One key of a hypothesis: the word it spells, and where it came from. */
interface Keyed {
  hyp: WordHyp;
  key: string;
  /** The word's index in the hypothesis, and which part of its key this is. */
  src: number;
  part: number;
}

/** A hypothesis's keys; a word that is only punctuation joins the word before it. */
function keyed(h: Hypothesis): Keyed[] {
  const out: Keyed[] = [];
  let lead = "";
  h.words.forEach((word, src) => {
    const keys = wordKey(word.w).split(" ").filter(Boolean);
    const last = out.at(-1);
    if (!keys.length) {
      if (last) last.hyp.w = `${last.hyp.w} ${word.w}`;
      else lead = `${lead}${word.w} `;
      return;
    }
    const spelt = pieces(word.w, keys);
    keys.forEach((key, part) => {
      const w = `${part === 0 ? lead : ""}${spelt[part] as string}`;
      out.push({ hyp: { ...word, w }, key, src, part });
    });
    lead = "";
  });
  return out;
}

/** Confidence ROVER as a `Fuser` over any number of hypotheses, in priority order. */
export class RoverFuser implements Fuser {
  constructor(
    readonly id: "rover-conf" | "rover-freq" = "rover-conf",
    private readonly params: RoverParams = id === "rover-freq" ? ROVER_FREQ : ROVER_CONF,
  ) {}

  async fuse(
    hyps: readonly Hypothesis[],
    _ctx: { lang: string; glossary: readonly string[]; provider?: Provider },
  ): Promise<Hypothesis> {
    return this.fuseSync(hyps);
  }

  /** One hypothesis comes back as it is; none is a caller's bug. */
  fuseSync(hyps: readonly Hypothesis[]): Hypothesis {
    const only = hyps[0];
    if (!only) throw new RangeError("rover: no hypotheses to fuse");
    if (hyps.length === 1) return only;
    const t = performance.now();
    const words = hyps.map(keyed);
    const cols = build(
      words.map((ws) => ({ words: ws.map((x) => x.key), conf: ws.map((x) => x.hyp.conf) })),
    );
    const defaultConf = words.map((ws) =>
      ws.some((x) => x.hyp.conf !== undefined) ? 1 : this.params.defaultConf,
    );
    const fused: { hyp: WordHyp; e: number; src: number; part: number }[] = [];
    vote(cols, this.params, defaultConf).forEach((s, k) => {
      if (s < 0) return;
      const col = cols[k] as Column;
      const key = col[s]?.w;
      const from = col.flatMap((x, e) =>
        x.w === key ? [(words[e] as Keyed[])[x.i] as Keyed] : [],
      );
      const head = from[0] as Keyed;
      const word: WordHyp = { w: head.hyp.w };
      const confs = from.flatMap((x) => (x.hyp.conf === undefined ? [] : [x.hyp.conf]));
      if (confs.length) word.conf = Math.max(...confs);
      const timed = from.find((x) => x.hyp.t0 !== undefined && x.hyp.t1 !== undefined);
      if (timed) {
        word.t0 = timed.hyp.t0;
        word.t1 = timed.hyp.t1;
      }
      const prev = fused.at(-1);
      if (prev && prev.e === s && prev.src === head.src && prev.part + 1 === head.part) {
        // The next part of the same word from the same engine: join it back.
        prev.hyp.w += word.w;
        if (word.conf !== undefined) prev.hyp.conf = Math.min(prev.hyp.conf ?? 1, word.conf);
        if (word.t0 !== undefined) {
          prev.hyp.t0 ??= word.t0;
          prev.hyp.t1 = word.t1;
        }
        prev.part = head.part;
      } else fused.push({ hyp: word, e: s, src: head.src, part: head.part });
    });
    const out: Hypothesis = {
      engine: `${this.id}(${hyps.map((h) => h.engine).join(",")})`,
      text: fused.map((x) => x.hyp.w).join(" "),
      words: fused.map((x) => x.hyp),
      ms: performance.now() - t,
    };
    const lang = hyps.find((h) => h.lang)?.lang;
    if (lang) out.lang = lang;
    return out;
  }
}
