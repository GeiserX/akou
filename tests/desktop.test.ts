/**
 * The desktop shell's P1 lines (docs/ux/DESKTOP.md sections 5 to 7): the default hotkey off macOS
 * (DK-K4), the Dock's `reopen` (DK-M2), the quit that asks during a recording (DK-M3), the window's
 * remembered frame (DK-M4), the command-line install from the menu (DK-M6) and the floating
 * indicator (DK-F1). Each runs the real shell over the fake `NativeUi`; nothing opens a window.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_HOTKEY, hotkeyWarning } from "../src/main/window/hotkey.ts";
import { hotkeyFor } from "../src/main/window/shell.ts";

/**
 * Global shortcuts a default must never take, per platform (`*` is any key). A global grab steals
 * the keys from every app, the meeting app and its browser included.
 */
const KNOWN_COLLISIONS: { accel: string; what: string }[] = [
  { accel: "Control+Alt+*", what: "AltGr on Spanish, German, French and Polish layouts" },
  { accel: "Control+R", what: "browser reload" },
  { accel: "Control+Shift+R", what: "browser hard reload" },
  { accel: "F5", what: "browser reload" },
  { accel: "Control+F5", what: "browser hard reload" },
  { accel: "Super+G", what: "Game Bar" },
  { accel: "Super+Alt+R", what: "Game Bar: record that" },
  { accel: "Super+Alt+G", what: "Game Bar: record the last 30 s" },
  { accel: "Super+Alt+M", what: "Game Bar: microphone" },
  { accel: "Super+Shift+R", what: "Snipping Tool: screen recording" },
  { accel: "Alt+Shift+R", what: "Zoom: remote control" },
  { accel: "Alt+A", what: "Zoom: mute" },
  { accel: "Alt+R", what: "Zoom: local recording" },
  { accel: "Control+Shift+M", what: "Teams: mute" },
  { accel: "Control+Shift+O", what: "Teams: camera" },
  { accel: "Control+Shift+E", what: "Teams: share" },
  { accel: "Control+Shift+Space", what: "Slack huddle: mute" },
  { accel: "Control+D", what: "Google Meet: microphone" },
];

const norm = (a: string) => {
  const parts = a.split("+").map((p) => p.trim().toLowerCase());
  const key = parts.pop() ?? "";
  return { mods: new Set(parts), key };
};

/** The known collision `accel` hits, or null. */
function collision(accel: string): string | null {
  const a = norm(accel);
  for (const c of KNOWN_COLLISIONS) {
    const k = norm(c.accel);
    const sameMods =
      k.key === "*"
        ? [...k.mods].every((m) => a.mods.has(m))
        : k.mods.size === a.mods.size && [...k.mods].every((m) => a.mods.has(m));
    if (sameMods && (k.key === "*" || k.key === a.key)) return c.what;
  }
  return null;
}

describe("[DK-K4] the default hotkey never eats AltGr on Windows and Linux", () => {
  test("no default off macOS holds Control+Alt or a known collision", () => {
    for (const platform of ["win32", "linux"]) {
      const d = hotkeyFor("", platform);
      expect(norm(d).mods.has("control") && norm(d).mods.has("alt")).toBe(false);
      expect(collision(d)).toBeNull();
    }
    expect(hotkeyFor("", "darwin")).toBe("Alt+Command+R");
    // A set hotkey is kept as typed, whatever it collides with: the warning is Settings' job.
    expect(hotkeyFor(" Control+Alt+K ", "linux")).toBe("Control+Alt+K");
    // Positive controls: the old default and each named family are caught by the same check.
    expect(collision("Control+Alt+R")).toContain("AltGr");
    expect(collision("Control+Shift+R")).toBe("browser hard reload");
    expect(collision("Super+Alt+R")).toContain("Game Bar");
  });

  test("Settings warns for a typed Control+Alt hotkey off macOS, and only there", () => {
    for (const platform of ["win32", "linux"]) {
      expect(hotkeyWarning("Control+Alt+X", platform)).toContain("AltGr");
      expect(hotkeyWarning("Alt+Ctrl+X", platform)).toContain("AltGr");
      expect(hotkeyWarning("CommandOrControl+Alt+X", platform)).toContain("AltGr");
      expect(hotkeyWarning(DEFAULT_HOTKEY, platform)).toBeNull();
      expect(hotkeyWarning("Control+Shift+K", platform)).toBeNull();
      expect(hotkeyWarning("", platform)).toBeNull();
    }
    // On a Mac, Control+Option is not AltGr.
    expect(hotkeyWarning("Control+Alt+X", "darwin")).toBeNull();
  });
});
