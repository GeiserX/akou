/**
 * The in-call upgrade's unit and how its words go back to the lines (ASR-7, docs/research/
 * asr-architecture.md section 3.2).
 *
 * The unit is an utterance: the streaming lines from one stop of the speaker to the next (a line
 * the engine closed because it heard nothing new, or a flush), at most `UTTERANCE_MAX_SECONDS`.
 * A line alone is too short a unit. The line cutter breaks at a 0.7 s gap between tokens, which
 * falls inside sentences, and a token's time trails its audio, so a line's audio cuts words at
 * both ends. Parakeet on each line read 16.63 % WER on 20 FLEURS English clips against 7.34 for
 * the stream, and 5.62 on the whole clips.
 *
 * Qwen's words for the utterance are then cut back into its lines by text, not by time: they are
 * aligned with the stream's words (rover.ts's `build`), and each goes to the line of the stream
 * word it aligns with. A word the stream did not have goes with the word before it, or to the
 * first line when none comes before it.
 *
 * Qwen reviews once a minute, not per utterance: the utterances closed in the last minute go in
 * one request, whole, at most `REVIEW_CAP_SECONDS` of audio each (`reviewBatches`). On FLEURS
 * clips joined into 27 and 34 minute calls that read 10.19 and 4.19 % WER against 11.36 and 4.32
 * per utterance, with 0.9 requests a minute instead of 4.7 to 6.2, and the reviewed text about 45 s
 * after the words instead of 6 to 9 s (docs/research/asr-architecture.md section 3.2). Its words are cut back into all of the request's lines as above.
 */

import { ASR_RATE } from "./engine.ts";
import { build, wordKey } from "./rover.ts";

/** The longest utterance the upgrade decodes, seconds: the final pass's longest span. */
export const UTTERANCE_MAX_SECONDS = 30;
/** How often Qwen reviews the utterances closed since its last review, seconds. */
export const REVIEW_EVERY_SECONDS = 60;
/** The most audio one review request carries, seconds; more goes in the next request. */
export const REVIEW_CAP_SECONDS = 90;
/** Silence between two utterances in one request, seconds, so their words do not run together. */
export const REVIEW_GAP_SECONDS = 0.2;

/**
 * Closed utterances in requests for Qwen, in order: whole utterances, each request at most
 * `capSeconds` of audio (an utterance longer than that alone goes alone).
 */
export function reviewBatches<T extends { samples: Float32Array }>(
  utts: readonly T[],
  capSeconds = REVIEW_CAP_SECONDS,
): T[][] {
  const cap = capSeconds * ASR_RATE;
  const out: T[][] = [];
  let cur: T[] = [];
  let n = 0;
  for (const u of utts) {
    if (cur.length > 0 && n + u.samples.length > cap) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(u);
    n += u.samples.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** A request's utterances as one audio, `REVIEW_GAP_SECONDS` of silence between them. */
export function joinUtterances(parts: readonly Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0] as Float32Array;
  const gap = Math.round(REVIEW_GAP_SECONDS * ASR_RATE);
  const out = new Float32Array(
    parts.reduce((a, p) => a + p.length, 0) + gap * Math.max(0, parts.length - 1),
  );
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length + gap;
  }
  return out;
}

/** Each line's share of `words`, in line order; a line may get none. */
export function splitToLines(lines: readonly string[], words: readonly string[]): string[] {
  const out = lines.map(() => [] as string[]);
  if (out.length === 0) return [];
  const stream = lines.flatMap((t, line) =>
    t
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => ({ w, line })),
  );
  const key = (w: string) => wordKey(w) || w;
  const cols = build([
    { words: stream.map((x) => key(x.w)), conf: [] },
    { words: words.map(key), conf: [] },
  ]);
  let line = 0;
  for (const [s, n] of cols) {
    if (s && s.i >= 0) line = (stream[s.i] as { line: number }).line;
    if (n && n.i >= 0) (out[line] as string[]).push(words[n.i] as string);
  }
  return out.map((ws) => ws.join(" "));
}
