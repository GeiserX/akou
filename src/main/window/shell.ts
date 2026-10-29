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
 *   During a recording the question is asked in the window, never in the SDK's message box: that
 *   is a synchronous FFI call that blocks this process, and with it the capture's packets, the
 *   API, MCP and the CLI, for as long as the box is up (TRAPS "A synchronous SDK dialog").
 * - **Single instance** is the app's own lock; `main.ts` asks a running app to show its window.
 * - **The tray always has an image** (DK-T1): the idle item has no text, so without one it is
 *   invisible on macOS. While a call records it is the mark with a red dot and no text (DK-T2).
 *   The files are drawn by `scripts/tray-icons.ts`. On a Mac with no display the mark waits:
 *   swapping it removes the status item and makes a new one, and the SDK crashed doing that with
 *   no screen (`Array index out of range` on the main thread, akou-abh). It changes once a
 *   display is back, at the next refresh.
 * - **The application menu** (DK-M1, macOS) carries the Edit roles: the webview gets copy, paste,
 *   undo and select all only through them.
 * - **Notifications** (DK-N1, DK-N2, DK-T5): `notify.ts` decides; the shell feeds it the app's
 *   starts and shares, the capture's health, and its own tray and hotkey starts, and shows each
 *   notice once a minute at most. With the dictation pill off, a learn chip for a fix made in the
 *   app's field becomes one notification, which names no word (Notification Center keeps it), and
 *   the fix waits in the words to review (DC-O4).
 */

import { join } from "node:path";
import type { DraftOpen, DraftRpc } from "../../ui/dictation-protocol.ts";
import type { Chip, ChipAnswer } from "../../ui/pill-protocol.ts";
import type { AppStatus, QuitQuestion } from "../../ui/protocol.ts";
import type { DraftWindow } from "../dictation/draft.ts";
import type { AkouApp, Announcement, WindowShell } from "../index.ts";
import type { Bridge } from "./bridge.ts";
import { hotkeyFor, hotkeyLabel } from "./hotkey.ts";
import { type IndicatorRpcHandlers, type IndicatorSend, indicatorRpc } from "./indicator.ts";
import { type InstallOutcome, installMessage } from "./install-cli.ts";
import { DEDUP_MS, type NotifyEvent, notifyFor, originOf } from "./notify.ts";
import type { SettingsPane } from "./page-server.ts";
import { type PillDictation, type PillRpcHandlers, type PillSend, pillRpc } from "./pill.ts";
import { Refit } from "./refit.ts";
import { type WindowRpc, type WindowSend, windowRpc } from "./rpc.ts";

export { hotkeyFor };

export const WINDOW_URL = "views://main/index.html";
export const INDICATOR_URL = "views://indicator/index.html";
export const PILL_URL = "views://pill/index.html";
export const DRAFT_URL = "views://draft/index.html";

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
  /** The dictation pill's places after a drag (DC-O1): one per display and edge. */
  pillPlaces?: PillPlace[];
  /**
   * The single place kept before the pill had one per display, and its edge: read as the place on
   * the display it overlaps, never written again.
   */
  pill?: Rect;
  pillEdge?: string;
}

/**
 * Where the pill was dragged on one display (DC-O1): `area` is that display's work area, `edge` the
 * `dictation.pill` setting it was dragged under, `frame` where it went.
 */
export interface PillPlace {
  edge: string;
  area: Rect;
  frame: Rect;
}

export interface NativeWindow {
  show(): void;
  close(): void;
  /** Zooms the window, or back, as a double-click on a title bar does (DK-M7). */
  zoom(): void;
  onClose(fn: () => void): void;
  /** The window gained (true) or lost (false) the focus. */
  onFocus(fn: (focused: boolean) => void): void;
  /** The window moved or was resized. The shell keeps the last, so it never reads a closed one. */
  onFrame(fn: (frame: Rect) => void): void;
  /** The window's size in points; on macOS (`hiddenInset`) that is its content's too. */
  size?(): { width: number; height: number };
  /** Sizes the window, its top-left corner kept (the re-fit's nudge). */
  setSize?(width: number, height: number): void;
  /**
   * Puts the window in front on the Space the user is on, restored if minimized, without taking
   * the keyboard from the app in front (DK-M9).
   */
  raise?(): void;
  /** Is it minimized? The SDK has no event for a minimize or a restore, so the shell asks (DK-F1). */
  isMinimized?(): boolean;
}

/** The floating indicator's window: always on top, never takes the focus when shown. */
export interface IndicatorWindow {
  /** Moves and sizes it: to the width of its pill, which changes with what the pill shows. */
  setFrame(frame: Rect): void;
  /** Shows it without taking the focus from the app in front (the meeting). */
  showInactive(): void;
  hide(): void;
  close(): void;
  onClose(fn: () => void): void;
  onFrame(fn: (frame: Rect) => void): void;
}

/** The dictation pill's window (DC-O1): always on top, never takes the focus, a click included. */
export interface PillWindow {
  /** Moves it, shown or hidden: to the display of the window the text goes to (DC-O1). */
  setFrame(frame: Rect): void;
  showInactive(): void;
  hide(): void;
  close(): void;
  onClose(fn: () => void): void;
  onFrame(fn: (frame: Rect) => void): void;
}

/**
 * The draft box's window (DC-S1): above every other window, shown taking the keyboard for a
 * deliberate open and without it for an automatic one.
 */
export interface DraftNativeWindow {
  show(): void;
  showInactive(): void;
  hide(): void;
  close(): void;
  onClose(fn: () => void): void;
}

/** What the shell pushes to the draft box's page; ElectroBun's `rpc.send`. */
export interface DraftSend {
  open(d: DraftOpen): void;
  chip(c: Chip): void;
  append(text: string): void;
}

type DraftRequests = DraftRpc["bun"]["requests"];

/** The draft box's request handlers, answered by `DraftBox` (src/main/dictation/draft.ts). */
export type DraftHandlers = {
  [K in keyof DraftRequests]: (
    p: DraftRequests[K]["params"],
  ) => Promise<DraftRequests[K]["response"]>;
};

/**
 * How the pill's window refuses the focus on each OS (DC-O1): an `NSPanel` with the
 * `NonactivatingPanel` style on macOS, `WS_EX_NOACTIVATE` on Windows. `activate: false` alone
 * governs only the first show; a click on a plain window still activates it.
 */
export interface PillStyle {
  styleMask?: { NonactivatingPanel: true };
  noActivate?: true;
}

export function pillStyle(platform: string): PillStyle {
  if (platform === "darwin") return { styleMask: { NonactivatingPanel: true } };
  if (platform === "win32") return { noActivate: true };
  return {};
}

