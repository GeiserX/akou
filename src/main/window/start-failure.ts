/**
 * A desktop start that fails (the API port taken, a bind the settings refuse, a config folder that
 * cannot be written): LaunchServices reads nothing the app prints, so the reason goes to `app.log`
 * and a notification says akou did not start. The notification's text is fixed (DK-N4) and never
 * a dialog, which would block the process (DK-M3).
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_LOG, AppLog } from "../app-log.ts";

export const START_FAILED_TITLE = "akou could not start";

export interface StartFailureOptions {
  /** The config folder; it may throw (a bad environment), which only skips the log. */
  configDir: () => string;
  notify: (n: { title: string; body: string }) => void;
}

/** Writes why the start failed and says so on screen. Never throws, so the quit always follows. */
export function reportStartFailure(err: unknown, o: StartFailureOptions): void {
  const why = err instanceof Error ? err.message : String(err);
  let logged = false;
  try {
    const file = join(o.configDir(), APP_LOG);
    const before = existsSync(file) ? statSync(file).size : -1;
    new AppLog(file).line("error", `cannot start: ${why}`);
    // A size that moved: the line went in (a rotation makes the file smaller, not the same).
    logged = existsSync(file) && statSync(file).size !== before;
  } catch {}
  try {
    o.notify({
      title: START_FAILED_TITLE,
      body: logged
        ? "The reason is in app.log in akou's config folder."
        : "akou cannot write to its config folder.",
    });
  } catch {}
}
