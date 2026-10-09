/**
 * The G1 gate's readers (scripts/gates/g1-shell.ts): what `wmctrl`, the PowerShell probe, `gdbus`,
 * an autostart file, `reg query`, the macOS probe and a LaunchAgent print, read the way the gate
 * judges it. The gate itself runs on the release workflow's Windows and Linux runners and on a Mac;
 * these hold its readers to real output shapes.
 */

import { describe, expect, test } from "bun:test";
import {
  desktopExec,
  gvariantStrings,
  launchAgentCommand,
  macTray,
  macWindows,
  parseWinWindows,
  parseWmctrl,
  regValue,
  statusItemWindow,
} from "../scripts/gates/g1-shell.ts";
import { autostartDesktop, LOGIN_LABEL } from "../src/main/window/login-item.ts";

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

  test("macOS windows: a layer-0 window of the app's process titled akou; a hidden title counts", () => {
    const rows = [
      { pid: 30567, layer: 0, owner: "akou", title: "akou" },
      { pid: 30567, layer: 3, owner: "akou", title: "akou" },
      { pid: 511, layer: 0, owner: "Finder", title: "akou" },
      { pid: 30567, layer: 0, owner: "akou", title: "Settings" },
      { pid: 40001, layer: 0, owner: "akou", title: null },
    ];
    expect(macWindows(rows, [30567, 40001])).toEqual([
      { pid: 30567, title: "akou" },
      { pid: 40001, title: "(title hidden: no Screen Recording)" },
    ]);
    // Control: the app's pid gone, nothing of it shows.
    expect(macWindows(rows, [])).toEqual([]);
  });

  test("macOS tray: an app with a status item; no item is none; a probe refused is an error", () => {
    const out = macTray([
      { pid: 30567, items: [{ role: "AXMenuBarItem", title: "", description: null }] },
      { pid: 511, items: [] },
      { pid: 77, error: "AXError -25211" },
    ]);
    expect(out.items).toEqual([{ pid: 30567, props: { items: "1", role: "AXMenuBarItem" } }]);
    expect(out.errors).toEqual(["pid 77: AXError -25211"]);
    expect(macTray([{ pid: 511, items: [] }])).toEqual({ items: [], errors: [] });
  });

  test("the LaunchAgent the app writes, as plutil reads it: its command sets AKOU_HEADLESS=1", () => {
    const plist = {
      Label: LOGIN_LABEL,
      ProgramArguments: ["/Applications/akou app.app/Contents/MacOS/launcher"],
      EnvironmentVariables: { AKOU_HEADLESS: "1" },
      RunAtLoad: true,
      ProcessType: "Interactive",
    };
    expect(launchAgentCommand(plist)).toBe(
      'env AKOU_HEADLESS=1 "/Applications/akou app.app/Contents/MacOS/launcher"',
    );
    expect(launchAgentCommand({ ...plist, EnvironmentVariables: undefined })).toBe(
      'env "/Applications/akou app.app/Contents/MacOS/launcher"',
    );
    expect(launchAgentCommand({ Label: LOGIN_LABEL })).toBeNull();
    expect(launchAgentCommand(null)).toBeNull();
  });

  test("macOS status item: its own status-bar window by place; none found is no shot", () => {
    const rows = [
      // A wider status-bar window over the same spot is not the item's own.
      {
        id: 6,
        pid: 509,
        layer: 25,
        owner: "Control Center",
        title: "Item-0",
        bounds: { x: 1480, y: 0, w: 68, h: 30 },
      },
      {
        id: 7,
        pid: 509,
        layer: 25,
        owner: "Control Center",
        title: "Item-0",
        bounds: { x: 1499, y: 0, w: 34, h: 30 },
      },
      {
        id: 8,
        pid: 509,
        layer: 25,
        owner: "Control Center",
        title: "Item-0",
        bounds: { x: 1533, y: 0, w: 40, h: 30 },
      },
      {
        id: 2,
        pid: 257,
        layer: 24,
        owner: "Window Server",
        title: "Menubar",
        bounds: { x: 0, y: 0, w: 1920, h: 30 },
      },
      {
        id: 9,
        pid: 600,
        layer: 0,
        owner: "Notes",
        title: "x",
        bounds: { x: 1400, y: 0, w: 300, h: 300 },
      },
    ];
    expect(statusItemWindow(rows, { x: 1499, y: 0, w: 34, h: 32 })?.id).toBe(7);
    expect(statusItemWindow(rows, { x: 1534, y: 1, w: 38, h: 28 })?.id).toBe(8);
    // Control: where no status-bar window sits, the menu bar and a covering window are never taken.
    expect(statusItemWindow(rows, { x: 200, y: 0, w: 34, h: 30 })).toBeNull();
    expect(statusItemWindow(rows.slice(2), { x: 1499, y: 0, w: 34, h: 30 })).toBeNull();
  });
});
