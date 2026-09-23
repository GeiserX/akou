import { describe, expect, test } from "bun:test";
import { runPackBench, withinBudget } from "../scripts/bench-pack.ts";
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

  test("positive control: the latency gate trips when the budget is impossibly low", () => {
    expect(withinBudget(r, 0.000_001)).toBe(false);
  });

  test("[T3.12] every pack in the run stays inside the MCP budget", () => {
    expect(r.maxTokens).toBeLessThanOrEqual(MCP_BUDGET);
  });
});
