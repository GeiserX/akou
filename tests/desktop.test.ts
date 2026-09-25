/**
 * The desktop shell's P1 lines (docs/ux/DESKTOP.md sections 5 to 7): the default hotkey off macOS
 * (DK-K4), the Dock's `reopen` (DK-M2), the quit that asks during a recording (DK-M3), the window's
 * remembered frame (DK-M4), the command-line install from the menu (DK-M6) and the floating
 * indicator (DK-F1). Each runs the real shell over the fake `NativeUi`; nothing opens a window.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BUILT, builtCopies, MAIN_OUT } from "../electrobun.config.ts";
import type { LogEvent } from "../src/core/log/events.ts";
import type { Bridge } from "../src/main/window/bridge.ts";
import { DEFAULT_HOTKEY, hotkeyWarning } from "../src/main/window/hotkey.ts";
import {
  adminScript,
  BUNDLED_CLI,
  CLI_DIR,
  type InstallOps,
  type InstallOutcome,
  installCli,
  installMessage,
  nodeOps,
} from "../src/main/window/install-cli.ts";
import {
  hotkeyFor,
  INDICATOR_SIZE,
  placeFrame,
  type Rect,
  Shell,
  type ShellApp,
  type ShellState,
  TRAY_DIR,
  WINDOW_URL,
} from "../src/main/window/shell.ts";
import { fileState, SHELL_STATE_FILE } from "../src/main/window/state.ts";
import { appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";
import { fakeUi, shellOn } from "./shell-helpers.ts";

const LONG = 30_000;

/** An app that records what the shell asks of it; `live` says whether a call records. */
function fakeApp(o: { live?: boolean; settings?: Record<string, unknown> } = {}) {
  const state = { live: o.live ?? false, quits: 0, windows: 0, stops: 0 };
  let shell: Shell | null = null;
  const app: ShellApp = {
    status: async () => ({
      live: state.live ? { call: "c1", state: "recording" } : null,
      share: { active: false },
    }),
    start: async () => {
      state.live = true;
      return { ok: true, call: "c1" };
    },
    stopLive: async () => {
      state.stops++;
      state.live = false;
    },
    config: () => ({
      settings: { "app.hotkey": "", "app.openAtLogin": false, ...o.settings },
    }),
    saveSetting: async () => {},
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

/** A store for the shell's remembered state, in memory. */
function memoryState(initial: ShellState = {}) {
  let saved: ShellState = structuredClone(initial);
  const writes: ShellState[] = [];
  return {
    writes,
    load: () => structuredClone(saved),
    save: (s: ShellState) => {
      saved = structuredClone(s);
      writes.push(saved);
    },
  };
}

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

describe("[DK-M2] clicking the Dock icon reopens a closed window", () => {
  test("reopen with no window opens one; with a window, brings it forward", async () => {
    const f = fakeUi();
    const a = fakeApp();
    const shell = new Shell(a.app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    a.bind(shell);
    await shell.start();
    expect(f.log.filter((l) => l.startsWith("window"))).toEqual([]);
    f.reopen();
    await until(() => f.log.includes("show"), 1000, "the window");
    expect(a.state.windows).toBe(1);
    expect(f.log.filter((l) => l.startsWith("window"))).toEqual([`window ${WINDOW_URL}`]);
    // With the window there, the Dock click brings the same window forward.
    f.reopen();
    await until(() => f.log.filter((l) => l === "show").length === 2, 1000, "forward");
    expect(f.log.filter((l) => l.startsWith("window"))).toHaveLength(1);
    // Closed by the user, the next click opens a new one.
    f.closeWindow();
    f.reopen();
    await until(() => f.log.filter((l) => l.startsWith("window")).length === 2, 1000, "reopened");
    await shell.close();
  });
});

describe("[DK-M3] quitting during a recording asks first", () => {
  test(
    "Cancel keeps the call recording; Stop and quit writes part.ended before the exit",
    async () => {
      const rig = await appRig();
      const { shell, f } = await shellOn(rig);
      const id = await rig.startCall();
      const events = () =>
        readFileSync(join(rig.app.manager.summary(id)?.dir as string, "events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as LogEvent);
      await until(() => events().some((e) => e.type === "part.started"), 10_000, "recording");

      // Cmd+Q (the menu's quit role) with Cancel, the default.
      expect(f.quitRequested()).toBe(true);
      await until(() => f.boxes.length === 1, 2000, "the question");
      expect(f.boxes[0]).toEqual({
        message: "A call is recording. Stop it and quit?",
        buttons: ["Cancel", "Stop and quit"],
        defaultId: 0,
        cancelId: 0,
      });
      await Bun.sleep(200);
      expect(f.log).not.toContain("quit");
      expect((await rig.api("GET", "/calls/live")).body.state).toBe("recording");
      expect(events().some((e) => e.type === "part.ended")).toBe(false);

      // The tray's Quit asks the same, and Stop and quit ends the part before the process exits.
      let atExit: LogEvent[] = [];
      f.onQuit = () => {
        atExit = events();
      };
      f.answer = (m) => (m.startsWith("A call is recording") ? 1 : undefined);
      f.tray("quit");
      await until(() => f.log.includes("quit"), 15_000, "the quit");
      expect(f.boxes).toHaveLength(2);
      const ended = atExit.filter((e) => e.type === "part.ended");
      expect(ended.map((e) => (e as Extract<LogEvent, { type: "part.ended" }>).reason)).toEqual([
        "stop",
      ]);
      await shell.close();
      await rig.close();
    },
    LONG,
  );

  test("with no call recording, quit asks nothing", async () => {
    const f = fakeUi();
    const a = fakeApp();
    const shell = new Shell(a.app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    await shell.start();
    expect(f.quitRequested()).toBe(true);
    await until(() => f.log.includes("quit"), 1000, "the quit");
    expect(f.boxes).toEqual([]);
    expect(a.state.quits).toBe(1);
    await shell.close();
  });

  test("two quits while the question is up ask once", async () => {
    const f = fakeUi();
    const a = fakeApp({ live: true });
    let release: (n: number) => void = () => {};
    f.ui.showMessageBox = (o) => {
      f.boxes.push({ message: o.message, buttons: o.buttons, defaultId: 0, cancelId: 0 });
      return new Promise((r) => {
        release = r;
      });
    };
    const shell = new Shell(a.app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    await shell.start();
    f.quitRequested();
    f.tray("quit");
    await until(() => f.boxes.length === 1, 1000, "the question");
    await Bun.sleep(50);
    expect(f.boxes).toHaveLength(1);
    release(0);
    await Bun.sleep(50);
    expect(a.state).toMatchObject({ live: true, quits: 0 });
    // Asked again after Cancel: a new question.
    f.quitRequested();
    await until(() => f.boxes.length === 2, 1000, "asked again");
    release(1);
    await until(() => f.log.includes("quit"), 1000, "the quit");
    expect(a.state.quits).toBe(1);
    await shell.close();
  });
});

describe("[DK-M4] the window reopens where it was left", () => {
  const primary: Rect = { x: 0, y: 25, width: 1440, height: 850 };
  const second: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };

  test("close at a frame, reopen, same frame; and again after a restart", async () => {
    const store = memoryState();
    const f = fakeUi();
    f.areas = [primary, second];
    const a = fakeApp();
    const shell = new Shell(a.app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
      state: store,
    });
    a.bind(shell);
    await shell.start();
    shell.show();
    const moved = { x: 1600, y: 100, width: 1000, height: 700 };
    f.moveWindow(moved);
    f.closeWindow();
    expect(store.load().window).toEqual(moved);
    shell.show();
    expect(f.frames.at(-1)).toEqual(moved);
    await shell.close();

    // A new app over the same store opens there too.
    const f2 = fakeUi();
    f2.areas = [primary, second];
    const shell2 = new Shell(fakeApp().app, bridgeStub, f2.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
      state: store,
    });
    await shell2.start();
    shell2.show();
    expect(f2.frames).toEqual([moved]);
    await shell2.close();
  });

  test("a frame is kept at quit too, without a close first", async () => {
    const store = memoryState();
    const f = fakeUi();
    const shell = new Shell(fakeApp().app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
      state: store,
    });
    await shell.start();
    shell.show();
    f.moveWindow({ x: 40, y: 60, width: 900, height: 600 });
    await shell.close();
    expect(store.load().window).toEqual({ x: 40, y: 60, width: 900, height: 600 });
  });

  test("a zero frame from a closing window never replaces the last real one", async () => {
    // The SDK answers {0,0,0,0} once the window is gone; a late move or resize carries it.
    const store = memoryState();
    const f = fakeUi();
    const shell = new Shell(fakeApp().app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
      state: store,
    });
    await shell.start();
    shell.show();
    const good = { x: 40, y: 60, width: 900, height: 600 };
    f.moveWindow(good);
    f.moveWindow({ x: 0, y: 0, width: 0, height: 0 });
    f.moveWindow({ x: 10, y: 10, width: 900, height: -1 });
    f.closeWindow();
    expect(store.load().window).toEqual(good);
    // Positive control: a real frame after it is kept.
    shell.show();
    const next = { x: 50, y: 70, width: 800, height: 500 };
    f.moveWindow(next);
    await shell.close();
    expect(store.load().window).toEqual(next);
  });

  test("placeFrame: kept on its display, clamped into the primary work area when off every display", () => {
    // On the second display: unchanged.
    const onSecond = { x: 1600, y: 100, width: 1000, height: 700 };
    expect(placeFrame(onSecond, [primary, second])).toEqual(onSecond);
    // That display is gone: into the primary work area, size kept where it fits.
    expect(placeFrame(onSecond, [primary])).toEqual({ x: 440, y: 100, width: 1000, height: 700 });
    // Far off every display: inside the primary, never outside it.
    const lost = { x: -5000, y: 9000, width: 1280, height: 820 };
    const p = placeFrame(lost, [primary, second]);
    expect(inside(p, primary)).toBe(true);
    expect(p).toEqual({ x: 0, y: 55, width: 1280, height: 820 });
    // Bigger than the work area: shrunk to it.
    expect(placeFrame({ x: 0, y: 0, width: 3000, height: 2000 }, [primary])).toEqual(primary);
    // Half off the edge of its display: pulled in whole.
    expect(placeFrame({ x: 1000, y: 500, width: 800, height: 600 }, [primary])).toEqual({
      x: 640,
      y: 275,
      width: 800,
      height: 600,
    });
    // Nothing saved: the default size, centred on the primary.
    expect(placeFrame(undefined, [primary, second])).toEqual({
      x: 80,
      y: 40,
      width: 1280,
      height: 820,
    });
    // No display reported (the SDK answers zeros when it cannot tell): the saved frame as it was.
    expect(placeFrame(onSecond, [{ x: 0, y: 0, width: 0, height: 0 }])).toEqual(onSecond);
    // Positive control: the check used above fails for a frame off the primary.
    expect(inside(lost, primary)).toBe(false);
  });
});

describe("[DK-M4] the remembered frame on disk", () => {
  test("shell.json round-trips, and a torn or hand-edited file means the default place", () => {
    const t = tempDir();
    const st = fileState(join(t.dir, "cfg"));
    expect(st.load()).toEqual({});
    const s = {
      window: { x: 10, y: 20, width: 900, height: 600 },
      indicator: { x: 5, y: 6, width: 300, height: 44 },
    };
    st.save(s);
    expect(st.load()).toEqual(s);
    const path = join(t.dir, "cfg", SHELL_STATE_FILE);
    writeFileSync(path, '{"window": {"x": 1, "y": 2, "width": ');
    expect(st.load()).toEqual({});
    writeFileSync(
      path,
      JSON.stringify({
        window: { x: "1", y: 2, width: 3, height: 4 },
        indicator: { x: 1, y: 2, width: 0, height: 9 },
      }),
    );
    expect(st.load()).toEqual({});
    // Positive control: the same file with numbers is read.
    writeFileSync(path, JSON.stringify({ window: { x: 1, y: 2, width: 3, height: 4 } }));
    expect(st.load()).toEqual({ window: { x: 1, y: 2, width: 3, height: 4 } });
    t.cleanup();
  });
});

/** A filesystem in memory: files, links, and folders that need a password. */
function memoryOps(o: { locked?: string[]; cancel?: boolean } = {}) {
  const files = new Set<string>();
  const links = new Map<string, string>();
  const admin: string[] = [];
  const ops: InstallOps = {
    exists: (p) => files.has(p) || links.has(p),
    readlink: (p) => links.get(p) ?? null,
    writable: (dir) => !(o.locked ?? []).includes(dir),
    link: (src, dst) => {
      if (files.has(dst)) throw new Error("EEXIST");
      links.set(dst, src);
    },
    linkAsAdmin: async (src, dst) => {
      admin.push(dst);
      if (o.cancel) return false;
      links.set(dst, src);
      return true;
    },
  };
  return { ops, files, links, admin };
}

describe("[DK-M6] Install Command-Line Tool… from the akou menu", () => {
  const SRC = "/Applications/akou.app/Contents/Resources/app/bun/akou";

  test("links the bundled akou into /usr/local/bin, and a second run says it is already there", async () => {
    const m = memoryOps();
    m.files.add(SRC);
    expect(await installCli(SRC, m.ops)).toEqual({ state: "installed", path: `${CLI_DIR}/akou` });
    expect(m.links.get(`${CLI_DIR}/akou`)).toBe(SRC);
    expect(await installCli(SRC, m.ops)).toEqual({ state: "already", path: `${CLI_DIR}/akou` });
    expect(installMessage({ state: "already", path: `${CLI_DIR}/akou` }).title).toBe(
      "The akou command is already installed.",
    );
    // No password was asked for a folder that needed none.
    expect(m.admin).toEqual([]);
  });

  test("asks for the password only when the folder needs one; a cancel installs nothing", async () => {
    const m = memoryOps({ locked: [CLI_DIR] });
    m.files.add(SRC);
    expect((await installCli(SRC, m.ops)).state).toBe("installed");
    expect(m.admin).toEqual([`${CLI_DIR}/akou`]);
    const c = memoryOps({ locked: [CLI_DIR], cancel: true });
    c.files.add(SRC);
    expect(await installCli(SRC, c.ops)).toEqual({ state: "refused" });
    expect(c.links.size).toBe(0);
  });

  test("a link into an older copy is repointed; a file that is not ours is left alone", async () => {
    const m = memoryOps();
    m.files.add(SRC);
    m.links.set(`${CLI_DIR}/akou`, "/Users/x/Downloads/akou.app/Contents/Resources/app/bun/akou");
    expect((await installCli(SRC, m.ops)).state).toBe("installed");
    expect(m.links.get(`${CLI_DIR}/akou`)).toBe(SRC);
    const f = memoryOps();
    f.files.add(SRC);
    f.files.add(`${CLI_DIR}/akou`);
    expect(await installCli(SRC, f.ops)).toEqual({ state: "in-the-way", path: `${CLI_DIR}/akou` });
    expect(f.links.size).toBe(0);
    // A build without the binary (a checkout) says so and touches nothing.
    const none = memoryOps();
    expect(await installCli(SRC, none.ops)).toEqual({ state: "missing" });
  });

  test("a live link to another tool's akou is left alone; a live link into an older app is repointed", async () => {
    // Homebrew links its own formulae into /usr/local/bin on Intel Macs.
    const brew = "/usr/local/Cellar/akou/1.0/bin/akou";
    const f = memoryOps();
    f.files.add(SRC);
    f.files.add(brew);
    f.links.set(`${CLI_DIR}/akou`, brew);
    expect(await installCli(SRC, f.ops)).toEqual({ state: "in-the-way", path: `${CLI_DIR}/akou` });
    expect(f.links.get(`${CLI_DIR}/akou`)).toBe(brew);
    expect(f.admin).toEqual([]);
    // Positive controls: a live link into another copy of the app, and a dangling link to
    // anything, are ours to replace.
    const older = "/Users/x/Downloads/akou.app/Contents/Resources/app/bun/akou";
    const o = memoryOps();
    o.files.add(SRC);
    o.files.add(older);
    o.links.set(`${CLI_DIR}/akou`, older);
    expect((await installCli(SRC, o.ops)).state).toBe("installed");
    expect(o.links.get(`${CLI_DIR}/akou`)).toBe(SRC);
    const d = memoryOps();
    d.files.add(SRC);
    d.links.set(`${CLI_DIR}/akou`, brew);
    expect((await installCli(SRC, d.ops)).state).toBe("installed");
  });

  test("an app run from a mounted disk image or a translocated copy installs nothing", async () => {
    // Both paths vanish at eject, quit or reboot, and the link would dangle.
    for (const src of [
      "/Volumes/akou/akou.app/Contents/Resources/app/bun/akou",
      "/private/var/folders/x1/abc/T/AppTranslocation/0F1E2D3C/d/akou.app/Contents/Resources/app/bun/akou",
    ]) {
      const m = memoryOps();
      m.files.add(src);
      expect(await installCli(src, m.ops)).toEqual({ state: "not-in-place" });
      expect(m.links.size).toBe(0);
      expect(m.admin).toEqual([]);
    }
    expect(installMessage({ state: "not-in-place" }).detail).toBe(
      "Move akou to Applications, open it from there, then choose Install Command-Line Tool… again.",
    );
    // Positive control: the same app in /Applications installs.
    const m = memoryOps();
    m.files.add(SRC);
    expect((await installCli(SRC, m.ops)).state).toBe("installed");
  });

  test(
    "the admin script quotes paths with spaces and quotes",
    () => {
      const src = `/Applications/a k"o'u.app/akou`;
      const s = adminScript(src, "/usr/local/bin/akou");
      const head = 'do shell script "';
      const tail = '" with administrator privileges';
      expect(s.startsWith(head) && s.endsWith(tail)).toBe(true);
      // Unescaped once as AppleScript reads its string, it is the command sh gets.
      const cmd = s.slice(head.length, -tail.length).replace(/\\(.)/g, "$1");
      if (process.platform === "win32") return;
      // sh with the two programs swapped for printf prints the arguments they would get.
      const probe = cmd
        .replace("/bin/mkdir -p", "printf '%s\\n'")
        .replace("/bin/ln -sfn", "printf '%s\\n'");
      const r = Bun.spawnSync(["/bin/sh", "-c", probe]);
      expect(r.stdout.toString().split("\n")).toEqual([
        "/usr/local/bin",
        src,
        "/usr/local/bin/akou",
        "",
      ]);
    },
    LONG,
  );

  test("the real file operations make and read the link (POSIX)", async () => {
    // The menu exists on macOS only; this checks nodeOps where links need no privilege.
    if (process.platform === "win32") return;
    const t = tempDir();
    const src = join(t.dir, "app", "akou");
    mkdirSync(join(t.dir, "app"));
    mkdirSync(join(t.dir, "bin"));
    writeFileSync(src, "#!/bin/sh\n");
    const bin = join(t.dir, "bin");
    expect(await installCli(src, nodeOps, bin)).toEqual({
      state: "installed",
      path: join(bin, "akou"),
    });
    expect(readlinkSync(join(bin, "akou"))).toBe(src);
    expect((await installCli(src, nodeOps, bin)).state).toBe("already");
    expect(nodeOps.writable(join(t.dir, "none"))).toBe(false);
    expect(existsSync(join(bin, "akou"))).toBe(true);
    t.cleanup();
  });

  test("the app carries the binary where the menu looks: beside the main process", () => {
    // The build copies it to `bun/akou`, beside `bun/tray`; the menu reads it beside the tray.
    expect(builtCopies((p) => p === BUILT.cli)).toEqual({ [BUILT.cli]: `${MAIN_OUT}/akou` });
    expect(builtCopies(() => false)).toEqual({});
    expect(dirname(BUNDLED_CLI)).toBe(dirname(TRAY_DIR));
    expect(basename(BUNDLED_CLI)).toBe("akou");
  });

  test("the menu item runs the install and shows what happened", async () => {
    const f = fakeUi();
    const runs: string[] = [];
    let next: InstallOutcome = { state: "installed", path: `${CLI_DIR}/akou` };
    const shell = new Shell(fakeApp().app, bridgeStub, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
      installCli: async () => {
        runs.push("install");
        return next;
      },
    });
    await shell.start();
    const menu = f.appMenu() ?? [];
    const akou = menu[0] as { submenu: { label?: string; action?: string }[] };
    expect(akou.submenu.find((i) => i.action === "install-cli")?.label).toBe(
      "Install Command-Line Tool…",
    );
    f.menu("install-cli");
    await until(() => f.boxes.length === 1, 1000, "the result");
    expect(f.boxes[0]?.message).toBe("The akou command is installed.");
    next = { state: "already", path: `${CLI_DIR}/akou` };
    f.menu("install-cli");
    await until(() => f.boxes.length === 2, 1000, "the second result");
    expect(f.boxes[1]?.message).toBe("The akou command is already installed.");
    expect(runs).toHaveLength(2);
    await shell.close();
  });
});

/** A shell whose bridge hands the test the app's event feed, to play a call's lifecycle. */
async function eventShell(
  f: ReturnType<typeof fakeUi>,
  o: {
    settings?: Record<string, unknown>;
    state?: ReturnType<typeof memoryState>;
    live?: boolean;
  } = {},
) {
  let watcher: (call: string, e: LogEvent) => void = () => {};
  const bridge = {
    watchLifecycle: () => () => {},
    app: {
      status: async () => ({}),
      watch: (fn: typeof watcher) => {
        watcher = fn;
        return () => {};
      },
      onStatusChange: () => () => {},
    },
  } as unknown as Bridge;
  const a = fakeApp({ live: o.live ?? true, settings: o.settings });
  const shell = new Shell(a.app, bridge, f.ui, {
    platform: "darwin",
    setLoginItem: async () => {},
    state: o.state,
  });
  a.bind(shell);
  await shell.start();
  const feed = (type: string, extra: Record<string, unknown> = {}) =>
    watcher("c1", { type, ...extra } as unknown as LogEvent);
  return { shell, a, feed };
}

describe("[DK-F1] the floating indicator, in the shell", () => {
  test("created on call.created, hidden while the main window has the focus, closed on part.ended", async () => {
    const f = fakeUi();
    const store = memoryState();
    const { shell, feed } = await eventShell(f, { state: store });
    expect(f.indicator()).toBeNull();
    feed("call.created");
    await until(() => f.indicator() !== null, 1000, "the indicator");
    const ind = f.indicator();
    expect(ind).toMatchObject({ visible: true, closed: false, opened: 1 });
    // At the top right of the primary work area the first time.
    expect(ind?.frame).toEqual({ x: 1440 - INDICATOR_SIZE.width - 16, y: 16, ...INDICATOR_SIZE });
    // The main window comes forward with the focus: the indicator steps aside.
    shell.show();
    expect(f.indicator()?.visible).toBe(false);
    f.focus(false);
    expect(f.indicator()?.visible).toBe(true);
    f.focus(true);
    f.closeWindow();
    expect(f.indicator()?.visible).toBe(true);
    // part.started of the same call does not open a second one.
    feed("part.started", { part: 1 });
    await Bun.sleep(20);
    expect(f.indicator()?.opened).toBe(1);
    // Dragged, then the call ends: closed, and its place kept.
    const moved = { x: 200, y: 300, ...INDICATOR_SIZE };
    f.moveIndicator(moved);
    // A late event from the closing window reports no frame at all.
    f.moveIndicator({ x: 0, y: 0, width: 0, height: 0 });
    feed("part.ended", { part: 1, reason: "stop" });
    expect(f.indicator()).toMatchObject({ closed: true, visible: false });
    expect(store.load().indicator).toEqual(moved);
    // The next call's indicator opens where the last one was left.
    feed("call.created");
    await until(() => f.indicator()?.opened === 2, 1000, "the second indicator");
    expect(f.indicator()).toMatchObject({ opened: 2, frame: moved, visible: true });
    await shell.close();
    expect(f.indicator()?.closed).toBe(true);
  });

  test("a call.created that records nothing (an import) opens no indicator", async () => {
    const f = fakeUi();
    const { shell, a, feed } = await eventShell(f, { live: false });
    feed("call.created");
    await Bun.sleep(20);
    expect(f.indicator()).toBeNull();
    // Positive control: the same event while a call records opens it.
    a.state.live = true;
    feed("call.created");
    await until(() => f.indicator() !== null, 1000, "the indicator");
    await shell.close();
  });

  test("an end while the status is still being read cancels the open", async () => {
    const f = fakeUi();
    const { shell, feed } = await eventShell(f);
    feed("call.created");
    feed("part.ended", { part: 1, reason: "cancelled" });
    await Bun.sleep(30);
    expect(f.indicator()).toBeNull();
    await shell.close();
  });

  test("app.floatingIndicator off: no indicator", async () => {
    const f = fakeUi();
    const { shell, feed } = await eventShell(f, { settings: { "app.floatingIndicator": false } });
    feed("call.created");
    feed("part.started", { part: 1 });
    await Bun.sleep(20);
    expect(f.indicator()).toBeNull();
    // Positive control: the same feed with the setting on opens it.
    const g = fakeUi();
    const on = await eventShell(g, { settings: { "app.floatingIndicator": true } });
    on.feed("call.created");
    await until(() => g.indicator() !== null, 1000, "the indicator");
    await shell.close();
    await on.shell.close();
  });

  test("Ask brings the main window forward with its ask box focused; a click opens it", async () => {
    const f = fakeUi();
    const { shell, a, feed } = await eventShell(f);
    feed("call.created");
    await until(() => f.indicator() !== null, 1000, "the indicator");
    const rpc = f.indicator()?.rpc;
    expect(await rpc?.handlers.focusAsk({})).toBe(true);
    // No window was open: it opens, and the page is told once it has booted.
    expect(a.state.windows).toBe(1);
    expect(f.log).not.toContain("ask");
    await f.boot();
    await until(() => f.log.includes("ask"), 1000, "the ask box");
    expect(await rpc?.handlers.openMain({})).toBe(true);
    expect(a.state.windows).toBe(2);
    await shell.close();
  });
});

function inside(r: Rect, a: Rect): boolean {
  return (
    r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width && r.y + r.height <= a.y + a.height
  );
}
