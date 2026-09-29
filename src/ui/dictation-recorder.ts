/**
 * The hotkey recorder for the dictation keys (docs/ux/DICTATION.md DC-U3, extending DK-K5): press
 * the keys and see them as keycaps. A chord is taken at its first key that is not a modifier. A
 * modifier alone counts once it is held for 400 ms and released with nothing else pressed, and
 * shows as `Right ⌘`; the page tells Right from Left by `KeyboardEvent.code`. The webview never
 * sees Fn or Globe on macOS, so while the recorder is open those two are taken from the helper's
 * own key names (`Transport.dictationKeys`, the window only). The helper streams every key, but
 * any other name is left to the page, which alone applies the 400 ms rule and sees each chord once.
 *
 * Fn has a test of its own (DC-N2): many keyboards not made by Apple keep Fn to themselves and send
 * the Mac nothing, so on macOS `Use Fn` opens the recorder and waits `FN_TEST_MS` for the helper to
 * report Fn; with none by then the note says to pick another key. With no helper hearing keys
 * (dictation off, or its key tap dead without Accessibility) it says that instead, since no
 * keyboard's Fn could reach akou then.
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

/** How long `Use Fn` waits for the helper to hear Fn before it says the keyboard sends none (DC-N2). */
export const FN_TEST_MS = 2000;

/** What the recorder says when no Fn press reached the helper in `FN_TEST_MS`. */
export const NO_FN =
  "No Fn press reached akou in 2 seconds. Keyboards not made by Apple often keep Fn to themselves; pick another key, such as Right ⌘.";

/** What `Use Fn` says when no helper hears keys: the keyboard is not the one to blame then. */
export const NO_HELPER =
  "Only akou's dictation helper hears Fn, and it is not listening now. Turn dictation on, with the Accessibility grant, then try again.";

/** The helper's key names the page takes: the keys the webview never sees (DC-U3). */
const HELPER_ONLY = /^(fn|globe)$/i;

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
  if (mods.length === 1 && mods[0] === "Shift" && /^[A-Z0-9]$/.test(key))
    return { refused: "Shift with a letter or digit types a character; add Control, Alt or ⌘." };
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
  // A modifier with its side (`RightCommand`, alone or last in fix last's `Shift+RightCommand`).
  const sided = (p: string) => {
    const m = /^(Left|Right)(.+)$/.exec(p);
    return m ? `${m[1]} ${sym(m[2] as string)}` : sym(p);
  };
  if (isAlone(value)) return [sided(value.trim())];
  return value
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map(sided);
}

export interface RecorderContext {
  platform: string;
  /** Why only chords can be bound now (the no-grant fallback), or null. */
  chordsOnly(): string | null;
  /** Every other binding in force, as `[words, value]`, for the conflict check. */
  others(key: string): [string, string][];
  /** This recorder started: the page stops any other, so one holds the keys at a time. */
  started?(r: KeyRecorder): void;
  /** The button's word while not recording: `Record` unless the page says `Change`. */
  button?: string;
  /** False: keys come from the page alone, never from the dictation helper, and no `Use Fn`. */
  helper?: boolean;
  /** False: Fn from the helper is still taken, but the row draws no `Use Fn` of its own. */
  fnButton?: boolean;
  /** The binding in force while the field is empty (its default), drawn as the keycaps. */
  fallback?: string;
  /** What the binding is for, so the button's name says it and the binding (the keycaps are hidden from screen readers). */
  label?: string;
  /** With no binding and no default: the words shown in the keycaps' place ("Not set"). */
  unset?: string;
  /** With no binding and no default: the button's word instead of `button` ("Set"). */
  setButton?: string;
}

const SPOKEN: Record<string, [mac: string, other: string]> = {
  command: ["Command", "Windows"],
  cmd: ["Command", "Windows"],
  commandorcontrol: ["Command", "Control"],
  super: ["Command", "Super"],
  control: ["Control", "Control"],
  ctrl: ["Control", "Control"],
  option: ["Option", "Alt"],
  alt: ["Option", "Alt"],
  shift: ["Shift", "Shift"],
  fn: ["Fn", "Fn"],
};

/** A binding as words a screen reader says: `Alt+Command+R` is `Option Command R` on a Mac. */
export function spokenKeys(value: string, platform: string): string {
  return value
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => {
      const s = SPOKEN[p.toLowerCase()];
      return s ? (platform === "darwin" ? s[0] : s[1]) : p;
    })
    .join(" ");
}

