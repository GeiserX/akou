/**
 * The global hotkey's default and the one warning Settings shows (docs/ux/DESKTOP.md section 5,
 * DK-K4). No Node import: the Settings pane in the window uses the same check.
 *
 * - **macOS**: `Option+Command+R`.
 * - **Windows and Linux**: `Control+Shift+F9`. `Control+Alt` is AltGr on many European layouts
 *   (Spanish, German, French, Polish), so a global grab on `Control+Alt+R` swallows a typed
 *   character; `Control+R` and `Control+Shift+R` reload a browser, where most meetings run; the
 *   Game Bar holds `Win+Alt+R`; and the meeting apps bind `Alt+Shift+<letter>` (Zoom) and
 *   `Control+Shift+<letter>` (Teams). A function key with two modifiers is clear of all of them.
 *   It is not free: while akou runs it takes `Control+Shift+F9` from Visual Studio (delete all
 *   breakpoints) and Word (unlink fields), and on laptops whose F-row is media keys by default it
 *   needs Fn as well. Accepted knowingly: no meeting app or browser uses it, and Settings changes it.
 */

import { modifier, parseBinding } from "../../core/dictation/activation.ts";

export const MAC_HOTKEY = "Alt+Command+R";
export const DEFAULT_HOTKEY = "Control+Shift+F9";

/** The hotkey from the settings, or the platform's default. */
export function hotkeyFor(setting: string, platform: string): string {
  if (setting.trim() !== "") return setting.trim();
  return platform === "darwin" ? MAC_HOTKEY : DEFAULT_HOTKEY;
}

/**
 * The dictation key's default (docs/ux/DICTATION.md DC-A2): Right Command on macOS, since Option
 * is the symbol layer of every ISO layout and no layout puts characters on Command; Right Control
 * on Windows, where DC-A1's interrupt rule keeps Right Ctrl+C a copy; a chord on Linux, because the
 * GlobalShortcuts portal binds chords only. Neither Linux default (this one and fix last's
 * `Control+Shift+Period`) is a default binding of GNOME (window manager, shell, mutter, media keys),
 * IBus or KDE Plasma (KWin, the workspace, KRunner, Spectacle).
 */
export function dictationHotkeyDefault(platform: string): string {
  if (platform === "darwin") return "RightCommand";
  if (platform === "win32") return "RightControl";
  return "Control+Shift+Space";
}

/** The fix-last key when the dictation key is a chord (the Linux default). */
export const FIX_LAST_CHORD = "Control+Shift+Period";

/**
 * Fix last's default (DC-A5): Shift held before a modifier-only dictation key goes down
 * (`Shift+RightCommand`), since Shift pressed during a hold is DC-A1's interrupt; with a chord, or
 * a Shift key, as the dictation key, `Control+Shift+Period`.
 */
export function fixLastDefault(hotkey: string): string {
  const h = parseHotkey(hotkey);
  if ("error" in h || h.kind !== "modifier" || h.with.length > 0) return FIX_LAST_CHORD;
  return modifier(h.key)?.[0] === "Shift" ? FIX_LAST_CHORD : `Shift+${h.key}`;
}

/**
 * A dictation binding (DC-A2): a modifier-only key, side-specific (`RightCommand`) or `Fn`, with
 * the modifiers held before it (`Shift+RightCommand`, fix last's form), or a chord the helper binds
 * (`Control+Shift+Space`).
 */
export type DictationHotkey =
  | { kind: "modifier"; key: string; with: string[] }
  | { kind: "chord"; key: string };

/**
 * Reads a dictation binding by the helper's rules (`parseBinding`, held to the Rust tables), plus
 * the modifier-only key with modifiers held first. Refused, with the reason: a lone modifier with
 * no side, a lone character key, a modifier twice, and a left and a right of one modifier.
 */
