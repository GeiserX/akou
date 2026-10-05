/**
 * Windows holds its loader lock for the whole of a DLL's first load on the machine, and the first
 * load of a freshly written file (an install, an update) takes 0.1 to 2 s on a slow disk. A main
 * thread that calls into the runtime meanwhile waits for that lock, so a Worker's first
 * `require("sherpa-onnx-node")` stopped the app's main thread as long as the load took (TRAPS
 * "A Worker's first native load stops the main thread"). On Windows the Worker therefore loads the
 * addon once in a short child process first: the slow first load happens there, under the child's
 * own lock, and the Worker's own load then takes about 10 ms. Only the Worker waits for the child.
 * Nothing stays loaded: the child exits, and an idle Worker still lets go of its models.
 */

import { spawnSync } from "node:child_process";

type Spawn = (cmd: string, args: string[], o: Parameters<typeof spawnSync>[2]) => unknown;

/** Long enough for a first load on a slow disk; a child that hangs past it is left to fail. */
export const WARM_TIMEOUT_MS = 30_000;

/**
 * Loads `entry` (a module path, as `require` takes it) in a child process of this same runtime on
 * Windows, and does nothing elsewhere. Best effort: a child that fails costs this nothing, the
 * caller's own `require` still runs and reports any real error.
 */
export function warmNativeLoad(
  entry: string,
  o: { platform?: string; spawn?: Spawn; execPath?: string } = {},
): boolean {
  if ((o.platform ?? process.platform) !== "win32") return false;
  const spawn = o.spawn ?? (spawnSync as Spawn);
  // BUN_BE_BUN: the compiled `akou` binary runs `-e` as Bun does instead of its own command line.
  spawn(o.execPath ?? process.execPath, ["-e", `require(${JSON.stringify(entry)})`], {
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdio: "ignore",
    timeout: WARM_TIMEOUT_MS,
    windowsHide: true,
  });
  return true;
}
