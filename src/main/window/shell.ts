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
 */

import type { AppStatus } from "../../ui/protocol.ts";
import type { WindowShell } from "../index.ts";
import type { Bridge } from "./bridge.ts";
import type { SettingsPane } from "./page-server.ts";
import { type WindowRpc, type WindowSend, windowRpc } from "./rpc.ts";

export const WINDOW_URL = "views://main/index.html";

export interface NativeWindow {
  show(): void;
  close(): void;
  onClose(fn: () => void): void;
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

/** The part of ElectroBun the shell uses. */
export interface NativeUi {
  /** A window over the page, its RPC wired to `rpc.handlers`; returns the window and its sender. */
  openWindow(o: { title: string; url: string; rpc: WindowRpc }): {
    window: NativeWindow;
    send: WindowSend;
  };
  createTray(o: { title: string }): NativeTray;
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
  }): Promise<{ ok: boolean; message?: string }>;
  stopLive(): Promise<void>;
  config(): { settings: Record<string, unknown> };
  saveSetting(key: "app.openAtLogin", value: boolean): Promise<void>;
  quit(): Promise<void>;
  openSettingsPane(pane: SettingsPane): Promise<boolean>;
  /** Shows the window through the app, so the app knows it has one. */
  openWindow(call?: string): Promise<unknown>;
}

export interface ShellOptions {
  platform: string;
  /** Turns the login item on or off (`login-item.ts`). */
  setLoginItem(enabled: boolean): Promise<unknown>;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
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

  constructor(
    private readonly app: ShellApp,
    private readonly bridge: Bridge,
    private readonly ui: NativeUi,
    private readonly o: ShellOptions,
  ) {}

  /** The tray, the hotkey, the login item and the quit path. The window opens on `show`. */
  async start(): Promise<void> {
    const s = this.app.config().settings;
    this.tray = this.ui.createTray({ title: "" });
    this.tray.onAction((a) => void this.onTray(a));
    const accel = hotkeyFor(String(s["app.hotkey"] ?? ""), this.o.platform);
    if (this.ui.registerShortcut(accel, () => void this.toggle())) this.hotkey = accel;
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
    this.unwatch = this.bridge.watchLifecycle(() => void this.refresh());
    await this.refresh();
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
      });
    }
    this.window.show();
    if (call) this.send?.showCall({ call });
  }

  private sender(): WindowSend {
    const s = this.send;
    const drop = () => {};
    return s ?? { followed: drop, asked: drop, status: drop, showCall: drop };
  }

  /** The hotkey and the tray's first item: record when idle, stop when recording. */
  async toggle(): Promise<void> {
    this.live = !!((await this.app.status()) as { live?: unknown }).live;
    if (this.live) {
      await this.app.stopLive();
      return;
    }
    const r = await this.app.start({ by: "user" });
    if (!r.ok) this.o.onLog?.("warn", `record from the tray: ${r.message ?? "refused"}`);
  }

  private async onTray(action: string): Promise<void> {
    switch (action) {
      case "record":
      case "stop":
        await this.toggle();
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
