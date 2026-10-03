/**
 * The draft box (docs/ux/DICTATION.md section 5.2, DC-S1): where a dictation lands when you want to
 * read it before it goes anywhere. Enter inserts into the app captured when the session began,
 * Ctrl+Enter (Cmd+Enter on macOS) inserts and presses the send key (and so does Enter in a box a
 * per-app rule opened with `draft-send`), Shift+Enter is a newline, and
 * Escape discards. Discard, Retry with another engine, Copy, Insert and Send sit below as buttons.
 * It is drawn as a sheet dropped from the island at the top (docs/ux/design-explorations/README.md):
 * the island says `Draft` and the audio's length, the sheet holds the field, where the text goes,
 * and the engine, where it ran, how long it took, the audio's length and the language. With two or
 * more of the user's languages and an engine that takes a forced one, the language chip is a
 * button: a click decodes the same audio again in the next language (akou-5v8), and the new reading
 * comes back as a new open, the chip ringed as one the user chose.
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
  /** The chip's click; false when no new reading comes, and the chip takes clicks again. */
  language(p: Params<"language">): Promise<boolean>;
  chip(a: ChipAnswer): void;
}

export interface DraftSink {
  open(d: DraftOpen): void;
  chip(c: Chip): void;
  /** A dictation made while the box had the keyboard: at the end of the field, a space between. */
  append(text: string): void;
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

/**
 * The low-confidence words, found in order in the text. Words next to each other that the other
 * engine heard as one stretch carry the same alternative (`cooper netties` for `Kubernetes`): they
 * are one mark when any of them is unsure, so picking the alternative replaces the whole stretch.
 */
export function lowMarks(text: string, words: DraftOpen["words"]): Mark[] {
  const found: { start: number; end: number; low: boolean; alt: string[] }[] = [];
  let at = 0;
  for (const w of words ?? []) {
    if (!w.w) continue;
    const i = text.indexOf(w.w, at);
    if (i < 0) continue;
    at = i + w.w.length;
    const low = typeof w.c === "number" && w.c < LOW_CONFIDENCE;
    found.push({ start: i, end: at, low, alt: (w.alt ?? []).filter(Boolean) });
  }
  const key = (x: { alt: string[] }) => (x.alt.length > 0 ? JSON.stringify(x.alt) : null);
  const out: Mark[] = [];
  for (let k = 0; k < found.length; ) {
    const first = found[k] as (typeof found)[number];
    let e = k;
    const same = key(first);
    while (same !== null) {
      const next = found[e + 1];
      if (!next || key(next) !== same) break;
      if (text.slice((found[e] as (typeof found)[number]).end, next.start).trim() !== "") break;
      e++;
    }
    const run = found.slice(k, e + 1);
    k = e + 1;
    if (!run.some((x) => x.low)) continue;
    const end = (run.at(-1) as (typeof found)[number]).end;
    const said = text.slice(first.start, end);
    out.push({ start: first.start, end, alt: first.alt.filter((a) => a !== said) });
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

/** The audio's length as `0:14`. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The language chip: the tag in capitals, a button only when a click can decode the audio again
 * in another language, ringed when the user chose it.
 */
function languageChip(d: DraftOpen, onSwitch: () => Promise<boolean>): HTMLElement {
  const tag = (d.language ?? "").split("-")[0]?.toUpperCase() ?? "";
  if (d.languageSwitch !== true)
    return h("span", { id: "draft-lang", class: "lang", attrs: { title: "Language heard" } }, tag);
  const b = h(
    "button",
    {
      id: "draft-lang",
      class: "lang",
      type: "button",
      attrs: { title: "Switch language", "aria-label": `Switch language, now ${tag}` },
    },
    tag,
  );
  b.toggleAttribute("data-switchable", true);
  b.toggleAttribute("data-forced", d.languageForced === true);
  b.addEventListener("click", () => {
    // One decode at a time: the next open draws a new chip, and a switch that failed frees it.
    b.disabled = true;
    void onSwitch().then((ok) => {
      if (!ok) b.disabled = false;
    });
  });
  return b;
}

/** The engine line: `fast (Parakeet) on this Mac · took 0.3 s · 0:14 of audio · EN`. */
function metaLine(d: DraftOpen, onSwitch: () => Promise<boolean>): (string | HTMLElement)[] {
  const dot = () => h("span", { class: "dot", attrs: { "aria-hidden": "true" } });
  const here = d.platform === "darwin" ? "on this Mac" : "on this computer";
  const parts: (string | HTMLElement)[][] = [
    [h("b", {}, d.engine), d.local === true ? ` ${here}` : ""],
    ["took ", h("b", {}, `${(d.ms / 1000).toFixed(1)} s`)],
  ];
  if (typeof d.seconds === "number" && d.seconds > 0) parts.push([`${clock(d.seconds)} of audio`]);
  if (d.language) parts.push([languageChip(d, onSwitch)]);
  return parts.flatMap((p, i) => (i === 0 ? p : [dot(), ...p]));
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
    // A per-app rule's `draft-send` (DC-U9): Enter sends as well.
    insert(mod || d?.enterSends === true);
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
  el("draft-insert").addEventListener("click", () => insert(false));
  el("draft-send").addEventListener("click", () => insert(true));
  const retryWith = () => {
    const engine = el<HTMLSelectElement>("draft-retry-engine").value;
    el("draft-retry").textContent = engine ? `↻ Retry with ${engine}` : "";
  };
  el("draft-retry-engine").addEventListener("change", retryWith);
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
      el("draft-to").hidden = !next.to;
      el("draft-app").textContent = next.to ?? "";
      el("draft-app-icon").textContent = (next.to ?? "").charAt(0).toUpperCase();
      el("draft-length").textContent =
        typeof next.seconds === "number" && next.seconds > 0 ? `· ${clock(next.seconds)}` : "";
      replace(
        el("draft-meta"),
        ...metaLine(next, () =>
          d === next && !done ? t.language({ id: next.id }) : Promise.resolve(false),
        ),
      );
      replace(el("draft-retry-engine"), ...next.engines.map((e) => h("option", { value: e }, e)));
      el("draft-retry-group").hidden = next.engines.length === 0;
      el("draft-retry-pick").hidden = next.engines.length < 2;
      retryWith();
      const sendMod = mac() ? "Cmd+Enter" : "Ctrl+Enter";
      el("draft-send-key").textContent = next.enterSends ? "↵" : mac() ? "⌘↵" : "Ctrl ↵";
      el("draft-send").title = next.enterSends
        ? `Insert and send (Enter or ${sendMod})`
        : `Insert and send (${sendMod})`;
      el("draft-insert").title = next.enterSends ? "Insert without sending" : "Insert (Enter)";
      el("draft").hidden = false;
      paintMarks();
      if (next.focus) {
        field.focus();
        field.setSelectionRange(text.length, text.length);
      }
    },
    chip: (c) => chip.show(c),
    append: (more) => {
      if (!d || done || more.trim() === "") return;
      const glue = field.value === "" || /\s$/.test(field.value) ? "" : " ";
      field.value = `${field.value}${glue}${more.trim()}`;
      field.dispatchEvent(new Event("input"));
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    },
  };
}
