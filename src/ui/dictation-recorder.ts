/**
 * The hotkey recorder for the dictation keys (docs/ux/DICTATION.md DC-U3, extending DK-K5): press
 * the keys and see them as keycaps. A chord is taken at its first key that is not a modifier. A
 * modifier alone counts once it is held for 400 ms and released with nothing else pressed, and
 * shows as `Right ⌘`; the page tells Right from Left by `KeyboardEvent.code`. The webview never
 * sees Fn or Globe on macOS, so while the recorder is open the helper's own key names are taken
 * too (`Transport.dictationKeys`, the window only).
 *
 * Refused inline, with nothing saved: a binding the recording hotkey (`app.hotkey`) or another
 * dictation key already has, and, in the clipboard-only fallback of DC-N3 (no Accessibility grant,
 * so a Carbon hotkey that takes chords only), any modifier alone. The platform warnings of
 * `hotkey.ts` show under the field and never refuse.
 */

import { hotkeyWarning, parseAccelerator } from "../main/window/hotkey.ts";
import { h, replace } from "./dom.ts";
import type { Transport } from "./protocol.ts";

/** The settings the recorder serves, with the words a conflict names them by. */
export const KEY_SETTINGS: Record<string, string> = {
  "dictation.hotkey": "the dictation key",
  "dictation.hotkeyDraft": "the draft key",
  "dictation.hotkeyFixLast": "the fix-last key",
  "dictation.hotkeyPasteLast": "the paste-last key",
};

/** How long a modifier is held alone before it counts as the key (DC-U3). */
export const HOLD_ALONE_MS = 400;

const MODS: Record<string, string> = {
  Control: "Control",
  Alt: "Option",
  Shift: "Shift",
  Meta: "Command",
  OS: "Command",
};

/** A modifier's code as `{side, name}`: `MetaRight` is Right Command. */
function modifier(code: string): { side: "Left" | "Right"; name: string } | null {
  const m = /^(Control|Alt|Shift|Meta|OS)(Left|Right)$/.exec(code);
  return m ? { side: m[2] as "Left" | "Right", name: MODS[m[1] as string] as string } : null;
}

/** The binding for a modifier held alone, or why it cannot be one. */
export function aloneName(code: string, platform: string): { value: string } | { refused: string } {
  const m = modifier(code);
  if (!m) return { refused: "not a modifier" };
  if (m.name === "Command" && platform !== "darwin")
    return { refused: "The Windows or Super key alone opens the system's menu; pick another key." };
  return { value: `${m.side}${m.name}` };
}

/** A key's name in an accelerator, from its code: `KeyD` is `D`, `Digit1` is `1`. */
function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code;
}

/** A pressed chord as the accelerator Settings stores (`Control+Shift+D`), or why it cannot be. */
export function chordName(
  e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
  platform: string,
): { value: string } | { refused: string } {
  const key = keyName(e.code);
  const mods = [
    e.ctrlKey ? "Control" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey ? "Shift" : "",
    e.metaKey ? (platform === "darwin" ? "Command" : "Super") : "",
  ].filter((m) => m !== "");
  if (mods.length === 0 && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key))
    return {
      refused: "A key with no modifier types a character; hold Control, Alt, Shift or ⌘ with it.",
    };
  return { value: [...mods, key].join("+") };
}

/** A binding with no `+` is a key alone: a modifier (`RightCommand`) or `Fn`. */
export function isAlone(value: string): boolean {
  return value.trim() !== "" && !value.includes("+");
}

/** One spelling per binding, so `shift+control+d` and `Control+Shift+D` are the same. */
export function canonical(value: string, platform: string): string {
  if (isAlone(value)) return value.trim().toLowerCase();
  const { mods, key } = parseAccelerator(value);
  if (mods.delete("commandorcontrol")) mods.add(platform === "darwin" ? "command" : "control");
  return [...[...mods].sort(), key].join("+");
}

const SYMBOLS: Record<string, [mac: string, other: string]> = {
  command: ["⌘", "Win"],
  cmd: ["⌘", "Win"],
  super: ["⌘", "Super"],
  control: ["⌃", "Ctrl"],
  ctrl: ["⌃", "Ctrl"],
  option: ["⌥", "Alt"],
  alt: ["⌥", "Alt"],
  shift: ["⇧", "Shift"],
  fn: ["fn", "Fn"],
};

/** A binding as keycaps: `RightCommand` is `Right ⌘`, `Control+Shift+D` is `⌃`, `⇧`, `D`. */
export function keycaps(value: string, platform: string): string[] {
  const sym = (name: string) => {
    const s = SYMBOLS[name.toLowerCase()];
    return s ? (platform === "darwin" ? s[0] : s[1]) : name;
  };
  if (isAlone(value)) {
    const m = /^(Left|Right)(.+)$/.exec(value.trim());
    return [m ? `${m[1]} ${sym(m[2] as string)}` : sym(value.trim())];
  }
  return value
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map(sym);
}

