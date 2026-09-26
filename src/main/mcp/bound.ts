/**
 * The ceiling on every MCP answer (PG-M5): 8,000 tokens, counted with the pack's estimator.
 * Claude Code warns at 10,000, so 8,000 leaves headroom. The text and the structured result are
 * each held to it, because a harness may show the model either one.
 *
 * The tools that can grow stay small by design: `akou_get_call` and `akou_get_notes` page,
 * `akou_read` keeps the newest lines that fit, `akou_list_calls` stops at its budget,
 * `akou_context` has a budget. `capAnswer` is the last guard, on every tool's answer: it cuts a
 * long answer on a line, closes a `<call-text>` block the cut left open, and says outside the block
 * what was left out and how to ask for less in that tool's own parameters. Quoted bodies put one
 * item per line so the cut always has somewhere to fall; an answer it still cannot cut becomes an
 * error, never a huge answer.
 */

import { CALL_TEXT_CLOSE, CALL_TEXT_OPEN, estimateTokens } from "../query/render.ts";

export const MAX_ANSWER_TOKENS = 8000;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** How to ask for less when a tool names no way of its own. */
export const ASK_FOR_LESS =
  "a smaller limit, a narrower call, time range or query, or page with a cursor";

const note = (left: number, less: string) =>
  `[cut here: this answer reached akou's 8,000-token ceiling; ${left} lines left out. Ask for less: ${less}.]`;

/**
 * `text` cut on a line to fit `max` tokens with the note, the call-text block closed if the cut
 * fell inside it. Null when not even the first line fits.
 */
export function cutText(text: string, max: number, less = ASK_FOR_LESS): string | null {
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  let open = false;
  // The note and a closing marker, reserved up front so the result always fits.
  const reserve = estimateTokens(note(lines.length, less)) + estimateTokens(CALL_TEXT_CLOSE) + 2;
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
  return [...kept, ...(open ? [CALL_TEXT_CLOSE] : []), note(left, less)].join("\n");
}

const tooLarge = (tokens: number, less: string): ToolResult => ({
  content: [
    {
      type: "text",
      text: `answer_too_large: the answer is about ${tokens} tokens, over akou's 8,000-token ceiling, and cannot be cut on a line. Ask for less: ${less}.`,
    },
  ],
  isError: true,
});

/**
 * Holds an answer to the ceiling: unchanged when it fits, cut on a line, or an error. `less` is how
 * this tool's caller asks for less, in the tool's own parameters.
 */
export function capAnswer(r: ToolResult, max = MAX_ANSWER_TOKENS, less = ASK_FOR_LESS): ToolResult {
  const text = r.content.map((c) => c.text).join("\n");
  const textTokens = estimateTokens(text);
  const sc = r.structuredContent;
  const scTokens = sc === undefined ? 0 : estimateTokens(JSON.stringify(sc));
  if (textTokens <= max && scTokens <= max) return r;
  if (r.isError) return tooLarge(Math.max(textTokens, scTokens), less);
  let body = text;
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
      const c = cutText(v as string, Math.floor(share / 1.25), less);
      if (c === null) return tooLarge(scTokens, less);
      data[k] = c;
      // The same call text in the text answer gets the same cut, so the two stay one block (PG-Z1).
      const at = body.indexOf(v as string);
      if (at >= 0) body = body.slice(0, at) + c + body.slice(at + (v as string).length);
    }
    if (estimateTokens(JSON.stringify(data)) > max) return tooLarge(scTokens, less);
  }
  const cut = estimateTokens(body) <= max ? body : cutText(body, max, less);
  if (cut === null) return tooLarge(textTokens, less);
  return {
    content: [{ type: "text", text: cut }],
    ...(data !== undefined ? { structuredContent: data } : {}),
  };
}
