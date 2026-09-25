/**
 * `akou serve` (docs/ux/SERVER.md SV-P8): the server in the foreground, in this process. It is the
 * same core the app runs (`startApp` in `index.ts`), started headless with `AKOU_SERVER=1`, so the
 * image's entrypoint, a systemd unit and a person at a terminal all run one command. It runs until
 * Ctrl-C, SIGTERM or `POST /quit`, and exits 0 after the one quit path.
 *
 * It needs no window, no sound server and no capture helper: nothing here opens a device, and a
 * recording is refused later by the call routes, not here.
 */

import { EXIT } from "../client.ts";
import type { Command } from "../context.ts";

/** The environment the server runs with: the caller's, plus server mode and headless. */
export function serverEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...env, AKOU_SERVER: "1", AKOU_HEADLESS: "1" };
}

export const serveCommand: Command = {
  name: "serve",
  summary: "Run the akou server in the foreground (server mode, no window) until Ctrl-C",
  usage: "akou serve",
  run: async (ctx, p) => {
    if (p.positional.length > 0) {
      ctx.io.err(
        "akou serve: takes no arguments; settings come from the config file\nusage: akou serve",
      );
      return EXIT.usage;
    }
    const env = serverEnv(ctx.io.env);
    // The process becomes the server: code that reads the environment directly sees the same mode.
    process.env.AKOU_SERVER = "1";
    process.env.AKOU_HEADLESS = "1";
    // Loaded only here, so the other commands never load the core.
    const { AlreadyRunningError, startApp } = await import("../../index.ts");
    let app: Awaited<ReturnType<typeof startApp>>;
    try {
      app = await startApp({ env, headless: true, version: ctx.version });
    } catch (err) {
      if (err instanceof AlreadyRunningError) {
        ctx.io.err(`akou serve: ${err.message}`);
        return EXIT.unavailable;
      }
      ctx.io.err(`akou serve: cannot start: ${(err as Error).message}`);
      return EXIT.software;
    }
    for (const i of app.config().issues) ctx.io.err(`akou: setting refused: ${i.message}`);
    ctx.io.err(`akou ${app.version}: serving on ${app.server?.url} (pid ${process.pid})`);
    const quit = () => void app.quit();
    if (ctx.io.signal?.aborted) quit();
    ctx.io.signal?.addEventListener("abort", quit, { once: true });
    await app.closed;
    return EXIT.ok;
  },
};
