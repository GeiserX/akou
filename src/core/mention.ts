/**
 * Whether a line says the user's name (docs/ux/PROGRAMMABILITY.md PG-S4): any word of `user.name`
 * as a whole word, ignoring case and accents, so "Ana García" is mentioned by "ana" and "Garcia"
 * but not by "Anabel". `akou events --mention` uses it; the window's alert (W6.11) is meant to.
 */

/** Lower case with the accents taken off: "García" and "garcia" are one word. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of a name worth matching: two letters or more, folded. */
export function nameWords(name: string): string[] {
  return [...new Set(fold(name).match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => w.length >= 2);
}

/** True when `text` holds one of `words` (from `nameWords`) as a whole word. */
export function mentions(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const said = new Set(fold(text).match(/[\p{L}\p{N}]+/gu) ?? []);
  return words.some((w) => said.has(w));
}
