/**
 * Replay evaluation harness (docs/DESIGN.md section 5.4, "BM25"; ROADMAP M1): for each question
 * with gold segment ids, build the pack and check whether an answering segment is in it. The share
 * of questions that pass decides whether embeddings are needed (target: at least 85 %).
 *
 * This harness runs on synthetic calls only. The ROADMAP criterion is measured on real calls,
 * whose transcripts are never committed; the same harness takes them from outside the repository.
 */

import type { LogEvent } from "../../src/core/log/events.ts";
import { fold } from "../../src/core/log/fold.ts";
import { CallQuery, type ContextOptions } from "../../src/main/query/context.ts";

export interface EvalQuestion {
  q: string;
  /** Any of these segment ids answers the question. */
  gold: string[];
  kind: string;
}

export interface EvalReport {
  total: number;
  hits: number;
  rate: number;
  byKind: Record<string, { total: number; hits: number }>;
  misses: { q: string; kind: string }[];
}

export function replay(
  events: readonly LogEvent[],
  questions: readonly EvalQuestion[],
  opts: ContextOptions,
): EvalReport {
  const engine = new CallQuery(fold(events));
  const byKind: EvalReport["byKind"] = {};
  const misses: EvalReport["misses"] = [];
  let hits = 0;
  for (const q of questions) {
    const pack = engine.context(q.q, opts);
    const ids = new Set(pack.lines.map((l) => l.id));
    const ok = q.gold.some((g) => ids.has(g));
    const k = byKind[q.kind] ?? { total: 0, hits: 0 };
    byKind[q.kind] = k;
    k.total++;
    if (ok) {
      hits++;
      k.hits++;
    } else {
      misses.push({ q: q.q, kind: q.kind });
    }
  }
  return {
    total: questions.length,
    hits,
    rate: questions.length === 0 ? 0 : hits / questions.length,
    byKind,
    misses,
  };
}

export function formatReport(r: EvalReport): string {
  const kinds = Object.entries(r.byKind)
    .map(([k, v]) => `${k} ${v.hits}/${v.total}`)
    .join(", ");
  return `answering segment in the pack for ${r.hits} of ${r.total} questions (${(r.rate * 100).toFixed(1)} %): ${kinds}`;
}
