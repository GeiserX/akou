#!/usr/bin/env bun
/**
 * An app thread for the watchdog tests (DK-M8): starts the watchdog with a short silence, starts a
 * child that stands in for a helper, prints `ready`, then does what the arguments say.
 *
 *   bun tests/fixtures/watchdog-app.ts LOG HANGS --silence MS [--recording] [--no-watchdog]
 *     [--sample] [--window --reopen MARKER] (--block MS | --busy MS)
 *
 * `--block MS` blocks this thread for MS; `--busy MS` keeps it working in bursts shorter than the
 * silence, for MS, then exits 0. `--window` says the window is open; `--reopen MARKER` is what
 * opens the app again: a process that writes MARKER.
 */

import { spawn } from "node:child_process";
import { startWatchdog } from "../../src/main/watchdog.ts";

const [logFile, hangsDir] = process.argv.slice(2) as [string, string];
const num = (flag: string) => Number(process.argv[process.argv.indexOf(flag) + 1]);
const has = (flag: string) => process.argv.includes(flag);
if (!has("--no-watchdog")) {
  startWatchdog({
    logFile,
    hangsDir,
    recording: () => has("--recording"),
    sample: has("--sample"),
    silenceMs: num("--silence"),
    tickMs: 100,
    beatMs: 100,
    windowOpen: () => has("--window"),
    relaunch: has("--reopen")
      ? [
          process.execPath,
          "-e",
          `require("node:fs").appendFileSync(${JSON.stringify(process.argv[process.argv.indexOf("--reopen") + 1])}, "x")`,
        ]
      : null,
  });
}
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(`child ${child.pid}\nready\n`);
if (has("--block")) {
  setTimeout(() => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, num("--block"));
    process.stdout.write("unblocked\n");
  }, 300);
} else if (has("--busy")) {
  const end = performance.now() + num("--busy");
  const burst = () => {
    const stop = performance.now() + num("--silence") / 3;
    while (performance.now() < stop) {}
    if (performance.now() < end) setTimeout(burst, 0);
    else {
      child.kill("SIGKILL");
      process.exit(0);
    }
  };
  setTimeout(burst, 300);
}
