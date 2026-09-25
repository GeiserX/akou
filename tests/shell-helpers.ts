/**
 * Test support for the desktop shell: a fake `NativeUi` that records what the shell asks of
 * ElectroBun (the tray and its image, the application menu, notifications, the window and its
 * focus), and a shell over a whole app from `appRig`. Nothing here opens a window.
 */

import { Bridge } from "../src/main/window/bridge.ts";
import {
  type AppMenuItem,
  appForShell,
  type NativeUi,
  Shell,
  type ShellOptions,
} from "../src/main/window/shell.ts";
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
  quitRequested: () => boolean;
}

export function fakeUi(): FakeUi {
  const log: string[] = [];
  let action: (a: string) => void = () => {};
  let beforeQuit: (e: { cancel(): void }) => void = () => {};
  let menuAction: (a: string) => void = () => {};
  let focusFn: (focused: boolean) => void = () => {};
  let trayItems: unknown[] = [];
  let title = "";
  let appMenu: AppMenuItem[] | null = null;
  const shortcuts = new Map<string, () => void>();
  const trays: FakeUi["trays"] = [];
  const notices: FakeUi["notices"] = [];
  const ui: NativeUi = {
    openWindow: (o) => {
      log.push(`window ${o.url}`);
      return {
        window: {
          show: () => {
            log.push("show");
            focusFn(true);
          },
          close: () => log.push("close"),
          onClose: () => {},
          onFocus: (fn) => {
            focusFn = fn;
          },
        },
        send: {
          followed: () => {},
          asked: () => {},
          status: () => {},
          showCall: (m) => log.push(`call ${m.call}`),
          showSettings: () => log.push("settings"),
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
    quit: () => log.push("quit"),
    openExternal: (url) => {
      log.push(`open ${url}`);
      return true;
    },
  };
  return {
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
    quitRequested: () => {
      let cancelled = false;
      beforeQuit({ cancel: () => (cancelled = true) });
      return cancelled;
    },
  };
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
