/**
 * Harness session reuse, measured (docs/DESIGN.md section 5.3, ROADMAP M2: tokens per follow-up
 * question through the harness at least 40 % lower with `--resume` than without, or the feature
 * stays off).
 *
 * The method, so the number can be reproduced:
 *
 * 1. A synthetic call from a fixed seed, short enough for whole-call mode (the only mode reuse
 *    applies to), with its last lines held back.
 * 2. The same questions asked twice through the user's Claude Code: once with every question a
 *    fresh run (the default), once in one kept session (`--session-id`, then `--resume`). Between
 *    questions three held-back lines are appended, the way a live call grows, identically both
 *    ways.
 * 3. Each run's tokens are read from Claude Code's own `result` event: input, cache writes, cache
 *    reads and output, all counted (`src/main/llm/reuse.ts` says why cache reads count in full).
 * 4. The first question is left out both ways; the mean over the follow-ups decides.
 *
 * This runs the real harness and spends the user's subscription, so it refuses to start without
 * `--yes`. No test runs it; `tests/session-reuse.test.ts` checks the method on fixtures.
 *
 *   bun scripts/measure-resume.ts --yes [--questions 6] [--harness /path/to/claude]
 */

import { parseArgs } from "node:util";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { discoverHarnesses, HarnessProvider, pickHarness } from "../src/main/llm/harness.ts";
import type { Usage } from "../src/main/llm/provider.ts";
import { reuseVerdict } from "../src/main/llm/reuse.ts";
import { ask, MemorySessions } from "../src/main/query/ask.ts";
import { CallQuery } from "../src/main/query/context.ts";
import { synthCall } from "../tests/synth.ts";

const QUESTIONS = [
  "catch me up",
  "what did Ben say about the deploy?",
  "what decisions so far?",
  "who owns the next step?",
  "what was said in the last 5 minutes?",
  "any open questions?",
  "what did Carla say?",
  "action items so far",
];

async function run(
  provider: HarnessProvider,
  questions: readonly string[],
  reuse: boolean,
): Promise<{ usage: Usage[]; sent: number[] }> {
  const syn = synthCall({ hours: 0.4, seed: 5, facts: 4, tailLines: questions.length * 3 });
  const view = fold(syn.events);
  const q = new CallQuery(view);
  const tail = [...syn.tail];
  let seq = view.lastSeq;
  const sessions = reuse ? new MemorySessions((id) => HarnessProvider.endSession(id)) : undefined;
  const usage: Usage[] = [];
  const sent: number[] = [];
  for (const question of questions) {
    const r = await ask({
      q,
      question,
      now: syn.end,
      provider,
      by: "user",
      sessions,
      timeoutMs: 180_000,
      write: async (d) => {
        const draft = typeof d === "function" ? d(view) : d;
        const e = { ...draft, seq: ++seq, t: Date.now() } as LogEvent;
        view.apply(e);
        return e;
      },
    });
    if (!r.answered || !r.usage) throw new Error(`no answer or no usage: ${r.reason ?? r.text}`);
    if (q.context(question, { now: syn.end, surface: "app" }).mode !== "whole") {
      throw new Error("the synthetic call is too long for whole-call mode");
    }
    usage.push(r.usage);
    sent.push(r.sent ?? 0);
    for (const e of tail.splice(0, 3)) view.apply({ ...e, seq: ++seq } as LogEvent);
  }
  return { usage, sent };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      yes: { type: "boolean" },
      questions: { type: "string" },
      harness: { type: "string" },
    },
  });
  if (!values.yes) {
    console.error(
      "measure-resume runs your Claude Code and spends your subscription; run it with --yes",
    );
    return 64;
  }
  const n = Math.max(3, Math.min(QUESTIONS.length, Number(values.questions ?? 6)));
  const found = await discoverHarnesses(process.env);
  const target = pickHarness("claude", values.harness ?? "", found);
  if ("none" in target) {
    console.error(target.none);
    return 69;
  }
  const provider = new HarnessProvider({ target: () => target });
  const questions = QUESTIONS.slice(0, n);
  const without = await run(provider, questions, false);
  const withReuse = await run(provider, questions, true);
  const verdict = reuseVerdict(without.usage, withReuse.usage);
  console.log(
    JSON.stringify(
      {
        harness: `${provider.label()}`,
        questions,
        without,
        with: withReuse,
        verdict,
        method:
          "tokens per follow-up = input + cache writes + cache reads + output from the harness's result event; first question excluded; mean over follow-ups",
      },
      null,
      2,
    ),
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
