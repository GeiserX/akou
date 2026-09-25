/**
 * Test support for the desktop shell: a fake `NativeUi` that records what the shell asks of
 * ElectroBun (the tray and its image, the application menu, notifications, the window and its
 * focus), and a shell over a whole app from `appRig`. Nothing here opens a window.
 */

import { Bridge } from "../src/main/window/bridge.ts";
import type { IndicatorRpcHandlers } from "../src/main/window/indicator.ts";
import type { WindowRpc } from "../src/main/window/rpc.ts";
import {
  type AppMenuItem,
  appForShell,
  type NativeUi,
  type Rect,
  Shell,
  type ShellOptions,
} from "../src/main/window/shell.ts";
import type { QuitQuestion } from "../src/ui/protocol.ts";
import type { AppRig } from "./api-helpers.ts";

export interface FakeUi {
  ui: NativeUi;
  log: string[];
  shortcuts: Map<string, () => void>;
  /** What `createTray` was given, once per call. */
  trays: { title: string; image?: string; template?: boolean }[];
  /** Every notification shown, in order. */
  notices: { title: string; body: string }[];
  /** The application menu, or null when none was set. */
  appMenu: () => AppMenuItem[] | null;
  /** Clicks an application menu item by its action. */
  menu: (action: string) => void;
  trayMenu: () => unknown[];
  title: () => string;
  tray: (action: string) => void;
  /** The window gains (true) or loses (false) focus. */
  focus: (focused: boolean) => void;
  /** The page finishes loading and pulls the status, as `src/ui/app.ts` does at boot. */
  boot: () => Promise<unknown>;
  quitRequested: () => boolean;
  /** Clicks the Dock icon (`reopen`). */
  reopen: () => void;
  /** Every quit question the booted page was shown, in order (DK-M3). */
  questions: QuitQuestion[];
  /** How the page answers a question: true quits, false is Cancel (the default), undefined leaves it up. */
  answer: (q: QuitQuestion) => boolean | undefined;
  /** The page answers the last question shown, or question `id`. */
  answerQuit: (go: boolean, id?: number) => Promise<unknown>;
  /** Runs when the shell asks the process to exit, before `quit` is logged. */
  onQuit: () => void;
  /** Every frame a window was opened at, in order. */
  frames: (Rect | undefined)[];
  /** The OS moved or resized the window. */
  moveWindow: (r: Rect) => void;
  /** The user closed the window (its close button). */
  closeWindow: () => void;
  /** The displays' work areas, the primary first. */
  areas: Rect[];
  /** The floating indicator: what it was opened with and whether it shows; null before the first. */
  indicator: () => {
    frame: Rect;
    rpc: IndicatorRpcHandlers;
    visible: boolean;
    closed: boolean;
    opened: number;
  } | null;
  /** The user dragged the indicator. */
  moveIndicator: (r: Rect) => void;
  /** What the shell pushed to the indicator page. */
  indicatorPushes: unknown[];
}

/**
 * `focusOnShow: false` is a window the OS shows without focusing (another app is active), so no
 * focus event follows `show`. Messages sent to a page before it booted are lost, as ElectroBun's
 * are when the page has not registered its handlers yet.
 */
