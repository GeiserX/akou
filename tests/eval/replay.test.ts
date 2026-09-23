import { describe, expect, test } from "bun:test";
import { synthCall, synthQuestions } from "../synth.ts";
import { formatReport, replay } from "./replay.ts";

describe("replay evaluation, synthetic (DESIGN 5.4, ROADMAP M1)", () => {
  const call = synthCall({ hours: 3, seed: 42 });
  const questions = synthQuestions(call);
  const now = call.end + 60_000;

  test("the answering segment is in the pack for at least 85 % of questions", () => {
    const r = replay(call.events, questions, { now });
    console.log(`eval: ${formatReport(r)}`);
    expect(r.total).toBeGreaterThanOrEqual(50);
    expect(new Set(questions.map((q) => q.kind)).size).toBeGreaterThanOrEqual(5);
    expect(r.rate).toBeGreaterThanOrEqual(0.85);
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
