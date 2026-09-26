/**
 * The dictation pill (docs/ux/DICTATION.md section 5.1, DC-O1): a small window above every other,
 * never activated, that says what dictation is doing. Five states: `listening` with the level, the
 * elapsed time, the key hints the backend can honour and clickable Stop and Cancel; `transcribing`
 * with a spinner and the elapsed time once past 2 s; `inserted` or `copied`; `error` with its
 * message and up to three buttons; hidden. The learn chip (DC-L4) sits under it.
 *
 * The page only draws what the main process sends (`pill-protocol.ts`): the main side decides when
 * a state ends, and the window's no-focus style is the shell's. No state carries dictated text, and
 * the page reads each field it draws by name, so an extra field is never shown (DC-D2).
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
  chip(c: Chip): void;
}

/** Transcribing shows its time only once a wait is worth counting. */
export const TRANSCRIBING_CLOCK_MS = 2000;

const KEY_HINT: Record<PillKey, string> = {
  escape: "Esc cancel",
  enter: "Enter send",
  "shift-enter": "Shift+Enter draft",
};

const ACTION_LABEL: Record<PillAction, string> = {
  retry: "Retry",
  copy: "Copy",
  "open-draft": "Open draft",
};

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`the pill page has no #${id}`);
  return e as T;
}

export function mountPill(t: PillTransport, now: () => number = () => Date.now()): PillSink {
  let s: PillState = { state: "hidden" };
  const chip = mountChip(el("chip"), (a) => t.chip(a));

  const tick = () => {
    const e = el("elapsed");
    const since = s.state === "listening" || s.state === "transcribing" ? s.since : null;
    const ms = since === null ? 0 : now() - since;
    const show = since !== null && (s.state === "listening" || ms >= TRANSCRIBING_CLOCK_MS);
    e.textContent = show ? elapsedText(ms) : "";
  };

  const button = (id: string, label: string, action: Control) =>
    h("button", { id, type: "button", on: { click: () => t.control(action) } }, label);

  const draw = () => {
    const pill = el("pill");
    pill.dataset.state = s.state === "done" ? s.how : s.state;
    pill.hidden = s.state === "hidden";
    el("level").hidden = s.state !== "listening";
    if (s.state !== "listening") el<HTMLMeterElement>("level").value = -60;
    el("mark").textContent =
      s.state === "listening"
        ? "●"
        : s.state === "transcribing"
          ? "◌"
          : s.state === "done"
            ? "✓"
            : s.state === "error"
              ? "!"
              : "";
    el("word").textContent =
      s.state === "error"
        ? s.message
        : s.state === "done"
          ? s.how
          : s.state === "hidden"
            ? ""
            : s.state;
    const note = s.state === "hidden" || s.state === "error" ? "" : (s.note ?? "");
    el("note").textContent = note;
    el("note").hidden = note === "";
    const hints =
      s.state === "listening"
        ? [`${s.hotkey} stop`, ...s.keys.filter((k) => k in KEY_HINT).map((k) => KEY_HINT[k])]
        : [];
    replace(el("hints"), ...hints.map((x) => h("span", { class: "hint" }, x)));
    el("hints").hidden = hints.length === 0;
    const buttons =
      s.state === "listening"
        ? [button("stop", "Stop", "stop"), button("cancel", "Cancel", "cancel")]
        : s.state === "error"
          ? s.actions
              .filter((a) => a in ACTION_LABEL)
              .map((a) =>
                button(
                  a,
                  a === "retry"
                    ? ((s as { retryLabel?: string }).retryLabel ?? "Retry")
                    : ACTION_LABEL[a],
                  a,
                ),
              )
          : [];
    replace(el("buttons"), ...buttons);
    el("buttons").hidden = buttons.length === 0;
    tick();
  };

  setInterval(tick, 250);
  draw();

  return {
    state: (next) => {
      s = next;
      draw();
    },
    level: ({ db }) => {
      if (s.state !== "listening") return;
      el<HTMLMeterElement>("level").value = Math.max(-60, Math.min(0, Number(db) || -60));
    },
    chip: (c) => chip.show(c),
  };
}
