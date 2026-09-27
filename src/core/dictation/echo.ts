/**
 * The echo guard of dictation (docs/ux/DICTATION.md DC-E6, section 8.4): a recognizer given
 * context can answer with the context instead of the speech. Qwen3-ASR gets the learned terms as
 * `Technical terms: A, B, C.` once DC-L7's gate passes, and a remote akou may send its own, so an
 * answer that holds the wrapper text, or is mostly the glossary, is decoded again with no context.
 */

import { foldText } from "../vocab/correct.ts";

/** The words the context is wrapped in (DC-L7). */
export const CONTEXT_WRAPPER = "Technical terms:";

/** An answer holding at least this many glossary terms, and mostly them, is the list echoed. */
export const ECHO_MIN_TERMS = 3;

const WRAPPER = /technical\s+terms\s*:/i;

const words = (s: string): string[] =>
  foldText(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Whether `text` is the context echoed back rather than speech: it holds the wrapper text, or more
 * than half its words belong to at least `ECHO_MIN_TERMS` distinct glossary terms. One or two
 * terms said on their own are a dictation, not an echo.
 */
export function isEcho(text: string, glossary: readonly string[] = []): boolean {
  if (WRAPPER.test(text)) return true;
  const said = words(text);
  if (said.length === 0 || glossary.length < ECHO_MIN_TERMS) return false;
  const byWord = new Map<string, number>();
  glossary.forEach((g, i) => {
    for (const w of words(g)) byWord.set(w, i);
  });
  const terms = new Set<number>();
  let inGlossary = 0;
  for (const w of said) {
    const i = byWord.get(w);
    if (i === undefined) continue;
    inGlossary++;
    terms.add(i);
  }
  return terms.size >= ECHO_MIN_TERMS && inGlossary / said.length > 0.5;
}
