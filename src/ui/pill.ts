/**
 * The dictation pill (docs/ux/DICTATION.md section 5.1, DC-O1): a small window above every other,
 * never activated, that says what dictation is doing. It is drawn as the island at the top chosen
 * in docs/ux/design-explorations/README.md: a black island that only changes width. Five states:
 * `listening` with the recording dot, a five-segment level, the elapsed time and round Stop and
 * Cancel, and the key hints the backend can honour in a line under it after 1.5 s; `transcribing`
 * with a ring around the dot and the elapsed time once past 2 s; `inserted` with a check or
 * `copied` with the paste shortcut; `error` with a sheet under the island holding the message and
 * up to three buttons; hidden. The learn chip (DC-L4) hangs under the island, a neutral one when no
 * state is showing.
 *
 * The page only draws what the main process sends (`pill-protocol.ts`): the main side decides when
 * a state ends, and the window's no-focus style is the shell's. No state carries dictated text, and
 * the page reads each field it draws by name, so an extra field is never shown (DC-D2). The one
 * exception is the words-as-I-speak preview (DC-O2), its own message, which the main side sends
 * only with `dictation.pillPreview` on; the page shows it while listening and drops it after.
 */

import { mountChip } from "./dictation-chip.ts";
import { h, replace } from "./dom.ts";
import { elapsedText } from "./indicator-clock.ts";
import type { Chip, ChipAnswer, PillAction, PillKey, PillRpc, PillState } from "./pill-protocol.ts";

type Control = PillRpc["bun"]["requests"]["control"]["params"]["action"];

export interface PillTransport {
  control(action: Control): void;
  chip(a: ChipAnswer): void;
}

export interface PillSink {
  state(s: PillState): void;
  level(l: { db: number }): void;
  preview(p: { text: string }): void;
  chip(c: Chip): void;
}

/**
 * The preview keeps the last words of the dictation, at most this many characters: the ticker shows
 * one line of it, newest at the right, and the rest never reaches the page's DOM.
 */
export const PREVIEW_CHARS = 90;

/** The end of a long preview, from a word start, after an ellipsis. */
export function previewTail(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  const cut = text.slice(-PREVIEW_CHARS);
  return `…${cut.slice(cut.indexOf(" ") + 1)}`;
}

/** Transcribing shows its time only once a wait is worth counting. */
export const TRANSCRIBING_CLOCK_MS = 2000;
/** The key hints fade in under the island once the user has been listening this long. */
export const HINTS_AFTER_MS = 1500;

/** The level meter's segments, and the dBFS they span. */
export const LEVEL_SEGMENTS = 5;
const FLOOR_DB = -60;

/**
 * The segments of the meter for a level in dBFS: how many are full, and whether the next one is
 * half lit. Silence lights none; full scale, or a clipping mic above it, lights all five.
 */
export function levelSegments(db: number): { on: number; half: boolean } {
  const v = Number.isFinite(db) ? Math.max(FLOOR_DB, Math.min(0, db)) : FLOOR_DB;
  const lit = ((v - FLOOR_DB) / -FLOOR_DB) * LEVEL_SEGMENTS;
  const on = Math.floor(lit);
  return { on, half: on < LEVEL_SEGMENTS && lit - on >= 0.5 };
}

/** A key hint: the key cap and what it does. */
const KEY_HINT: Record<PillKey, [string, string]> = {
  enter: ["↵", "sends"],
  "shift-enter": ["⇧↵", "drafts"],
  escape: ["esc", "cancels"],
};
const HINT_ORDER: readonly PillKey[] = ["enter", "shift-enter", "escape"];

const ACTION_LABEL: Record<PillAction, string> = {
  retry: "Retry",
  copy: "Copy",
  "open-draft": "Open draft",
};

/** The island's word for each state; listening has none, its dot and level say it. */
const WORD: Record<string, string> = {
  transcribing: "Transcribing",
  inserted: "Inserted",
  copied: "Copied",
  error: "Didn’t finish",
  chip: "Vocabulary",
};

/** The icon each state shows at the island's left. */
const ICON: Record<string, string> = {
  listening: "rec",
  transcribing: "ring",
  inserted: "check",
  copied: "copied",
  error: "alert",
  chip: "book",
};

/** Transcribing's wait in seconds with one decimal, as `2.4 s`; a minute or more as `1:05`. */
function waitText(ms: number): string {
  return ms < 60_000 ? `${(Math.floor(ms / 100) / 10).toFixed(1)} s` : elapsedText(ms);
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`the pill page has no #${id}`);
  return e as T;
}

