/**
 * ElectroBun 2.0.1 behind `NativeUi` (`shell.ts`): the one module that imports the SDK's main
 * process API. It is loaded only by the app's ElectroBun entry (`main.ts`), never by a test and
 * never by the headless app, because the SDK exists only inside a Hutch build.
 */

import Electrobun, {
  BrowserView,
  BrowserWindow,
  GlobalShortcut,
  Tray,
  Utils,
} from "electrobun/main";
import type { AkouRpc } from "../../ui/protocol.ts";
import type { NativeTray, NativeUi, NativeWindow, TrayMenuItem } from "./shell.ts";

/** A streamed answer or a long follow can outlive the SDK's default request timeout. */
const MAX_REQUEST_MS = 600_000;

export function electrobunUi(): NativeUi {
  return {
    openWindow({ title, url, rpc }) {
      const defined = BrowserView.defineRPC<AkouRpc>({
        maxRequestTime: MAX_REQUEST_MS,
        handlers: { requests: rpc.handlers, messages: {} },
      });
      const win = new BrowserWindow({
        title,
        url,
        rpc: defined,
        frame: { width: 1280, height: 820 },
      });
      const window: NativeWindow = {
        show: () => {
          win.show();
          win.focus();
        },
        close: () => win.close(),
        onClose: (fn) => win.on("close", fn),
      };
      return {
        window,
        send: {
          followed: (m) => defined.send.followed(m),
          asked: (m) => defined.send.asked(m),
          status: (s) => defined.send.status(s),
          showCall: (m) => defined.send.showCall(m),
        },
      };
    },

    createTray({ title }): NativeTray {
      const tray = new Tray({ title, template: true, width: 16, height: 16 });
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
  };
}
