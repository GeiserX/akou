/**
 * ElectroBun 2.0.1 behind `NativeUi` (`shell.ts`): the one module that imports the SDK's main
 * process API. It is loaded only by the app's ElectroBun entry (`main.ts`), never by a test and
 * never by the headless app, because the SDK exists only inside a Hutch build.
 */

import { dlopen, FFIType, type Pointer } from "bun:ffi";
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
import type { PillRpc } from "../../ui/pill-protocol.ts";
import type { AkouRpc } from "../../ui/protocol.ts";
import type { NativeTray, NativeUi, NativeWindow, TrayMenuItem } from "./shell.ts";

/** A streamed answer or a long follow can outlive the SDK's default request timeout. */
const MAX_REQUEST_MS = 600_000;

/** `GetWindowLongPtrW`'s index of the extended style, and the style that refuses activation. */
const GWL_EXSTYLE = -20;
const WS_EX_NOACTIVATE = 0x08000000n;

/**
 * Sets `WS_EX_NOACTIVATE` on a window (DC-O1, Windows): a click on it then never takes the
 * keyboard from the app in front. The SDK has no option for it, so through user32 directly.
 */
function noActivate(hwnd: Pointer | null): void {
  if (!hwnd) throw new Error("the pill's window has no handle");
  const user32 = dlopen("user32.dll", {
    GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
    SetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
  });
  try {
    const style = BigInt(user32.symbols.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    user32.symbols.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE);
  } finally {
    user32.close();
  }
}

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
          askQuit: (m) => defined.send.askQuit(m),
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
          onFrame: (fn) => win.on("move", () => fn(win.getFrame())),
        },
        send: {
          followed: (m) => defined.send.followed(m),
          status: (s) => defined.send.status(s),
        },
      };
    },

    openPill({ url, rpc, frame, style }) {
      const defined = BrowserView.defineRPC<PillRpc>({
        maxRequestTime: MAX_REQUEST_MS,
        handlers: { requests: rpc.handlers, messages: {} },
      });
      // Hidden until a session, never activated, and on macOS a non-activating panel, so neither
      // showing it nor clicking Stop takes the keyboard from the app the text goes to.
      const win = new BrowserWindow({
        title: "akou dictation",
        url,
        rpc: defined,
        frame,
        titleBarStyle: "hidden",
        // Only the card is painted (pill.css): the rest of the window, kept for the chip, shows
        // what is behind it.
        transparent: true,
        hidden: true,
        activate: false,
        ...(style.styleMask ? { styleMask: { ...style.styleMask, Resizable: false } } : {}),
      });
      if (style.noActivate) {
        try {
          noActivate(win.ptr);
        } catch (err) {
          // A pill that a click activates would take the keyboard from the target: none at all.
          win.close();
          throw err;
        }
      }
      win.setAlwaysOnTop(true);
      win.setVisibleOnAllWorkspaces(true);
      return {
        window: {
          showInactive: () => win.showInactive(),
          hide: () => win.hide(),
          close: () => win.close(),
          onClose: (fn) => win.on("close", fn),
          onFrame: (fn) => win.on("move", () => fn(win.getFrame())),
        },
        send: {
          state: (s) => defined.send.state(s),
          level: (l) => defined.send.level(l),
          preview: (p) => defined.send.preview(p),
          chip: (c) => defined.send.chip(c),
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

    workAreas: () => {
      const all = Screen.getAllDisplays();
      return [...all.filter((d) => d.isPrimary), ...all.filter((d) => !d.isPrimary)].map(
        (d) => d.workArea,
      );
    },
  };
}
