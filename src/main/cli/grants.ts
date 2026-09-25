/**
 * The OS grants akou needs, as `akou doctor` reads them and `doctor --grant` asks for them
 * (docs/ux/CLI.md CLI-38, REQUIREMENTS F0.26).
 *
 * - macOS: the microphone and system-audio grants belong to the akou app, which macOS asks the
 *   first time it records; the Accessibility grant is the global hotkey's (DK-K1). A command line
 *   is another process and cannot read another app's grants, so each reads `unknown`, and asking
 *   opens its pane in System Settings.
 * - Windows: the microphone switch for desktop apps is read from the registry; asking opens its
 *   Settings page. System audio (loopback) needs no grant.
 * - Linux: no grants; PipeWire or PulseAudio has to be running, which `doctor` cannot ask for.
 */

import { spawnSync } from "node:child_process";
import type { Grant, GrantChecker } from "./context.ts";

const MAC_PANES: Readonly<Record<string, string>> = {
  mic: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "system audio": "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

const WINDOWS_MIC_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

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
      const all = regValue(WINDOWS_MIC_KEY);
      const desktop = regValue(`${WINDOWS_MIC_KEY}\\NonPackaged`);
      const state: Grant["state"] =
        all === "Deny" || desktop === "Deny"
          ? "missing"
          : all === "Allow" && desktop !== null
            ? "granted"
            : "unknown";
      return [
        {
          name: "mic",
          state,
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
