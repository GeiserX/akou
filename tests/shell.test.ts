/**
 * The desktop shell's pieces that need no ElectroBun (docs/DESIGN.md sections 1.5, 7 and 9): the
 * window's RPC handlers, the shell over a fake `NativeUi`, the login item, the ElectroBun config and
 * the Info.plist patch. Nothing here opens a window: the SDK exists only inside a Hutch build.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import config, { MAIN_OUT, SHERPA_LIBS, sherpaCopies } from "../electrobun.config.ts";
import { MIN_MACOS } from "../scripts/build-app.ts";
import { trayIconFiles } from "../scripts/tray-icons.ts";
import type { LogEvent } from "../src/core/log/events.ts";
import { BUNDLE_ID } from "../src/main/app-info.ts";
import { Bridge } from "../src/main/window/bridge.ts";
import {
  autostartDesktop,
  isLoginItem,
  LOGIN_LABEL,
  launchAgentPlist,
  loginItemPath,
  setLoginItem,
} from "../src/main/window/login-item.ts";
import { type WindowSend, windowRpc } from "../src/main/window/rpc.ts";
import {
  type AppMenuItem,
  DOCS_URL,
  hotkeyFor,
  Shell,
  type ShellApp,
  TRAY_DIR,
  trayImage,
  trayMenu,
  trayTitle,
  WINDOW_URL,
} from "../src/main/window/shell.ts";
import { appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";
import { fakeUi } from "./shell-helpers.ts";

const ROOT = join(import.meta.dir, "..");
const LONG = 30_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Why a tray item would show nothing, or null when its image would show (DK-T1). */
function trayImageFault(
  o: { title?: string; image?: string; template?: boolean },
  platform: string,
): string | null {
  if (!o.image) return "no image";
  if (!existsSync(o.image)) return "no file";
  const b = readFileSync(o.image);
  if (platform === "win32") {
    if (b.readUInt32BE(0) !== 0x00000100 || b.readUInt16LE(4) < 1) return "not an ICO";
    return o.template ? "a template image off macOS" : null;
  }
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) return "not a PNG";
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  if (w !== h || w < 16) return `a ${w}x${h} image`;
  // Colour type 6: RGBA. A template image is its alpha channel.
  if (b[25] !== 6) return "no alpha channel";
  if ((platform === "darwin") !== (o.template === true)) return "the template flag is wrong";
  return null;
}

const EDIT_ROLES = ["undo", "redo", "cut", "copy", "paste", "selectAll"];

function roles(items: readonly AppMenuItem[] | null, into = new Set<string>()): Set<string> {
  for (const i of items ?? []) {
    if ("role" in i && i.role) into.add(i.role);
    if ("submenu" in i && i.submenu) roles(i.submenu, into);
  }
  return into;
}

function missingRoles(menu: readonly AppMenuItem[] | null, want: string[]): string[] {
  const have = roles(menu);
  return want.filter((r) => !have.has(r));
}

