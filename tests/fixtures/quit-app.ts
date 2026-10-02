#!/usr/bin/env bun
/**
 * An app for the quit test (akou-m23): it answers `/healthz`, and `POST /v1/quit` with 202. Then it
 * removes `runtime.json` at once, as the real app does before its process ends, and exits 1.5 s
 * later (`--linger MS` sets it). Its helper child never exits on its own. `--harness FILE` also
 * starts a child that stands in for an agent the app started: it runs `akou quit` itself, writes
 * the exit code and output to FILE, and stays. `--recording FILE` makes the helper one that
 * records into FILE. Prints the pids, then `ready`.
 */

import { spawn } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, processAlive } from "../../src/core/log/writer.ts";
import { resolvePaths } from "../../src/main/config/schema.ts";

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const linger = Number(arg("--linger") ?? 1500);
const dir = resolvePaths(process.env).configDir;
mkdirSync(dir, { recursive: true, mode: 0o700 });
const lock = join(dir, "akou.lock");
acquireLock(lock, process.pid, processAlive);
const runtime = join(dir, "runtime.json");
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return Response.json({ ok: true });
    if (req.method === "POST" && path === "/v1/quit") {
      setTimeout(() => {
        unlinkSync(runtime);
        unlinkSync(lock);
        setTimeout(() => process.exit(0), linger);
      }, 20);
      return Response.json({ ok: true, quitting: true }, { status: 202 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});
writeFileSync(
  runtime,
  `${JSON.stringify({ pid: process.pid, port: server.port, version: "0.0.0-quit" })}\n`,
);
// `--recording FILE`: the helper records like a capture helper (`run --out FILE`).
const recording = arg("--recording");
const helper = recording
  ? spawn(
      process.execPath,
      [join(import.meta.dir, "growing-helper.ts"), "run", "--out", recording],
      {
        stdio: "ignore",
      },
    )
  : spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const out = arg("--harness");
if (out) {
  const cli = join(import.meta.dir, "..", "..", "src", "main", "cli", "cli.ts");
  const harness = spawn(
    process.execPath,
    [
      "-e",
      `const r = Bun.spawnSync([process.execPath, ${JSON.stringify(cli)}, "quit"]);
       require("node:fs").writeFileSync(${JSON.stringify(out)}, r.exitCode + " " + r.stdout.toString());
       setInterval(() => {}, 1000);`,
    ],
    { stdio: "ignore", env: process.env },
  );
  process.stdout.write(`harness ${harness.pid}\n`);
}
process.stdout.write(`app ${process.pid}\nhelper ${helper.pid}\nready\n`);
