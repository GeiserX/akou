/**
 * The desktop shell with real pages (docs/ux/DESKTOP.md DK-F1): the real app, the real `Shell`,
 * and a `NativeUi` whose windows are headless Chromium pages running the ElectroBun entries
 * (`window.ts`, `indicator-window.ts`) over `electroview-shim.ts`. A click in the indicator goes
 * through its RPC to the shell, and from the shell to the main window's page, as in the app.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { Bridge } from "../../src/main/window/bridge.ts";
import type { IndicatorRpcHandlers } from "../../src/main/window/indicator.ts";
import type { WindowRpc } from "../../src/main/window/rpc.ts";
import {
  appForShell,
  INDICATOR_URL,
  type IndicatorWindow,
  type NativeUi,
  type NativeWindow,
  type Rect,
  Shell,
  WINDOW_URL,
} from "../../src/main/window/shell.ts";
import { type AppRig, appRig, type RigOptions } from "../api-helpers.ts";
import { launch } from "./rig.ts";

const UI = join(import.meta.dir, "..", "..", "src", "ui");
const ORIGIN = "http://akou.test";

/** An ElectroBun entry built for the browser, with the shim in place of `electrobun/view`. */
async function buildEntry(entry: string): Promise<string> {
  const shim = join(import.meta.dir, "electroview-shim.ts");
  const r = await Bun.build({
    entrypoints: [join(UI, entry)],
    target: "browser",
    format: "esm",
    plugins: [
      {
        name: "electroview-shim",
        setup(b) {
          b.onResolve({ filter: /^electrobun\/view$/ }, () => ({ path: shim }));
        },
      },
    ],
  });
  if (!r.success || !r.outputs[0]) throw new Error(`build ${entry}: ${r.logs.join("; ")}`);
  return r.outputs[0].text();
}

/** The files a view folder holds, as ElectroBun lays them out (`electrobun.config.ts`). */
async function views(): Promise<Record<string, Record<string, string>>> {
  const read = (f: string) => readFileSync(join(UI, f), "utf8");
  return {
    main: {
      "index.html": read("index.html"),
      "theme.css": read("theme.css"),
      "index.js": await buildEntry("window.ts"),
    },
    indicator: {
      "index.html": read("indicator.html"),
      "indicator.css": read("indicator.css"),
      "index.js": await buildEntry("indicator-window.ts"),
    },
  };
}

const TYPES: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css" };

export interface DesktopRig extends AppRig {
  shell: Shell;
  /** The main window's page, once the shell opened one. */
  main(): Page | null;
  /** The indicator's page, while one is open. */
  indicator(): Page | null;
  /** Whether the shell has the indicator shown (`showInactive`) or hidden. */
  indicatorShown(): boolean;
  /** Pages the rig opened, in order, for the console. */
  pages: Page[];
  /** Cmd+Q: runs the shell's before-quit; true when the shell cancelled it to ask or clean up. */
  quitRequested(): boolean;
  /** How many times the shell asked the process to exit. */
  exits(): number;
}

export async function desktopRig(o: RigOptions = {}): Promise<DesktopRig> {
  const rig = (await appRig(o)) as DesktopRig;
  const browser = await launch();
  const files = await views();
  const pages: Page[] = [];
  let main: Page | null = null;
  let indicator: Page | null = null;
  let shown = false;
  let beforeQuit: (e: { cancel(): void }) => void = () => {};
  let exits = 0;

  /** A page on a view, with `handlers` answering its requests; `send` pushes a message. */
  const open = (view: "main" | "indicator", handlers: object) => {
    const ready = (async () => {
      const page = await browser.newPage();
      pages.push(page);
      page.on("pageerror", (err) => console.error(`${view} page error: ${err.message}`));
      await page.route(`${ORIGIN}/**`, (route) => {
        const name = new URL(route.request().url()).pathname.slice(1) || "index.html";
        const body = files[view]?.[name];
        if (body === undefined) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({
          status: 200,
          contentType: TYPES[name.split(".").pop() as string],
          body,
        });
      });
      await page.exposeFunction("__akouRequest", (name: string, params: unknown) =>
        (handlers as Record<string, (p: unknown) => unknown>)[name]?.(params),
      );
      await page.goto(`${ORIGIN}/index.html`);
      return page;
    })();
    const send = (name: string) => (payload: unknown) =>
      void ready.then((p) =>
        p.isClosed()
          ? undefined
          : p
              .evaluate(([n, m]) => window.__akouMessage?.(n as string, m), [name, payload])
              .catch(() => {}),
      );
    return { ready, send };
  };

  const ui: NativeUi = {
    openWindow: (w: { url: string; rpc: WindowRpc; frame?: Rect }) => {
      if (w.url !== WINDOW_URL) throw new Error(`unknown window ${w.url}`);
      const p = open("main", w.rpc.handlers);
      void p.ready.then((page) => {
        main = page;
      });
      let focusFn: (f: boolean) => void = () => {};
      const window: NativeWindow = {
        show: () => {
          void p.ready.then((page) => page.bringToFront());
          focusFn(true);
        },
        close: () => void p.ready.then((page) => page.close()),
        onClose: () => {},
        onFocus: (fn) => {
          focusFn = fn;
        },
        onFrame: () => {},
      };
      const s = p.send;
      return {
        window,
        send: {
          followed: s("followed"),
          asked: s("asked"),
          status: s("status"),
          showCall: s("showCall"),
          showSettings: s("showSettings"),
          askQuit: s("askQuit"),
        },
      };
    },
    openIndicator: (w: { url: string; rpc: IndicatorRpcHandlers; frame: Rect }) => {
      if (w.url !== INDICATOR_URL) throw new Error(`unknown window ${w.url}`);
      const p = open("indicator", w.rpc.handlers);
      void p.ready.then((page) => {
        indicator = page;
      });
      const window: IndicatorWindow = {
        showInactive: () => {
          shown = true;
        },
        hide: () => {
          shown = false;
        },
        close: () => {
          shown = false;
          void p.ready.then((page) => {
            if (indicator === page) indicator = null;
            return page.close();
          });
        },
        onClose: () => {},
        onFrame: () => {},
      };
      return { window, send: { followed: p.send("followed"), status: p.send("status") } };
    },
    createTray: () => ({
      setMenu: () => {},
      setTitle: () => {},
      onAction: () => {},
      remove: () => {},
    }),
    setApplicationMenu: () => {},
    showNotification: () => {},
    registerShortcut: () => true,
    unregisterShortcut: () => {},
    onBeforeQuit: (fn) => {
      beforeQuit = fn;
    },
    quit: () => {
      exits++;
    },
    openExternal: () => true,
    onReopen: () => {},
    workAreas: () => [{ x: 0, y: 0, width: 1440, height: 875 }],
  };

  const shell = new Shell(appForShell(rig.app), new Bridge(rig.app), ui, {
    platform: "darwin",
    setLoginItem: async () => {},
  });
  rig.app.window = shell;
  await shell.start();
  rig.shell = shell;
  rig.main = () => main;
  rig.indicator = () => indicator;
  rig.indicatorShown = () => shown;
  rig.pages = pages;
  rig.exits = () => exits;
  rig.quitRequested = () => {
    let cancelled = false;
    beforeQuit({ cancel: () => (cancelled = true) });
    return cancelled;
  };
  const close = rig.close;
  rig.close = async () => {
    await shell.close();
    for (const p of pages) await p.close().catch(() => {});
    await close();
  };
  return rig;
}
