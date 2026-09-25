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
import { hotkeyFor } from "./hotkey.ts";
import { type IndicatorRpcHandlers, type IndicatorSend, indicatorRpc } from "./indicator.ts";
import { type InstallOutcome, installMessage } from "./install-cli.ts";
import { DEDUP_MS, type NotifyEvent, notifyFor, originOf } from "./notify.ts";
import type { SettingsPane } from "./page-server.ts";
import { type WindowRpc, type WindowSend, windowRpc } from "./rpc.ts";

export { hotkeyFor };

export const WINDOW_URL = "views://main/index.html";
export const INDICATOR_URL = "views://indicator/index.html";

/** Where the tray images are: beside the main process in the bundle, beside this file in a checkout. */
export const TRAY_DIR = join(import.meta.dir, "tray");

/** The Help menu's page. */
export const DOCS_URL = "https://github.com/GeiserX/akou#readme";

/** A window's frame, or a display's work area, in screen points. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the shell remembers between runs (`state.ts` keeps it in the config folder). */
export interface ShellState {
  /** The main window's last frame (DK-M4). */
  window?: Rect;
  /** The floating indicator's last frame (DK-F1). */
  indicator?: Rect;
}

export interface NativeWindow {
  show(): void;
  close(): void;
  onClose(fn: () => void): void;
  /** The window gained (true) or lost (false) the focus. */
  onFocus(fn: (focused: boolean) => void): void;
  /** The window moved or was resized. The shell keeps the last, so it never reads a closed one. */
  onFrame(fn: (frame: Rect) => void): void;
}

/** The floating indicator's window: always on top, never takes the focus when shown. */
export interface IndicatorWindow {
  /** Shows it without taking the focus from the app in front (the meeting). */
  showInactive(): void;
  hide(): void;
  close(): void;
  onClose(fn: () => void): void;
  onFrame(fn: (frame: Rect) => void): void;
}

