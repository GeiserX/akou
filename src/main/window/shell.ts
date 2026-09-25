/**
 * The desktop shell (docs/DESIGN.md sections 1.1, 1.5 and 7): the window, the tray with Record and
 * Stop, the global hotkey, the login item and the quit path, around the app. It implements the
 * `WindowShell` seam of `src/main/index.ts`.
 *
 * ElectroBun is behind `NativeUi` (`native.ts` adapts the real SDK), so everything here is tested
 * with a fake and nothing opens a window in a test.
 *
 * - **Fast start.** The tray item and the hotkey start a call directly, with no model turn and no
 *   window on the path (DESIGN 1.5); a second press stops it.
 * - **The window** is created on demand and can be closed and reopened: the recording lives in the
 *   app, so a webview that froze after sleep (ElectroBun #550) costs nothing but a reopen, and the
 *   page resumes from its cursor. Closing it never quits the app; the tray does.
 * - **Quit.** ElectroBun's `before-quit` cannot wait for a promise, so the first quit is cancelled,
 *   the app's one quit path runs (stop the helper, fsync the log), and the quit is asked again.
 * - **Single instance** is the app's own lock; `main.ts` asks a running app to show its window.
 * - **The tray always has an image** (DK-T1): the idle item has no text, so without one it is
 *   invisible on macOS. The files are drawn by `scripts/tray-icons.ts`.
 * - **The application menu** (DK-M1, macOS) carries the Edit roles: the webview gets copy, paste,
 *   undo and select all only through them.
 * - **Notifications** (DK-N1, DK-N2, DK-T5): `notify.ts` decides; the shell feeds it the app's
 *   starts and shares, the capture's health, and its own tray and hotkey starts, and shows each
 *   notice once a minute at most.
 */

import { join } from "node:path";
import type { AppStatus } from "../../ui/protocol.ts";
import type { AkouApp, Announcement, WindowShell } from "../index.ts";
import type { Bridge } from "./bridge.ts";
import { DEDUP_MS, type NotifyEvent, notifyFor, originOf } from "./notify.ts";
import type { SettingsPane } from "./page-server.ts";
import { type WindowRpc, type WindowSend, windowRpc } from "./rpc.ts";

export const WINDOW_URL = "views://main/index.html";

/** Where the tray images are: beside the main process in the bundle, beside this file in a checkout. */
export const TRAY_DIR = join(import.meta.dir, "tray");

/** The Help menu's page. */
export const DOCS_URL = "https://github.com/GeiserX/akou#readme";

export interface NativeWindow {
  show(): void;
  close(): void;
  onClose(fn: () => void): void;
  /** The window gained (true) or lost (false) the focus. */
  onFocus(fn: (focused: boolean) => void): void;
}

export type TrayMenuItem =
  | { type: "normal"; label: string; action: string; enabled?: boolean; checked?: boolean }
  | { type: "separator" };

export interface NativeTray {
  setMenu(items: TrayMenuItem[]): void;
  setTitle(title: string): void;
  onAction(fn: (action: string) => void): void;
  remove(): void;
}

/** An application menu item: a role the OS implements, or an action the shell handles. */
export type AppMenuItem =
  | { type: "separator" }
  | { label?: string; role: string; accelerator?: string }
  | { label: string; action: string; accelerator?: string }
  | { label: string; submenu: AppMenuItem[] };

