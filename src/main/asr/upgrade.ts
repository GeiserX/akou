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
 * The utterance's new words are then cut back into its lines by text, not by time: they are
 * aligned with the stream's words (rover.ts's `build`), and each goes to the line of the stream
 * word it aligns with. A word the stream did not have goes with the word before it, or to the
 * first line when none comes before it.
 */

import { build, wordKey } from "./rover.ts";

/** The longest utterance the upgrade decodes, seconds: the final pass's longest span. */
export const UTTERANCE_MAX_SECONDS = 30;

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
