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
 *   The files are drawn by `scripts/tray-icons.ts`.
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
  config(): { settings: Record<string, unknown> };
  saveSetting(key: "app.openAtLogin", value: boolean): Promise<void>;
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
    config: () => app.config(),
    saveSetting: async (key, value) => {
      await app.saveConfig({ ...app.config().file, [key]: value });
    },
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
}

/** The quit question (DK-M3), asked in the window; Cancel is the default. */
export const QUIT_QUESTION: Omit<QuitQuestion, "id"> = {
  message: "A call is recording. Stop it and quit?",
  detail: "Everything recorded so far is kept.",
  confirm: "Stop and quit",
};

/** The window's size the first time it opens. */
export const DEFAULT_WINDOW = { width: 1280, height: 820 } as const;
/** No window is restored smaller than this. */
const MIN_WINDOW = { width: 480, height: 360 } as const;
/** The floating indicator's size: one row, never resized. */
export const INDICATOR_SIZE = { width: 480, height: 40 } as const;
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
 * a call records, the mark's dot is red; a template image cannot hold a colour, so on macOS that
 * one is a plain image.
 */
export function trayImage(
  platform: string,
  recording = false,
  dir = TRAY_DIR,
): { image: string; template: boolean } {
  if (platform === "darwin") {
    return recording
      ? { image: join(dir, "akou-recording-macos.png"), template: false }
      : { image: join(dir, "akou-template.png"), template: true };
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
function dictationItem(state: string | undefined): TrayMenuItem[] {
  switch (state) {
    case undefined:
    case "off":
      return [];
    case "idle":
      return [{ type: "normal", label: "Start dictation", action: "dictate" }];
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

/** The tray's menu for the app's state. */
export function trayMenu(o: {
  live: boolean;
  openAtLogin: boolean;
  /** The dictation session's state; absent or `off` without dictation. */
  dictation?: string;
}): TrayMenuItem[] {
  return [
    o.live
      ? { type: "normal", label: "■ Stop recording", action: "stop" }
      : { type: "normal", label: "● Record", action: "record" },
    ...dictationItem(o.dictation),
    { type: "normal", label: "Show akou", action: "show" },
    { type: "separator" },
    { type: "normal", label: "Open at login", action: "login", checked: o.openAtLogin },
    { type: "separator" },
    { type: "normal", label: "Quit akou", action: "quit" },
  ];
}

/**
 * The tray's title: what a glance at the menu bar needs beside the image. A recording call has
 * none, since the mark's red dot says it. A dictation shows while it listens or transcribes,
 * whatever the pill setting (DC-O4), since it lasts seconds and a call's state is back right after.
 */
export function trayTitle(s: Pick<AppStatus, "live" | "share">, dictation?: string): string {
  if (dictation === "listening") return "● dictating";
  if (dictation === "transcribing" || dictation === "inserting") return "… transcribing";
  if (s.share?.active) return "● shared";
  return s.live?.state === "paused" ? "❚❚" : "";
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
  } | null = null;
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
        (id, go) => this.answerQuit(id, go),
        () => this.window?.zoom(),
      );
      const frame = placeFrame(this.o.state?.load().window, this.ui.workAreas());
      // The title is never drawn on macOS, but the Window menu, Mission Control and VoiceOver read it.
      const w = this.ui.openWindow({
        title: "akou",
        url: WINDOW_URL,
        rpc: this.rpc,
        frame,
        titleBarStyle: titleBarStyle(this.o.platform),
      });
      this.frame = frame;
      this.window = w.window;
      this.send = w.send;
      this.pageReady = false;
      this.pending = [];
      w.window.onFrame((f) => {
        if (hasArea(f)) this.frame = f;
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
        // A window closed with the question up answers Cancel.
        if (this.question) this.answerQuit(this.question.id, false);
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
    const dictation = this.app.dictation?.state();
    this.tray?.setTitle(trayTitle(s, dictation));
    const recording = trayRecording(s);
    if (recording !== this.recordingMark) {
      this.recordingMark = recording;
      this.tray?.setImage(trayImage(this.o.platform, recording));
    }
    this.tray?.setMenu(
      trayMenu({
        live: this.live,
        openAtLogin: this.app.config().settings["app.openAtLogin"] === true,
        dictation,
      }),
    );
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
    this.tray?.remove();
    this.tray = null;
    this.recordingMark = false;
  }
}