/** The part of ElectroBun the shell uses. */
export interface NativeUi {
  /** A window over the page, its RPC wired to `rpc.handlers`; returns the window and its sender. */
  openWindow(o: { title: string; url: string; rpc: WindowRpc }): {
    window: NativeWindow;
    send: WindowSend;
  };
  /** `image` is a file path; `template` lets macOS recolour it for the menu bar. */
  createTray(o: { title: string; image: string; template: boolean }): NativeTray;
  setApplicationMenu(items: AppMenuItem[], onAction: (action: string) => void): void;
  /** A notification with no buttons (ElectroBun has none). */
  showNotification(n: { title: string; body: string }): void;
  registerShortcut(accelerator: string, fn: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
  onBeforeQuit(fn: (e: { cancel(): void }) => void): void;
  /** Asks the process to exit (runs `before-quit` again). */
  quit(): void;
  openExternal(url: string): boolean;
}

/** What the shell needs of the app. */
export interface ShellApp {
  status(): Promise<Record<string, unknown>>;
  start(req: {
    workspace?: string;
    title?: string;
    by?: string;
  }): Promise<{ ok: true; call: string } | { ok: false; code: string; message: string }>;
  stopLive(): Promise<void>;
  config(): { settings: Record<string, unknown> };
  saveSetting(key: "app.openAtLogin", value: boolean): Promise<void>;
  quit(): Promise<void>;
  openSettingsPane(pane: SettingsPane): Promise<boolean>;
  /** Shows the window through the app, so the app knows it has one. */
  openWindow(call?: string): Promise<unknown>;
  /** Every start and share from any door, with who asked. Returns the unsubscribe function. */
  onAnnounce(fn: (a: Announcement) => void): () => void;
}

/** The app as the shell sees it. */
export function appForShell(app: AkouApp): ShellApp {
  return {
    status: () => app.status(),
    start: async (req) => {
      const r = await app.start(req);
      return r.ok ? { ok: true, call: r.call } : { ok: false, code: r.code, message: r.error };
    },
    stopLive: async () => {
      const live = app.manager.live();
      if (live) await app.manager.stop(live.id);
    },
    config: () => app.config(),
    saveSetting: async (key, value) => {
      await app.saveConfig({ ...app.config().file, [key]: value });
    },
    quit: () => app.quit(),
    openSettingsPane: (pane) => app.openSettingsPane(pane),
    openWindow: (call) => app.openWindow(call),
    onAnnounce: (fn) => app.onAnnounce(fn),
  };
}

export interface ShellOptions {
  platform: string;
  /** Turns the login item on or off (`login-item.ts`). */
  setLoginItem(enabled: boolean): Promise<unknown>;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
  /** Epoch ms, for the once-a-minute rule. Tests pass their own. */
  now?(): number;
}

/** The tray image for a platform: a template PNG on macOS, an ICO on Windows, a PNG elsewhere. */
export function trayImage(platform: string, dir = TRAY_DIR): { image: string; template: boolean } {
  if (platform === "darwin") return { image: join(dir, "akou-template.png"), template: true };
  if (platform === "win32") return { image: join(dir, "akou.ico"), template: false };
  return { image: join(dir, "akou.png"), template: false };
}

/**
 * The application menu, or null where there is none to set. On macOS it is the menu bar: the
 * webview's copy, paste, undo and select all work only through the Edit roles, and Quit is the
 * `quit` role, which runs the same before-quit path as the tray. Windows and Linux have no
 * application menu; their webviews handle the clipboard keys themselves.
 *
 * "Check for updates…" waits for the update check (DK-U1) and "Show logs folder" for a log file:
 * an item with nothing behind it would be a control that does nothing.
 */
export function appMenu(platform: string): AppMenuItem[] | null {
  if (platform !== "darwin") return null;
  return [
    {
      label: "akou",
      submenu: [
        { role: "about", label: "About akou" },
        { type: "separator" },
        { label: "Settings…", action: "settings", accelerator: "," },
        { type: "separator" },
        { role: "hide", label: "Hide akou", accelerator: "h" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit", label: "Quit akou", accelerator: "q" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo", accelerator: "z" },
        { role: "redo", accelerator: "Z" },
        { type: "separator" },
        { role: "cut", accelerator: "x" },
        { role: "copy", accelerator: "c" },
        { role: "paste", accelerator: "v" },
        { role: "selectAll", accelerator: "a" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize", accelerator: "m" },
        { role: "zoom" },
        { type: "separator" },
        { role: "close", accelerator: "w" },
      ],
    },
    { label: "Help", submenu: [{ label: "akou documentation", action: "docs" }] },
  ];
}

/** The hotkey from the settings, or the platform's default. */
export function hotkeyFor(setting: string, platform: string): string {
  if (setting.trim() !== "") return setting.trim();
  return platform === "darwin" ? "Alt+Command+R" : "Control+Alt+R";
}

/** The tray's menu for the app's state. */
export function trayMenu(o: { live: boolean; openAtLogin: boolean }): TrayMenuItem[] {
  return [
    o.live
      ? { type: "normal", label: "■ Stop recording", action: "stop" }
      : { type: "normal", label: "● Record", action: "record" },
    { type: "normal", label: "Show akou", action: "show" },
    { type: "separator" },
    { type: "normal", label: "Open at login", action: "login", checked: o.openAtLogin },
    { type: "separator" },
    { type: "normal", label: "Quit akou", action: "quit" },
  ];
}

/** The tray's title: what a glance at the menu bar needs. */
export function trayTitle(s: Pick<AppStatus, "live" | "share">): string {
  if (s.share?.active) return "● shared";
  if (!s.live) return "";
  return s.live.state === "paused" ? "❚❚" : "● rec";
}

export class Shell implements WindowShell {
  private window: NativeWindow | null = null;
  private send: WindowSend | null = null;
  private rpc: WindowRpc | null = null;
  private tray: NativeTray | null = null;
  private hotkey: string | null = null;
  private quitting = false;
  private unwatch: () => void = () => {};
  private live = false;
  private focused = false;
  /** When each notice key last showed, for the once-a-minute rule. */
  private readonly shown = new Map<string, number>();

  constructor(
    private readonly app: ShellApp,
    private readonly bridge: Bridge,
    private readonly ui: NativeUi,
    private readonly o: ShellOptions,
  ) {}

  /** The tray, the hotkey, the login item and the quit path. The window opens on `show`. */
  async start(): Promise<void> {
    const s = this.app.config().settings;
    this.tray = this.ui.createTray({ title: "", ...trayImage(this.o.platform) });
    this.tray.onAction((a) => void this.onTray(a));
    const menu = appMenu(this.o.platform);
    if (menu) this.ui.setApplicationMenu(menu, (a) => void this.onMenu(a));
    const accel = hotkeyFor(String(s["app.hotkey"] ?? ""), this.o.platform);
    if (this.ui.registerShortcut(accel, () => void this.toggle("hotkey"))) this.hotkey = accel;
    else this.o.onLog?.("warn", `the hotkey ${accel} is taken by another app`);
    try {
      await this.o.setLoginItem(s["app.openAtLogin"] === true);
    } catch (err) {
      this.o.onLog?.("warn", `login item: ${(err as Error).message}`);
    }
    this.ui.onBeforeQuit((e) => {
      if (this.quitting) return;
      e.cancel();
      void this.quitApp();
    });
    const unwatchLifecycle = this.bridge.watchLifecycle(() => void this.refresh());
    const unannounce = this.app.onAnnounce((a) => this.onAnnounce(a));
    const unhealth = this.bridge.app.watch((call, e) => {
      if (e.type === "health") this.notify({ type: "capture", call, ch: e.ch, state: e.state });
    });
    this.unwatch = () => {
      unwatchLifecycle();
      unannounce();
      unhealth();
    };
    await this.refresh();
  }

  /** Shows what `notifyFor` says for an event, unless the same showed within a minute. */
  private notify(e: NotifyEvent): void {
    const n = notifyFor(e, { windowFocused: this.focused, platform: this.o.platform });
    if (!n) return;
    const now = this.o.now?.() ?? Date.now();
    const last = this.shown.get(n.key);
    if (last !== undefined && now - last < DEDUP_MS) return;
    this.shown.set(n.key, now);
    this.ui.showNotification({ title: n.title, body: n.body });
  }

  /**
   * Starts and shares from every door. The window's own (`user`) come back as origin `window`, for
   * which `notifyFor` shows nothing; so do the tray's and the hotkey's, which `toggle` announces.
   */
  private onAnnounce(a: Announcement): void {
    const origin = originOf(a.by);
    if (a.what === "share") this.notify({ type: "shared", call: a.call, origin });
    else if (a.ok) this.notify({ type: "started", call: a.call, origin });
    else this.notify({ type: "refused", code: a.code, origin });
  }

  /** Brings the window forward, creating it when there is none; on a call when one is named. */
  show(call?: string): void {
    if (!this.window) {
      this.rpc = windowRpc(
        this.bridge,
        () => this.sender(),
        (pane) => this.app.openSettingsPane(pane),
      );
      const w = this.ui.openWindow({ title: "akou", url: WINDOW_URL, rpc: this.rpc });
      this.window = w.window;
      this.send = w.send;
      w.window.onClose(() => {
        this.rpc?.close();
        this.rpc = null;
        this.window = null;
        this.send = null;
        this.focused = false;
      });
      w.window.onFocus((focused) => {
        this.focused = focused;
      });
    }
    this.window.show();
    this.focused = true;
    if (call) this.send?.showCall({ call });
  }

  private sender(): WindowSend {
    const s = this.send;
    const drop = () => {};
    return s ?? { followed: drop, asked: drop, status: drop, showCall: drop, showSettings: drop };
  }

  /**
   * The hotkey and the tray's first item: record when idle, stop when recording. A start that is
   * refused says why in a notification, and a missing download opens the window on its card.
   */
  async toggle(origin: "tray" | "hotkey" = "hotkey"): Promise<void> {
    this.live = !!((await this.app.status()) as { live?: unknown }).live;
    if (this.live) {
      await this.app.stopLive();
      return;
    }
    const r = await this.app.start({ by: "user" });
    if (r.ok) {
      this.notify({ type: "started", call: r.call, origin });
      return;
    }
    this.o.onLog?.("warn", `record from the ${origin}: ${r.message}`);
    this.notify({ type: "refused", code: r.code, origin });
    if (r.code === "models_missing") await this.app.openWindow();
  }

  private async onMenu(action: string): Promise<void> {
    switch (action) {
      case "settings":
        await this.app.openWindow();
        this.send?.showSettings({});
        break;
      case "docs":
        this.ui.openExternal(DOCS_URL);
        break;
    }
  }

  private async onTray(action: string): Promise<void> {
    switch (action) {
      case "record":
      case "stop":
        await this.toggle("tray");
        break;
      case "show":
        await this.app.openWindow();
        break;
      case "login": {
        const on = this.app.config().settings["app.openAtLogin"] !== true;
        await this.app.saveSetting("app.openAtLogin", on);
        await this.o.setLoginItem(on);
        await this.refresh();
        break;
      }
      case "quit":
        await this.quitApp();
        break;
    }
  }

  private async refresh(): Promise<void> {
    const s = (await this.app.status()) as unknown as AppStatus;
    this.live = !!s.live;
    this.tray?.setTitle(trayTitle(s));
    this.tray?.setMenu(
      trayMenu({
        live: this.live,
        openAtLogin: this.app.config().settings["app.openAtLogin"] === true,
      }),
    );
  }

  private async quitApp(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    await this.app.quit();
    this.ui.quit();
  }

  async close(): Promise<void> {
    this.unwatch();
    this.rpc?.close();
    this.window?.close();
    this.window = null;
    if (this.hotkey) this.ui.unregisterShortcut(this.hotkey);
    this.tray?.remove();
    this.tray = null;
  }
}