function findItem(items: readonly AppMenuItem[] | null, action: string): AppMenuItem | undefined {
  for (const i of items ?? []) {
    if ("action" in i && i.action === action) return i;
    const inner = "submenu" in i && i.submenu ? findItem(i.submenu, action) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

describe("the window's RPC handlers (main side)", () => {
  test(
    "follow pushes the backlog and live events once each; unfollow stops it",
    async () => {
      const rig = await appRig();
      const id = await rig.startCall();
      const pushed: { stream: string; kind: string; data?: unknown }[] = [];
      const send: WindowSend = {
        followed: (m) => pushed.push(m),
        asked: () => {},
        status: () => {},
        showCall: () => {},
        showSettings: () => {},
      };
      const rpc = windowRpc(
        new Bridge(rig.app),
        () => send,
        async () => false,
      );
      expect((await rpc.handlers.follow({ stream: "s1", call: id, after: 0 })).ok).toBe(true);
      await until(() => pushed.filter((m) => m.kind === "event").length >= 3, 5000, "backlog");
      const seqs = pushed.filter((m) => m.kind === "event").map((m) => (m.data as LogEvent).seq);
      expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
      expect(seqs[0]).toBe(1);
      const api = await rpc.handlers.api({ method: "GET", path: `/calls/${id}` });
      expect(api.status).toBe(200);
      await rpc.handlers.unfollow({ stream: "s1" });
      const before = pushed.length;
      await rig.api("POST", `/calls/${id}/notes`, { text: "after unfollow" });
      await Bun.sleep(300);
      expect(pushed.filter((m, i) => i >= before && m.kind === "event").length).toBe(0);
      await rig.api("POST", "/calls/live/stop");
      rpc.close();
      await rig.close();
    },
    LONG,
  );

  test(
    "audio comes back as base64 of the part's bytes",
    async () => {
      const rig = await appRig();
      const id = await rig.startCall();
      await rig.api("POST", "/calls/live/stop");
      const folder = (await rig.api("GET", `/calls/${id}`)).body.folder as string;
      writeFileSync(join(folder, "audio", "part-001.opus"), new Uint8Array([1, 2, 3, 250]));
      const rpc = windowRpc(
        new Bridge(rig.app),
        () => ({}) as WindowSend,
        async () => false,
      );
      const a = await rpc.handlers.audio({ call: id, part: 1 });
      expect([...Buffer.from(a.base64, "base64")]).toEqual([1, 2, 3, 250]);
      expect(a.type).toBe("audio/ogg");
      rpc.close();
      await rig.close();
    },
    LONG,
  );
});

describe("the desktop shell over a fake NativeUi", () => {
  function fakeApp() {
    const state = { live: false, login: false, quits: 0, starts: 0, windows: 0 };
    let shell: Shell | null = null;
    const app: ShellApp = {
      status: async () => ({
        live: state.live ? { call: "c1", state: "recording" } : null,
        share: { active: false },
      }),
      start: async () => {
        state.starts++;
        state.live = true;
        return { ok: true, call: "c1" };
      },
      stopLive: async () => {
        state.live = false;
      },
      config: () => ({ settings: { "app.hotkey": "", "app.openAtLogin": state.login } }),
      saveSetting: async (_k, v) => {
        state.login = v;
      },
      quit: async () => {
        state.quits++;
      },
      openSettingsPane: async () => false,
      openWindow: async (call) => {
        state.windows++;
        shell?.show(call);
      },
      onAnnounce: () => () => {},
    };
    return { app, state, bind: (s: Shell) => (shell = s) };
  }

  const bridgeStub = {
    watchLifecycle: () => () => {},
    app: { status: async () => ({}), watch: () => () => {} },
  } as unknown as Bridge;

  test("the hotkey is the platform default unless set", () => {
    expect(hotkeyFor("", "darwin")).toBe("Alt+Command+R");
    expect(hotkeyFor("", "linux")).toBe("Control+Alt+R");
    expect(hotkeyFor(" Control+Shift+K ", "win32")).toBe("Control+Shift+K");
  });

  test("[T3.6] Minutes to start: the hotkey and the tray start a call directly, and stop it", async () => {
    const f = fakeUi();
    const a = fakeApp();
    const logins: boolean[] = [];
    const shell = new Shell(a.app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async (on) => logins.push(on),
    });
    a.bind(shell);
    await shell.start();
    expect([...f.shortcuts.keys()]).toEqual(["Alt+Command+R"]);
    expect(logins).toEqual([false]);
    // No window was opened to start: the shell opens it only when asked.
    expect(f.log.filter((l) => l.startsWith("window"))).toEqual([]);
    await (f.shortcuts.get("Alt+Command+R") as () => Promise<void>)();
    expect(a.state).toMatchObject({ starts: 1, live: true });
    await shell.toggle();
    expect(a.state.live).toBe(false);
    f.tray("record");
    await until(() => a.state.live, 1000, "tray record");
    expect(a.state.starts).toBe(2);
    await shell.close();
  });

  test("the tray menu and title follow the state; Open at login toggles the login item", async () => {
    expect(trayMenu({ live: false, openAtLogin: false })[0]).toMatchObject({ action: "record" });
    expect(trayMenu({ live: true, openAtLogin: true })[0]).toMatchObject({ action: "stop" });
    expect(
      trayMenu({ live: true, openAtLogin: true }).find(
        (i) => i.type === "normal" && i.action === "login",
      ),
    ).toMatchObject({ checked: true });
    expect(trayTitle({ live: null, share: { active: false } })).toBe("");
    expect(trayTitle({ live: { state: "recording" } as never, share: { active: false } })).toBe(
      "● rec",
    );
    expect(trayTitle({ live: null, share: { active: true } })).toBe("● shared");
    const f = fakeUi();
    const a = fakeApp();
    const logins: boolean[] = [];
    const shell = new Shell(a.app, bridgeStub, f.ui, {
      platform: "linux",
      setLoginItem: async (on) => logins.push(on),
    });
    await shell.start();
    f.tray("login");
    await until(() => logins.length === 2, 1000, "login toggle");
    expect(logins).toEqual([false, true]);
    expect(a.state.login).toBe(true);
    await shell.close();
  });

  test("show opens one window on the page, reuses it, and passes the call to the page", async () => {
    const f = fakeUi();
    const a = fakeApp();
    const shell = new Shell(a.app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    await shell.start();
    shell.show();
    shell.show("c9");
    expect(f.log.filter((l) => l.startsWith("window"))).toEqual([`window ${WINDOW_URL}`]);
    // A new page is still loading and would drop the message: it waits for the page's boot.
    expect(f.log).not.toContain("call c9");
    await f.boot();
    expect(f.log.filter((l) => l === "call c9")).toEqual(["call c9"]);
    // The booted page gets the next one at once.
    shell.show("c8");
    expect(f.log).toContain("call c8");
    await shell.close();
    expect(f.log).toContain("close");
    expect(f.log).toContain("tray removed");
    expect(f.shortcuts.size).toBe(0);
  });

  test("[DK-T1] An invisible tray: the tray always gets the platform's icon, idle included", async () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const f = fakeUi();
      const a = fakeApp();
      const shell = new Shell(a.app, bridgeStub, f.ui, { platform, setLoginItem: async () => {} });
      await shell.start();
      expect(f.trays).toHaveLength(1);
      expect(trayImageFault(f.trays[0] ?? {}, platform)).toBeNull();
      // Idle has no text title, so the image is all the menu bar shows.
      expect(f.title()).toBe("");
      await shell.close();
    }
    // Positive controls: no image, a missing file and the wrong format all fail the same check.
    expect(trayImageFault({ title: "" }, "darwin")).toBe("no image");
    expect(trayImageFault({ image: join(TRAY_DIR, "none.png"), template: true }, "darwin")).toBe(
      "no file",
    );
    expect(trayImageFault({ ...trayImage("darwin"), template: false }, "win32")).toBe("not an ICO");
    expect(trayImageFault({ ...trayImage("win32") }, "linux")).toBe("not a PNG");
  });

  test("the tray icons on disk are the ones scripts/tray-icons.ts draws", () => {
    const files = trayIconFiles();
    expect(Object.keys(files).sort()).toEqual(["akou-template.png", "akou.ico", "akou.png"]);
    for (const [name, bytes] of Object.entries(files)) {
      expect(Buffer.from(readFileSync(join(TRAY_DIR, name))).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  test("[DK-M1] the application menu carries the Edit roles, so copy and paste work in the notepad and the ask box", async () => {
    const f = fakeUi();
    const a = fakeApp();
    const shell = new Shell(a.app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    a.bind(shell);
    await shell.start();
    const menu = f.appMenu();
    expect(missingRoles(menu, EDIT_ROLES)).toEqual([]);
    expect(missingRoles(menu, ["about", "hide", "quit", "minimize", "zoom", "close"])).toEqual([]);
    // Positive control: the same check on a menu without Copy, and on no menu at all.
    const noCopy = (menu ?? []).map((m) =>
      "submenu" in m && m.submenu
        ? { ...m, submenu: m.submenu.filter((i) => !("role" in i && i.role === "copy")) }
        : m,
    );
    expect(missingRoles(noCopy, EDIT_ROLES)).toEqual(["copy"]);
    expect(missingRoles(null, EDIT_ROLES)).toEqual(EDIT_ROLES);
    // Settings… with no window opens the window on Settings once its page has booted; the Help
    // item opens the docs.
    expect(findItem(menu, "settings")).toMatchObject({ label: "Settings…", accelerator: "," });
    f.menu("settings");
    await until(() => a.state.windows === 1, 1000, "the window");
    expect(f.log).not.toContain("settings");
    await f.boot();
    await until(() => f.log.includes("settings"), 1000, "the settings pane");
    // With the page up, Settings… reaches it directly.
    f.menu("settings");
    await until(() => f.log.filter((l) => l === "settings").length === 2, 1000, "again");
    expect(findItem(menu, "docs")).toMatchObject({ label: "Open the docs" });
    f.menu("docs");
    expect(f.log).toContain(`open ${DOCS_URL}`);
    await shell.close();
  });

  /** A shell whose bridge hands the test the app's event watcher, to feed it health events. */
  async function healthShell(f: ReturnType<typeof fakeUi>) {
    let watcher: (call: string, e: LogEvent) => void = () => {};
    const bridge = {
      watchLifecycle: () => () => {},
      app: {
        status: async () => ({}),
        watch: (fn: typeof watcher) => {
          watcher = fn;
          return () => {};
        },
      },
    } as unknown as Bridge;
    const shell = new Shell(fakeApp().app, bridge, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    await shell.start();
    const health = (ch: "mic" | "call", state: string) =>
      watcher("c1", { type: "health", ch, state } as unknown as LogEvent);
    return { shell, health };
  }

  test("[DK-N2] a window shown without the focus leaves the capture notices on", async () => {
    const f = fakeUi({ focusOnShow: false });
    const { shell, health } = await healthShell(f);
    // An agent or `akou open` shows the window while the user stays in the meeting app.
    shell.show();
    health("call", "dead");
    expect(f.notices.map((n) => n.title)).toEqual(["Call side silent"]);
    // Positive control: once the OS says the window has the focus, its banner says it instead.
    f.focus(true);
    health("mic", "dead");
    expect(f.notices).toHaveLength(1);
    f.focus(false);
    health("mic", "dead");
    expect(f.notices.map((n) => n.title)).toEqual(["Call side silent", "Microphone silent"]);
    await shell.close();
  });

  test("[DK-N2] a new capture state on the same channel within the minute still notifies", async () => {
    const f = fakeUi();
    const { shell, health } = await healthShell(f);
    health("call", "dead");
    health("call", "dead");
    expect(f.notices).toHaveLength(1);
    // The helper's `permission-suspect` names the fix; a `dead` a moment earlier must not hide it.
    health("call", "permission-suspect");
    expect(f.notices.map((n) => n.body)).toEqual([
      "akou is rebuilding the capture.",
      "Check that akou is allowed in System Settings > Privacy & Security > System Audio Recording.",
    ]);
    await shell.close();
  });

  test("off macOS the webview handles the clipboard keys itself: no application menu is set", async () => {
    for (const platform of ["win32", "linux"]) {
      const f = fakeUi();
      const shell = new Shell(fakeApp().app, bridgeStub, f.ui, {
        platform,
        setLoginItem: async () => {},
      });
      await shell.start();
      expect(f.appMenu()).toBeNull();
      await shell.close();
    }
  });

  test("[spike] Signals swallowed by the shell: the first quit is held until the app has quit", async () => {
    const f = fakeUi();
    const a = fakeApp();
    const shell = new Shell(a.app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    await shell.start();
    expect(f.quitRequested()).toBe(true);
    await until(() => f.log.includes("quit"), 1000, "the quit after the app's");
    expect(a.state.quits).toBe(1);
    // The second before-quit (from ui.quit) is let through.
    expect(f.quitRequested()).toBe(false);
    await shell.close();
  });
});

describe("the login item", () => {
  test("macOS: a LaunchAgent that starts the app headless, and removing it removes it", async () => {
    const t = tempDir();
    const o = {
      platform: "darwin",
      home: t.dir,
      program: "/Applications/akou & co.app/Contents/MacOS/launcher",
    };
    expect(await isLoginItem(o)).toBe(false);
    await setLoginItem(true, o);
    const path = loginItemPath("darwin", t.dir) as string;
    const plist = readFileSync(path, "utf8");
    expect(plist).toContain(`<string>${LOGIN_LABEL}</string>`);
    expect(plist).toContain("akou &amp; co.app");
    expect(plist).toContain("<key>AKOU_HEADLESS</key>");
    expect(plist).toBe(launchAgentPlist(o.program));
    expect(await isLoginItem(o)).toBe(true);
    if (process.platform === "darwin") {
      const lint = spawnSync("/usr/bin/plutil", ["-lint", path]);
      expect(lint.status).toBe(0);
    }
    await setLoginItem(false, o);
    expect(existsSync(path)).toBe(false);
    t.cleanup();
  });

  test("Linux: an XDG autostart entry with the program quoted", async () => {
    const t = tempDir();
    const o = { platform: "linux", home: t.dir, program: '/opt/akou/bin/a"k$ou' };
    await setLoginItem(true, o);
    const text = readFileSync(loginItemPath("linux", t.dir) as string, "utf8");
    expect(text).toBe(autostartDesktop(o.program));
    expect(text).toContain('Exec=env AKOU_HEADLESS=1 "/opt/akou/bin/a\\"k\\$ou"');
    await setLoginItem(false, o);
    expect(await isLoginItem(o)).toBe(false);
    t.cleanup();
  });

  test("Windows: the current user's Run key, added and deleted through reg.exe", async () => {
    const calls: string[][] = [];
    const o = {
      platform: "win32",
      home: "C:\\Users\\a",
      program: "C:\\Program Files\\akou\\akou.exe",
      run: async (cmd: readonly string[]) => {
        calls.push([...cmd]);
        return { code: 0, stdout: "akou REG_SZ x" };
      },
    };
    expect(loginItemPath("win32", o.home)).toBeNull();
    await setLoginItem(true, o);
    await setLoginItem(false, o);
    expect(calls[0]?.slice(0, 3)).toEqual([
      "reg",
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    ]);
    expect(calls[0]?.join(" ")).toContain("AKOU_HEADLESS=1");
    expect(calls[1]?.slice(0, 2)).toEqual(["reg", "delete"]);
  });
});

describe("the ElectroBun build", () => {
  test("ElectroBun 2.0.1 pinned, with the real Bun main process and the window's view", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.devDependencies.electrobun).toBe("2.0.1");
    expect(config.build?.mainProcess).toBe("bun");
    expect(config.app.identifier).toBe(BUNDLE_ID);
    expect(config.app.version).toBe(pkg.version);
    expect(config.runtime?.exitOnLastWindowClosed).toBe(false);
    for (const p of [
      config.build?.bun?.entrypoint,
      config.build?.views?.main?.entrypoint,
      config.scripts?.postWrap,
    ]) {
      expect(existsSync(join(ROOT, p as string))).toBe(true);
    }
    for (const src of Object.keys(config.build?.copy ?? {})) {
      if (!src.startsWith("node_modules/")) expect(existsSync(join(ROOT, src))).toBe(true);
    }
    expect(config.build?.mac?.bundleCEF).toBe(false);
    expect(config.build?.mac?.entitlements?.["com.apple.security.device.audio-input"]).toBe(true);
  });

  test("[spike] Native libraries missing from the bundle: sherpa-onnx-node, its .node file and both libraries are in build.copy beside the main process", () => {
    const copies = sherpaCopies("darwin", "arm64");
    const nm = `${MAIN_OUT}/node_modules`;
    expect(copies).toEqual({
      "node_modules/sherpa-onnx-node": `${nm}/sherpa-onnx-node`,
      "node_modules/sherpa-onnx-darwin-arm64/package.json": `${nm}/sherpa-onnx-darwin-arm64/package.json`,
      "node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node": `${nm}/sherpa-onnx-darwin-arm64/sherpa-onnx.node`,
      "node_modules/sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib": `${nm}/sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib`,
      "node_modules/sherpa-onnx-darwin-arm64/libonnxruntime.dylib": `${nm}/sherpa-onnx-darwin-arm64/libonnxruntime.dylib`,
    });
    // The .node file finds its libraries beside itself (@loader_path), so they travel together.
    for (const lib of SHERPA_LIBS.darwin ?? []) {
      expect(copies[`node_modules/sherpa-onnx-darwin-arm64/${lib}`]).toBe(
        `${nm}/sherpa-onnx-darwin-arm64/${lib}`,
      );
    }
    // The two names are the ones the addon links, when the package is here to ask.
    const node = join(ROOT, "node_modules", "sherpa-onnx-darwin-arm64", "sherpa-onnx.node");
    if (process.platform === "darwin" && existsSync(node)) {
      const linked = spawnSync("otool", ["-L", node]).stdout.toString();
      for (const lib of SHERPA_LIBS.darwin ?? []) expect(linked).toContain(`@rpath/${lib}`);
    }
  });

  test("[spike] Info.plist cannot carry the system-audio usage string: the patch writes both keys", () => {
    if (process.platform !== "darwin") {
      console.log(
        "patch-plist: skipped, plutil exists on macOS only; the release job runs it there",
      );
      return;
    }
    const t = tempDir();
    const plist = join(t.dir, "Info.plist");
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string><key>CFBundleVersion</key><string>1.2.3</string></dict></plist>\n`,
    );
    // Positive control: before the patch the key is missing.
    expect(
      spawnSync("/usr/bin/plutil", ["-extract", "NSAudioCaptureUsageDescription", "raw", plist])
        .status,
    ).not.toBe(0);
    const r = spawnSync("/bin/sh", [join(ROOT, "scripts", "patch-plist.sh"), plist]);
    expect(r.status).toBe(0);
    for (const key of ["NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription"]) {
      const v = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", plist]);
      expect(v.status).toBe(0);
      expect(v.stdout.toString()).toContain("akou records");
    }
    expect(
      spawnSync("/bin/sh", [join(ROOT, "scripts", "patch-plist.sh"), join(t.dir, "none")]).status,
    ).toBe(66);
    t.cleanup();
  });

  test("the patch gives Finder the version and macOS the 14.4 floor Hutch's table leaves out", () => {
    if (process.platform !== "darwin") {
      console.log(
        "patch-plist: skipped, plutil exists on macOS only; the release job runs it there",
      );
      return;
    }
    const t = tempDir();
    const plist = join(t.dir, "Info.plist");
    const head = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>`;
    const value = (key: string) => {
      const r = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", plist]);
      return r.status === 0 ? r.stdout.toString().trim() : null;
    };
    // Hutch writes CFBundleVersion only.
    writeFileSync(
      plist,
      `${head}<key>CFBundleVersion</key><string>1.2.3</string></dict></plist>\n`,
    );
    expect(value("CFBundleShortVersionString")).toBeNull();
    expect(value("LSMinimumSystemVersion")).toBeNull();
    expect(spawnSync("/bin/sh", [join(ROOT, "scripts", "patch-plist.sh"), plist]).status).toBe(0);
    expect(value("CFBundleShortVersionString")).toBe("1.2.3");
    expect(value("LSMinimumSystemVersion")).toBe(MIN_MACOS);
    // Without a CFBundleVersion there is no version to show: the patch refuses.
    writeFileSync(plist, `${head}</dict></plist>\n`);
    expect(spawnSync("/bin/sh", [join(ROOT, "scripts", "patch-plist.sh"), plist]).status).toBe(70);
    t.cleanup();
  });
});
