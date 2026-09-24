/**
 * Whether harness session reuse ships on (docs/DESIGN.md section 5.3, ROADMAP M2): measured, never
 * assumed. `provider.harnessResume` stays off unless reuse cuts the tokens of a follow-up question
 * by at least 40 %.
 *
 * The measure is every token the model processed on a follow-up, as the harness reports it in its
 * `result` event: input, cache writes, cache reads and output (`totalTokens`). Cache reads count in
 * full on purpose: a resumed session carries the whole earlier conversation, and whether the
 * subscription window charges those reads less is the vendor's to decide, not ours to assume. The
 * first question of each run is left out, because both ways send the whole pack then.
 *
 * `scripts/measure-resume.ts` produces the two lists against the real harness on a synthetic call;
 * this module only judges them, so the rule is tested without running one.
 */

import { totalTokens, type Usage } from "./provider.ts";

export const REUSE_MIN_CUT = 0.4;

export interface ReuseVerdict {
  followUps: number;
  /** Mean tokens per follow-up, each way. */
  withoutMean: number;
  withMean: number;
  /** 1 − with / without: 0.4 is a 40 % cut. Negative when reuse costs more. */
  cut: number;
  enable: boolean;
}

/**
 * Judges a measurement: per-question usage of the same questions asked without and with reuse,
 * the first question of each list included (it is left out here).
 */
export function reuseVerdict(without: readonly Usage[], withReuse: readonly Usage[]): ReuseVerdict {
  const a = without.slice(1).map(totalTokens);
  const b = withReuse.slice(1).map(totalTokens);
  const n = Math.min(a.length, b.length);
  if (n === 0) return { followUps: 0, withoutMean: 0, withMean: 0, cut: 0, enable: false };
  const mean = (xs: number[]) => xs.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const withoutMean = mean(a);
  const withMean = mean(b);
  const cut = withoutMean > 0 ? 1 - withMean / withoutMean : 0;
  return { followUps: n, withoutMean, withMean, cut, enable: cut >= REUSE_MIN_CUT };
}
