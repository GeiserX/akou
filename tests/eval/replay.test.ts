import { describe, expect, test } from "bun:test";
import { MCP_BUDGET } from "../../src/main/query/context.ts";
import { synthCall, synthQuestions } from "../synth.ts";
import { formatReport, replay } from "./replay.ts";

describe("replay evaluation, synthetic (DESIGN 5.4, ROADMAP M1)", () => {
  const call = synthCall({ hours: 3, seed: 42 });
  const questions = synthQuestions(call);
  const now = call.end + 60_000;

  // A smoke check, not the ROADMAP M1 number: every recall and speaker question here carries a
  // codename that occurs once in the call, so BM25 finds it by a unique token. The 85 % criterion
  // is measured by the same harness on real calls, whose transcripts stay outside the repository.
  test("smoke: the answering segment is in a bounded pack for at least 85 % of synthetic questions", () => {
    const r = replay(call.events, questions, { now });
    console.log(`eval (synthetic smoke check, not the M1 number): ${formatReport(r)}`);
    expect(r.total).toBeGreaterThanOrEqual(50);
    expect(new Set(questions.map((q) => q.kind)).size).toBeGreaterThanOrEqual(5);
    expect(r.overBound).toBe(0);
    expect(r.maxTokens).toBeLessThanOrEqual(MCP_BUDGET);
    expect(r.rate).toBeGreaterThanOrEqual(0.85);
  });

  test("positive control: packs built with a huge budget are counted over the bound", () => {
    const r = replay(call.events, questions.slice(0, 5), { now, budget: 100_000 });
    expect(r.overBound).toBeGreaterThan(0);
    expect(formatReport(r)).toContain("over the bound");
  });

  test("positive control: gold ids that point at the wrong segments score near zero", () => {
    // Each question keeps its text but its gold moves to a segment an hour away, so a harness that
    // passed everything regardless would be caught.
    const ids = call.events.filter((e) => e.type === "seg").map((e) => (e as { id: string }).id);
    const shifted = questions.map((q) => ({
      ...q,
      gold: q.gold.map(
        (g) => ids[(ids.indexOf(g) + Math.floor(ids.length / 3)) % ids.length] as string,
      ),
    }));
    const r = replay(call.events, shifted, { now });
    expect(r.rate).toBeLessThan(0.3);
  });
});
