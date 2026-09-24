/**
 * The app's entry inside ElectroBun (`build.bun.entrypoint` in `electrobun.config.ts`): the same
 * app as `src/main/index.ts`, plus the desktop shell (window, tray, hotkey, login item).
 *
 * - Started normally, it opens the window. Started by the login item (`AKOU_HEADLESS=1`), it has
 *   the tray and the hotkey and no window until one is asked for.
 * - A second launch finds the first through the single-instance lock, asks it to show its window
 *   over the local API (`POST /v1/window`, with the token file), and exits.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOKEN_FILE } from "../api/guard.ts";
import { BUNDLE_ID } from "../app-info.ts";
import { loadConfig } from "../config/schema.ts";
import { type AkouApp, AlreadyRunningError, startApp } from "../index.ts";
import { Bridge } from "./bridge.ts";
import { setLoginItem } from "./login-item.ts";
import { electrobunUi } from "./native.ts";
import { Shell, type ShellApp } from "./shell.ts";

function shellApp(app: AkouApp): ShellApp {
  return {
    status: () => app.status(),
    start: async (req) => {
      const r = await app.start(req);
      return r.ok ? { ok: true } : { ok: false, message: r.error };
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
  };
}

const ui = electrobunUi();
let shell: Shell | null = null;

async function ensureShell(app: AkouApp): Promise<Shell> {
  if (shell) return shell;
  const s = new Shell(shellApp(app), new Bridge(app), ui, {
    platform: process.platform,
    setLoginItem: (enabled) =>
      setLoginItem(enabled, {
        platform: process.platform,
        home: homedir(),
        program: process.execPath,
      }),
    onLog: (level, msg) => console.error(`akou ${level}: ${msg}`),
  });
  shell = s;
  await s.start();
  return s;
}

try {
  const app = await startApp({
    excludeResponsible:
      process.platform === "darwin"
        ? BUNDLE_ID
        : process.platform === "win32"
          ? String(process.pid)
          : undefined,
    window: async (a) => {
      const s = await ensureShell(a);
      s.show();
      return s;
    },
  });
  // Headless (the login item): the tray and the hotkey still, and no window until asked.
  await ensureShell(app);
  await app.closed;
  ui.quit();
} catch (err) {
  if (err instanceof AlreadyRunningError && err.runtime?.port) {
    const dir = loadConfig(process.env).paths.configDir;
    try {
      const token = readFileSync(join(dir, TOKEN_FILE), "utf8").trim();
      await fetch(`http://127.0.0.1:${err.runtime.port}/v1/window`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
    } catch {}
    ui.quit();
  } else {
    console.error(`akou: cannot start: ${(err as Error).message}`);
    ui.quit();
  }
}
