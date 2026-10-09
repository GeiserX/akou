#!/usr/bin/env bun
/**
 * The first open of a newly installed macOS bundle, for the launch wait (#356), in four roles
 * (the first argument), each run as `BUNDLE/Contents/MacOS/launcher` (a link to Bun) except `open`:
 *
 * - `open -a BUNDLE`: stands in for `/usr/bin/open`. Starts the wrapper and exits 0 at once.
 *   With `--nothing` it starts nothing and exits 0.
 * - `wrapper`: the stable wrapper. "Unpacks" for 500 ms, starts the real launcher through a
 *   process that exits at once (so the launcher is not its child, as a relaunch through
 *   LaunchServices is not), then stays, idle and with no child: the leftover launcher.
 * - `relaunch`: that short-lived process in between.
 * - `launcher`: the real launcher. Runs the slow app (`slow-app.ts --delay MS`) as its child and
 *   exits when it does.
 *
 * Every role but `open` and `relaunch` appends `ROLE PID` to `--pids FILE`.
 */

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const role = process.argv[2] as string;
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] as string) : "";
};
const bundle = arg("-a");
const pids = arg("--pids");
const delay = arg("--delay") || "4000";
const launcher = join(bundle, "Contents", "MacOS", "launcher");
const self = import.meta.path;
const pass = ["-a", bundle, "--pids", pids, "--delay", delay];
const detached = (args: string[]) =>
  spawn(launcher, args, { detached: true, stdio: "ignore", env: process.env }).unref();
if (role !== "open" && role !== "relaunch") appendFileSync(pids, `${role} ${process.pid}\n`);

if (role === "open") {
  if (!process.argv.includes("--nothing")) detached([self, "wrapper", ...pass]);
} else if (role === "wrapper") {
  // clock: the unpacking this fixture stands in for takes real time.
  setTimeout(() => detached([self, "relaunch", ...pass]), 500);
  setInterval(() => {}, 1000);
} else if (role === "relaunch") {
  detached([self, "launcher", ...pass]);
} else if (role === "launcher") {
  const app = spawn(process.execPath, [join(import.meta.dir, "slow-app.ts"), "--delay", delay], {
    stdio: "ignore",
    env: process.env,
  });
  app.on("exit", () => process.exit(0));
}
