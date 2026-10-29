/**
 * The hand-off to the user's own agent (docs/DESIGN.md section 5.3, "When it cannot run"): what
 * "Copy context for my agent" puts on the clipboard, built here and nowhere else so every surface
 * hands over the same thing.
 *
 * It lands as the user's own message in their agent, so it says only what the user would:
 *
 * 1. The question, word for word, as the first line. Never only an analysis of it.
 * 2. A reference the agent can follow: the call's id, the span of the call the question is about,
 *    and the exact `akou context` command and `akou_context` call that fetch the pack. The pack is
 *    passed by reference, never pasted: a pasted pack is a wall of text that costs tokens and buries
 *    the question. When the question was logged, the `akou answer` command and `akou_answer` call
 *    that post the agent's answer back to the ask box.
 * 3. Last, for an agent that cannot reach akou, a short excerpt of the lines that matched, quoted as
 *    call text (PG-Z1). Never the whole window.
 *
 * akou's notes to an agent (a stale memo to write, tools to call) stay in the pack, which the agent
 * fetches itself; pasted as the user's message they read as the user's ask.
 */

import { formatLocalDate, formatWall } from "../../core/log/clock.ts";
import type { ExcerptBlock } from "../llm/none.ts";
import type { CallQuery, ContextPack } from "./context.ts";
import { quoteCallText } from "./render.ts";

/** The most excerpt lines a hand-off carries. */
export const HANDOFF_MAX_LINES = 8;

export interface HandoffInput {
  question: string;
  /** The call's id; null when there is none to name. */
  call: string | null;
  tz: string;
  /** The span of the call the pack covers, wall-clock ms. */
  window?: { from: number; to: number };
  excerpts: readonly ExcerptBlock[];
  /** The `ask` event's id, when the question was logged: the agent answers it back to the box. */
  ask?: string;
}

/**
 * `akou context '…' -c ID`, with the question in single quotes, where a shell expands nothing: no
 * `$`, no backticks, and no `!` history expansion in an interactive bash. An apostrophe closes the
 * quote, adds an escaped `'` and reopens it.
 */
export function contextCommand(question: string, call: string | null): string {
  const q = question.replace(/'/g, `'\\''`);
  return `akou context '${q}'${call ? ` -c ${call}` : ""}`;
}

/** The text handed to the user's agent: the question first, then where to read, then a short excerpt. */
export function agentHandoff(h: HandoffInput): string {
  const span = h.window
    ? `, the part from ${formatWall(h.window.from, h.tz, { seconds: false })} to ${formatWall(h.window.to, h.tz, { seconds: false })} on ${formatLocalDate(h.window.from, h.tz)} (${h.tz})`
    : "";
  const out = [
    h.question,
    "",
    `This is about a call recorded in akou${h.call ? `: call ${h.call}${span}` : span}.`,
    `Read what the call says before you answer: run \`${contextCommand(h.question, h.call)}\`, or call the akou_context tool with ${JSON.stringify(h.call ? { call: h.call, question: h.question } : { question: h.question })}.`,
  ];
  if (h.ask) {
    out.push(
      `Then post your answer to akou's ask box: run \`akou answer ${h.ask} '<your answer>'${h.call ? ` -c ${h.call}` : ""}\`, or call the akou_answer tool with ${JSON.stringify(h.call ? { call: h.call, ask: h.ask } : { ask: h.ask })} and your text.`,
    );
  }
  const lines: string[] = [];
  let left = HANDOFF_MAX_LINES;
  for (const b of h.excerpts) {
    if (left <= 0) break;
    const take = b.lines.slice(0, left);
    lines.push(b.citation, ...take.map((l) => `  ${l}`));
    left -= take.length;
  }
  if (lines.length > 0) {
    out.push(
      "",
      "If you cannot run akou, these are the lines that matched:",
      quoteCallText(lines.join("\n")),
    );
  }
  return out.join("\n");
}

/** The hand-off for a question asked of one call, from the pack built for it. */
export function handoffFor(
  q: CallQuery,
  question: string,
  pack: ContextPack,
  excerpts: readonly ExcerptBlock[],
  ask?: string,
): string {
  const first = pack.lines[0];
  const last = pack.lines.at(-1);
  return agentHandoff({
    question,
    call: q.view.call?.id ?? null,
    tz: q.tz,
    ...(first && last ? { window: { from: first.w0, to: last.w1 } } : {}),
    excerpts,
    ...(ask ? { ask } : {}),
  });
}
