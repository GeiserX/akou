/**
 * The scoring behind the nightly model evaluation (docs/TESTING.md TS-19, TS-20): word error rate
 * with the one normalizer every engine is scored with, diarization error rate with a collar and
 * the best speaker mapping, percentiles, and the comparison with the committed baselines. Pure
 * functions, so `tests/eval/score.test.ts` checks each against answers worked out by hand,
 * including the inputs each must reject.
 */

/**
 * The normalizer of docs/research/asr-benchmark.md: NFKC, lower case, apostrophes dropped,
 * punctuation turned into spaces, accents kept. Numbers are left as written.
 */
export function normalizeText(s: string): string[] {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’ʼ`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
}

/** Word edits (substitutions, deletions, insertions) turning `ref` into `hyp`. */
export function wordErrors(ref: readonly string[], hyp: readonly string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const sub = (prev[j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      row.push(Math.min(sub, (prev[j] as number) + 1, (row[j - 1] as number) + 1));
    }
    prev = row;
  }
  return prev[hyp.length] as number;
}

/** Corpus WER in percent: every utterance's edits over every reference word. */
export function wer(pairs: readonly { ref: string; hyp: string }[]): number {
  let errors = 0;
  let words = 0;
  for (const p of pairs) {
    const r = normalizeText(p.ref);
    errors += wordErrors(r, normalizeText(p.hyp));
    words += r.length;
  }
  if (words === 0) throw new Error("no reference words");
  return (100 * errors) / words;
}

/** Nearest-rank percentile, `p` from 0 to 100. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) throw new Error("no values");
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] as number;
}

export interface Turn {
  start: number;
  end: number;
  speaker: string;
}

/** The turns of an RTTM file (`SPEAKER <file> 1 <start> <duration> <NA> <NA> <speaker> ...`). */
export function parseRttm(text: string): Turn[] {
  const out: Turn[] = [];
  for (const line of text.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p[0] !== "SPEAKER") continue;
    const start = Number(p[3]);
    const dur = Number(p[4]);
    if (!Number.isFinite(start) || !Number.isFinite(dur) || !p[7])
      throw new Error(`bad RTTM line: ${line}`);
    out.push({ start, end: start + dur, speaker: p[7] });
  }
  return out;
}

export interface DerParts {
  /** Scored reference speech, seconds (speaker-seconds: two at once count twice). */
  speech: number;
  missed: number;
  falseAlarm: number;
  confusion: number;
  /** (missed + false alarm + confusion) / speech, percent. */
  der: number;
}

const STEP = 0.01;

/** Frame `i`'s speakers, 10 ms frames. */
function frames(turns: readonly Turn[], n: number): Set<string>[] {
  const out = Array.from({ length: n }, () => new Set<string>());
  for (const t of turns) {
    for (
      let i = Math.max(0, Math.round(t.start / STEP));
      i < Math.min(n, Math.round(t.end / STEP));
      i++
    )
      out[i]?.add(t.speaker);
  }
  return out;
}

/** Every one-to-one mapping of `hyp` labels onto `ref` labels (or none), best overlap first. */
function bestMapping(
  overlap: Map<string, Map<string, number>>,
  refs: string[],
  hyps: string[],
): Map<string, string> {
  // Exact search for the small speaker counts diarization meets; greedy past 8 labels.
  if (hyps.length > 8 || refs.length > 8) {
    const pairs = hyps.flatMap((h) => refs.map((r) => ({ h, r, o: overlap.get(h)?.get(r) ?? 0 })));
    pairs.sort((a, b) => b.o - a.o);
    const m = new Map<string, string>();
    const used = new Set<string>();
    for (const p of pairs)
      if (!m.has(p.h) && !used.has(p.r) && p.o > 0) {
        m.set(p.h, p.r);
        used.add(p.r);
      }
    return m;
  }
  let best = { score: -1, map: new Map<string, string>() };
  const walk = (i: number, used: Set<string>, map: Map<string, string>, score: number) => {
    if (i === hyps.length) {
      if (score > best.score) best = { score, map: new Map(map) };
      return;
    }
    const h = hyps[i] as string;
    walk(i + 1, used, map, score);
    for (const r of refs) {
      if (used.has(r)) continue;
      used.add(r);
      map.set(h, r);
      walk(i + 1, used, map, score + (overlap.get(h)?.get(r) ?? 0));
      map.delete(h);
      used.delete(r);
    }
  };
  walk(0, new Set(), new Map(), 0);
  return best.map;
}

/**
 * Diarization error rate as NIST scores it: 10 ms frames, frames within `collar` seconds of a
 * reference boundary left out, overlapping speech scored, and hypothesis labels mapped one to one
 * onto reference labels to maximize agreement.
 */
export function der(ref: readonly Turn[], hyp: readonly Turn[], collar = 0.25): DerParts {
  const end = Math.max(0, ...ref.map((t) => t.end), ...hyp.map((t) => t.end));
  const n = Math.ceil(end / STEP) + 1;
  const r = frames(ref, n);
  const h = frames(hyp, n);
  const scored = new Array<boolean>(n).fill(true);
  const c = Math.round(collar / STEP);
  for (const t of ref)
    for (const b of [Math.round(t.start / STEP), Math.round(t.end / STEP)])
      for (let i = Math.max(0, b - c); i < Math.min(n, b + c); i++) scored[i] = false;
  const overlap = new Map<string, Map<string, number>>();
  for (let i = 0; i < n; i++) {
    if (!scored[i]) continue;
    for (const hs of h[i] as Set<string>)
      for (const rs of r[i] as Set<string>) {
        const m = overlap.get(hs) ?? new Map<string, number>();
        m.set(rs, (m.get(rs) ?? 0) + 1);
        overlap.set(hs, m);
      }
  }
  const map = bestMapping(
    overlap,
    [...new Set(ref.map((t) => t.speaker))],
    [...new Set(hyp.map((t) => t.speaker))],
  );
  let speech = 0;
  let missed = 0;
  let falseAlarm = 0;
  let confusion = 0;
  for (let i = 0; i < n; i++) {
    if (!scored[i]) continue;
    const rs = r[i] as Set<string>;
    const hs = h[i] as Set<string>;
    const correct = [...hs].filter((x) => {
      const m = map.get(x);
      return m !== undefined && rs.has(m);
    }).length;
    speech += rs.size;
    missed += Math.max(0, rs.size - hs.size);
    falseAlarm += Math.max(0, hs.size - rs.size);
    confusion += Math.min(rs.size, hs.size) - correct;
  }
  if (speech === 0) throw new Error("no scored reference speech");
  const s = (x: number) => x * STEP;
  return {
    speech: s(speech),
    missed: s(missed),
    falseAlarm: s(falseAlarm),
    confusion: s(confusion),
    der: (100 * (missed + falseAlarm + confusion)) / speech,
  };
}

/** One measured number, which way is better, and its gate. */
export interface Measure {
  /** `wer.fleurs_en.parakeet-tdt-0.6b-v3`, `der.voxconverse`, `replay.recall` ... */
  key: string;
  value: number;
  unit: string;
  /** `lower`: at or below the baseline passes; `higher`: at or above. */
  better: "lower" | "higher";
  /** Compared with the committed baseline, or only recorded (latency, opt-in engines). */
  gate: "baseline" | "record";
  /** A fixed bound that holds whatever the baseline says (a floor or a budget). */
  bound?: number;
}

export interface Verdict {
  key: string;
  value: number;
  unit: string;
  baseline: number | null;
  ok: boolean;
  why: string;
}

/**
 * Each measure against the committed baseline for this OS. A gated measure with no baseline
 * fails, so a new metric or OS cannot pass unrecorded; a measure past its fixed bound fails too.
 * Rounded to two decimals before comparing, as the baselines are written.
 */
export function compare(
  measures: readonly Measure[],
  baselines: Readonly<Record<string, number>>,
): Verdict[] {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return measures.map((m) => {
    const value = r2(m.value);
    const base = baselines[m.key];
    const baseline = base === undefined ? null : r2(base);
    const worse = (a: number, b: number) => (m.better === "lower" ? a > b : a < b);
    if (m.bound !== undefined && worse(value, m.bound))
      return { ...m, value, baseline, ok: false, why: `past its bound ${m.bound}` };
    if (m.gate === "record") return { ...m, value, baseline, ok: true, why: "recorded" };
    if (baseline === null)
      return {
        ...m,
        value,
        baseline,
        ok: false,
        why: "no committed baseline: add this run's value to docs/gates/nightly-baselines.json",
      };
    return worse(value, baseline)
      ? { ...m, value, baseline, ok: false, why: `worse than the baseline ${baseline}` }
      : { ...m, value, baseline, ok: true, why: "at or better than the baseline" };
  });
}

/** The job summary: one table row per measure, the failures first. */
export function summary(
  title: string,
  verdicts: readonly Verdict[],
  notes: readonly string[],
): string {
  const rows = [...verdicts].sort((a, b) => Number(a.ok) - Number(b.ok));
  return [
    `### ${title}`,
    "",
    "| | Measure | Value | Baseline | |",
    "|---|---|---|---|---|",
    ...rows.map(
      (v) =>
        `| ${v.ok ? "ok" : "**FAIL**"} | \`${v.key}\` | ${v.value} ${v.unit} | ${v.baseline ?? "none"} | ${v.why} |`,
    ),
    "",
    ...notes.map((n) => `- ${n}`),
    "",
  ].join("\n");
}
