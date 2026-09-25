/**
 * The OS grants akou needs, as `akou doctor` reads them and `doctor --grant` asks for them
 * (docs/ux/CLI.md CLI-38, REQUIREMENTS F0.26).
 *
 * - macOS: the microphone and system-audio grants belong to the akou app, which macOS asks the
 *   first time it records; the Accessibility grant is the global hotkey's (DK-K1). A command line
 *   is another process and cannot read another app's grants, so each reads `unknown`, and asking
 *   opens its pane in System Settings.
 * - Windows: three registry switches can turn the microphone off: the device-wide one (HKLM), the
 *   user's, and the user's desktop apps (HKCU); asking opens its Settings page. System audio
 *   (loopback) needs no grant.
 * - Linux: no grants; PipeWire or PulseAudio has to be running, which `doctor` cannot ask for.
 */

import { spawnSync } from "node:child_process";
import type { Grant, GrantChecker } from "./context.ts";

const MAC_PANES: Readonly<Record<string, string>> = {
  mic: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "system audio": "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

const CONSENT_MIC =
  "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

/** The Windows microphone switches, each a `Value` of `Allow` or `Deny`. */
export const WINDOWS_MIC_KEYS = {
  /** Settings, Privacy & security, Microphone, "Microphone access": the whole device. */
  device: `HKLM\\${CONSENT_MIC}`,
  /** "Let apps access your microphone", for this user. */
  user: `HKCU\\${CONSENT_MIC}`,
  /** "Let desktop apps access your microphone", for this user: akou is a desktop app. */
  desktop: `HKCU\\${CONSENT_MIC}\\NonPackaged`,
} as const;

/** The microphone grant from the three switches: any `Deny` is missing. */
export function windowsMicState(read: (key: string) => string | null): Grant["state"] {
  const device = read(WINDOWS_MIC_KEYS.device);
  const user = read(WINDOWS_MIC_KEYS.user);
  const desktop = read(WINDOWS_MIC_KEYS.desktop);
  if (device === "Deny" || user === "Deny" || desktop === "Deny") return "missing";
  return user === "Allow" && desktop !== null ? "granted" : "unknown";
}

/** `Allow` or `Deny` from one registry value, or null when it cannot be read. */
function regValue(key: string): string | null {
  const r = spawnSync("reg", ["query", key, "/v", "Value"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  return /Value\s+REG_SZ\s+(\w+)/.exec(r.stdout)?.[1] ?? null;
}

function openPane(url: string): void {
  if (process.platform === "darwin") spawnSync("/usr/bin/open", [url], { timeout: 5000 });
  else if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], { timeout: 5000, windowsHide: true });
  }
}

export const systemGrants: GrantChecker = {
  async check(): Promise<Grant[]> {
    if (process.platform === "darwin") {
      const unread =
        "it belongs to the akou app, which this command line cannot read; the app asks the first time it records";
      return [
        { name: "mic", state: "unknown", detail: unread },
        { name: "system audio", state: "unknown", detail: unread },
        {
          name: "accessibility",
          state: "unknown",
          detail: "the global hotkey needs it (System Settings, Privacy & Security, Accessibility)",
        },
      ];
    }
    if (process.platform === "win32") {
      return [
        {
          name: "mic",
          state: windowsMicState(regValue),
          detail: "Settings, Privacy & security, Microphone, for desktop apps",
        },
        { name: "system audio", state: "n/a", detail: "Windows asks for no grant to record it" },
      ];
    }
    const none = "Linux asks for no grant; PipeWire or PulseAudio has to be running";
    return [
      { name: "mic", state: "n/a", detail: none },
      { name: "system audio", state: "n/a", detail: none },
    ];
  },
  async request(name: string) {
    if (process.platform === "darwin") {
      const pane = MAC_PANES[name];
      if (pane) openPane(pane);
    } else if (process.platform === "win32" && name === "mic") {
      openPane("ms-settings:privacy-microphone");
    }
    return "settings opened";
  },
};
