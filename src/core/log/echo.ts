/**
 * Echo marking (DESIGN 3.1 step 7): without headphones the mic hears the call, so a remote
 * sentence comes back as a `you` line too. A mic line that repeats a call line is marked
 * `echo: true`: kept in the log, hidden from views and packs. One rule for the live path and the
 * final pass.
 *
 * The rule must not hide the user's own speech, so it is narrow: a person often reads back a
 * number or a name, which is short and said after the other side finished. A mic line is echo only
 * when it has at least `ECHO_MIN_TOKENS` words, the call line started first (or at the same time),
 * the mic line starts no later than `ECHO_WINDOW_MS` after the call line ends, and at least
 * `ECHO_MIN_SHARE` of the mic line's words are in the call line.
 */

import { tokenize } from "../vocab/correct.ts";

/** How far after the call line ends a mic line may start and still be its echo. */
export const ECHO_WINDOW_MS = 1500;
/** The share of the mic line's words that must be in the call line, in tenths: 7 is 70 %. */
export const ECHO_MIN_SHARE_TENTHS = 7;
/** A shorter mic line is never echo: two words read back are the user's. */
export const ECHO_MIN_TOKENS = 3;

/** What the rule reads of a line: its wall times and its text (null when retracted). */
export interface EchoLine {
  w0: number;
  w1: number;
  text: string | null;
}

/** Whether the mic line `mic` is the mic hearing the call line `call`. */
export function isEcho(mic: EchoLine, call: EchoLine): boolean {
  if (call.w0 > mic.w0) return false;
  if (mic.w0 > call.w1 + ECHO_WINDOW_MS) return false;
  const said = tokenize(mic.text ?? "").map((t) => t.folded);
  if (said.length < ECHO_MIN_TOKENS) return false;
  const pool = new Map<string, number>();
  for (const t of tokenize(call.text ?? "")) pool.set(t.folded, (pool.get(t.folded) ?? 0) + 1);
  let found = 0;
  for (const w of said) {
    const n = pool.get(w) ?? 0;
    if (n === 0) continue;
    found++;
    pool.set(w, n - 1);
  }
  return found * 10 >= said.length * ECHO_MIN_SHARE_TENTHS;
}
