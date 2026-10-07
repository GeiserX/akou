/**
 * ROADMAP G1, the shell, on Windows x64 and Linux x64: the packaged app shows a window, a tray
 * item, a global hotkey, registers a login item, and starts headless with `AKOU_HEADLESS=1`. Run
 * on the machine that built the app, after `scripts/build-app.ts`:
 *
 *   bun scripts/gates/g1-shell.ts --models <models dir> [--out result.json] [--shots <dir>]
 *
 * On Linux it needs an X display and a session bus, and the tools named below:
 *
 *   xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- bun scripts/gates/g1-shell.ts ...
 *
 * What runs:
 *
 * - A scratch `AKOU_HOME`, with the call models in `--models` (the recognizer plus the small
 *   helpers of the `embeddings` speaker-label engine, downloaded and checked against their pins)
 *   and `capture.helper` set to `scripts/fake-helper.ts`, so a call records a generated signal and
 *   opens no audio device. The app itself is the built one: the launcher in
 *   `build/stable-<platform>/akou/bin`, started the way a person starts it. The gate talks to it
 *   only through the `akou` command the bundle carries, which never launches an app off macOS.
 * - **Window**: a visible top-level window titled akou. Linux: `wmctrl -lp` under Openbox.
 *   Windows: `EnumWindows` through PowerShell. A screenshot of the screen for each start.
 * - **Tray**: Linux: the Ayatana AppIndicator ElectroBun uses registers a StatusNotifierItem with
 *   the watcher this gate runs on the session bus (`g1-sni-watcher.py`), and the item answers with
 *   ElectroBun's id and status Active. Windows: the notification-area icon of ElectroBun's
 *   `TrayWindowClass` window exists for the shell (`Shell_NotifyIcon(NIM_MODIFY)` with no flags,
 *   which changes nothing and fails for an icon that is not there).
 * - **Hotkey**: the default `Control+Shift+F9` sent as real key events (`xdotool`, `keybd_event`):
 *   the first press starts a call, the second stops it, read from `akou status`.
 * - **Login item**: `app.openAtLogin` set through `akou config set`, applied at the next start
 *   (the tray applies it at once; `config set` does not yet, docs/ux/DESKTOP.md DK-L2): the
 *   autostart file or the `Run` value holds `AKOU_HEADLESS=1`; set off, the next start removes it.
 * - **Headless**: the launcher with `AKOU_HEADLESS=1`, and the login item's own command: the API
 *   answers, `akou status` says headless, the tray is there, and no window shows.
 *
 * Positive controls, each a check that must come out the other way: no window, tray item, login
 * item or call exists before the first start; a headless start shows no window while the normal
 * start shows one; with no key sent no call starts; a tray probe of an id the app never used
 * fails; the login item is gone once turned off.
 *
 * Prints one JSON object with every phase and the verdict; exits 1 unless the gate passes.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE_ID } from "../../src/main/app-info.ts";
import {
  downloadModels,
  hostPlatform,
  MODELS,
  modelsFor,
  RECOGNIZER,
} from "../../src/main/asr/models.ts";
import { DEFAULT_HOTKEY } from "../../src/main/window/hotkey.ts";
import { loginItemPath } from "../../src/main/window/login-item.ts";
import { APP_DIR, RELEASE_DIR, releaseName } from "../build-app.ts";
import { unpackApp } from "../smoke-app.ts";
import { sourceVersion } from "../stamp-version.ts";

const ROOT = join(import.meta.dir, "..", "..");
const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
/** The window's title (`src/main/window/shell.ts` `show`). */
const TITLE = /^akou$/i;
/** ElectroBun's tray indicator id on Linux: `electrobun-tray-<id>`. */
const SNI_ID = /^electrobun-tray-\d+$/;
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` every `every` ms until it returns something truthy or `ms` pass; the last value. */
async function waitFor<T>(fn: () => T | Promise<T>, ms: number, every = 500): Promise<T> {
  const until = performance.now() + ms;
  let v = await fn();
  while (!v && performance.now() < until) {
    await sleep(every);
    v = await fn();
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Parsers, exported for tests/g1-shell.test.ts.

export interface ShownWindow {
  pid: number;
  title: string;
}

/** `wmctrl -lp` lines: `0x00a00003  0 4242 host akou`. The title may hold spaces. */
export function parseWmctrl(out: string): ShownWindow[] {
  const rows: ShownWindow[] = [];
  for (const line of out.split("\n")) {
    const m = /^0x[0-9a-f]+\s+-?\d+\s+(\d+)\s+\S+\s?(.*)$/i.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), title: (m[2] ?? "").trim() });
  }
  return rows;
}

/** Tab-separated `pid<TAB>class<TAB>title` lines, as the PowerShell probe prints them. */
export function parseWinWindows(out: string): ShownWindow[] {
  const rows: ShownWindow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [pid, , title] = line.split("\t");
    if (pid && /^\d+$/.test(pid)) rows.push({ pid: Number(pid), title: (title ?? "").trim() });
  }
  return rows;
}

/** Strings out of a `gdbus call ... GetAll` answer: `{'Id': <'electrobun-tray-1'>, ...}`. */
export function gvariantStrings(out: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const m of out.matchAll(/'([A-Za-z]+)':\s*<'((?:[^'\\]|\\.)*)'>/g)) {
    props[m[1] as string] = (m[2] as string).replace(/\\(.)/g, "$1");
  }
  return props;
}

/** The command of an autostart file's `Exec=` line, unquoted as a shell reads it. */
export function desktopExec(text: string): string | null {
  const line = text.split("\n").find((l) => l.startsWith("Exec="));
  return line ? line.slice("Exec=".length) : null;
}

/** The data of `reg query <key> /v akou`: `    akou    REG_SZ    <data>`. */
export function regValue(out: string): string | null {
  const m = /^\s*akou\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(out);
  return m ? (m[1] as string).trim() : null;
}

// ---------------------------------------------------------------------------------------------
// The machine: windows, tray, keys, screenshots, login item.

/** The Windows half: one PowerShell script with a small C# class, run per probe. */
const PS1 = String.raw`
param([string]$what, [string]$arg)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class G1 {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct NOTIFYICONDATAW {
    public int cbSize; public IntPtr hWnd; public int uID; public int uFlags; public int uCallbackMessage; public IntPtr hIcon;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
    public int dwState; public int dwStateMask;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
    public int uVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
    public int dwInfoFlags; public Guid guidItem; public IntPtr hBalloonIcon;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern bool Shell_NotifyIconW(int msg, ref NOTIFYICONDATAW d);
  const int NIM_MODIFY = 1;

  public static string Windows() {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (t.Length > 0) sb.Append(pid).Append('\t').Append(c).Append('\t').Append(t).Append('\n');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }

  // Each TrayWindowClass window (ElectroBun's tray, message-only), and which icon ids answer a
  // NIM_MODIFY with no flags: it changes nothing, and fails for an icon that does not exist.
  // 4242 is an id no tray uses: it must fail, or the probe cannot say no.
  public static string Tray() {
    var sb = new StringBuilder();
    IntPtr after = IntPtr.Zero;
    IntPtr HWND_MESSAGE = new IntPtr(-3);
    while (true) {
      after = FindWindowExW(HWND_MESSAGE, after, "TrayWindowClass", null);
      if (after == IntPtr.Zero) break;
      uint pid; GetWindowThreadProcessId(after, out pid);
      var ids = new List<string>();
      for (int id = 0; id <= 64; id++) if (Probe(after, id)) ids.Add(id.ToString());
      sb.Append(pid).Append('\t').Append(string.Join(",", ids)).Append('\t').Append(Probe(after, 4242) ? "control-answered" : "control-refused").Append('\n');
    }
    return sb.ToString();
  }

  static bool Probe(IntPtr h, int id) {
    var d = new NOTIFYICONDATAW();
    d.cbSize = Marshal.SizeOf(typeof(NOTIFYICONDATAW));
    d.hWnd = h; d.uID = id; d.uFlags = 0;
    return Shell_NotifyIconW(NIM_MODIFY, ref d);
  }

  // Control+Shift+F9 as real key events, released in reverse order.
  public static void Hotkey() {
    byte[] keys = { 0x11, 0x10, 0x78 };
    foreach (var k in keys) keybd_event(k, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 2, UIntPtr.Zero);
  }
}
"@
switch ($what) {
  "windows" { [Console]::Out.Write([G1]::Windows()) }
  "tray" { [Console]::Out.Write([G1]::Tray()) }
  "hotkey" { [G1]::Hotkey() }
  "shot" {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save($arg, [System.Drawing.Imaging.ImageFormat]::Png)
  }
}
`;

/** A StatusNotifierItem as the watcher saw it register, and what it answers. */
interface TrayItem {
  pid: number | null;
  props: Record<string, string>;
}

class Machine {
  private watcher: ChildProcess | null = null;
  private wm: ChildProcess | null = null;
  private readonly ps1: string;
  private readonly sniLog: string;

  constructor(work: string) {
    this.ps1 = join(work, "g1.ps1");
    this.sniLog = join(work, "sni.jsonl");
  }

  /** Linux: a window manager and the StatusNotifierWatcher. Windows: the probe script. */
  async setUp(): Promise<string | null> {
    if (WIN) {
      writeFileSync(this.ps1, PS1);
      return null;
    }
    if (!process.env.DISPLAY) return "no DISPLAY: run under xvfb-run";
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) return "no session bus: run under dbus-run-session";
    this.wm = spawn("openbox", ["--sm-disable"], { stdio: "ignore" });
    writeFileSync(this.sniLog, "");
    this.watcher = spawn("python3", [join(import.meta.dir, "g1-sni-watcher.py"), this.sniLog], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const ready = await new Promise<boolean>((done) => {
      const t = setTimeout(() => done(false), 15_000);
      this.watcher?.stdout?.on("data", (d: Buffer) => {
        if (d.toString().includes("ready")) {
          clearTimeout(t);
          done(true);
        }
      });
      this.watcher?.on("exit", () => done(false));
    });
    if (!ready) return "the StatusNotifierWatcher did not take its name on the session bus";
    const wmUp = await waitFor(() => spawnSync("wmctrl", ["-m"]).status === 0, 10_000);
    return wmUp ? null : "the window manager did not start";
  }

  tearDown(): void {
    this.watcher?.kill();
    this.wm?.kill();
  }

  private ps(what: string, arg = ""): string {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.ps1, what, arg],
      { encoding: "utf8", timeout: 60_000 },
    );
    if (r.status !== 0) throw new Error(`powershell ${what}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  }

  /** Visible top-level windows titled akou. */
  windows(): ShownWindow[] {
    const all = WIN
      ? parseWinWindows(this.ps("windows"))
      : parseWmctrl(spawnSync("wmctrl", ["-lp"], { encoding: "utf8" }).stdout ?? "");
    return all.filter((w) => TITLE.test(w.title));
  }

  /** How many StatusNotifierItems registered so far (Linux), to read only the new ones later. */
  trayMark(): number {
    return WIN ? 0 : this.registrations().length;
  }

  private registrations(): { sender: string; service: string }[] {
    if (!existsSync(this.sniLog)) return [];
    return readFileSync(this.sniLog, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  }

  /**
   * The tray items present now. Linux: items registered since `mark` that still answer with
   * ElectroBun's id. Windows: the tray windows with an icon that answers, and the control id.
   */
  tray(mark: number): { items: TrayItem[]; control?: string[] } {
    if (WIN) {
      const items: TrayItem[] = [];
      const control: string[] = [];
      for (const line of this.ps("tray").split(/\r?\n/)) {
        const [pid, ids, ctl] = line.split("\t");
        if (!pid || !/^\d+$/.test(pid)) continue;
        control.push(ctl ?? "");
        if (ids) items.push({ pid: Number(pid), props: { iconIds: ids } });
      }
      return { items, control };
    }
    const items: TrayItem[] = [];
    const seen = new Set<string>();
    for (const r of this.registrations().slice(mark)) {
      // The indicator registers again when the watcher answers; one item, read once.
      if (seen.has(r.sender + r.service)) continue;
      seen.add(r.sender + r.service);
      const dest = r.service.startsWith("/") ? r.sender : r.service;
      const path = r.service.startsWith("/") ? r.service : "/StatusNotifierItem";
      const all = spawnSync(
        "gdbus",
        [
          "call",
          "--session",
          "--dest",
          dest,
          "--object-path",
          path,
          "--method",
          "org.freedesktop.DBus.Properties.GetAll",
          "org.kde.StatusNotifierItem",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      if (all.status !== 0) continue;
      const pidOut = spawnSync(
        "gdbus",
        [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.DBus",
          "--object-path",
          "/org/freedesktop/DBus",
          "--method",
          "org.freedesktop.DBus.GetConnectionUnixProcessID",
          dest,
        ],
        { encoding: "utf8", timeout: 10_000 },
      ).stdout;
      const pid = /\(uint32 (\d+),\)/.exec(pidOut ?? "")?.[1];
      const props = gvariantStrings(all.stdout);
      if (SNI_ID.test(props.Id ?? "")) items.push({ pid: pid ? Number(pid) : null, props });
    }
    return { items };
  }

  hotkey(): void {
    if (WIN) this.ps("hotkey");
    else {
      const r = spawnSync("xdotool", ["key", "--clearmodifiers", "ctrl+shift+F9"]);
      if (r.status !== 0) throw new Error(`xdotool: ${r.stderr}`);
    }
  }

  screenshot(path: string): boolean {
    try {
      if (WIN) this.ps("shot", path);
      else spawnSync("import", ["-window", "root", path]);
      return existsSync(path);
    } catch {
      return false;
    }
  }

  /** The login item now: the autostart file's command, or the `Run` value. */
  loginItem(): { present: boolean; command: string | null } {
    if (WIN) {
      const r = spawnSync("reg", ["query", RUN_KEY, "/v", "akou"], { encoding: "utf8" });
      const v = r.status === 0 ? regValue(r.stdout) : null;
      return { present: v !== null, command: v };
    }
    const path = loginItemPath(process.platform, homedir()) as string;
    if (!existsSync(path)) return { present: false, command: null };
    return { present: true, command: desktopExec(readFileSync(path, "utf8")) };
  }
}

// ---------------------------------------------------------------------------------------------
// The app.

class App {
  private child: ChildProcess | null = null;

  constructor(
    private readonly cli: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly logFile: string,
  ) {}

  /** The bundled `akou` command with `--json`: exit code and the parsed answer. */
  akou(...args: string[]): {
    code: number | null;
    json: Record<string, unknown> | null;
    out: string;
  } {
    const r = spawnSync(this.cli, [...args, "--json"], {
      env: this.env,
      encoding: "utf8",
      timeout: 60_000,
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {}
    return { code: r.status, json, out: (r.stdout + r.stderr).trim().slice(-600) };
  }

  /** Starts the launcher, or a login item's command line through the system shell. */
  start(how: { launcher: string; headless: boolean } | { command: string }): void {
    const out = openSync(this.logFile, "a");
    const env = { ...this.env };
    if ("command" in how) {
      this.child = spawn(how.command, [], { env, shell: true, stdio: ["ignore", out, out] });
    } else {
      if (how.headless) env.AKOU_HEADLESS = "1";
      else delete env.AKOU_HEADLESS;
      this.child = spawn(how.launcher, [], { env, stdio: ["ignore", out, out] });
    }
  }

  /** `akou status` once the app answers, or null after `ms`. */
  async answering(ms: number): Promise<Record<string, unknown> | null> {
    return waitFor(
      () => {
        const r = this.akou("status");
        return r.code === 0 ? r.json : null;
      },
      ms,
      1000,
    );
  }

  live(): boolean {
    return !!this.akou("status").json?.live;
  }

  /** `akou quit`, then waits for the app's `runtime.json` to go. */
  async quit(configDir: string): Promise<boolean> {
    this.akou("quit");
    const gone = await waitFor(() => !existsSync(join(configDir, "runtime.json")), 30_000);
    // The launcher that started it ends with it; one that does not is ended here.
    await waitFor(() => this.child?.exitCode !== null || this.child?.signalCode !== null, 10_000);
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
    await sleep(1000);
    return gone;
  }

  tail(): string {
    try {
      return readFileSync(this.logFile, "utf8").split("\n").slice(-30).join("\n");
    } catch {
      return "";
    }
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Windows: the release's installer, as a person runs it. `akou-<version>-setup` holds
 * `akou-Setup.exe` with the packed app beside it; ElectroBun's installer installs into
 * `%LOCALAPPDATA%\\<identifier>\\stable` and closes its final dialog itself with
 * `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`. The built launcher alone is the self-extractor, which
 * refuses to run without its archive.
 */
function installWindows(work: string): { launcher: string; detail: string } {
  const version = sourceVersion(ROOT);
  const name = readdirSync(RELEASE_DIR).find((f) => f.startsWith(`${releaseName(version)}-setup.`));
  if (!name) return { launcher: "", detail: `no ${releaseName(version)}-setup in ${RELEASE_DIR}` };
  const dir = join(work, "setup");
  mkdirSync(dir);
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  spawnSync(tar, ["-x", "-f", join(RELEASE_DIR, name), "-C", dir]);
  const r = spawnSync(join(dir, "akou-Setup.exe"), [], {
    cwd: dir,
    env: { ...process.env, ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1" },
    encoding: "utf8",
    timeout: 300_000,
  });
  const root = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), BUNDLE_ID);
  return {
    launcher: join(root, "stable", "app", "bin", "launcher.exe"),
    detail: `${name}: akou-Setup.exe exit ${r.status}${r.error ? ` (${r.error.message})` : ""}; ${(r.stdout + r.stderr).trim().slice(-400)}`,
  };
}

async function main(): Promise<void> {
  const models = opt("--models");
  if (!models)
    throw new Error("usage: bun scripts/gates/g1-shell.ts --models <dir> [--out f] [--shots d]");
  const modelsDir = resolve(models);
  const shots = resolve(opt("--shots") ?? "g1-shots");
  mkdirSync(shots, { recursive: true });

  // The call models: the recognizer and the embeddings engine's helpers (VAD, segmentation,
  // TitaNet), a few tens of MB beyond the recognizer G2 already fetched into the same folder.
  const need = modelsFor({ "asr.diarizer": "embeddings" }, hostPlatform(), MODELS, [RECOGNIZER]);
  await downloadModels(
    modelsDir,
    need.map((m) => m.id),
    { env: {} },
  );

  const work = mkdtempSync(join(tmpdir(), "akou-g1-"));
  const installed = WIN ? installWindows(work) : null;
  // Linux: the built launcher, which unpacks the app into ~/.local/share on its first start, as
  // the installed one does. Windows: the launcher the installer put in %LOCALAPPDATA%.
  const launcher = installed?.launcher ?? join(APP_DIR, "bin", `launcher${EXE}`);
  if (!existsSync(launcher))
    throw new Error(
      `no launcher at ${launcher}; ${installed?.detail ?? "run scripts/build-app.ts"}`,
    );
  const home = join(work, "home");
  const configDir = join(home, ".config", "akou");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(work, "unpacked"));
  const unpacked = unpackApp(join(work, "unpacked"));
  if (typeof unpacked === "string") throw new Error(unpacked);
  const cliPath = join(unpacked.main, `akou${EXE}`);
  writeFileSync(
    join(configDir, "config.json"),
    `${JSON.stringify(
      {
        "asr.diarizer": "embeddings",
        "capture.helper": [process.execPath, join(ROOT, "scripts", "fake-helper.ts")],
        "app.openAtLogin": false,
      },
      null,
      2,
    )}\n`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, AKOU_HOME: home, AKOU_MODELS_DIR: modelsDir };
  delete env.AKOU_HEADLESS;
  const app = new App(cliPath, env, join(work, "app-stdout.log"));
  const machine = new Machine(work);
  const problems: string[] = [];
  const fail = (what: string) => problems.push(what);
  const phases: Record<string, unknown> = { install: installed };
  const appLog = () => {
    try {
      return readFileSync(join(configDir, "app.log"), "utf8").split("\n").slice(-25);
    } catch {
      return [];
    }
  };

  /** Two presses of the hotkey: the first starts a call, the second stops it. */
  const hotkeyToggles = async (p: Record<string, unknown>, label: string) => {
    machine.hotkey();
    const started = await waitFor(() => app.live(), 30_000);
    p.liveAfterFirstPress = started;
    if (!started) fail(`${label}: the first ${DEFAULT_HOTKEY} started no call within 30 s`);
    await sleep(3000);
    return () => {
      machine.hotkey();
      return waitFor(() => !app.live(), 30_000).then((stopped) => {
        p.liveAfterSecondPress = !stopped;
        if (!stopped)
          fail(`${label}: the second ${DEFAULT_HOTKEY} did not stop the call within 30 s`);
      });
    };
  };

  try {
    const setUp = await machine.setUp();
    if (setUp) throw new Error(setUp);

    // Controls before any start: nothing of akou's exists, and no call is live.
    const before = {
      windows: machine.windows(),
      tray: machine.tray(0).items,
      loginItem: machine.loginItem(),
    };
    phases.before = before;
    if (before.windows.length > 0) fail("control: an akou window exists before the first start");
    if (before.tray.length > 0) fail("control: a tray item exists before the first start");
    if (before.loginItem.present) fail("control: a login item exists before the first start");

    // 1. Normal start: window, tray, hotkey; the login item off.
    {
      const mark = machine.trayMark();
      app.start({ launcher, headless: false });
      const status = await app.answering(240_000);
      const p: Record<string, unknown> = { status: status?.app ?? null };
      phases.normal = p;
      if (!status) {
        fail(`normal start: the API never answered; launcher output: ${app.tail()}`);
        throw new Error("the app did not start");
      }
      const shown = await waitFor(() => machine.windows(), 60_000);
      p.windows = shown;
      if (shown.length === 0) fail("normal start: no window titled akou showed within 60 s");
      const tray = await waitFor(() => machine.tray(mark).items, 30_000);
      p.tray = tray;
      if (tray.length === 0) fail("normal start: no tray item");
      if (WIN && machine.tray(mark).control?.some((c) => c !== "control-refused"))
        fail("control: the tray probe answered for an icon id the app never used");
      p.hotkeyRegistered = (status.app as { hotkey?: unknown }).hotkey ?? null;
      if (p.hotkeyRegistered !== DEFAULT_HOTKEY)
        fail(`normal start: the registered hotkey is ${p.hotkeyRegistered}, not ${DEFAULT_HOTKEY}`);
      // Control, and time for the page to draw before the screenshot: no key sent, no call.
      await sleep(5000);
      p.screenshot = machine.screenshot(join(shots, "1-normal.png")) ? "1-normal.png" : null;
      const unsent = app.live();
      p.liveWithNoKeySent = unsent;
      if (unsent) fail("control: a call is live with no key sent");
      const stop = await hotkeyToggles(p, "hotkey");
      p.screenshotRecording = machine.screenshot(join(shots, "2-recording.png"))
        ? "2-recording.png"
        : null;
      await stop();

      p.loginItem = machine.loginItem();
      if ((p.loginItem as { present: boolean }).present)
        fail("normal start: a login item exists with app.openAtLogin off");
      const set = app.akou("config", "set", "app.openAtLogin", "true");
      if (set.code !== 0) fail(`config set app.openAtLogin true failed: ${set.out}`);
      // DK-L2: `config set` does not apply the login item at once; recorded, not judged.
      p.loginItemRightAfterConfigSet = machine.loginItem().present;
      p.appLog = appLog();
      if (!(await app.quit(configDir))) fail("normal start: the app did not quit within 30 s");
    }

    // 2. Headless start with AKOU_HEADLESS=1: the API, the tray, no window; the login item on.
    {
      const mark = machine.trayMark();
      app.start({ launcher, headless: true });
      const status = await app.answering(120_000);
      const p: Record<string, unknown> = { status: status?.app ?? null };
      phases.headless = p;
      if (!status) fail(`headless start: the API never answered; launcher output: ${app.tail()}`);
      else {
        if ((status.app as { headless?: unknown }).headless !== true)
          fail("headless start: akou status does not say headless");
        const tray = await waitFor(() => machine.tray(mark).items, 30_000);
        p.tray = tray;
        if (tray.length === 0) fail("headless start: no tray item");
        // The window, were there one, would have shown by now: the normal start's showed in
        // the time the tray took. Ten more seconds to be sure.
        await sleep(10_000);
        p.windows = machine.windows();
        if ((p.windows as ShownWindow[]).length > 0) fail("headless start: a window showed");
        p.screenshot = machine.screenshot(join(shots, "3-headless.png")) ? "3-headless.png" : null;
        // The tray and the hotkey are ready with no window (DK-L1).
        await (await hotkeyToggles(p, "headless hotkey"))();
        const item = machine.loginItem();
        p.loginItem = item;
        if (!item.present) fail("login item: not written at the start after app.openAtLogin true");
        else if (!item.command?.includes("AKOU_HEADLESS=1"))
          fail(`login item: its command does not set AKOU_HEADLESS=1: ${item.command}`);
        p.appLog = appLog();
      }
      if (!(await app.quit(configDir))) fail("headless start: the app did not quit within 30 s");
    }

    // 3. The login item's own command: what the session runs at the next login.
    {
      const item = machine.loginItem();
      const p: Record<string, unknown> = { command: item.command };
      phases.loginCommand = p;
      if (item.command) {
        const mark = machine.trayMark();
        app.start({ command: item.command });
        const status = await app.answering(120_000);
        p.status = status?.app ?? null;
        if (!status)
          fail(`login item: its command did not start akou; launcher output: ${app.tail()}`);
        else {
          if ((status.app as { headless?: unknown }).headless !== true)
            fail("login item: the app it started is not headless");
          const tray = await waitFor(() => machine.tray(mark).items, 30_000);
          p.tray = tray;
          if (tray.length === 0) fail("login item: the app it started has no tray item");
          await sleep(10_000);
          p.windows = machine.windows();
          if ((p.windows as ShownWindow[]).length > 0)
            fail("login item: the app it started showed a window");
          p.screenshot = machine.screenshot(join(shots, "4-login-item.png"))
            ? "4-login-item.png"
            : null;
          await (await hotkeyToggles(p, "login item hotkey"))();
          const off = app.akou("config", "set", "app.openAtLogin", "false");
          if (off.code !== 0) fail(`config set app.openAtLogin false failed: ${off.out}`);
          p.appLog = appLog();
        }
        if (!(await app.quit(configDir)))
          fail("login item start: the app did not quit within 30 s");
      }
    }

    // 4. The login item off: the next start removes it, and shows the window again.
    {
      // Set off through `akou config set` in step 3; when step 3 could not run, in the file.
      const cfgFile = join(configDir, "config.json");
      const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
      const offBy = cfg["app.openAtLogin"] === false ? "akou config set" : "config.json";
      writeFileSync(cfgFile, `${JSON.stringify({ ...cfg, "app.openAtLogin": false }, null, 2)}\n`);
      app.start({ launcher, headless: false });
      const status = await app.answering(120_000);
      const p: Record<string, unknown> = { status: status?.app ?? null };
      phases.loginOff = p;
      p.setOffBy = offBy;
      if (!status) fail(`last start: the API never answered; launcher output: ${app.tail()}`);
      else {
        p.windows = await waitFor(() => machine.windows(), 60_000);
        if ((p.windows as ShownWindow[]).length === 0) fail("last start: no window showed");
        p.loginItem = machine.loginItem();
        if ((p.loginItem as { present: boolean }).present)
          fail("login item: still there after app.openAtLogin false and a start");
      }
      if (!(await app.quit(configDir))) fail("last start: the app did not quit within 30 s");
    }
  } catch (err) {
    fail(`the run stopped: ${(err as Error).message}`);
    await app.quit(configDir).catch(() => false);
  } finally {
    machine.tearDown();
    rmSync(work, { recursive: true, force: true });
  }

  const result = {
    gate: "G1",
    platform: hostPlatform(),
    display: WIN ? "Windows desktop session" : "X11: Xvfb with Openbox (Wayland not covered)",
    hotkey: DEFAULT_HOTKEY,
    phases,
    verdict: problems.length === 0 ? "pass" : "fail",
    problems,
  };
  const text = JSON.stringify(result, null, 2);
  const out = opt("--out");
  if (out) writeFileSync(out, `${text}\n`);
  console.log(text);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    // A run that stops before its phases still leaves a result to read.
    const result = {
      gate: "G1",
      platform: hostPlatform(),
      verdict: "fail",
      problems: [`the run stopped: ${(err as Error).stack ?? err}`],
    };
    const out = opt("--out");
    if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
}
