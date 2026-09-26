/**
 * The draft box (docs/ux/DICTATION.md section 5.2, DC-S1): where a dictation lands when you want to
 * read it before it goes anywhere. Enter inserts into the app captured when the session began,
 * Ctrl+Enter (Cmd+Enter on macOS) inserts and presses the send key, Shift+Enter is a newline, and
 * Escape discards. Copy and Retry with another engine sit below.
 *
 * Words the engine was unsure of are underlined, from its word confidences; an engine that gives
 * none gets the note `no confidence from this engine` and no underline. A click on an underlined
 * word that the other engine heard differently offers that reading, and picking it is an edit like
 * any other. The underlines are drawn behind the field, in a copy of its text with the same box, so
 * the field stays a plain textarea.
 */

import { mountChip } from "./dictation-chip.ts";
import type { DraftOpen, DraftRpc } from "./dictation-protocol.ts";
import { h, replace } from "./dom.ts";
import type { Chip, ChipAnswer } from "./pill-protocol.ts";

/** Below this confidence a word is underlined. */
export const LOW_CONFIDENCE = 0.5;

type Requests = DraftRpc["bun"]["requests"];
type Params<K extends keyof Requests> = Requests[K]["params"];

export interface DraftTransport {
  insert(p: Params<"insert">): void;
  discard(p: Params<"discard">): void;
  copy(p: Params<"copy">): void;
  retry(p: Params<"retry">): void;
  chip(a: ChipAnswer): void;
}

export interface DraftSink {
  open(d: DraftOpen): void;
  chip(c: Chip): void;
}

/** An underlined span of the field: where it is now, and what the other engine heard. */
interface Mark {
  start: number;
  end: number;
  alt: string[];
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`the draft page has no #${id}`);
  return e as T;
}

/** The low-confidence words, found in order in the text. */
export function lowMarks(text: string, words: DraftOpen["words"]): Mark[] {
  const out: Mark[] = [];
  let at = 0;
  for (const w of words ?? []) {
    if (!w.w) continue;
    const i = text.indexOf(w.w, at);
    if (i < 0) continue;
    at = i + w.w.length;
    if (typeof w.c === "number" && w.c < LOW_CONFIDENCE) {
      out.push({ start: i, end: at, alt: (w.alt ?? []).filter((a) => a && a !== w.w) });
    }
  }
  return out;
}

/**
 * The marks after an edit from `before` to `after`: a mark before the changed region stays, one
 * after it moves by the change in length, and one the edit touched is gone (the user fixed it).
 */
export function shiftMarks(marks: readonly Mark[], before: string, after: string): Mark[] {
  let p = 0;
  const n = Math.min(before.length, after.length);
  while (p < n && before[p] === after[p]) p++;
  let s = 0;
  while (s < n - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const oldEnd = before.length - s;
  const delta = after.length - before.length;
  const out: Mark[] = [];
  for (const m of marks) {
    if (m.end <= p) out.push(m);
    else if (m.start >= oldEnd) out.push({ ...m, start: m.start + delta, end: m.end + delta });
  }
  return out;
}

export function mountDraft(t: DraftTransport): DraftSink {
  const field = el<HTMLTextAreaElement>("draft-text");
  const marksEl = el("draft-marks");
  const alts = el("draft-alts");
  const chip = mountChip(el("chip"), (a) => t.chip(a));
  let d: DraftOpen | null = null;
  let marks: Mark[] = [];
  let text = "";
  /** Answered: the box waits for the main side to close it or open the next draft. */
  let done = false;

  const mac = () => d?.platform === "darwin";

  const paintMarks = () => {
    const parts: (string | HTMLElement)[] = [];
    let at = 0;
    for (const m of marks) {
      parts.push(text.slice(at, m.start), h("mark", {}, text.slice(m.start, m.end)));
      at = m.end;
    }
    // A trailing newline needs a character after it, or the copy is a line short of the field.
    parts.push(`${text.slice(at)}​`);
    replace(marksEl, ...parts);
    marksEl.scrollTop = field.scrollTop;
  };

  const answer = (fn: () => void) => {
    if (!d || done) return;
    done = true;
    fn();
  };

  const insert = (send: boolean) =>
    answer(() => t.insert({ id: (d as DraftOpen).id, text: field.value, send }));
  const discard = () => answer(() => t.discard({ id: (d as DraftOpen).id }));

  field.addEventListener("input", () => {
    marks = shiftMarks(marks, text, field.value);
    text = field.value;
    alts.hidden = true;
    paintMarks();
  });
  field.addEventListener("scroll", () => {
    marksEl.scrollTop = field.scrollTop;
  });
  field.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      discard();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.altKey) return;
    const mod = mac() ? e.metaKey : e.ctrlKey;
    const other = mac() ? e.ctrlKey : e.metaKey;
    if (other) return;
    e.preventDefault();
    insert(mod);
  });
  field.addEventListener("click", () => {
    const at = field.selectionStart;
    const m = marks.find((x) => x.start <= at && at <= x.end && x.alt.length > 0);
    if (!m) {
      alts.hidden = true;
      return;
    }
    replace(
      alts,
      h("span", { class: "hint" }, "Other engine heard:"),
      ...m.alt.map((a) =>
        h(
          "button",
          {
            type: "button",
            class: "alt",
            role: "menuitem",
            on: {
              click: () => {
                field.setRangeText(a, m.start, m.end, "end");
                field.dispatchEvent(new Event("input"));
                field.focus();
              },
            },
          },
          a,
        ),
      ),
    );
    alts.hidden = false;
  });
  el("draft-close").addEventListener("click", discard);
  el("draft-copy").addEventListener("click", () => {
    if (d) t.copy({ id: d.id, text: field.value });
  });
  el("draft-retry").addEventListener("click", () => {
    const engine = el<HTMLSelectElement>("draft-retry-engine").value;
    if (d && engine) t.retry({ id: d.id, engine });
  });

  return {
    open: (next) => {
      chip.dismiss();
      d = next;
      done = false;
      text = next.text;
      field.value = text;
      marks = lowMarks(text, next.words);
      const scored = (next.words ?? []).some((w) => typeof w.c === "number");
      el("draft-noconf").hidden = scored;
      alts.hidden = true;
      el("draft-to").textContent = next.to ? `to: ${next.to}` : "";
      el("draft-engine").textContent = `${next.engine} ${(next.ms / 1000).toFixed(1)} s`;
      replace(
        el("draft-retry-engine"),
        ...next.engines.map((e) => h("option", { value: e }, `Retry with ${e}`)),
      );
      el("draft-retry-engine").hidden = next.engines.length === 0;
      el("draft-retry").hidden = next.engines.length === 0;
      const m = mac() ? "Cmd" : "Ctrl";
      el("draft-keys").textContent =
        `Enter: insert · ${m}+Enter: insert and send · Shift+Enter: newline · Esc: discard`;
      el("draft").hidden = false;
      paintMarks();
      if (next.focus) {
        field.focus();
        field.setSelectionRange(text.length, text.length);
      }
    },
    chip: (c) => chip.show(c),
  };
}
