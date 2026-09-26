/**
 * `akou serve` (docs/ux/SERVER.md SV-P8): the real CLI entry as a child process runs the server in
 * the foreground, answers the API, and takes the one quit path on SIGTERM, which is what
 * `docker stop` sends to the image's pid 1. The compiled binary is checked the same way by
 * `scripts/smoke-cli.ts` on each release runner, linux-arm64 included.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compiledServeWarning, serverEnv } from "../src/main/cli/commands/serve.ts";
import { until } from "./capture-helpers.ts";
import { CLI } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * A fresh home whose config picks a free port, so the test never collides with a real app, and
 * binds loopback: server mode's default bind, 0.0.0.0, starts only behind a proxy (SV-P5).
 */
function home(): { dir: string; configDir: string; env: Record<string, string> } {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const configDir = join(t.dir, ".config", "akou");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ "api.port": 0, "api.bind": "127.0.0.1" }),
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.AKOU_URL;
  Object.assign(env, {
    AKOU_HOME: t.dir,
    AKOU_MODELS_DIR: join(t.dir, "models"),
    AKOU_NO_DOWNLOAD: "1",
  });
  return { dir: t.dir, configDir, env };
}

function serve(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, CLI, "serve"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for the exit, so the home is never removed under a handle the server still holds.
  cleanups.push(async () => {
    proc.kill("SIGKILL");
    await proc.exited;
  });
  return proc;
}

function runtime(configDir: string): { pid: number; port: number; headless: boolean } | null {
  try {
    return JSON.parse(readFileSync(join(configDir, "runtime.json"), "utf8"));
  } catch {
    return null;
  }
}

describe("[SV-P8] akou serve", () => {
  test("serverEnv adds server mode and headless to the caller's environment, and keeps the rest", () => {
    expect(serverEnv({ AKOU_HOME: "/data", AKOU_HEADLESS: "0" })).toEqual({
      AKOU_HOME: "/data",
      AKOU_SERVER: "1",
      AKOU_HEADLESS: "1",
    });
  });

  test("the single-file CLI says it cannot transcribe; from source nothing is said", () => {
    expect(compiledServeWarning(true)).toContain("cannot transcribe");
    expect(compiledServeWarning(true)).toContain("drumsergio/akou");
    expect(compiledServeWarning(false)).toBeNull();
  });

  test("runs the server in the foreground, answers the API, and quits cleanly on SIGTERM (POST /quit on Windows, which has no SIGTERM)", async () => {
    const h = home();
    const proc = serve(h.env);
    await until(() => runtime(h.configDir) !== null, 15_000, "runtime.json");
    const rt = runtime(h.configDir) as { pid: number; port: number; headless: boolean };
    // The server is this process, not a launched app: the foreground command is pid 1 in a container.
    expect(rt.pid).toBe(proc.pid);
    expect(rt.headless).toBe(true);
    const token = readFileSync(join(h.configDir, "token"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${rt.port}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { app: { pid: number } }).app.pid).toBe(proc.pid);

    if (process.platform === "win32") {
      // Windows turns SIGTERM into TerminateProcess, which no handler sees: the quit route is its
      // clean stop, and the same one quit path runs.
      const q = await fetch(`http://127.0.0.1:${rt.port}/v1/quit`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(q.status).toBe(202);
    } else {
      proc.kill("SIGTERM");
    }
    const code = await proc.exited;
    const err = await new Response(proc.stderr).text();
    expect(err).toContain(`serving on http://127.0.0.1:${rt.port}/v1`);
    // From source the engine is there, so no warning.
    expect(err).not.toContain("cannot transcribe");
    expect(code).toBe(0);
    // The one quit path ran: runtime.json and the lock are gone.
    expect(existsSync(join(h.configDir, "runtime.json"))).toBe(false);
    expect(existsSync(join(h.configDir, "akou.lock"))).toBe(false);
  }, 30_000);

  test("a second akou serve on the same home is refused with 69 and names the running one", async () => {
    const h = home();
    serve(h.env);
    await until(() => runtime(h.configDir) !== null, 15_000, "runtime.json");
    const rt = runtime(h.configDir) as { pid: number; port: number };
    const second = serve(h.env);
    const code = await second.exited;
    const err = await new Response(second.stderr).text();
    expect(code).toBe(69);
    expect(err).toContain(`akou is already running (pid ${rt.pid}, port ${rt.port})`);
  }, 30_000);

  test("takes no arguments: settings come from the config file", async () => {
    const h = home();
    const proc = Bun.spawn([process.execPath, CLI, "serve", "--port", "9"], {
      env: h.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(64);
    expect(runtime(h.configDir)).toBeNull();
  });

  test("[SV-P5] the default bind with no proxy is a settings refusal: exit 78 naming both keys, nothing served", async () => {
    const h = home();
    writeFileSync(join(h.configDir, "config.json"), JSON.stringify({ "api.port": 0 }));
    const proc = serve(h.env);
    const code = await proc.exited;
    const err = await new Response(proc.stderr).text();
    expect(err).toContain("api.bind");
    expect(err).toContain("server.behind_proxy");
    expect(code).toBe(78);
    expect(runtime(h.configDir)).toBeNull();
  }, 30_000);

  test("[SV-P11] AKOU_BEHIND_PROXY=true starts the default bind with no proxy setting in the file", async () => {
    const h = home();
    writeFileSync(join(h.configDir, "config.json"), JSON.stringify({ "api.port": 0 }));
    serve({ ...h.env, AKOU_BEHIND_PROXY: "true" });
    await until(() => runtime(h.configDir) !== null, 15_000, "runtime.json");
    const rt = runtime(h.configDir) as { port: number };
    // 0.0.0.0 is reached on loopback too.
    const res = await fetch(`http://127.0.0.1:${rt.port}/healthz`);
    expect(res.status).toBe(200);
  }, 30_000);
});

// A folder mode stops no one running as root, and Windows has no mode bits.
const noModeBits = process.platform === "win32" || process.getuid?.() === 0;

describe("[SV-P12] a folder the server cannot write", () => {
  for (const which of ["models", "data"] as const) {
    test.skipIf(noModeBits)(
      `an unwritable ${which} folder stops akou serve with 77, naming the folder and the uid (skipped as root or on Windows)`,
      async () => {
        const h = home();
        // The image's layout: AKOU_HOME is the data folder, the models folder is its own mount.
        const data = join(h.dir, "data");
        const models = join(h.dir, "models");
        mkdirSync(data);
        mkdirSync(models);
        const env = {
          ...h.env,
          AKOU_HOME: data,
          AKOU_MODELS_DIR: models,
          AKOU_BEHIND_PROXY: "true",
        };
        const locked = which === "models" ? models : data;
        chmodSync(locked, 0o555);
        cleanups.push(() => chmodSync(locked, 0o755));
        const proc = serve(env);
        const code = await proc.exited;
        const err = await new Response(proc.stderr).text();
        expect(err).toContain(`${locked} is not writable by uid ${process.getuid?.()}`);
        expect(code).toBe(77);
        // One line, never a stack trace.
        expect(err).not.toContain("    at ");
        // Positive control: the same start with the folder writable serves.
        chmodSync(locked, 0o755);
        const configDir = join(data, ".config", "akou");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, "config.json"), JSON.stringify({ "api.port": 0 }));
        serve(env);
        await until(() => runtime(configDir) !== null, 15_000, "runtime.json");
      },
      30_000,
    );
  }
});
