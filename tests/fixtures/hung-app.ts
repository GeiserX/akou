#!/usr/bin/env bun
/**
 * A hung akou for the DK-M8 tests: it holds the app lock, writes `runtime.json` like the app, and
 * listens on a port, then blocks its only thread for good. The kernel still accepts connections on
 * the port and nothing ever answers, and SIGTERM and SIGINT do nothing (their handlers would run
 * on the blocked thread), which is how the desktop app behaves when its toolkit's main thread is
 * stuck. Only SIGKILL ends it.
 *
 *   AKOU_HOME=... bun tests/fixtures/hung-app.ts [--record FILE]
 *
 * `--record FILE` starts a child that records like a capture helper (`run --out FILE`, appending
 * to the file every 100 ms), so the CLI sees a recording in progress. Prints `ready` when hung.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, processAlive } from "../../src/core/log/writer.ts";
import { resolvePaths } from "../../src/main/config/schema.ts";

const dir = resolvePaths(process.env).configDir;
mkdirSync(dir, { recursive: true, mode: 0o700 });
acquireLock(join(dir, "akou.lock"), process.pid, processAlive);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
writeFileSync(
  join(dir, "runtime.json"),
  `${JSON.stringify({ pid: process.pid, port: server.port, version: "0.0.0-hung" })}\n`,
  { mode: 0o600 },
);
const i = process.argv.indexOf("--record");
const out = i >= 0 ? process.argv[i + 1] : undefined;
if (out) {
  const helper = spawn(
    process.execPath,
    [join(import.meta.dir, "growing-helper.ts"), "run", "--out", out],
    { stdio: "ignore" },
  );
  process.stdout.write(`helper ${helper.pid}\n`);
}
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
process.stdout.write("ready\n");
// Let the line out, then hang for good.
setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0), 50);
