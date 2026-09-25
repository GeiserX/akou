/**
 * The ceiling on every MCP answer (PG-M5): 8,000 tokens, counted with the pack's estimator.
 * Claude Code warns at 10,000, so 8,000 leaves headroom. The text and the structured result are
 * each held to it, because a harness may show the model either one.
 *
 * The tools that can grow stay small by design: `akou_get_call` pages, `akou_read` keeps the newest
 * lines that fit, `akou_list_calls` stops at its budget, `akou_context` has a budget. `capAnswer`
 * is the last guard, on every tool's answer: it cuts a long answer on a line, closes a `<call-text>`
 * block the cut left open, and says outside the block what was left out. An answer it cannot cut
 * on a line (one long JSON line) becomes an error that says to ask for less, never a huge answer.
 */

import { CALL_TEXT_CLOSE, CALL_TEXT_OPEN, estimateTokens } from "../query/render.ts";

export const MAX_ANSWER_TOKENS = 8000;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const note = (left: number) =>
  `[cut here: this answer reached akou's 8,000-token ceiling; ${left} lines left out. Ask for less: a smaller limit, a narrower call, time range or query, or page with a cursor.]`;

/**
 * `text` cut on a line to fit `max` tokens with the note, the call-text block closed if the cut
 * fell inside it. Null when not even the first line fits.
 */
export function cutText(text: string, max: number): string | null {
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  let open = false;
  // The note and a closing marker, reserved up front so the result always fits.
  const reserve = estimateTokens(note(lines.length)) + estimateTokens(CALL_TEXT_CLOSE) + 2;
  for (const l of lines) {
    const t = estimateTokens(l) + 1;
    if (used + t + reserve > max) break;
    kept.push(l);
    used += t;
    if (l === CALL_TEXT_OPEN) open = true;
    else if (l === CALL_TEXT_CLOSE) open = false;
  }
  const left = lines.length - kept.length;
  // Nothing of substance fits: only headers, or a block opened with nothing in it.
  if (kept.length === 0 || (open && kept.at(-1) === CALL_TEXT_OPEN)) return null;
  return [...kept, ...(open ? [CALL_TEXT_CLOSE] : []), note(left)].join("\n");
}

const tooLarge = (tokens: number): ToolResult => ({
  content: [
    {
      type: "text",
      text: `answer_too_large: the answer is about ${tokens} tokens, over akou's 8,000-token ceiling, and cannot be cut on a line. Ask for less: a smaller limit, a narrower call, time range or query.`,
    },
  ],
  isError: true,
});

/** Holds an answer to the ceiling: unchanged when it fits, cut on a line, or an error. */
export function capAnswer(r: ToolResult, max = MAX_ANSWER_TOKENS): ToolResult {
  const text = r.content.map((c) => c.text).join("\n");
  const textTokens = estimateTokens(text);
  const sc = r.structuredContent;
  const scTokens = sc === undefined ? 0 : estimateTokens(JSON.stringify(sc));
  if (textTokens <= max && scTokens <= max) return r;
  if (r.isError) return tooLarge(Math.max(textTokens, scTokens));
  const cut = textTokens <= max ? text : cutText(text, max);
  if (cut === null) return tooLarge(textTokens);
  let data = sc;
  if (sc !== undefined && scTokens > max) {
    // Cut the long strings (call text); what else is typed stays as it is.
    data = { ...sc };
    const rest = estimateTokens(
      JSON.stringify(
        Object.fromEntries(Object.entries(sc).filter(([, v]) => typeof v !== "string")),
      ),
    );
    const strings = Object.entries(sc).filter(([, v]) => typeof v === "string");
    const share = Math.floor((max - rest - 50 * strings.length) / Math.max(1, strings.length));
    for (const [k, v] of strings) {
      // JSON escapes (a newline becomes two characters) cost more than the raw text.
      if (estimateTokens(JSON.stringify(v)) <= share) continue;
      const c = cutText(v as string, Math.floor(share / 1.25));
      if (c === null) return tooLarge(scTokens);
      data[k] = c;
    }
    if (estimateTokens(JSON.stringify(data)) > max) return tooLarge(scTokens);
  }
  return {
    content: [{ type: "text", text: cut }],
    ...(data !== undefined ? { structuredContent: data } : {}),
  };
}
