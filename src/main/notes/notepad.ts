/**
 * The notepad (docs/DESIGN.md section 5.1): one line per `note` event, timestamped against the log.
 *
 * - `w` is the wall time of the first keystroke and `afterSeq` the last log entry visible then, so
 *   a line such as "build -> new box?" can be tied to what was being said at that moment.
 * - The author is `user` or `agent:<client>`; the window renders the two differently, and
 *   enhancement keeps only the user's own lines word for word (TRAPS "Agent-authored notes
 *   indistinguishable from the user's").
 * - An edit is the same id with `rev + 1`; a delete is a `note.del`. Nothing is rewritten.
 * - Markdown-lite markers: `- ` (bullet), `[] ` (action), `? ` (open question), `# ` (section).
 *
 * These functions build drafts from the call's view; the caller appends them through the call's
 * one writer, building the draft at the moment of the append so ids and revisions cannot race.
 */

import { formatWall } from "../../core/log/clock.ts";
import type { EventDraft } from "../../core/log/events.ts";
import type { CallView, Line, NoteView } from "../../core/log/fold.ts";

export const MAX_NOTE_CHARS = 4000;

export type NoteKind = "text" | "bullet" | "action" | "question" | "section";

export class NoteError extends Error {
  override name = "NoteError";
  constructor(
    readonly code: "bad_field" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export function checkNoteText(text: string): string {
  const t = text.trim();
  if (t === "") throw new NoteError("bad_field", "text is empty");
  if (t.length > MAX_NOTE_CHARS) {
    throw new NoteError("bad_field", `text is over ${MAX_NOTE_CHARS} characters`);
  }
  return t;
}

/** The marker a line starts with. */
export function noteKind(text: string): NoteKind {
  if (text.startsWith("[] ") || text.startsWith("[ ] ")) return "action";
  if (text.startsWith("? ")) return "question";
  if (text.startsWith("# ")) return "section";
  if (text.startsWith("- ")) return "bullet";
  return "text";
}

/** Next id for an item kind (`n0012`): the seq the event will get, so ids never collide. */
export function nextNoteId(view: CallView): string {
  return `n${String(view.lastSeq + 1).padStart(4, "0")}`;
}

/**
 * A new line. `w` defaults to now and `afterSeq` to the log's end; the window passes the time of
 * the first keystroke and what was visible then.
 */
export function noteDraft(
  view: CallView,
  o: { text: string; by: string; now: number; w?: number; afterSeq?: number },
): EventDraft {
  return {
    type: "note",
    id: nextNoteId(view),
    rev: 1,
    text: checkNoteText(o.text),
    w: o.w ?? o.now,
    afterSeq: Math.min(o.afterSeq ?? view.lastSeq, view.lastSeq),
    by: o.by,
  };
}

function findNote(view: CallView, id: string): NoteView {
  const n = view.notes().find((x) => x.id === id);
  if (!n) throw new NoteError("not_found", `no note ${id}`);
  return n;
}

/**
 * An edit: the same id, `rev + 1`, the line's time kept. The editor becomes the line's author, so
 * a user's line an agent rewrote is no longer kept verbatim as the user's.
 */
export function noteEditDraft(view: CallView, id: string, text: string, by: string): EventDraft {
  const n = findNote(view, id);
  return {
    type: "note",
    id: n.id,
    rev: n.rev + 1,
    text: checkNoteText(text),
    w: n.w,
    afterSeq: n.afterSeq,
    by,
  };
}

export function noteDeleteDraft(view: CallView, id: string, by: string): EventDraft {
  findNote(view, id);
  return { type: "note.del", id, by };
}

/**
 * The transcript around a note: from `beforeMs` before its time to `afterMs` after it, in the
 * `best` view. Enhancement reads each user line with the talk that surrounded it.
 */
export function linesAround(
  lines: readonly Line[],
  w: number,
  beforeMs = 90_000,
  afterMs = 30_000,
): Line[] {
  return lines.filter((l) => l.w1 >= w - beforeMs && l.w0 <= w + afterMs);
}

/** One notepad line for a model or a person: `15:41:07 (you) build -> new box?`. */
export function renderNote(n: NoteView, tz: string): string {
  const who = n.author === "human" ? "you" : `agent ${n.client ?? n.by.slice(6)}`;
  return `${formatWall(n.w, tz)} (${who}) ${n.text}`;
}
