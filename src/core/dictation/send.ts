/**
 * The spoken send (docs/ux/DICTATION.md DC-S5): with `dictation.spokenSend` on, a dictation that
 * ends in "send it" (Spanish "envíalo") leaves those words out and presses the send key, as Enter
 * during the session would. The phrase counts only at the very end and only after other words, so
 * "I'll send it tomorrow" stays text, and so does "send it" said on its own.
 */

/** The phrases, compared without case; the Spanish one with or without its accent. */
export const SEND_PHRASES: readonly string[] = ["send it", "envíalo", "envialo"];

const PHRASE = new RegExp(
  `(?:^|[\\s,;:]+)(?:${SEND_PHRASES.map((p) => p.replace(/ /g, "\\s+")).join("|")})[\\s.!?,;:]*$`,
  "iu",
);

/** The text without a closing "send it", and whether it had one. */
export function spokenSend(text: string): { text: string; send: boolean } {
  const m = PHRASE.exec(text);
  if (!m) return { text, send: false };
  // The phrase opens the text or follows a space or a comma, never the end of a word ("resend
  // it"); with nothing before it, it is text.
  const before = text.slice(0, m.index).trimEnd();
  if (before === "") return { text, send: false };
  return { text: before.replace(/[,;:]+$/u, ""), send: true };
}
