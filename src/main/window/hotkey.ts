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

export const MAC_HOTKEY = "Alt+Command+R";
export const DEFAULT_HOTKEY = "Control+Shift+F9";

/** The hotkey from the settings, or the platform's default. */
export function hotkeyFor(setting: string, platform: string): string {
  if (setting.trim() !== "") return setting.trim();
  return platform === "darwin" ? MAC_HOTKEY : DEFAULT_HOTKEY;
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

/**
 * What Settings says about a typed hotkey, or null. Off macOS, `Control+Alt` (or `AltGr`, or
 * `CommandOrControl+Alt`, which is `Control+Alt` there) is AltGr on many layouts.
 */
export function hotkeyWarning(accel: string, platform: string): string | null {
  if (platform === "darwin" || accel.trim() === "") return null;
  const { mods } = parseAccelerator(accel);
  const control = mods.has("control") || mods.has("commandorcontrol");
  if ((control && mods.has("alt")) || mods.has("altgr")) {
    return "Control+Alt is AltGr on many keyboard layouts (Spanish, German, French), so this hotkey can swallow a typed character. Pick one without Control+Alt.";
  }
  return null;
}