/** The Record button, the keycaps and the notes for one key's row; the page saves on `change`. */
export class KeyRecorder {
  readonly root: HTMLElement;
  private readonly caps = h("span", { class: "keycaps", attrs: { "aria-hidden": "true" } });
  private readonly note = h("small", { class: "recorder-note", attrs: { role: "status" } });
  private readonly button: HTMLButtonElement;
  private live: { close(): void; hearing?: Promise<boolean> } | null = null;
  /** The Fn test's timer while it waits (DC-N2). */
  private fnWait: ReturnType<typeof setTimeout> | undefined;
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
      this.word(),
    );
    // Fn reaches akou only through the helper, which the window alone hears (DC-N2).
    const fn =
      ctx.platform === "darwin" && ctx.helper !== false && ctx.fnButton !== false && t.dictationKeys
        ? h(
            "button",
            {
              class: "record-fn",
              type: "button",
              attrs: { "data-for": key },
              on: { click: () => this.testFn() },
            },
            "Use Fn",
          )
        : null;
    this.root = h("span", { class: "recorder" }, this.caps, this.button, fn, this.note);
    this.input.addEventListener("input", () => this.draw());
    this.draw();
  }

  get recording(): boolean {
    return this.live !== null;
  }

  private draw(): void {
    const value = this.input.value || this.ctx.fallback || "";
    if (!value && this.ctx.unset)
      replace(this.caps, h("span", { class: "recorder-unset" }, this.ctx.unset));
    else replace(this.caps, ...keycaps(value, this.ctx.platform).map((k) => h("kbd", {}, k)));
    if (!this.live) this.button.textContent = this.word();
    this.name();
  }

  /** The button's word while not recording: `Set` for a key with nothing bound, where asked. */
  private word(): string {
    const none = !this.input.value && !this.ctx.fallback;
    return (none ? this.ctx.setButton : undefined) ?? this.ctx.button ?? "Record";
  }

  /** The button's accessible name while not recording: what it changes, and the binding now. */
  private name(): void {
    const value = this.input.value || this.ctx.fallback || "";
    if (!this.ctx.label || this.live) this.button.removeAttribute("aria-label");
    else
      this.button.setAttribute(
        "aria-label",
        `${this.word()} ${this.ctx.label}${value ? `, now ${spokenKeys(value, this.ctx.platform)}` : ""}`,
      );
  }

  /** Says what is wrong with the binding already saved (an AltGr chord), as a new one would. */
  warnSaved(): void {
    if (this.input.value) this.say(hotkeyWarning(this.input.value, this.ctx.platform) ?? "");
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
    const helper =
      this.ctx.helper === false
        ? undefined
        : this.t.dictationKeys?.((name) => {
            if (!HELPER_ONLY.test(name.trim())) return;
            // Fn reached akou: the test is answered, whatever `take` makes of it.
            clearTimeout(this.fnWait);
            this.fnWait = undefined;
            this.take(name.trim());
          });
    this.live = {
      ...(helper?.hearing ? { hearing: helper.hearing } : {}),
      close: () => {
        window.removeEventListener("keydown", this.down, true);
        window.removeEventListener("keyup", this.up, true);
        helper?.close();
      },
    };
    this.name();
  }

  /**
   * Opens the recorder for Fn alone and waits `FN_TEST_MS` for the helper to hear it; a keyboard
   * that sends none gets `NO_FN` and the recorder stays open for another key (DC-N2).
   */
  testFn(): void {
    this.start();
    const live = this.live;
    if (!live) return;
    this.say("Press Fn now.");
    clearTimeout(this.fnWait);
    const wait = setTimeout(() => {
      this.fnWait = undefined;
      if (this.live) this.say(NO_FN, true);
    }, FN_TEST_MS);
    this.fnWait = wait;
    // No helper hears keys: say so now rather than blame the keyboard in 2 s.
    void live.hearing?.then((ok) => {
      if (ok || this.fnWait !== wait || this.live !== live) return;
      clearTimeout(wait);
      this.fnWait = undefined;
      this.say(NO_HELPER, true);
    });
  }

  stop(): void {
    clearTimeout(this.fnWait);
    this.fnWait = undefined;
    this.live?.close();
    this.live = null;
    this.alone = null;
    this.button.textContent = this.word();
    this.button.setAttribute("aria-pressed", "false");
    this.name();
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
    // Pressed after another modifier that is still down: not alone. The released key's own flag
    // is already off.
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
      this.say("Release the other keys to bind one alone.");
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
