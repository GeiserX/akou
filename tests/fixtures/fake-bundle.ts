#!/usr/bin/env bun
/**
 * The first open of a newly installed macOS bundle, for the launch wait (#356), in four roles
 * (the first argument), each run as `BUNDLE/Contents/MacOS/launcher` (a link to Bun) except `open`:
 *
 * - `open -a BUNDLE`: stands in for `/usr/bin/open`. Starts the wrapper and exits 0 at once.
 *   With `--nothing` it starts nothing and exits 0.
 * - `wrapper`: the stable wrapper. "Unpacks" for 500 ms, starts the real launcher through a
 *   process that exits at once (so the launcher is not its child, as a relaunch through
 *   LaunchServices is not), then stays, idle: the leftover launcher. As the real one, which never
 *   reaps the `open` it ran, it has one child that exited and stays in the process list
 *   (`<defunct>`): `open` starts it through a shell that starts that child and then becomes it.
 * - `relaunch`: that short-lived process in between.
 * - `launcher`: the real launcher. Runs the slow app (`slow-app.ts --delay MS`) as its child and
 *   exits when it does.
 *
 * - `stray`: a launcher left behind, idle and with no child (with `--with-child`, one child, as a
 *   launcher whose app still runs).
 *
 * `open` with `--installed` opens an app already unpacked: it starts the real launcher, and, as
 * LaunchServices does, starts nothing while a launcher of the bundle is alive unless `-n` is
 * given.
 *
 * Every role but `open` and `relaunch` appends `ROLE PID` to `--pids FILE`, and the launcher
 * appends `app PID` for the slow app, so a test can end every process the bundle started.
 */

import { spawn, spawnSync } from "node:child_process";
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

/** Is a launcher of the bundle running, which LaunchServices takes for the running app? */
function launcherRunning(): boolean {
  const r = spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").some((l) => l.trim().startsWith(`${launcher} `));
}

if (role === "open") {
  if (process.argv.includes("--nothing")) {
    // Starts nothing.
  } else if (!process.argv.includes("--installed")) {
    spawn("/bin/sh", ["-c", 'true & exec "$0" "$@"', launcher, self, "wrapper", ...pass], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    }).unref();
  } else if (process.argv.includes("-n") || !launcherRunning())
    detached([self, "launcher", ...pass]);
} else if (role === "stray") {
  if (process.argv.includes("--with-child")) {
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  }
  setInterval(() => {}, 1000);
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
  appendFileSync(pids, `app ${app.pid}\n`);
  app.on("exit", () => process.exit(0));
}
