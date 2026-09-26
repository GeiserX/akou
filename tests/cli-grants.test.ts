/**
 * The Windows microphone grant as `akou doctor` reads it from the registry (docs/ux/CLI.md CLI-38):
 * three switches, any of which can turn it off. The registry reader is a fake, so this runs on
 * every OS; reading the real registry is owner-verifiable on a Windows machine.
 */

import { describe, expect, test } from "bun:test";
import { requestGrant, WINDOWS_MIC_KEYS, windowsMicState } from "../src/main/cli/grants.ts";

/** A registry of the three switches: device-wide, this user's, and this user's desktop apps. */
function reg(device: string | null, user: string | null, desktop: string | null) {
  const values: Record<string, string | null> = {
    [WINDOWS_MIC_KEYS.device]: device,
    [WINDOWS_MIC_KEYS.user]: user,
    [WINDOWS_MIC_KEYS.desktop]: desktop,
  };
  return (key: string) => values[key] ?? null;
}

describe("[CLI-38] the Windows microphone grant", () => {
  test("the device-wide switch off is missing, even with the user's switches on", () => {
    expect(windowsMicState(reg("Deny", "Allow", "Allow"))).toBe("missing");
  });

  test("positive controls: all on is granted; the user's or the desktop switch off is missing", () => {
    expect(windowsMicState(reg("Allow", "Allow", "Allow"))).toBe("granted");
    // No device-wide value is the default, which is on.
    expect(windowsMicState(reg(null, "Allow", "Allow"))).toBe("granted");
    expect(windowsMicState(reg("Allow", "Deny", "Allow"))).toBe("missing");
    expect(windowsMicState(reg("Allow", "Allow", "Deny"))).toBe("missing");
    expect(windowsMicState(reg("Allow", null, null))).toBe("unknown");
  });

  test("the device-wide switch is read from HKLM, the others from HKCU", () => {
    expect(WINDOWS_MIC_KEYS.device.startsWith("HKLM\\")).toBe(true);
    expect(WINDOWS_MIC_KEYS.user.startsWith("HKCU\\")).toBe(true);
    expect(WINDOWS_MIC_KEYS.desktop).toBe(`${WINDOWS_MIC_KEYS.user}\\NonPackaged`);
  });
});

describe("[CLI-38] asking for a grant says whether its settings pane opened", () => {
  /** An opener that records each URL and answers as told. */
  function opener(ok: boolean) {
    const urls: string[] = [];
    const open = (url: string): boolean => {
      urls.push(url);
      return ok;
    };
    return { urls, open };
  }

  test("an opener that failed or timed out is reported, not called opened", async () => {
    const o = opener(false);
    expect(await requestGrant("mic", "darwin", o.open)).toBe("not opened");
    expect(await requestGrant("mic", "win32", o.open)).toBe("not opened");
    expect(o.urls).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      "ms-settings:privacy-microphone",
    ]);
  });

  test("positive control: an opener that succeeded is `settings opened`", async () => {
    const o = opener(true);
    expect(await requestGrant("accessibility", "darwin", o.open)).toBe("settings opened");
    expect(o.urls).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    ]);
  });

  test("a grant with no pane on this OS opens nothing and says so", async () => {
    const o = opener(true);
    expect(await requestGrant("system audio", "win32", o.open)).toBe("not opened");
    expect(await requestGrant("mic", "linux", o.open)).toBe("not opened");
    expect(o.urls).toEqual([]);
  });
});