/**
 * The main window's frame on each OS (DK-M7): on macOS no title bar is drawn, the traffic lights
 * float over the sidebar and the page runs to the top edge; the page leaves them room when it runs
 * in the window on macOS (`src/ui/app.ts` `titleBar`). Windows and Linux keep their native frame.
 */
export function titleBarStyle(platform: string): "hiddenInset" | "default" {
  return platform === "darwin" ? "hiddenInset" : "default";
}

export type TrayMenuItem =
  | { type: "normal"; label: string; action: string; enabled?: boolean; checked?: boolean }
  | { type: "separator" };

export interface NativeTray {
  setMenu(items: TrayMenuItem[]): void;
  setTitle(title: string): void;
  setImage(o: { image: string; template: boolean }): void;
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
  openWindow(o: {
    title: string;
    url: string;
    rpc: WindowRpc;
    frame?: Rect;
    titleBarStyle: "hiddenInset" | "default";
    /** Opened hidden, so the shell shows it its own way (`raise`, DK-M9). */
    hidden?: boolean;
  }): {
    window: NativeWindow;
    send: WindowSend;
  };
  /** The floating indicator (DK-F1): a small window with no title bar, above every other. */
  openIndicator(o: { url: string; rpc: IndicatorRpcHandlers; frame: Rect }): {
    window: IndicatorWindow;
    send: IndicatorSend;
  };
  /** The dictation pill (DC-O1): hidden until shown, above every other window, never focused. */
  openPill?(o: { url: string; rpc: PillRpcHandlers; frame: Rect; style: PillStyle }): {
    window: PillWindow;
    send: PillSend;
  };
  /** The draft box (DC-S1): hidden until a draft opens, above every other window. */
  openDraft?(o: { url: string; handlers: DraftHandlers; frame: Rect }): {
    window: DraftNativeWindow;
    send: DraftSend;
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
  /** Pause and resume the live call, as the window's buttons do. */
  pauseLive(): Promise<void>;
  resumeLive(): Promise<void>;
  config(): { settings: Record<string, unknown> };
  quit(): Promise<void>;
  openSettingsPane(pane: SettingsPane): Promise<boolean>;
  /** Shows the window through the app, so the app knows it has one. */
  openWindow(call?: string): Promise<unknown>;
  /** Every start and share from any door, with who asked. Returns the unsubscribe function. */
  onAnnounce(fn: (a: Announcement) => void): () => void;
  /** Dictation (docs/ux/DICTATION.md DC-O4); absent where the app runs none (server mode). */
  dictation?: ShellDictation;
}

/**
 * Dictation as the tray and the pill see it: its state, the same session door as the API, its
 * changes, and for the pill its events and levels.
 */
export interface ShellDictation
  extends Pick<
    PillDictation,
    "follow" | "languageChoice" | "setLanguage" | "errorActions" | "errorAction"
  > {
  /** `off`, `starting`, `idle`, `listening`, `transcribing` or `inserting`. */
  state(): string;
  status(): ReturnType<PillDictation["status"]>;
  /** `POST /v1/dictation/start`, `/stop` and `/cancel`; true when the helper acted. */
  control(action: "start" | "stop" | "cancel"): Promise<boolean>;
  /** Called at every change of the state. Returns the unsubscribe function. */
  watch(fn: () => void): () => void;
  /** The dictation key the helper is bound to (`RightCommand`), empty before it starts. */
  hotkey(): string;
  /** The draft box's main side, or null with no dictation service. */
  draft?(): { handlers: DraftHandlers; attach(w: DraftWindow | null): void } | null;
  /** A learn chip the pill showed was answered (DC-L4). */
  chip?(a: ChipAnswer): Promise<boolean>;
  /** A learn chip had nowhere to show: its pairs wait in the words to review (DC-O4). */
  releaseChip?(id: string): void;
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
    pauseLive: async () => {
      await app.manager.pause();
    },
    resumeLive: async () => {
      await app.manager.resume();
    },
    config: () => app.config(),
    quit: () => app.quit(),
    openSettingsPane: (pane) => app.openSettingsPane(pane),
    openWindow: (call) => app.openWindow(call),
    onAnnounce: (fn) => app.onAnnounce(fn),
    dictation: {
      state: () => app.dictation()?.status().state ?? "off",
      status: () => {
        const s = app.dictation()?.status();
        return {
          state: s?.state ?? "off",
          loading: s?.loading ?? false,
          swallow_keys: s?.swallow_keys ?? null,
          accessibility: s?.grants?.accessibility ?? null,
        };
      },
      control: async (action) => (await app.dictation()?.control(action))?.ok === true,
      watch: (fn) => app.dictation()?.watch(fn) ?? (() => {}),
      follow: (fn, o) => app.dictation()?.follow(fn, o) ?? (() => {}),
      languageChoice: () =>
        app.dictation()?.languageChoice() ?? { languages: [], switchable: false },
      setLanguage: (language) => app.dictation()?.setLanguage(language) ?? false,
      errorActions: (id) => app.dictation()?.errorActions(id) ?? { actions: [] },
      errorAction: async (id, action) => (await app.dictation()?.errorAction(id, action)) === true,
      hotkey: () => app.dictation()?.hotkey() ?? "",
      draft: () => app.dictation()?.draft ?? null,
      chip: async (a) => (await app.dictation()?.answerChip(a)) === true,
      releaseChip: (id) => app.dictation()?.releaseChip(id),
    },
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
  /** How often the shell asks whether the window is minimized during a call. Tests pass their own. */
  minimizedPollMs?: number;
}

/** The quit question (DK-M3), asked in the window; Cancel is the default. */
export const QUIT_QUESTION: Omit<QuitQuestion, "id"> = {
  message: "A call is recording. Stop it and quit?",
  detail: "Everything recorded so far is kept.",
  confirm: "Stop and quit",
};

/**
 * How often, while a call's indicator and the main window are both open, the shell asks whether
 * the window is minimized (DK-F1): the SDK sends no event for a minimize or a restore. One cheap
 * native read a second, and none at all outside a call or with the window closed.
 */
export const MINIMIZED_POLL_MS = 1000;

/** How long the window must stay still after a move or resize before the page is measured. */
const MEASURE_SETTLE_MS = 250;

/**
 * The webview re-fit for a window (TRAPS "A webview left at its old size"): on macOS only, where
 * ElectroBun leaves the webview behind and the window's frame is its content (`hiddenInset`).
 */
export function refitFor(
  platform: string,
  win: NativeWindow,
  log: (msg: string) => void,
): Refit | null {
  if (platform !== "darwin" || !win.size || !win.setSize) return null;
  return new Refit({
    size: () => win.size?.() ?? null,
    setSize: (w, h) => win.setSize?.(w, h),
    log,
    // clock: the re-fit's once-a-second guard.
    now: () => Date.now(),
    // clock: the nudge's second half runs on a later tick of the real event loop.
    later: (fn) => setTimeout(fn, 50),
  });
}

/** The window's size the first time it opens. */
export const DEFAULT_WINDOW = { width: 1280, height: 820 } as const;
/** No window is restored smaller than this. */
const MIN_WINDOW = { width: 480, height: 360 } as const;
/**
 * The floating indicator's size before its page has measured its pill: one row. The window is then
 * made as wide as the pill (`fitIndicator`), never narrower than `INDICATOR_MIN_WIDTH` nor wider
 * than `INDICATOR_MAX_WIDTH`, and it is transparent, so nothing past the pill's rounded edge shows.
 */
export const INDICATOR_SIZE = { width: 480, height: 40 } as const;
export const INDICATOR_MIN_WIDTH = 160;
export const INDICATOR_MAX_WIDTH = 800;
/** Its distance from the work area's edge the first time it shows. */
const INDICATOR_MARGIN = 16;
/**
 * The dictation pill's place-holding size: the island at its widest (listening with its words) and
 * what hangs under it, the error's sheet or the learn chip, with room for their shadows. Places are
 * kept at this size; the window itself is as tall as its page asks (`sizePill`, H-11). It is
 * transparent; only the island and what hangs under it are painted (pill.css).
 */
export const PILL_SIZE = { width: 480, height: 200 } as const;
/**
 * The draft box's size: its island, the sheet with the field, the other readings, a chip of three
 * candidates, the engine line and the buttons. Past that the middle scrolls and the buttons stay.
 */
export const DRAFT_SIZE = { width: 640, height: 520 } as const;
/** Its distance from the work area's edge on the side `dictation.pill` names. */
const PILL_MARGIN = 24;
/** At the top the island sits right under the menu bar, where a notch would be. */
const ISLAND_TOP = 4;

/** A frame with an area. The SDK reports {0,0,0,0} for a window that is already gone. */
const hasArea = (r: Rect) => r.width > 0 && r.height > 0;

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

/** A width the indicator's window may take. */
const indicatorWidth = (w: number) =>
  Math.min(INDICATOR_MAX_WIDTH, Math.max(INDICATOR_MIN_WIDTH, Math.ceil(w)));

/**
 * Where the floating indicator shows (DK-F1): where it was dragged last, as wide as it was, pulled
 * onto a display the same way as the window; the first time, the top right of the primary work
 * area.
 */
export function placeIndicator(saved: Rect | undefined, areas: readonly Rect[]): Rect {
  const primary = areas.find((a) => a.width > 0 && a.height > 0);
  const width = saved ? indicatorWidth(saved.width) : INDICATOR_SIZE.width;
  const at = saved ?? {
    x: (primary ? primary.x + primary.width : width) - width - INDICATOR_MARGIN,
    y: (primary?.y ?? 0) + INDICATOR_MARGIN,
  };
  const want = { x: at.x, y: at.y, width, height: INDICATOR_SIZE.height };
  return primary ? fitInto(want, areas, { width, height: INDICATOR_SIZE.height }) : want;
}

/**
 * The indicator's frame once its pill is `width` wide: its right edge stays where it is, so from
 * the top right corner it keeps its margin, and Stop does not move under the pointer when the time
 * grows or Mute becomes Unmute. Pulled back onto its display if that pushed it off.
 */
export function fitIndicator(frame: Rect, width: number, areas: readonly Rect[]): Rect {
  const w = indicatorWidth(width);
  const want = { x: frame.x + frame.width - w, y: frame.y, width: w, height: frame.height };
  return areas.some(hasArea) ? fitInto(want, areas, { width: w, height: frame.height }) : want;
}

/** The same rectangle. */
const sameRect = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Where the shell put a window, as the OS reports it back: within a point or two. */
const near = (a: Rect, b: Rect) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2;

/**
 * The display work area that holds `r`: the one it overlaps most, else the one nearest its centre
 * (a window just past a display's edge, a work area that leaves out the menu bar). Undefined with
 * no display reported.
 */
export function areaOf(r: Rect, areas: readonly Rect[]): Rect | undefined {
  const real = areas.filter(hasArea);
  let best: Rect | undefined;
  let most = 0;
  for (const a of real) {
    const o = overlap(r, a);
    if (o > most) {
      most = o;
      best = a;
    }
  }
  if (best) return best;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const far = (a: Rect) =>
    Math.hypot(
      Math.max(a.x - cx, 0, cx - (a.x + a.width)),
      Math.max(a.y - cy, 0, cy - (a.y + a.height)),
    );
  return real.reduce<Rect | undefined>((b, a) => (!b || far(a) < far(b) ? a : b), undefined);
}

/**
 * Where the dictation pill shows (DC-O1), on the display whose work area is `on` (the primary when
 * absent or no longer there): where it was dragged last on that display while on this edge, else
 * centred on the side of that work area that `dictation.pill` names, and pulled whole onto a
 * display either way.
 */
export function placePill(
  places: readonly PillPlace[],
  edge: string,
  areas: readonly Rect[],
  on?: Rect,
): Rect {
  const real = areas.filter(hasArea);
  const area = (on && real.find((a) => sameRect(a, on))) || real[0];
  const { width, height } = PILL_SIZE;
  if (!area) {
    const any = places.find((p) => p.edge === edge);
    return any ? { x: any.frame.x, y: any.frame.y, width, height } : { x: 0, y: 0, width, height };
  }
  const saved = places.find((p) => p.edge === edge && sameRect(p.area, area));
  if (saved)
    return fitInto({ x: saved.frame.x, y: saved.frame.y, width, height }, [area], PILL_SIZE);
  const cx = area.x + Math.round((area.width - width) / 2);
  const cy = area.y + Math.round((area.height - height) / 2);
  const at =
    edge === "top"
      ? { x: cx, y: area.y + ISLAND_TOP }
      : edge === "left"
        ? { x: area.x + PILL_MARGIN, y: cy }
        : edge === "right"
          ? { x: area.x + area.width - width - PILL_MARGIN, y: cy }
          : { x: cx, y: area.y + area.height - height - PILL_MARGIN };
  return fitInto({ ...at, width, height }, [area], PILL_SIZE);
}

/**
 * The pill's window at `height` for `base`, a place at `PILL_SIZE` (H-11): it grows away from the
 * edge `dictation.pill` names. At the bottom its bottom stays; anywhere else, the left and right
 * edges included, its top stays, since the page lays its row at the top and the words below it,
 * so the row with Stop and Cancel never moves as it grows. The width never changes. Pulled whole into `area` when given, and never
 * taller than it.
 */
export function sizePill(base: Rect, edge: string, height: number, area?: Rect): Rect {
  const h = Math.max(1, Math.round(height));
  const y = edge === "bottom" ? base.y + base.height - h : base.y;
  const want = { x: base.x, y, width: base.width, height: h };
  if (!area || !hasArea(area)) return want;
  return fitInto(want, [area], { width: base.width, height: Math.min(h, area.height) });
}

/** The place at `PILL_SIZE` of a pill window at any height: `sizePill` the other way round. */
export function pillBase(frame: Rect, edge: string): Rect {
  const h = PILL_SIZE.height;
  const y = edge === "bottom" ? frame.y + frame.height - h : frame.y;
  return { x: frame.x, y, width: frame.width, height: h };
}

/** `places` with `frame`, dragged under `edge`, as the place on the display it is on now. */
export function rememberPill(
  places: readonly PillPlace[],
  edge: string,
  frame: Rect,
  areas: readonly Rect[],
): PillPlace[] {
  const area = areaOf(frame, areas);
  if (!area) return [...places];
  return [
    ...places.filter((p) => !(p.edge === edge && sameRect(p.area, area))),
    { edge, area, frame },
  ];
}

/** The places a state file holds, the single one kept before per-display places included. */
export function pillPlaces(s: ShellState, areas: readonly Rect[]): PillPlace[] {
  if (s.pillPlaces) return s.pillPlaces;
  if (!s.pill || !s.pillEdge) return [];
  const area = areaOf(s.pill, areas);
  return area ? [{ edge: s.pillEdge, area, frame: s.pill }] : [];
}

/**
 * Where the draft box opens: dropped from the island, at the top centre of the primary work area,
 * so its own island sits where the pill's does.
 */
export function placeDraft(areas: readonly Rect[]): Rect {
  const primary = areas.find((a) => a.width > 0 && a.height > 0);
  const { width, height } = DRAFT_SIZE;
  if (!primary) return { x: 0, y: 0, width, height };
  const want = {
    x: primary.x + Math.round((primary.width - width) / 2),
    y: primary.y + ISLAND_TOP,
    width,
    height,
  };
  return fitInto(want, areas, DRAFT_SIZE);
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

/**
 * The tray image for a platform: a template PNG on macOS, an ICO on Windows, a PNG elsewhere. While
 * a call records, macOS gets the mark cut out of a filled disc, a template too, so the menu bar inks
 * it on any bar; Windows and Linux get the mark with its dot red.
 */
export function trayImage(
  platform: string,
  recording = false,
  dir = TRAY_DIR,
): { image: string; template: boolean } {
  if (platform === "darwin") {
    const name = recording ? "akou-recording-template.png" : "akou-template.png";
    return { image: join(dir, name), template: true };
  }
  const name = recording ? "akou-recording" : "akou";
  if (platform === "win32") return { image: join(dir, `${name}.ico`), template: false };
  return { image: join(dir, `${name}.png`), template: false };
}

/** Whether the tray shows the recording mark: a call that records, not one that is paused. */
export function trayRecording(s: Pick<AppStatus, "live">): boolean {
  return !!s.live && s.live.state !== "paused";
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

/** The dictation item of the tray's menu (DC-O4), or none while dictation is off. */
function dictationItem(state: string | undefined, key: string): TrayMenuItem[] {
  switch (state) {
    case undefined:
    case "off":
      return [];
    case "idle":
      // The tray menu takes no accelerator, so the key is in the label, as the app menu names it.
      return [
        {
          type: "normal",
          label: key ? `Start dictation (${key})` : "Start dictation",
          action: "dictate",
        },
      ];
    case "listening":
      return [{ type: "normal", label: "■ Stop dictation", action: "dictate-stop" }];
    case "starting":
      return [{ type: "normal", label: "Dictation is starting", action: "none", enabled: false }];
    default:
      return [
        { type: "normal", label: "Transcribing the dictation", action: "none", enabled: false },
      ];
  }
}

/** How long a call title may run in the tray menu's header before it is cut with an ellipsis. */
export const TRAY_TITLE_MAX = 40;

/** What the tray menu's warning line says for a capture side that records nothing. */
const LOST: Record<"mic" | "call", string> = {
  call: "⚠ System audio lost",
  mic: "⚠ Microphone lost",
};

/** The call's elapsed time at `now`, from its first part's start; null before one or with no clock. */
export function callElapsedMs(live: AppStatus["live"], now: number | undefined): number | null {
  if (!live || live.startedAt == null || now === undefined) return null;
  return Math.max(0, now - live.startedAt);
}

/** An elapsed time as whole minutes in words, for the tray menu's header: `23 min`, `1 h 5 min`. */
export function minutesText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under 1 min";
  const h = Math.floor(m / 60);
  if (h === 0) return `${m} min`;
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** An elapsed time as `h:mm`, the macOS tray title's clock: `0:23` is 23 minutes. */
export function hoursMinutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** How long until a call's elapsed minute changes, so the tray moves once a minute. */
export function nextMinuteIn(startedAt: number, now: number): number {
  return 60_000 - (Math.max(0, now - startedAt) % 60_000);
}

/** The header of the tray menu while a call is live: what records, where, and for how long. */
function liveHeader(live: NonNullable<AppStatus["live"]>, now: number | undefined): string {
  // A status from a fake or an older app may lack a field: the header shows what is there.
  const t = (live.title ?? "").trim() || "Untitled call";
  const title = t.length > TRAY_TITLE_MAX ? `${t.slice(0, TRAY_TITLE_MAX - 1).trimEnd()}…` : t;
  const ms = callElapsedMs(live, now);
  return [title, live.workspace, ms === null ? "" : minutesText(ms)].filter(Boolean).join(" · ");
}

/**
 * The tray's menu for the app's state. While a call is live: a header naming it, a warning per
 * capture side that records nothing, Pause or Resume, Stop, and Ask about this call. Idle: Record.
 * Then dictation, Show akou and Quit. Open at login is in Settings.
 */
export function trayMenu(o: {
  live: AppStatus["live"];
  /** Epoch ms, for the header's elapsed time. */
  now?: number;
  /** The dictation session's state; absent or `off` without dictation. */
  dictation?: string;
  /** The dictation key as the app names it (`⌘ Right`), empty before the helper binds one. */
  dictationKey?: string;
}): TrayMenuItem[] {
  const sep: TrayMenuItem = { type: "separator" };
  const live = o.live;
  const call: TrayMenuItem[] = live
    ? [
        { type: "normal", label: liveHeader(live, o.now), action: "none", enabled: false },
        ...(live.lost ?? []).map(
          (ch): TrayMenuItem => ({
            type: "normal",
            label: LOST[ch],
            action: "none",
            enabled: false,
          }),
        ),
        sep,
        live.state === "paused"
          ? { type: "normal", label: "▶ Resume", action: "resume" }
          : { type: "normal", label: "❚❚ Pause", action: "pause" },
        { type: "normal", label: "■ Stop recording", action: "stop" },
        sep,
        { type: "normal", label: "Ask about this call…", action: "ask" },
        sep,
      ]
    : [{ type: "normal", label: "● Record", action: "record" }];
  return [
    ...call,
    ...dictationItem(o.dictation, o.dictationKey ?? ""),
    { type: "normal", label: "Show akou", action: "show" },
    sep,
    { type: "normal", label: "Quit akou", action: "quit" },
  ];
}

/**
 * The tray's title: what a glance at the menu bar needs beside the image. A dictation shows while
 * it listens or transcribes, whatever the pill setting (DC-O4), since it lasts seconds and a call's
 * state is back right after; then a share; then a paused call's bars. On macOS a recording call
 * shows its elapsed time as `h:mm`, moved once a minute. Windows has no title beside a tray icon,
 * and an AppIndicator label shows on some Linux panels only, so there the menu's header carries it.
 */
export function trayTitle(
  s: Pick<AppStatus, "live" | "share">,
  dictation?: string,
  o: { platform?: string; now?: number } = {},
): string {
  if (dictation === "listening") return "● dictating";
  if (dictation === "transcribing" || dictation === "inserting") return "… transcribing";
  if (s.share?.active) return "● shared";
  if (s.live?.state === "paused") return "❚❚";
  const ms = callElapsedMs(s.live, o.now);
  return o.platform === "darwin" && ms !== null ? hoursMinutes(ms) : "";
}

/** The dictation pill while it is open (DC-O1). */
interface OpenPill {
  window: PillWindow;
  rpc: PillRpcHandlers;
  edge: string;
  frame: Rect;
  area: Rect | undefined;
  places: PillPlace[];
  moved: boolean;
  placed: Rect | null;
  /** The height the page last asked for (H-11), or null before it asked. */
  height: number | null;
}

export class Shell implements WindowShell {
  private window: NativeWindow | null = null;
  private send: WindowSend | null = null;
  private rpc: WindowRpc | null = null;
  private tray: NativeTray | null = null;
  /** Whether the tray shows the recording mark, so the image is set only when that changes. */
  private recordingMark = false;
  /** The tray's last title and menu, so a refresh in the same state sets neither again. */
  private trayShown = { title: "", menu: "" };
  /** The next move of the tray's elapsed minute while a call is live. */
  private minute: ReturnType<typeof setTimeout> | null = null;
  /** The login item as last applied, so a changed setting applies at the next refresh (DK-L2). */
  private loginOn: boolean | null = null;
  private hotkey: string | null = null;
  private quitting = false;
  /** The quit question is up; a second quit waits for its answer instead of asking again. */
  private asking = false;
  /** The quit question the window has not answered yet, and how to resolve it. */
  private question: { id: number; resolve: (go: boolean) => void } | null = null;
  private questions = 0;
  /** The window's frame as last reported, saved when it closes and at quit (DK-M4). */
  private frame: Rect | undefined;
  /** The floating indicator while a call records (DK-F1), and where it was last. */
  private indicator: {
    window: IndicatorWindow;
    rpc: IndicatorRpcHandlers;
    frame: Rect;
    /** Whether it was last shown or hidden, so a check that finds nothing changed does nothing. */
    shown?: boolean;
  } | null = null;
  /** Asks whether the main window is minimized while the indicator and the window are both open. */
  private minimizedPoll: ReturnType<typeof setInterval> | null = null;
  /** Bumped by every close, so an open still reading the status knows it is stale. */
  private indicatorGen = 0;
  /**
   * The dictation pill while dictation runs (DC-O1): the edge it opened on, where it is and on
   * which display, the places dragged per display, whether a drag changed them, and the frame the
   * shell last moved it to, so the move it reports back is not taken for a drag.
   */
  private pill: OpenPill | null = null;
  /** The draft box while dictation runs (DC-S1), hidden between drafts. */
  private draft: {
    window: DraftNativeWindow;
    detach(): void;
  } | null = null;
  private unwatch: () => void = () => {};
  private live = false;
  /** Only the window's focus and blur events set this: a shown window may not have the focus. */
  private focused = false;
  /** Re-fits the webview when the page is not the window's size (macOS only). */
  private refit: Refit | null = null;
  private measuring: ReturnType<typeof setTimeout> | null = null;
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

  /** The global hotkey this shell holds, or null when another app took it first. */
  registeredHotkey(): string | null {
    return this.hotkey;
  }

  /** Is the main window open? Read by the watchdog, which reopens the app only if it was. */
  isOpen(): boolean {
    return this.window !== null;
  }

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
    // Set before it is applied, so one that fails is not tried again at every refresh.
    this.loginOn = s["app.openAtLogin"] === true;
    try {
      await this.o.setLoginItem(this.loginOn);
    } catch (err) {
      this.o.onLog?.("warn", `login item: ${(err as Error).message}`);
    }
    this.ui.onBeforeQuit((e) => {
      if (this.quitting) return;
      e.cancel();
      void this.quitApp();
    });
    // The Dock icon after the window was closed (DK-M2): the window again, or the same one forward.
    // While a quit runs, openWindow answers 503 "quitting": the click then does nothing.
    this.ui.onReopen(() => void this.app.openWindow().catch(() => {}));
    const unwatchLifecycle = this.bridge.watchLifecycle(() => void this.refresh());
    const unannounce = this.app.onAnnounce((a) => this.onAnnounce(a));
    const undictation =
      this.app.dictation?.watch(() => {
        this.syncPill();
        this.syncDraft();
        void this.refresh();
      }) ?? (() => {});
    // With the pill off, a learn chip falls back to a notification (DC-O4).
    const unchip =
      this.app.dictation?.follow((m) => {
        if (m.kind === "chip" && !this.pill) this.chipNotice(m.chip);
      }) ?? (() => {});
    const unhealth = this.bridge.app.watch((call, e) => {
      if (e.type === "health") {
        this.notify({ type: "capture", call, ch: e.ch, state: e.state });
        // The tray menu's warning line follows the capture's health.
        void this.refresh();
      }
      // The indicator lives with the recording: from the call's start (or a new part) to its end.
      if (e.type === "call.created" || e.type === "part.started") this.openIndicator();
      else if (e.type === "part.ended" || e.type === "call.ended" || e.type === "call.failed")
        this.closeIndicator();
    });
    this.unwatch = () => {
      unwatchLifecycle();
      unannounce();
      unhealth();
      undictation();
      unchip();
    };
    this.syncPill();
    this.syncDraft();
    await this.refresh();
  }

  /**
   * A learn chip with the pill off (DC-O4): one notification per dictation, then the chip is let go
   * with nothing written, so its fixes wait in the words to review on the Dictation page. It names
   * no word: macOS keeps notifications in Notification Center, and the words stay in akou.
   */
  private chipNotice(c: Chip): void {
    const one = c.candidates.length === 1;
    const words = one ? "a word" : `${c.candidates.length} words`;
    this.ui.showNotification(
      c.mode === "learned"
        ? {
            title: `akou learned ${words} you fixed`,
            body: `Undo ${one ? "it" : "them"} in Words to review on the Dictation page.`,
          }
        : {
            title: `akou can learn ${words} you fixed`,
            body: `${one ? "It waits" : "They wait"} in Words to review on the Dictation page.`,
          },
    );
    this.app.dictation?.releaseChip?.(c.id);
  }

  /** Shows what `notifyFor` says for an event, unless the same showed within a minute. */
  private notify(e: NotifyEvent): void {
    const n = notifyFor(e, { windowFocused: this.focused, platform: this.o.platform });
    if (!n) return;
    // clock: the default of the injected `now`; tests pass their own.
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
    else if (a.ok) {
      this.notify({ type: "started", call: a.call, origin });
      // A call an agent started shows the window where the user is (DK-M9). The window, the tray
      // and the hotkey start as `user`, and an attach is never announced: none of them raise it.
      if (
        origin !== "window" &&
        !this.quitting &&
        this.app.config().settings["app.showOnAgentStart"] !== false
      )
        this.show(a.call, { raise: true });
    } else this.notify({ type: "refused", code: a.code, origin });
  }

  /**
   * Brings the window forward, creating it when there is none; on a call when one is named. With
   * `raise`, it is put in front on the user's Space without taking the keyboard (DK-M9).
   */
  show(call?: string, o: { raise?: boolean } = {}): void {
    if (!this.window) {
      this.rpc = windowRpc(
        this.bridge,
        () => this.sender(),
        (pane) => this.app.openSettingsPane(pane),
        () => this.onPageReady(),
        (id, go) => this.answerQuit(id, go),
        () => this.window?.zoom(),
        // A report while a move or resize is still settling is stale against a window that has moved
        // on (a drag, a full-screen animation); the settled `measure` decides.
        (v) => {
          if (!this.measuring) this.refit?.check(v);
        },
      );
      const frame = placeFrame(this.o.state?.load().window, this.ui.workAreas());
      // The title is never drawn on macOS, but the Window menu, Mission Control and VoiceOver read it.
      const w = this.ui.openWindow({
        title: "akou",
        url: WINDOW_URL,
        rpc: this.rpc,
        frame,
        titleBarStyle: titleBarStyle(this.o.platform),
        ...(o.raise ? { hidden: true } : {}),
      });
      this.frame = frame;
      this.window = w.window;
      this.send = w.send;
      this.pageReady = false;
      this.pending = [];
      this.refit = refitFor(this.o.platform, w.window, (m) => this.o.onLog?.("info", m));
      w.window.onFrame((f) => {
        if (hasArea(f)) this.frame = f;
        this.measure();
      });
      w.window.onClose(() => {
        this.refit = null;
        if (this.measuring) clearTimeout(this.measuring);
        this.measuring = null;
        this.saveFrame();
        this.rpc?.close();
        this.rpc = null;
        this.window = null;
        this.send = null;
        this.focused = false;
        this.pageReady = false;
        this.pending = [];
        // A window closed with the question up answers Cancel.
        if (this.question) this.answerQuit(this.question.id, false);
        this.syncIndicator();
      });
      w.window.onFocus((focused) => {
        this.focused = focused;
        // A minimize takes the focus and a click that restores gives it back: check now rather
        // than at the next poll.
        this.syncIndicator();
        if (focused) this.measure();
      });
    }
    const win = this.window;
    if (o.raise && win.raise) win.raise();
    else win.show();
    this.syncIndicator();
    if (call) this.toPage((send) => send.showCall({ call }));
  }

  /**
   * Asks the page for its viewport once the window has settled after a move, a resize or the
   * focus (TRAPS "A webview left at its old size"); a drag sends many frames, the page hears one.
   */
  private measure(): void {
    if (!this.refit) return;
    if (this.measuring) clearTimeout(this.measuring);
    // clock: the window must stay still in real time before the page is measured.
    this.measuring = setTimeout(() => {
      this.measuring = null;
      if (this.pageReady) this.send?.measure?.({});
    }, MEASURE_SETTLE_MS);
    this.measuring.unref?.();
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
        askQuit: drop,
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
        // A notification, not a message box: the box would block this process (see `quitApp`).
        const m = installMessage(out);
        this.ui.showNotification({ title: m.title, body: m.detail });
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
      case "dictate":
        await this.app.dictation?.control("start");
        break;
      case "dictate-stop":
        await this.app.dictation?.control("stop");
        break;
      case "pause":
        await this.app.pauseLive();
        break;
      case "resume":
        await this.app.resumeLive();
        break;
      case "ask": {
        // The window on the live call, with the ask box focused. The call is read now: a refresh
        // may not have run since it started.
        const call = ((await this.app.status()) as { live?: { call?: string } | null }).live?.call;
        await this.app.openWindow();
        if (call) this.toPage((send) => send.showCall({ call, ask: true }));
        break;
      }
      case "show":
        await this.app.openWindow();
        break;
      case "quit":
        await this.quitApp();
        break;
    }
  }

  private async refresh(): Promise<void> {
    const s = (await this.app.status()) as unknown as AppStatus;
    if (!this.tray) return;
    this.live = !!s.live;
    // clock: the default of the injected `now`; tests pass their own.
    const now = this.o.now?.() ?? Date.now();
    const dictation = this.app.dictation?.state();
    const title = trayTitle(s, dictation, { platform: this.o.platform, now });
    if (title !== this.trayShown.title) this.tray.setTitle(title);
    const recording = trayRecording(s);
    // No display, nobody sees the mark, and a new status item then crashes the SDK: leave it.
    if (recording !== this.recordingMark && this.ui.workAreas().length > 0) {
      this.recordingMark = recording;
      this.tray.setImage(trayImage(this.o.platform, recording));
    }
    const key = this.app.dictation?.hotkey() ?? "";
    const items = trayMenu({
      live: s.live,
      now,
      dictation,
      dictationKey: key ? hotkeyLabel(key, this.o.platform) : "",
    });
    const menu = JSON.stringify(items);
    if (menu !== this.trayShown.menu) this.tray.setMenu(items);
    this.trayShown = { title, menu };
    this.nextMinute(s.live, now);
    await this.syncLogin();
  }

  /** While a call is live, a refresh when its elapsed minute moves: the title and the header. */
  private nextMinute(live: AppStatus["live"], now: number): void {
    if (this.minute) clearTimeout(this.minute);
    this.minute = null;
    if (live?.startedAt == null) return;
    // clock: the tray's elapsed minute moves in real time.
    this.minute = setTimeout(() => {
      this.minute = null;
      void this.refresh();
    }, nextMinuteIn(live.startedAt, now) + 50);
    this.minute.unref?.();
  }

  /**
   * Applies `app.openAtLogin` when it changed since it was last applied: Settings, `akou config
   * set` and `PATCH /config` all save it, and the save asks for a refresh (DK-L2).
   */
  private async syncLogin(): Promise<void> {
    const on = this.app.config().settings["app.openAtLogin"] === true;
    if (this.loginOn === null || on === this.loginOn) return;
    this.loginOn = on;
    try {
      await this.o.setLoginItem(on);
    } catch (err) {
      this.o.onLog?.("warn", `login item: ${(err as Error).message}`);
    }
  }

  /**
   * The one quit path of the tray, the menu's Quit and `Cmd+Q` (DK-M3). During a recording it asks
   * first, with Cancel the default: a quit never stops a call by accident. Stop and quit stops the
   * call through the app's quit, so `part.ended` is in the log before the process exits.
   */
  private async quitApp(): Promise<void> {
    if (this.quitting) return;
    if (this.asking) {
      // The question is up, maybe behind the meeting: bring it forward.
      void this.app.openWindow().catch(() => {});
      return;
    }
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
    let live = true;
    try {
      live = !!((await this.app.status()) as { live?: unknown }).live;
    } catch (err) {
      // Unknown means ask: a quit must neither stop a call unasked nor do nothing.
      this.o.onLog?.("warn", `quit: the status could not be read: ${(err as Error).message}`);
    }
    if (!live) return true;
    return this.askQuit();
  }

  /** Opens (or brings forward) the window and asks there; true when the user chose to quit. */
  private askQuit(): Promise<boolean> {
    const id = ++this.questions;
    const answer = new Promise<boolean>((resolve) => {
      this.question = { id, resolve };
    });
    this.app.openWindow().then(
      () => {
        if (this.question?.id === id) this.toPage((send) => send.askQuit({ id, ...QUIT_QUESTION }));
      },
      (err) => {
        this.o.onLog?.("warn", `quit: the window did not open: ${(err as Error).message}`);
        this.answerQuit(id, false);
      },
    );
    return answer;
  }

  /** The page's answer to question `id`; a stale or unknown id is ignored. */
  private answerQuit(id: number, go: boolean): void {
    const q = this.question;
    if (!q || q.id !== id) return;
    this.question = null;
    q.resolve(go);
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
      openMain: async () => {
        await this.app.openWindow(await liveCall());
      },
      fit: (width) => {
        // This window's pill, while it is the one open.
        const ind = this.indicator;
        if (ind?.rpc !== rpc) return;
        const f = fitIndicator(ind.frame, width, this.ui.workAreas());
        if (sameRect(f, ind.frame)) return;
        ind.frame = f;
        ind.window.setFrame(f);
      },
    });
    const w = this.ui.openIndicator({ url: INDICATOR_URL, rpc, frame });
    send = w.send;
    const ind = { window: w.window, rpc, frame };
    this.indicator = ind;
    w.window.onFrame((f) => {
      if (hasArea(f)) ind.frame = f;
    });
    w.window.onClose(() => {
      if (this.indicator === ind) this.closeIndicator();
    });
    this.syncIndicator();
  }

  /**
   * The indicator shows, without taking the focus, only while the main window is closed or
   * minimized (DK-F1): an open window already says the same. The SDK has no minimize event, so
   * while both are open the shell asks the window every `MINIMIZED_POLL_MS`, and on each focus
   * change.
   */
  private syncIndicator(): void {
    const ind = this.indicator;
    const win = this.window;
    const watch = ind !== null && win?.isMinimized !== undefined;
    if (watch && !this.minimizedPoll) {
      // clock: the SDK sends no minimize event, so the window is asked in real time.
      this.minimizedPoll = setInterval(
        () => this.syncIndicator(),
        this.o.minimizedPollMs ?? MINIMIZED_POLL_MS,
      );
      this.minimizedPoll.unref?.();
    } else if (!watch) this.stopMinimizedPoll();
    if (!ind) return;
    const show = !win || this.minimized(win);
    if (ind.shown === show) return;
    ind.shown = show;
    if (show) ind.window.showInactive();
    else ind.window.hide();
  }

  private minimized(win: NativeWindow): boolean {
    try {
      return win.isMinimized?.() === true;
    } catch {
      // A window the SDK already let go of: its close event is on the way.
      return false;
    }
  }

  private stopMinimizedPoll(): void {
    if (this.minimizedPoll) clearInterval(this.minimizedPoll);
    this.minimizedPoll = null;
  }

  private closeIndicator(): void {
    this.indicatorGen++;
    const ind = this.indicator;
    if (!ind) return;
    this.indicator = null;
    this.stopMinimizedPoll();
    const store = this.o.state;
    try {
      if (store) store.save({ ...store.load(), indicator: ind.frame });
    } catch (err) {
      this.o.onLog?.("warn", `the indicator's place was not saved: ${(err as Error).message}`);
    }
    ind.rpc.close();
    ind.window.close();
  }

  /**
   * The pill exists while dictation runs and `dictation.pill` is not `off`, hidden between
   * sessions, so its page has booted before the first press; a changed edge opens it again there.
   * Then it is told the session's state. The setting is read at each change of the state, so a
   * change applies from the next session.
   */
  private syncPill(): void {
    const d = this.app.dictation;
    const edge = String(this.app.config().settings["dictation.pill"] ?? "top");
    const want =
      !!d && !!this.ui.openPill && !this.quitting && edge !== "off" && d.state() !== "off";
    if (this.pill && (!want || this.pill.edge !== edge)) this.closePill();
    if (want && d && !this.pill) {
      try {
        this.createPill(d, edge);
      } catch (err) {
        // The tray and the cues still carry the state; a session never fails for the pill.
        this.o.onLog?.("warn", `the dictation pill did not open: ${(err as Error).message}`);
      }
    }
    this.pill?.rpc.update();
  }

  private createPill(d: ShellDictation, edge: string): void {
    const open = this.ui.openPill;
    if (!open) return;
    const areas = this.ui.workAreas();
    const places = pillPlaces(this.o.state?.load() ?? {}, areas);
    // Where it was dragged last on this edge, until a key-down names the target's display.
    const last = places.filter((p) => p.edge === edge).at(-1);
    const frame = placePill(places, edge, areas, last?.area);
    let send: PillSend | null = null;
    let win: PillWindow | null = null;
    const drop = () => {};
    const rpc = pillRpc(d, () => send ?? { state: drop, level: drop, preview: drop, chip: drop }, {
      platform: this.o.platform,
      hotkey: () => d.hotkey(),
      label: hotkeyLabel,
      // clock: the default of the injected `now`; tests pass their own.
      now: () => this.o.now?.() ?? Date.now(),
      onVisible: (visible) => {
        if (visible) win?.showInactive();
        else win?.hide();
      },
      // The words as you speak are on by default (DC-O2); a screen share shows them until DK-P3.
      preview: { setting: () => this.app.config().settings["dictation.pillPreview"] },
      grant: () => this.app.openSettingsPane("accessibility"),
      place: (target) => this.placePillOn(target),
      edge,
      resize: (height) => this.sizePillTo(height),
    });
    let w: ReturnType<typeof open>;
    try {
      w = open.call(this.ui, { url: PILL_URL, rpc, frame, style: pillStyle(this.o.platform) });
    } catch (err) {
      rpc.close();
      throw err;
    }
    send = w.send;
    win = w.window;
    const p = {
      window: w.window,
      rpc,
      edge,
      frame,
      area: areaOf(frame, areas),
      places,
      moved: false,
      placed: null as Rect | null,
      height: null as number | null,
    };
    this.pill = p;
    w.window.onFrame((f) => {
      if (!hasArea(f)) return;
      p.frame = f;
      // The shell's own move, reported back: not a place the user chose.
      if (p.placed && near(f, p.placed)) return;
      p.placed = null;
      const now = this.ui.workAreas();
      p.area = areaOf(f, now);
      // A place is kept at `PILL_SIZE`, whatever height the window had when it was dragged.
      p.places = rememberPill(p.places, p.edge, pillBase(f, p.edge), now);
      p.moved = true;
    });
    w.window.onClose(() => {
      if (this.pill === p) this.closePill();
    });
  }

  /**
   * The pill goes to the display of the window the text goes to (DC-O1), to its place there, before
   * it shows. A frame on the display it is on already, or none (the helper could not tell), leaves
   * it where it is.
   */
  private placePillOn(target: Rect | null): void {
    const p = this.pill;
    if (!p || !target) return;
    const areas = this.ui.workAreas();
    const area = areaOf(target, areas);
    if (!area || (p.area && sameRect(p.area, area))) return;
    const base = placePill(p.places, p.edge, areas, area);
    const next = p.height === null ? base : sizePill(base, p.edge, p.height, area);
    p.area = area;
    this.movePill(p, next);
  }

  /**
   * The page needs `height` (H-11): the window grows or shrinks to it from its edge, where it is
   * now, and within its display.
   */
  private sizePillTo(height: number): void {
    const p = this.pill;
    if (!p || p.height === height) return;
    p.height = height;
    const next = sizePill(pillBase(p.frame, p.edge), p.edge, height, p.area);
    if (sameRect(next, p.frame)) return;
    this.movePill(p, next);
  }

  /** The shell's own move or resize of the pill: the frame it reports back is not a drag. */
  private movePill(p: OpenPill, next: Rect): void {
    p.frame = next;
    p.placed = next;
    try {
      p.window.setFrame(next);
    } catch (err) {
      this.o.onLog?.("warn", `the pill did not move: ${(err as Error).message}`);
    }
  }

  private closePill(): void {
    const p = this.pill;
    if (!p) return;
    this.pill = null;
    const store = this.o.state;
    try {
      if (store && p.moved) {
        // The single place of before is folded into the per-display places, never written again.
        const { pill: _p, pillEdge: _e, ...rest } = store.load();
        store.save({ ...rest, pillPlaces: p.places });
      }
    } catch (err) {
      this.o.onLog?.("warn", `the pill's place was not saved: ${(err as Error).message}`);
    }
    p.rpc.close();
    p.window.close();
  }

  /**
   * The draft box exists while dictation runs, hidden between drafts, so its page has booted
   * before the first draft is sent to it; `DraftBox` decides when it shows.
   */
  private syncDraft(): void {
    const d = this.app.dictation;
    const box = d?.draft?.() ?? null;
    const want = !!box && !!this.ui.openDraft && !this.quitting && d?.state() !== "off";
    if (this.draft && !want) this.closeDraft();
    if (!want || this.draft || !box) return;
    const open = this.ui.openDraft;
    if (!open) return;
    try {
      const w = open.call(this.ui, {
        url: DRAFT_URL,
        handlers: box.handlers,
        frame: placeDraft(this.ui.workAreas()),
      });
      const win = w.window;
      box.attach({
        open: (o) => {
          w.send.open(o);
          if (o.focus) win.show();
          else win.showInactive();
        },
        chip: (c) => w.send.chip(c),
        append: (text) => w.send.append(text),
        showInactive: () => win.showInactive(),
        hide: () => win.hide(),
      });
      const entry = { window: win, detach: () => box.attach(null) };
      this.draft = entry;
      win.onClose(() => {
        if (this.draft === entry) {
          this.draft = null;
          entry.detach();
        }
      });
    } catch (err) {
      // A draft that cannot open fails its dictation as before; nothing else depends on it.
      this.o.onLog?.("warn", `the draft box did not open: ${(err as Error).message}`);
    }
  }

  private closeDraft(): void {
    const d = this.draft;
    if (!d) return;
    this.draft = null;
    d.detach();
    d.window.close();
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
    if (this.question) this.answerQuit(this.question.id, false);
    if (this.window) this.saveFrame();
    this.closeIndicator();
    this.closePill();
    this.closeDraft();
    this.unwatch();
    this.rpc?.close();
    this.window?.close();
    this.window = null;
    if (this.hotkey) this.ui.unregisterShortcut(this.hotkey);
    if (this.minute) clearTimeout(this.minute);
    this.minute = null;
    this.tray?.remove();
    this.tray = null;
    this.recordingMark = false;
    this.trayShown = { title: "", menu: "" };
  }
}
