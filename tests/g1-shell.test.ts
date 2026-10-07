/**
 * The G1 gate's readers (scripts/gates/g1-shell.ts): what `wmctrl`, the PowerShell probe, `gdbus`,
 * an autostart file and `reg query` print, read the way the gate judges it. The gate itself runs on
 * the release workflow's Windows and Linux runners; these hold its readers to real output shapes.
 */

import { describe, expect, test } from "bun:test";
import {
  desktopExec,
  gvariantStrings,
  parseWinWindows,
  parseWmctrl,
  regValue,
} from "../scripts/gates/g1-shell.ts";
import { autostartDesktop } from "../src/main/window/login-item.ts";

describe("G1 gate readers", () => {
  test("wmctrl -lp: pid and a title with spaces; a line that is not a window is left out", () => {
    const out = [
      "0x00a00003  0 4242   runner akou",
      "0x00c00004 -1 77     runner stalonetray",
      "0x00e00001  0 99     runner akou settings window",
      "not a window line",
    ].join("\n");
    expect(parseWmctrl(out)).toEqual([
      { pid: 4242, title: "akou" },
      { pid: 77, title: "stalonetray" },
      { pid: 99, title: "akou settings window" },
    ]);
    expect(parseWmctrl("")).toEqual([]);
  });

  test("the PowerShell window list: pid, class and title per line, CRLF included", () => {
    const out =
      "5120\tElectrobunWindow\takou\r\n808\tShell_TrayWnd\t\r\n12\tConsoleWindowClass\tbash\r\n";
    expect(parseWinWindows(out)).toEqual([
      { pid: 5120, title: "akou" },
      { pid: 808, title: "" },
      { pid: 12, title: "bash" },
    ]);
  });

  test("gdbus GetAll: the item's strings, an escaped quote included", () => {
    const out =
      "({'Category': <'ApplicationStatus'>, 'Id': <'electrobun-tray-1'>, 'Title': <'it\\'s akou'>, 'Status': <'Active'>, 'WindowId': <uint32 0>, 'IconThemePath': <'/opt/akou/tray'>},)";
    expect(gvariantStrings(out)).toEqual({
      Category: "ApplicationStatus",
      Id: "electrobun-tray-1",
      Title: "it's akou",
      Status: "Active",
      IconThemePath: "/opt/akou/tray",
    });
    expect(gvariantStrings("Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown")).toEqual(
      {},
    );
  });

  test("the autostart file the app writes: its Exec command sets AKOU_HEADLESS=1", () => {
    const exec = desktopExec(autostartDesktop("/opt/akou app/bin/launcher"));
    expect(exec).toBe('env AKOU_HEADLESS=1 "/opt/akou app/bin/launcher"');
    expect(desktopExec("[Desktop Entry]\nName=akou\n")).toBeNull();
  });

  test("reg query: the Run value's data; no value is null", () => {
    const out = [
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      '    akou    REG_SZ    cmd /c "set AKOU_HEADLESS=1&& start "" "C:\\akou\\bin\\launcher.exe""',
      "",
    ].join("\r\n");
    expect(regValue(out)).toBe(
      'cmd /c "set AKOU_HEADLESS=1&& start "" "C:\\akou\\bin\\launcher.exe""',
    );
    expect(
      regValue("ERROR: The system was unable to find the specified registry key or value."),
    ).toBeNull();
  });
});
