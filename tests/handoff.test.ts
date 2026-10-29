/**
 * The hand-off to the user's own agent when akou's provider cannot answer (TRAPS "Provider
 * unavailable answered with nothing"): the question word for word first, a reference the agent can
 * follow, a short excerpt last, and none of akou's notes to an agent.
 */

import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { NoneProvider } from "../src/main/llm/none.ts";
import { type Provider, ProviderError } from "../src/main/llm/provider.ts";
import { ask } from "../src/main/query/ask.ts";
import { CallQuery } from "../src/main/query/context.ts";
import { contextCommand, HANDOFF_MAX_LINES } from "../src/main/query/handoff.ts";
import { CALL_TEXT_OPEN } from "../src/main/query/render.ts";
import { LogBuilder, T0 } from "./helpers.ts";

const S = 1000;
const MIN = 60 * S;
const ID = "01J8Z6Q4M2VX0K7B3D4E5F6G7H";

/** A live call long enough for a retrieval pack, with no memo, so the pack asks for one. */
function staleMemoCall() {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  // Too long for a whole-call pack: the retrieval pack is the one that carries akou's notes.
  for (let i = 0; i < 1200; i++) {
    const text =
      i === 400
        ? "Ben could not find the word, he meant the deploy freeze"
        : `line ${i} about topic${i % 7} and the weekly numbers for the quarter, with a few more words`;
    b.seg({
      id: `l${String(i + 1).padStart(6, "0")}`,
      spk: i % 2 ? "c2" : "c1",
      text,
      w0: T0 + i * 2 * S,
    });
  }
  const view = fold(b.events);
  const q = new CallQuery(view);
  const add = (draft: Parameters<LogBuilder["add"]>[0]) => {
    const e = b.add(draft);
    view.apply(e);
    return e;
  };
  return { q, view, add, now: T0 + 41 * MIN };
}

const QUESTION = 'Ben can\'t find a word, what is it? (check what he says about "freeze")';

/** What a hand-off that lands as the user's message must hold; empty when it holds it. */
function problems(text: string, question: string): string[] {
  const out: string[] = [];
  if (!text.startsWith(`${question}\n`)) out.push("the question is not the first line");
  if (!text.includes(contextCommand(question, ID))) out.push("no akou context command");
  if (!text.includes(`"call":"${ID}"`)) out.push("no akou_context call");
  if (/akou_memo_put|memo is stale/.test(text)) out.push("an agent hint reads as the user's ask");
  if (/Question analysis/.test(text)) out.push("only the analysis of the question");
  const quoted = text.split("\n").filter((l) => /^ {2}#l\d{6}/.test(l)).length;
  if (quoted > HANDOFF_MAX_LINES) out.push(`${quoted} pasted lines, not an excerpt`);
  return out;
}

describe("[decision] Provider unavailable answered with nothing: the hand-off carries the question", () => {
  const providers: [string, Provider][] = [
    ["no provider", new NoneProvider()],
    [
      "a provider that fails",
      {
        id: "harness",
        available: async () => ({ ok: true, detail: "fake" }),
        complete: async () => {
          throw new ProviderError("exhausted", "Claude Code reported its usage limit is reached");
        },
      },
    ],
  ];
  for (const [name, provider] of providers) {
    test(`${name}: the question first, a reference to follow, a short excerpt, no agent hints`, async () => {
      const c = staleMemoCall();
      const r = await ask({
        q: c.q,
        question: QUESTION,
        now: c.now,
        provider,
        by: "user",
        write: async (d) => c.add(typeof d === "function" ? d(c.view) : d) as LogEvent,
      });
      expect(r.answered).toBe(false);
      expect(problems(r.handoff ?? "", QUESTION)).toEqual([]);
      expect(r.handoff).toContain("deploy freeze");
      expect(r.handoff).toContain(CALL_TEXT_OPEN);
      // The route that failed is named, for the one line the ask box shows.
      expect(r.route).toBe(
        provider.id === "none" ? "akou's assistant" : "the coding agent akou runs",
      );
    });
  }

  test("positive control: the pasted pack fails the same check", () => {
    const c = staleMemoCall();
    const pack = c.q.context(QUESTION, { now: c.now, surface: "app" });
    // The pack this call builds asks the agent for a memo, which is what leaked as the user's ask.
    expect(pack.text).toContain("akou_memo_put");
    const found = problems(pack.text, QUESTION);
    expect(found).toContain("the question is not the first line");
    expect(found).toContain("an agent hint reads as the user's ask");
    expect(found).toContain("only the analysis of the question");
  });

  test("the command quotes what a shell would expand", () => {
    expect(contextCommand('say "hi" $HOME `x` \\', null)).toBe(
      'akou context "say \\"hi\\" \\$HOME \\`x\\` \\\\"',
    );
    expect(contextCommand("what?", ID)).toBe(`akou context "what?" -c ${ID}`);
  });
});
