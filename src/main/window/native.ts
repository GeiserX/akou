/**
 * ElectroBun 2.0.1 behind `NativeUi` (`shell.ts`): the one module that imports the SDK's main
 * process API. It is loaded only by the app's ElectroBun entry (`main.ts`), never by a test and
 * never by the headless app, because the SDK exists only inside a Hutch build.
 */

import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  GlobalShortcut,
  Screen,
  Tray,
  Utils,
} from "electrobun/main";
import type { IndicatorRpc } from "../../ui/indicator-protocol.ts";
import type { AkouRpc } from "../../ui/protocol.ts";
import type { NativeTray, NativeUi, NativeWindow, TrayMenuItem } from "./shell.ts";

/** A streamed answer or a long follow can outlive the SDK's default request timeout. */
const MAX_REQUEST_MS = 600_000;

export function electrobunUi(): NativeUi {
  return {
    openWindow({ title, url, rpc, frame }) {
      const defined = BrowserView.defineRPC<AkouRpc>({
        maxRequestTime: MAX_REQUEST_MS,
        handlers: { requests: rpc.handlers, messages: {} },
      });
      const win = new BrowserWindow({
        title,
        url,
        rpc: defined,
        frame: frame ?? { width: 1280, height: 820 },
      });
      const window: NativeWindow = {
        show: () => {
          win.show();
          win.focus();
        },
        close: () => win.close(),
        onClose: (fn) => win.on("close", fn),
        onFocus: (fn) => {
          win.on("focus", () => fn(true));
          win.on("blur", () => fn(false));
        },
        frame: () => win.getFrame(),
        onFrame: (fn) => {
          win.on("move", () => fn(win.getFrame()));
          win.on("resize", () => fn(win.getFrame()));
        },
      };
      return {
        window,
        send: {
          followed: (m) => defined.send.followed(m),
          asked: (m) => defined.send.asked(m),
          status: (s) => defined.send.status(s),
          showCall: (m) => defined.send.showCall(m),
          showSettings: (m) => defined.send.showSettings(m),
          focusAsk: (m) => defined.send.focusAsk(m),
        },
      };
    },

    openIndicator({ url, rpc, frame }) {
      const defined = BrowserView.defineRPC<IndicatorRpc>({
        maxRequestTime: MAX_REQUEST_MS,
        handlers: { requests: rpc.handlers, messages: {} },
      });
      // Hidden until the shell shows it, and never activated: it must not take the focus from
      // the meeting app.
      const win = new BrowserWindow({
        title: "akou",
        url,
        rpc: defined,
        frame,
        titleBarStyle: "hidden",
        hidden: true,
        activate: false,
      });
      win.setAlwaysOnTop(true);
      win.setVisibleOnAllWorkspaces(true);
      return {
        window: {
          showInactive: () => win.showInactive(),
          hide: () => win.hide(),
          close: () => win.close(),
          onClose: (fn) => win.on("close", fn),
          frame: () => win.getFrame(),
          onFrame: (fn) => win.on("move", () => fn(win.getFrame())),
        },
        send: {
          followed: (m) => defined.send.followed(m),
          status: (s) => defined.send.status(s),
        },
      };
    },

    createTray({ title, image, template }): NativeTray {
      const tray = new Tray({ title, image, template, width: 16, height: 16 });
      return {
        setMenu: (items: TrayMenuItem[]) => tray.setMenu(items),
        setTitle: (t) => tray.setTitle(t),
        onAction: (fn) =>
          tray.on("tray-clicked", (e) => {
            const action = (e as { data?: { action?: string } }).data?.action;
            if (action) fn(action);
          }),
        remove: () => tray.remove(),
      };
    },

    setApplicationMenu(items, onAction) {
      ApplicationMenu.setApplicationMenu(items);
      ApplicationMenu.on("application-menu-clicked", (e) => {
        const action = (e as { data?: { action?: string } }).data?.action;
        if (action) onAction(action);
      });
    },

    showNotification: ({ title, body }) => Utils.showNotification({ title, body }),

    registerShortcut: (accelerator, fn) => GlobalShortcut.register(accelerator, fn),
    unregisterShortcut: (accelerator) => GlobalShortcut.unregister(accelerator),

    onBeforeQuit(fn) {
      Electrobun.events.on("before-quit", (e) => {
        fn({
          cancel: () => {
            e.response = { allow: false };
          },
        });
      });
    },

    quit: () => Utils.quit(0),
    openExternal: (url) => Utils.openExternal(url),

    onReopen: (fn) => Electrobun.events.on("reopen", () => fn()),

    showMessageBox: async (o) => (await Utils.showMessageBox(o)).response,

    workAreas: () => {
      const all = Screen.getAllDisplays();
      return [...all.filter((d) => d.isPrimary), ...all.filter((d) => !d.isPrimary)].map(
        (d) => d.workArea,
      );
    },
  };
}