export function fakeUi(opts: { focusOnShow?: boolean } = {}): FakeUi {
  const focusOnShow = opts.focusOnShow ?? true;
  let reopenFn: () => void = () => {};
  let frameFn: (r: Rect) => void = () => {};
  let closeFn: () => void = () => {};
  let ind: ReturnType<FakeUi["indicator"]> = null;
  let indFrame: (r: Rect) => void = () => {};
  const log: string[] = [];
  let action: (a: string) => void = () => {};
  let beforeQuit: (e: { cancel(): void }) => void = () => {};
  let menuAction: (a: string) => void = () => {};
  let focusFn: (focused: boolean) => void = () => {};
  let rpc: WindowRpc | null = null;
  let booted = false;
  let trayItems: unknown[] = [];
  let title = "";
  let appMenu: AppMenuItem[] | null = null;
  const shortcuts = new Map<string, () => void>();
  const trays: FakeUi["trays"] = [];
  const notices: FakeUi["notices"] = [];
  const ui: NativeUi = {
    openWindow: (o) => {
      log.push(`window ${o.url}`);
      f.frames.push(o.frame);
      rpc = o.rpc;
      booted = false;
      const page = (line: string) => {
        if (booted) log.push(line);
      };
      return {
        window: {
          show: () => {
            log.push("show");
            if (focusOnShow) focusFn(true);
          },
          close: () => log.push("close"),
          onClose: (fn) => {
            closeFn = fn;
          },
          onFrame: (fn) => {
            frameFn = fn;
          },
          onFocus: (fn) => {
            focusFn = fn;
          },
        },
        send: {
          followed: () => {},
          asked: () => {},
          status: () => {},
          showCall: (m) => page(`call ${m.call}`),
          showSettings: () => page("settings"),
          focusAsk: () => page("ask"),
          askQuit: (q) => {
            if (!booted) return;
            f.questions.push(q);
            const go = f.answer(q);
            if (go !== undefined) void rpc?.handlers.answerQuit({ id: q.id, go });
          },
        },
      };
    },
    createTray: (o) => {
      trays.push({ ...o });
      return {
        setMenu: (m) => {
          trayItems = m;
        },
        setTitle: (t) => {
          title = t;
        },
        onAction: (fn) => {
          action = fn;
        },
        remove: () => log.push("tray removed"),
      };
    },
    setApplicationMenu: (items, onAction) => {
      appMenu = items;
      menuAction = onAction;
    },
    showNotification: (n) => {
      notices.push({ title: n.title, body: n.body });
    },
    registerShortcut: (a, fn) => {
      shortcuts.set(a, fn);
      return true;
    },
    unregisterShortcut: (a) => shortcuts.delete(a),
    onBeforeQuit: (fn) => {
      beforeQuit = fn;
    },
    quit: () => {
      f.onQuit();
      log.push("quit");
    },
    onReopen: (fn) => {
      reopenFn = fn;
    },
    workAreas: () => f.areas,
    openIndicator: (o) => {
      log.push("indicator open");
      const opened = (ind?.opened ?? 0) + 1;
      const me = { frame: o.frame, rpc: o.rpc, visible: false, closed: false, opened };
      ind = me;
      return {
        window: {
          showInactive: () => {
            me.visible = true;
          },
          hide: () => {
            me.visible = false;
          },
          close: () => {
            me.visible = false;
            me.closed = true;
            log.push("indicator close");
          },
          onClose: () => {},
          onFrame: (fn) => {
            indFrame = fn;
          },
        },
        send: {
          followed: (m) => f.indicatorPushes.push(m),
          status: (m) => f.indicatorPushes.push(m),
        },
      };
    },
    openExternal: (url) => {
      log.push(`open ${url}`);
      return true;
    },
  };
  const f: FakeUi = {
    ui,
    log,
    shortcuts,
    trays,
    notices,
    appMenu: () => appMenu,
    menu: (a) => menuAction(a),
    trayMenu: () => trayItems,
    title: () => title,
    tray: (a) => action(a),
    focus: (f) => focusFn(f),
    boot: async () => {
      booted = true;
      return rpc?.handlers.status({});
    },
    quitRequested: () => {
      let cancelled = false;
      beforeQuit({ cancel: () => (cancelled = true) });
      return cancelled;
    },
    reopen: () => reopenFn(),
    questions: [],
    answer: () => false,
    answerQuit: async (go, id) => {
      const q = f.questions.at(-1);
      if (!q || !rpc) throw new Error("no question is up");
      return rpc.handlers.answerQuit({ id: id ?? q.id, go });
    },
    onQuit: () => {},
    frames: [],
    moveWindow: (r) => {
      frameFn(r);
    },
    closeWindow: () => {
      log.push("closed by the user");
      closeFn();
    },
    areas: [{ x: 0, y: 0, width: 1440, height: 875 }],
    indicator: () => ind,
    moveIndicator: (r) => {
      indFrame(r);
    },
    indicatorPushes: [],
  };
  return f;
}

/** The real shell over a whole app, with the fake `NativeUi`. */
export async function shellOn(
  rig: AppRig,
  o: Partial<ShellOptions> = {},
): Promise<{ shell: Shell; f: FakeUi; bridge: Bridge }> {
  const f = fakeUi();
  const bridge = new Bridge(rig.app);
  const shell = new Shell(appForShell(rig.app), bridge, f.ui, {
    platform: "darwin",
    setLoginItem: async () => {},
    ...o,
  });
  // `openWindow` goes through the app, as the ElectroBun entry wires it.
  rig.app.window = shell;
  await shell.start();
  return { shell, f, bridge };
}