export function parseHotkey(s: string): DictationHotkey | { error: string } {
  const parts = s.split("+").map((p) => p.trim());
  const last = parts.at(-1) ?? "";
  const lastMod = modifier(last);
  if (parts.length > 1 && lastMod && (lastMod[1] !== "Either" || lastMod[0] === "Fn")) {
    const held: string[] = [];
    for (const p of parts.slice(0, -1)) {
      const m = modifier(p);
      if (!m) return { error: `${p} is not a modifier, so ${s} is not a key to hold` };
      if (m[0] === lastMod[0])
        return { error: `${s} names ${m[0]} twice: a left and a right of one modifier` };
      if (held.some((h) => modifier(h)?.[0] === m[0])) return { error: `${s} names ${m[0]} twice` };
      held.push(p);
    }
    return { kind: "modifier", key: last, with: held };
  }
  try {
    const b = parseBinding(s);
    return b.kind === "modifier" ? { kind: "modifier", key: b.key, with: [] } : b;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** The key `dictation.hotkey` takes: one the helper binds alone, so no modifiers held first. */
export function checkDictationHotkey(s: string): string | null {
  if (s.trim() === "") return null;
  const h = parseHotkey(s);
  if ("error" in h) return h.error;
  if (h.kind === "modifier" && h.with.length > 0)
    return `${s} holds ${h.with.join("+")} first; that form is for fix last, the dictation key is one key or a chord`;
  return null;
}

/** The other dictation keys (fix last, draft, paste last): empty for none, else any binding. */
export function checkExtraHotkey(s: string): string | null {
  if (s.trim() === "") return null;
  const h = parseHotkey(s);
  return "error" in h ? h.error : null;
}

/** An accelerator as its modifiers (lower case, one name each) and its key. */
export function parseAccelerator(accel: string): { mods: Set<string>; key: string } {
  const names: Record<string, string> = {
    ctrl: "control",
    control: "control",
    alt: "alt",
    option: "alt",
    altgr: "altgr",
    shift: "shift",
    cmd: "command",
    command: "command",
    super: "super",
    meta: "super",
    win: "super",
    commandorcontrol: "commandorcontrol",
    cmdorctrl: "commandorcontrol",
  };
  const parts = accel
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== "");
  const mods = new Set<string>();
  let key = "";
  for (const p of parts) {
    const m = names[p];
    if (m) mods.add(m);
    else key = p;
  }
  return { mods, key };
}

/** Named keys that type a character (Option+Space is a non-breaking space on macOS). */
const TYPED_KEYS =
  /^(Space|Period|Comma|Slash|Backslash|Minus|Equal|Semicolon|Quote|Backquote|BracketLeft|BracketRight)$/i;

/**
 * What Settings says about a typed hotkey, or null. Off macOS, `Control+Alt` (or `AltGr`, or
 * `CommandOrControl+Alt`, which is `Control+Alt` there) is AltGr on many layouts. On macOS, Option
 * alone, or Option with a character key and no other modifier, types a symbol on most layouts.
 */
export function hotkeyWarning(accel: string, platform: string): string | null {
  if (accel.trim() === "") return null;
  if (platform === "darwin") {
    const parts = accel.split("+").map((p) => p.trim());
    const mods = parts.map((p) => modifier(p)?.[0]);
    const held = mods.slice(0, -1);
    const key = parts.at(-1) ?? "";
    const types = key.length === 1 || TYPED_KEYS.test(key);
    const option =
      (parts.length === 1 && mods[0] === "Option") ||
      (held.length > 0 && held.every((m) => m === "Option") && mods.at(-1) === undefined && types);
    return option
      ? "Option is the symbol layer of most keyboard layouts (Spanish, German, French and Italian type @, #, [, ], { and } with it), so this key can take a typed character. Right Command types nothing on any layout."
      : null;
  }
  const { mods } = parseAccelerator(accel);
  const control = mods.has("control") || mods.has("commandorcontrol");
  if ((control && mods.has("alt")) || mods.has("altgr")) {
    return "Control+Alt is AltGr on many keyboard layouts (Spanish, German, French), so this hotkey can swallow a typed character. Pick one without Control+Alt.";
  }
  return null;
}
