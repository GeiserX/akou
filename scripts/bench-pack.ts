/**
 * Pack build latency on a synthetic 3-hour, 4-speaker call (docs/DESIGN.md section 5.4, latency
 * targets; ROADMAP M1: pack build p95 under 50 ms on a synthetic 3-hour log).
 *
 * The log is generated from a fixed seed. The last lines are held back and appended one at a time
 * between questions, the way a live call grows, so every measured pack includes the incremental
 * index update for the new line. The first pack, which builds the index from scratch, is reported
 * separately and not counted in the percentiles.
 *
 *   bun scripts/bench-pack.ts [--questions 200] [--hours 3] [--seed 42]
 */

import { fold } from "../src/core/log/fold.ts";
import { CallQuery } from "../src/main/query/context.ts";
import { synthCall, synthQuestions } from "../tests/synth.ts";

export interface BenchResult {
  questions: number;
  lines: number;
  chunks: number;
  coldMs: number;
  p50: number;
  p95: number;
  max: number;
  maxTokens: number;
}

const MIXED = [
  "what is being said right now?",
  "catch me up",
  "action items so far",
  "what decisions so far?",
  "what was said in the first 10 minutes?",
  "what happened in the last 5 minutes?",
  "and after that?",
  "what did Ben say about the deploy?",
];

export function runPackBench(
  opts: { questions?: number; hours?: number; seed?: number } = {},
): BenchResult {
  const n = opts.questions ?? 200;
  const call = synthCall({ hours: opts.hours ?? 3, seed: opts.seed ?? 42, tailLines: n });
  const view = fold(call.events);
  const engine = new CallQuery(view);
  const facts = synthQuestions(call).map((q) => q.q);
  const pool = [...facts, ...MIXED];
  let now = call.end - n * 5_000;

  const cold = performance.now();
  engine.context("warm up", { now });
  const coldMs = performance.now() - cold;

  const times: number[] = [];
  let maxTokens = 0;
  for (let i = 0; i < n; i++) {
    const next = call.tail[i];
    if (next) view.apply(next);
    now += 5_000;
    const q = pool[i % pool.length] as string;
    const t = performance.now();
    const pack = engine.context(q, { now });
    times.push(performance.now() - t);
    maxTokens = Math.max(maxTokens, pack.tokens);
  }
  times.sort((a, b) => a - b);
  const at = (p: number) =>
    times[Math.min(times.length - 1, Math.floor(times.length * p))] as number;
  return {
    questions: n,
    lines: engine.index.allLines().length,
    chunks: engine.index.allChunks().length,
    coldMs,
    p50: at(0.5),
    p95: at(0.95),
    max: times[times.length - 1] as number,
    maxTokens,
  };
}

/** The latency gate, as a function so a test can prove it trips. */
export function withinBudget(r: BenchResult, p95BudgetMs: number): boolean {
  return r.p95 < p95BudgetMs;
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : undefined;
  };
  const r = runPackBench({ questions: arg("questions"), hours: arg("hours"), seed: arg("seed") });
  const ms = (x: number) => `${x.toFixed(2)} ms`;
  console.log(
    `pack build over ${r.questions} questions on ${r.lines} lines (${r.chunks} chunks): ` +
      `p50 ${ms(r.p50)}, p95 ${ms(r.p95)}, max ${ms(r.max)}; cold index ${ms(r.coldMs)}; ` +
      `largest pack ${r.maxTokens} tokens`,
  );
  process.exit(withinBudget(r, 50) ? 0 : 1);
}
