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
  hotkeyFor,
  type NativeTray,
  type NativeUi,
  Shell,
  type ShellApp,
  trayMenu,
  trayTitle,
  WINDOW_URL,
} from "../src/main/window/shell.ts";
import { appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const LONG = 30_000;

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
  function fakeUi() {
    const log: string[] = [];
    let action: (a: string) => void = () => {};
    let beforeQuit: (e: { cancel(): void }) => void = () => {};
    let menu: unknown[] = [];
    let title = "";
    const shortcuts = new Map<string, () => void>();
    const ui: NativeUi = {
      openWindow: (o) => {
        log.push(`window ${o.url}`);
        return {
          window: {
            show: () => log.push("show"),
            close: () => log.push("close"),
            onClose: () => {},
          },
          send: {
            followed: () => {},
            asked: () => {},
            status: () => {},
            showCall: (m) => log.push(`call ${m.call}`),
          },
        };
      },
      createTray: (): NativeTray => ({
        setMenu: (m) => {
          menu = m;
        },
        setTitle: (t) => {
          title = t;
        },
        onAction: (fn) => {
          action = fn;
        },
        remove: () => log.push("tray removed"),
      }),
      registerShortcut: (a, fn) => {
        shortcuts.set(a, fn);
        return true;
      },
      unregisterShortcut: (a) => shortcuts.delete(a),
      onBeforeQuit: (fn) => {
        beforeQuit = fn;
      },
      quit: () => log.push("quit"),
      openExternal: () => true,
    };
    return {
      ui,
      log,
      shortcuts,
      menu: () => menu,
      title: () => title,
      tray: (a: string) => action(a),
      quitRequested: () => {
        let cancelled = false;
        beforeQuit({ cancel: () => (cancelled = true) });
        return cancelled;
      },
    };
  }

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
        return { ok: true };
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
    };
    return { app, state, bind: (s: Shell) => (shell = s) };
  }

  const bridgeStub = {
    watchLifecycle: () => () => {},
    app: { status: async () => ({}) },
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
    expect(f.log).toContain("call c9");
    await shell.close();
    expect(f.log).toContain("close");
    expect(f.log).toContain("tray removed");
    expect(f.shortcuts.size).toBe(0);
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
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string></dict></plist>\n`,
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
});
