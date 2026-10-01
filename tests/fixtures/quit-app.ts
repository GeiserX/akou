#!/usr/bin/env bun
/**
 * An app for the quit test (akou-m23): it answers `/healthz`, and `POST /v1/quit` with 202. Then it
 * removes `runtime.json` at once, as the real app does before its process ends, and exits 1.5 s
 * later. Its helper child never exits on its own. Prints its pid and the helper's, then `ready`.
 */

import { spawn } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, processAlive } from "../../src/core/log/writer.ts";
import { resolvePaths } from "../../src/main/config/schema.ts";

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
        setTimeout(() => process.exit(0), 1500);
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
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(`app ${process.pid}\nhelper ${helper.pid}\nready\n`);
