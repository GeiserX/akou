#!/usr/bin/env bun
/**
 * An app that starts slowly, for the launch wait (#356): it takes the app lock at once, as the
 * real app does early in its start, then answers `/healthz` and `GET /v1/status` only after
 * `--delay MS` (2000 by default), when it writes `runtime.json`. It never exits on its own.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, processAlive } from "../../src/core/log/writer.ts";
import { APP_LOCK, RUNTIME_FILE } from "../../src/main/app-info.ts";
import { resolvePaths } from "../../src/main/config/schema.ts";

const i = process.argv.indexOf("--delay");
const delay = Number(i >= 0 ? process.argv[i + 1] : 2000);
const dir = resolvePaths(process.env).configDir;
mkdirSync(dir, { recursive: true, mode: 0o700 });
acquireLock(join(dir, APP_LOCK), process.pid, processAlive);
// clock: the start this fixture stands in for takes real time.
setTimeout(() => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz" || path === "/v1/status") return Response.json({ ok: true });
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  writeFileSync(
    join(dir, RUNTIME_FILE),
    `${JSON.stringify({ pid: process.pid, port: server.port, version: "0.0.0-slow" })}\n`,
  );
}, delay);
setInterval(() => {}, 1000);
