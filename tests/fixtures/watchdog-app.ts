#!/usr/bin/env bun
/**
 * An app thread for the watchdog tests (DK-M8): starts the watchdog with a short silence, starts a
 * child that stands in for a helper, prints `ready`, then does what the arguments say.
 *
 *   bun tests/fixtures/watchdog-app.ts LOG HANGS --silence MS [--recording] [--no-watchdog]
 *     [--sample | --sampler JSON [--sample-cap MS]] [--window (--reopen MARKER | --open JSON) [--runtime FILE] [--reopen-wait MS]]
 *     [--late-helper FILE | --touch-recording] [--ps-fails]
 *     (--block MS | --busy MS)
 *
 * `--sample` takes a real `sample` on macOS; `--sampler JSON` is any command in its place, given at
 * most `--sample-cap MS`. `--block MS` blocks this thread for MS; `--busy MS` keeps it working in bursts shorter than the
 * silence, for MS, then exits 0. `--window` says the window is open; `--reopen MARKER` is what
 * opens the app again: a process that writes MARKER, and `--open JSON` is any command instead.
 * `--runtime FILE` is where the opened app says it is up, and `--reopen-wait MS` how long each
 * open is given (300 ms by default here). Just before the thread blocks,
 * `--late-helper FILE` spawns a helper that records into FILE (`run --out FILE`) with the live
 * flag still false, as a start whose helper comes after the last beat; `--touch-recording` turns
 * the flag on and publishes it with `touch`, as the app does when a call goes live.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { startWatchdog } from "../../src/main/watchdog.ts";

const [logFile, hangsDir] = process.argv.slice(2) as [string, string];
const num = (flag: string) => Number(process.argv[process.argv.indexOf(flag) + 1]);
const has = (flag: string) => process.argv.includes(flag);
const str = (flag: string) => process.argv[process.argv.indexOf(flag) + 1] as string;
let live = has("--recording");
const wd = has("--no-watchdog")
  ? null
  : startWatchdog({
      logFile,
      hangsDir,
      recording: () => live,
      sample: has("--sample") || has("--sampler"),
      ...(has("--sampler") ? { sampler: JSON.parse(str("--sampler")) as string[] } : {}),
      ...(has("--sample-cap") ? { sampleCapMs: num("--sample-cap") } : {}),
      silenceMs: num("--silence"),
      tickMs: 100,
      beatMs: 100,
      windowOpen: () => has("--window"),
      ...(has("--ps-fails") ? { ps: "/usr/bin/false" } : {}),
      relaunch: has("--open")
        ? (JSON.parse(str("--open")) as string[])
        : has("--reopen")
          ? [
              process.execPath,
              "-e",
              `require("node:fs").appendFileSync(${JSON.stringify(str("--reopen"))}, "x")`,
            ]
          : null,
      ...(has("--runtime") ? { runtimeFile: str("--runtime") } : {}),
      reopenWaitMs: has("--reopen-wait") ? num("--reopen-wait") : 300,
    });
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(`child ${child.pid}\nready\n`);
if (has("--block")) {
  setTimeout(() => {
    if (has("--late-helper")) {
      const out = process.argv[process.argv.indexOf("--late-helper") + 1] as string;
      const h = spawn(
        process.execPath,
        [join(import.meta.dir, "growing-helper.ts"), "run", "--out", out],
        { stdio: "ignore" },
      );
      process.stdout.write(`helper ${h.pid}\n`);
    }
    if (has("--touch-recording")) {
      live = true;
      wd?.touch();
    }
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