export interface RecorderContext {
  platform: string;
  /** Why only chords can be bound now (the no-grant fallback), or null. */
  chordsOnly(): string | null;
  /** Every other binding in force, as `[words, value]`, for the conflict check. */
  others(key: string): [string, string][];
  /** This recorder started: the page stops any other, so one holds the keys at a time. */
  started?(r: KeyRecorder): void;
}

/** The Record button, the keycaps and the notes for one key's row; the page saves on `change`. */
export class KeyRecorder {
  readonly root: HTMLElement;
  private readonly caps = h("span", { class: "keycaps", attrs: { "aria-hidden": "true" } });
  private readonly note = h("small", { class: "recorder-note", attrs: { role: "status" } });
  private readonly button: HTMLButtonElement;
  private live: { close(): void } | null = null;
  /** The modifier held alone, since when; cleared once another key goes down. */
  private alone: { code: string; at: number } | null = null;

  constructor(
    private readonly key: string,
    private readonly input: HTMLInputElement,
    private readonly t: Transport,
    private readonly ctx: RecorderContext,
  ) {
    this.button = h(
      "button",
      {
        class: "record-key",
        type: "button",
        attrs: { "aria-pressed": "false", "data-for": key },
        on: { click: () => (this.live ? this.stop() : this.start()) },
      },
      "Record",
    );
    this.root = h("span", { class: "recorder" }, this.caps, this.button, this.note);
    this.input.addEventListener("input", () => this.draw());
    this.draw();
  }

  get recording(): boolean {
    return this.live !== null;
  }

  private draw(): void {
    replace(this.caps, ...keycaps(this.input.value, this.ctx.platform).map((k) => h("kbd", {}, k)));
  }

  private say(text: string, refused = false): void {
    this.note.textContent = text;
    this.note.classList.toggle("issue", refused);
  }

  start(): void {
    if (this.live) return;
    this.ctx.started?.(this);
    this.alone = null;
    this.button.textContent = "Press the keys (Esc stops)";
    this.button.setAttribute("aria-pressed", "true");
    const only = this.ctx.chordsOnly();
    this.say(only ?? "");
    window.addEventListener("keydown", this.down, true);
    window.addEventListener("keyup", this.up, true);
    const helper = this.t.dictationKeys?.((name) => this.take(name));
    this.live = {
      close: () => {
        window.removeEventListener("keydown", this.down, true);
        window.removeEventListener("keyup", this.up, true);
        helper?.close();
      },
    };
  }

  stop(): void {
    this.live?.close();
    this.live = null;
    this.alone = null;
    this.button.textContent = "Record";
    this.button.setAttribute("aria-pressed", "false");
  }

  private readonly down = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const mods = e.ctrlKey || e.altKey || e.metaKey || e.shiftKey;
    if (e.code === "Escape" && !mods) {
      this.stop();
      return;
    }
    if (modifier(e.code)) {
      // A second modifier makes it a chord in the making, never a key alone.
      this.alone = this.alone ? null : { code: e.code, at: e.timeStamp };
      return;
    }
    this.alone = null;
    const c = chordName(e, this.ctx.platform);
    if ("refused" in c) this.say(c.refused, true);
    else this.take(c.value);
  };

  private readonly up = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const a = this.alone;
    if (!a || a.code !== e.code) return;
    this.alone = null;
    if (e.timeStamp - a.at < HOLD_ALONE_MS) {
      this.say("Hold a key alone a moment longer to use it by itself.");
      return;
    }
    const r = aloneName(e.code, this.ctx.platform);
    if ("refused" in r) this.say(r.refused, true);
    else this.take(r.value);
  };

  /** A binding pressed: refused with the reason, or put in the field and saved. */
  private take(value: string): void {
    const only = this.ctx.chordsOnly();
    if (only && isAlone(value)) {
      this.say(
        `${keycaps(value, this.ctx.platform).join(" ")} alone cannot be bound: ${only}`,
        true,
      );
      return;
    }
    const mine = canonical(value, this.ctx.platform);
    const clash = this.ctx
      .others(this.key)
      .find(([, v]) => v.trim() !== "" && canonical(v, this.ctx.platform) === mine);
    if (clash) {
      this.say(`${keycaps(value, this.ctx.platform).join(" ")} is already ${clash[0]}.`, true);
      return;
    }
    this.stop();
    this.input.value = value;
    this.draw();
    this.say(hotkeyWarning(value, this.ctx.platform) ?? "");
    this.input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