/** A question with buttons; resolves to the index of the one pressed. */
export interface MessageBox {
  type: "question" | "warning" | "info";
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  /** The button Return presses. */
  defaultId: number;
  /** The button Escape and closing the box press. */
  cancelId: number;
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
  openWindow(o: { title: string; url: string; rpc: WindowRpc; frame?: Rect }): {
    window: NativeWindow;
    send: WindowSend;
  };
  /** The floating indicator (DK-F1): a small window with no title bar, above every other. */
  openIndicator(o: { url: string; rpc: IndicatorRpcHandlers; frame: Rect }): {
    window: IndicatorWindow;
    send: IndicatorSend;
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
  /** The Dock icon was clicked (macOS `reopen`). */
  onReopen(fn: () => void): void;
  showMessageBox(o: MessageBox): Promise<number>;
  /** Every display's work area (the screen less the menu bar and Dock), the primary first. */
  workAreas(): Rect[];
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
  /** "Install Command-Line Tool…" (DK-M6): links the bundled `akou` into PATH (`install-cli.ts`). */
  installCli?(): Promise<InstallOutcome>;
  /** Where the window's frame is kept between runs. None: forgotten at quit. */
  state?: { load(): ShellState; save(s: ShellState): void };
}

/** The window's size the first time it opens. */
export const DEFAULT_WINDOW = { width: 1280, height: 820 } as const;
/** No window is restored smaller than this. */
const MIN_WINDOW = { width: 480, height: 360 } as const;
/** The floating indicator's size: one row, never resized. */
export const INDICATOR_SIZE = { width: 330, height: 40 } as const;
/** Its distance from the work area's edge the first time it shows. */
const INDICATOR_MARGIN = 16;

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Where the window opens (DK-M4): the saved frame on the display it overlaps most, pulled whole
 * into that display's work area and shrunk to fit it; on the primary display when it overlaps
 * none (a display that was unplugged). With nothing saved, the default size centred on the primary.
 * With no display reported (the SDK answers zeros when it cannot tell), the saved frame as it was.
 */
export function placeFrame(saved: Rect | undefined, areas: readonly Rect[]): Rect {
  const primary = areas.find((a) => a.width > 0 && a.height > 0);
  if (!primary) return saved ?? { x: 0, y: 0, ...DEFAULT_WINDOW };
  const want = saved ?? {
    x: primary.x + Math.round((primary.width - DEFAULT_WINDOW.width) / 2),
    y: primary.y + Math.round((primary.height - DEFAULT_WINDOW.height) / 2),
    ...DEFAULT_WINDOW,
  };
  return fitInto(want, areas, MIN_WINDOW);
}

/**
 * Where the floating indicator shows (DK-F1): where it was dragged last, pulled onto a display the
 * same way as the window; the first time, the top right of the primary work area.
 */
export function placeIndicator(saved: Rect | undefined, areas: readonly Rect[]): Rect {
  const primary = areas.find((a) => a.width > 0 && a.height > 0);
  const at = saved ?? {
    x:
      (primary ? primary.x + primary.width : INDICATOR_SIZE.width) -
      INDICATOR_SIZE.width -
      INDICATOR_MARGIN,
    y: (primary?.y ?? 0) + INDICATOR_MARGIN,
  };
  const want = { x: at.x, y: at.y, ...INDICATOR_SIZE };
  return primary ? fitInto(want, areas, INDICATOR_SIZE) : want;
}

/** `want` on the display it overlaps most (the primary when none), whole and no bigger than it. */
function fitInto(want: Rect, areas: readonly Rect[], min: { width: number; height: number }): Rect {
  const real = areas.filter((a) => a.width > 0 && a.height > 0);
  let area = real[0] as Rect;
  let best = 0;
  for (const a of real) {
    const o = overlap(want, a);
    if (o > best) {
      best = o;
      area = a;
    }
  }
  const width = Math.min(Math.max(want.width, min.width), area.width);
  const height = Math.min(Math.max(want.height, min.height), area.height);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    x: clamp(want.x, area.x, area.x + area.width - width),
    y: clamp(want.y, area.y, area.y + area.height - height),
    width,
    height,
  };
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
        { label: "Install Command-Line Tool…", action: "install-cli" },
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
    { label: "Help", submenu: [{ label: "Open the docs", action: "docs" }] },
  ];
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
  /** The quit question is up; a second quit waits for its answer instead of asking again. */
  private asking = false;
  /** The window's frame as last reported, saved when it closes and at quit (DK-M4). */
  private frame: Rect | undefined;
  /** The floating indicator while a call records (DK-F1), and where it was last. */
  private indicator: {
    window: IndicatorWindow;
    rpc: IndicatorRpcHandlers;
    frame: Rect;
  } | null = null;
  /** Bumped by every close, so an open still reading the status knows it is stale. */
  private indicatorGen = 0;
  private unwatch: () => void = () => {};
  private live = false;
  /** Only the window's focus and blur events set this: a shown window may not have the focus. */
  private focused = false;
  /** The page pulled the status, so its message handlers exist; a message sent earlier is lost. */
  private pageReady = false;
  /** What to tell a page that is still loading, sent when it boots. */
  private pending: ((send: WindowSend) => void)[] = [];
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
    // The Dock icon after the window was closed (DK-M2): the window again, or the same one forward.
    this.ui.onReopen(() => void this.app.openWindow());
    const unwatchLifecycle = this.bridge.watchLifecycle(() => void this.refresh());
    const unannounce = this.app.onAnnounce((a) => this.onAnnounce(a));
    const unhealth = this.bridge.app.watch((call, e) => {
      if (e.type === "health") this.notify({ type: "capture", call, ch: e.ch, state: e.state });
      // The indicator lives with the recording: from the call's start (or a new part) to its end.
      if (e.type === "call.created" || e.type === "part.started") this.openIndicator();
      else if (e.type === "part.ended" || e.type === "call.ended" || e.type === "call.failed")
        this.closeIndicator();
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
        () => this.onPageReady(),
      );
      const frame = placeFrame(this.o.state?.load().window, this.ui.workAreas());
      const w = this.ui.openWindow({ title: "akou", url: WINDOW_URL, rpc: this.rpc, frame });
      this.frame = frame;
      this.window = w.window;
      this.send = w.send;
      this.pageReady = false;
      this.pending = [];
      w.window.onFrame((f) => {
        this.frame = f;
      });
      w.window.onClose(() => {
        this.saveFrame();
        this.rpc?.close();
        this.rpc = null;
        this.window = null;
        this.send = null;
        this.focused = false;
        this.pageReady = false;
        this.pending = [];
        this.showIndicator();
      });
      w.window.onFocus((focused) => {
        this.focused = focused;
        this.showIndicator();
      });
    }
    this.window.show();
    if (call) this.toPage((send) => send.showCall({ call }));
  }

  /** Sends to the page now, or when it boots if it is still loading. */
  private toPage(fn: (send: WindowSend) => void): void {
    if (this.pageReady && this.send) fn(this.send);
    else this.pending.push(fn);
  }

  private onPageReady(): void {
    const send = this.send;
    if (this.pageReady || !send) return;
    this.pageReady = true;
    for (const fn of this.pending.splice(0)) fn(send);
  }

  private sender(): WindowSend {
    const s = this.send;
    const drop = () => {};
    return (
      s ?? {
        followed: drop,
        asked: drop,
        status: drop,
        showCall: drop,
        showSettings: drop,
        focusAsk: drop,
      }
    );
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
        this.toPage((send) => send.showSettings({}));
        break;
      case "docs":
        this.ui.openExternal(DOCS_URL);
        break;
      case "install-cli": {
        const out = (await this.o.installCli?.()) ?? { state: "missing" };
        if (out.state === "failed") this.o.onLog?.("warn", `install the command: ${out.error}`);
        const m = installMessage(out);
        await this.ui.showMessageBox({
          type: out.state === "installed" || out.state === "already" ? "info" : "warning",
          title: "Install Command-Line Tool",
          message: m.title,
          detail: m.detail,
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0,
        });
        break;
      }
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

  /**
   * The one quit path of the tray, the menu's Quit and `Cmd+Q` (DK-M3). During a recording it asks
   * first, with Cancel the default: a quit never stops a call by accident. Stop and quit stops the
   * call through the app's quit, so `part.ended` is in the log before the process exits.
   */
  private async quitApp(): Promise<void> {
    if (this.quitting || this.asking) return;
    this.asking = true;
    let go: boolean;
    try {
      go = await this.confirmQuit();
    } finally {
      this.asking = false;
    }
    if (!go || this.quitting) return;
    this.quitting = true;
    await this.app.quit();
    this.ui.quit();
  }

  private async confirmQuit(): Promise<boolean> {
    const live = !!((await this.app.status()) as { live?: unknown }).live;
    if (!live) return true;
    const pressed = await this.ui.showMessageBox({
      type: "warning",
      title: "Quit akou",
      message: "A call is recording. Stop it and quit?",
      detail: "Everything recorded so far is kept.",
      buttons: ["Cancel", "Stop and quit"],
      defaultId: 0,
      cancelId: 0,
    });
    return pressed === 1;
  }

  /**
   * Opens the indicator when a call records, unless it is open or switched off
   * (`app.floatingIndicator`). A `call.created` that records nothing (an import) opens none: the
   * app's status decides. An end that arrives while the status is read cancels the open.
   */
  private openIndicator(): void {
    if (this.indicator || this.quitting) return;
    if (this.app.config().settings["app.floatingIndicator"] === false) return;
    const gen = this.indicatorGen;
    void this.app.status().then(
      (s) => {
        const live = !!(s as { live?: unknown }).live;
        if (live && gen === this.indicatorGen && !this.indicator && !this.quitting)
          this.createIndicator();
      },
      () => {},
    );
  }

  private createIndicator(): void {
    const frame = placeIndicator(this.o.state?.load().indicator, this.ui.workAreas());
    let send: IndicatorSend | null = null;
    const liveCall = async () =>
      ((await this.app.status()) as { live?: { call?: string } | null }).live?.call;
    const rpc = indicatorRpc(this.bridge, () => send ?? { followed: () => {}, status: () => {} }, {
      focusAsk: async () => {
        await this.app.openWindow(await liveCall());
        this.toPage((s) => s.focusAsk({}));
      },
      openMain: async () => {
        await this.app.openWindow(await liveCall());
      },
    });
    const w = this.ui.openIndicator({ url: INDICATOR_URL, rpc, frame });
    send = w.send;
    const ind = { window: w.window, rpc, frame };
    this.indicator = ind;
    w.window.onFrame((f) => {
      ind.frame = f;
    });
    w.window.onClose(() => {
      if (this.indicator === ind) this.closeIndicator();
    });
    this.showIndicator();
  }

  /** Shown while the main window does not have the focus, without taking it. */
  private showIndicator(): void {
    const ind = this.indicator;
    if (!ind) return;
    if (this.focused) ind.window.hide();
    else ind.window.showInactive();
  }

  private closeIndicator(): void {
    this.indicatorGen++;
    const ind = this.indicator;
    if (!ind) return;
    this.indicator = null;
    const store = this.o.state;
    try {
      if (store) store.save({ ...store.load(), indicator: ind.frame });
    } catch (err) {
      this.o.onLog?.("warn", `the indicator's place was not saved: ${(err as Error).message}`);
    }
    ind.rpc.close();
    ind.window.close();
  }

  private saveFrame(): void {
    const store = this.o.state;
    const frame = this.frame;
    if (!store || !frame) return;
    try {
      store.save({ ...store.load(), window: frame });
    } catch (err) {
      this.o.onLog?.("warn", `the window's place was not saved: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    if (this.window) this.saveFrame();
    this.closeIndicator();
    this.unwatch();
    this.rpc?.close();
    this.window?.close();
    this.window = null;
    if (this.hotkey) this.ui.unregisterShortcut(this.hotkey);
    this.tray?.remove();
    this.tray = null;
  }
}
