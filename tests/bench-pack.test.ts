import { describe, expect, test } from "bun:test";
import { percentile, runPackBench, withinBudget } from "../scripts/bench-pack.ts";
import { MCP_BUDGET } from "../src/main/query/context.ts";

describe("pack build latency (DESIGN 5.4, ROADMAP M1)", () => {
  // One run serves every assertion; it takes about a second.
  const r = runPackBench({ questions: 200, hours: 3, seed: 42 });

  test("[T1.19] Quadratic token mapping: pack build p95 under 50 ms on a synthetic 3-hour, 4-speaker log", () => {
    console.log(
      `bench: p50 ${r.p50.toFixed(2)} ms, p95 ${r.p95.toFixed(2)} ms, max ${r.max.toFixed(2)} ms, cold ${r.coldMs.toFixed(1)} ms, ${r.lines} lines, ${r.chunks} chunks`,
    );
    expect(r.questions).toBe(200);
    expect(r.lines).toBeGreaterThan(1200);
    expect(withinBudget(r, 50)).toBe(true);
  });

  test("the percentile is nearest-rank and the run's p95 is a p95", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 0.95)).toBe(96);
    expect(percentile(hundred, 0.5)).toBe(51);
    expect(percentile([7], 0.95)).toBe(7);
    // Positive control: a median passed off as the p95 is caught.
    expect(percentile(hundred, 0.5)).not.toBe(percentile(hundred, 0.95));
    expect(r.times).toHaveLength(r.questions);
    expect(r.p95).toBe(percentile(r.times, 0.95));
    expect(r.p50).toBe(percentile(r.times, 0.5));
    expect(r.max).toBe(r.times.at(-1) as number);
  });

  test("positive control: the latency gate trips when the budget is impossibly low", () => {
    expect(withinBudget(r, 0.000_001)).toBe(false);
  });

  test("[T3.12] every pack in the run stays inside the MCP budget", () => {
    expect(r.maxTokens).toBeLessThanOrEqual(MCP_BUDGET);
  });
});