export function mountPill(t: PillTransport, now: () => number = () => Date.now()): PillSink {
  let s: PillState = { state: "hidden" };
  /** The preview's words, for this listening session only. */
  let words = "";
  let chipUp = false;
  const chip = mountChip(
    el("chip"),
    (a) => t.chip(a),
    (up) => {
      chipUp = up;
      draw();
    },
  );

  /** The state the island draws: a chip with nothing else showing gets the neutral island. */
  const look = () =>
    s.state === "done" ? s.how : s.state === "hidden" && chipUp ? "chip" : s.state;

  const tick = () => {
    const since = s.state === "listening" || s.state === "transcribing" ? s.since : null;
    const ms = since === null ? 0 : now() - since;
    el("elapsed").textContent =
      since === null
        ? ""
        : s.state === "listening"
          ? elapsedText(ms)
          : ms >= TRANSCRIBING_CLOCK_MS
            ? waitText(ms)
            : "";
    el("hints").hidden =
      s.state !== "listening" || ms < HINTS_AFTER_MS || el("hints").childElementCount === 0;
  };

  const button = (id: string, label: string, action: Control) =>
    h("button", { id, type: "button", on: { click: () => t.control(action) } }, label);

  const showPreview = () => {
    const shown = s.state === "listening" ? words : "";
    el("preview-words").textContent = shown;
    el("preview").hidden = shown === "";
  };

  const draw = () => {
    const cur = s;
    const state = look();
    const pill = el("pill");
    pill.dataset.state = state;
    pill.hidden = state === "hidden";
    // The icons are SVG, which has no `hidden` property: the attribute itself.
    for (const id of Object.values(ICON)) el(id).toggleAttribute("hidden", ICON[state] !== id);
    const listening = s.state === "listening";
    el("level").hidden = !listening;
    if (!listening) paintLevel(FLOOR_DB);
    el("controls").hidden = !listening;
    const note = s.state === "done" || s.state === "transcribing" ? (s.note ?? "") : "";
    replace(
      el("word"),
      WORD[state] ?? "",
      note ? h("span", { class: "note" }, ` · ${note}`) : null,
    );
    const hints =
      cur.state === "listening"
        ? cur.keys.length > 0
          ? HINT_ORDER.filter((k) => cur.keys.includes(k)).map((k) => KEY_HINT[k])
          : [[cur.hotkey, "stops"] as [string, string]]
        : [];
    const warn = s.state === "listening" ? (s.note ?? "") : "";
    replace(
      el("hints"),
      ...hints.flatMap(([cap, what], i) => [
        i > 0 ? h("span", { class: "sep" }, "·") : null,
        h("span", { class: "key" }, cap),
        what,
      ]),
      warn ? h("span", { class: "sep" }, "·") : null,
      warn ? h("span", { id: "warn" }, warn) : null,
    );
    el("sheet").hidden = s.state !== "error";
    el("message").textContent = s.state === "error" ? s.message : "";
    const buttons =
      cur.state === "error"
        ? cur.actions
            .filter((a) => a in ACTION_LABEL)
            .map((a) => button(a, a === "retry" ? (cur.retryLabel ?? "Retry") : ACTION_LABEL[a], a))
        : [];
    replace(el("buttons"), ...buttons);
    showPreview();
    tick();
  };

  const paintLevel = (db: number) => {
    const { on, half } = levelSegments(db);
    const bars = el("level");
    bars.dataset.db = String(Math.max(FLOOR_DB, Math.min(0, Number.isFinite(db) ? db : FLOOR_DB)));
    [...bars.children].forEach((b, i) => {
      b.className = i < on ? "on" : i === on && half ? "half" : "";
    });
  };

  el("stop").addEventListener("click", () => t.control("stop"));
  el("cancel").addEventListener("click", () => t.control("cancel"));
  setInterval(tick, 250);
  draw();

  return {
    state: (next) => {
      // A new session, or the end of listening, drops the words of the one before.
      const same = s.state === "listening" && next.state === "listening" && s.since === next.since;
      if (!same) words = "";
      s = next;
      draw();
    },
    preview: ({ text }) => {
      if (typeof text !== "string") return;
      // Shown only while listening; the next state change drops it, so a late partial never shows.
      words = previewTail(text.trim());
      showPreview();
    },
    level: ({ db }) => {
      if (s.state !== "listening") return;
      paintLevel(Number(db));
    },
    chip: (c) => chip.show(c),
  };
}
