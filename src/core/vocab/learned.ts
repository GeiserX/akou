/**
 * Telling an agent what a fix taught akou (docs/DESIGN.md section 5.4, "Telling the agent"). A fix
 * changes how lines render, not when they last changed, so a follower reading from a cursor would
 * keep the old spelling of lines it read before. Each `vocab.learned` revision after the cursor is
 * one item of the read answer's `learned` field, and one line in `akou_read`, `akou tail` and the
 * notes of `akou_context`.
 */

import { formatWall } from "../log/clock.ts";
import type { LearnedKept } from "../log/events.ts";
import type { LearnedChange } from "../log/fold.ts";

/** One item of `learned`: a term learned, renamed (`was`) or taken back (`term` null). */
export interface LearnedItem {
  term: string | null;
  was?: string;
  heard: string[];
  by: string;
  /** Local wall-clock time of the change. */
  time: string;
  lines?: number;
  kept?: LearnedKept;
}

export function learnedItem(x: LearnedChange, tz: string): LearnedItem {
  return {
    term: x.term,
    ...(x.was ? { was: x.was } : {}),
    heard: x.heard,
    by: x.by,
    time: formatWall(x.t, tz),
    ...(x.lines !== undefined ? { lines: x.lines } : {}),
    ...(x.kept ? { kept: x.kept } : {}),
  };
}

function who(by: string, start = true): string {
  if (by === "user") return start ? "The user" : "the user";
  if (by.startsWith("agent:")) return `${start ? "An" : "an"} agent (${by.slice("agent:".length)})`;
  return "akou";
}

/**
 * The line an agent reads for one item:
 * `The user taught akou "Vercel" (heard "versal") at 15:41:07: 4 lines now read Vercel, lines you
 * read before included. Spell it that way.`
 */
export function learnedNote(x: LearnedItem): string {
  const heard = x.heard.length > 0 ? ` (heard ${x.heard.map((h) => `"${h}"`).join(", ")})` : "";
  if (x.term === null) {
    const back =
      x.heard.length > 0
        ? `those lines read ${x.heard.map((h) => `"${h}"`).join(", ")} again`
        : "those lines read as they were heard again";
    return `${who(x.by)} took back "${x.was ?? ""}" at ${x.time}: ${back}.`;
  }
  const what = x.was
    ? `renamed "${x.was}" to "${x.term}"${heard}`
    : `taught akou "${x.term}"${heard}`;
  const n = x.lines ?? 0;
  const lines =
    n === 0
      ? ""
      : n === 1
        ? `: 1 line now reads ${x.term}, even if you read it before`
        : `: ${n} lines now read ${x.term}, lines you read before included`;
  return `${who(x.by)} ${what} at ${x.time}${lines}. Spell it that way.`;
}

/** At most this many learned terms are listed in a context pack, newest first. */
export const LEARNED_IN_PACK = 5;

/**
 * The terms fixes taught akou in this call, as akou's note in a context pack: each term once, its
 * latest change, newest first, at most five. Empty when no fix taught one.
 */
export function learnedPackLines(changes: readonly LearnedChange[], tz: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = changes.length - 1; i >= 0 && out.length < LEARNED_IN_PACK; i--) {
    const x = changes[i] as LearnedChange;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    const it = learnedItem(x, tz);
    const by = who(it.by, false);
    const heard = it.heard.length > 0 ? ` (heard ${it.heard.map((h) => `"${h}"`).join(", ")})` : "";
    out.push(
      it.term === null
        ? `- "${it.was ?? ""}"${heard}: taken back by ${by} at ${it.time}; those lines read as heard.`
        : it.was
          ? `- "${it.term}"${heard}: renamed from "${it.was}" by ${by} at ${it.time}. Spell it that way.`
          : `- "${it.term}"${heard}: taught by ${by} at ${it.time}. Spell it that way.`,
    );
  }
  return out.length > 0 ? ["Words fixes taught akou in this call, newest first:", ...out] : [];
}
