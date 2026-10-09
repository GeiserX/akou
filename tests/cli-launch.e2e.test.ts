/**
 * The real `akou` entry point as a child process (docs/DESIGN.md sections 1.4, 1.5, 6.1 and 6.3):
 * with no app running, `akou start` launches the app headless and answers within the cold budget;
 * `akou quit` stops it; and a proxy in the environment never gets between the CLI and 127.0.0.1.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/core/log/writer.ts";
import { APP_LOG } from "../src/main/app-log.ts";
import { ApiClient, LAUNCH_LOG } from "../src/main/cli/client.ts";
import { appRig, FAKE_HELPER, writeSettings } from "./api-helpers.ts";
import { cliChild } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const LONG = 60_000;

describe("[T4.11] Login agent does not start mid-session / [T3.6] Minutes to start", () => {
  test(
    "akou start with no app running launches it headless and answers 201 within 3 s; quit stops it",
    async () => {
      const t = tempDir();
      writeSettings(t.dir, {
        "api.port": 0,
        "capture.helper": [process.execPath, FAKE_HELPER],
        // No test runs the user's real harness, not even for its version.
        "provider.kind": "none",
      });
      const env = { ...process.env, AKOU_HOME: t.dir, AKOU_HEADLESS: undefined };
      const rtPath = join(t.dir, ".config", "akou", "runtime.json");
      expect(existsSync(rtPath)).toBe(false);
      let pid = 0;
      try {
        // No models in this home: audio only, which is what a cold start has to prove.
        const start = await cliChild(env, ["start", "-t", "Cold", "--without-models", "--json"]);
        console.log(`akou start (app cold, as a child process): ${start.ms.toFixed(0)} ms`);
        expect(start.code).toBe(0);
        const body = JSON.parse(start.out);
        expect(body.part).toBe(1);
        // The design's cold target is 3 s from the command; the process start of the CLI itself
        // is part of it.
        expect(start.ms).toBeLessThan(3000);
        const rt = JSON.parse(readFileSync(rtPath, "utf8"));
        pid = rt.pid;
        // Headless because the CLI set AKOU_HEADLESS, not by an argument.
        expect(rt.headless).toBe(true);

        const status = await cliChild(env, ["status", "--json"]);
        expect(status.code).toBe(0);
        expect(JSON.parse(status.out).live.call).toBe(body.call);

        const quit = await cliChild(env, ["quit"]);
        expect(quit.code).toBe(0);
        expect(quit.out.trim()).toBe("akou has quit");
        expect(existsSync(rtPath)).toBe(false);
        const log = readFileSync(join(body.folder, "events.jsonl"), "utf8").trim().split("\n");
        expect(log.map((l) => JSON.parse(l).type).slice(-2)).toEqual(["part.ended", "call.ended"]);
      } finally {
        // A failed assertion must not leave the launched app running.
        if (pid && processAlive(pid)) process.kill(pid, "SIGTERM");
        t.cleanup();
      }
    },
    LONG,
  );
});

describe("[F2.7] Proxy on loopback", () => {
  test(
    "the CLI reaches 127.0.0.1 directly with every proxy variable pointing at a dead port",
    async () => {
      const rig = await appRig();
      try {
        const dead = "http://127.0.0.1:9";
        const env = {
          ...process.env,
          ...rig.env,
          HTTP_PROXY: dead,
          http_proxy: dead,
          HTTPS_PROXY: dead,
          https_proxy: dead,
          ALL_PROXY: dead,
          all_proxy: dead,
          NO_PROXY: "",
          no_proxy: "",
        };
        const r = await cliChild(env, ["status", "--json"]);
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out).app.port).toBe(rig.port);
        // No positive control is possible on this runtime: Bun 1.3.12 never sends a loopback
        // request through a proxy, even when `fetch` is given one explicitly (measured). The CLI
        // still adds the loopback names to NO_PROXY for itself and the app it launches, for
        // runtimes that do.
      } finally {
        await rig.close();
      }
    },
    LONG,
  );
});

const SLOW_APP = join(import.meta.dir, "fixtures", "slow-app.ts");
const FAKE_BUNDLE = join(import.meta.dir, "fixtures", "fake-bundle.ts");

/** Ends every pid named in a `--pids` file of the fake bundle, and the given ones. */
function killAll(pids: readonly number[], pidsFile?: string): void {
  const all = [...pids];
  if (pidsFile && existsSync(pidsFile)) {
    for (const line of readFileSync(pidsFile, "utf8").trim().split("\n")) {
      const pid = Number(line.split(" ")[1]);
      if (pid) all.push(pid);
    }
  }
  // Never pid 0: that signals this process group, the test runner included.
  for (const pid of all.filter((p) => p > 0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/** The pid each role of the fake bundle wrote, by role. */
function rolePids(file: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const [role, pid] = line.split(" ");
    if (role && pid) out[role] = Number(pid);
  }
  return out;
}

describe("[T3.6] Minutes to start: a first launch slower than the 3 s target (#356)", () => {
  test(
    "an app that answers 4 s after its launch is waited for, not given up on at 3 s",
    async () => {
      const t = tempDir();
      let pid = 0;
      try {
        const client = new ApiClient({
          env: { AKOU_HOME: t.dir },
          client: "test",
          launch: [process.execPath, SLOW_APP, "--delay", "4000"],
        });
        const t0 = performance.now();
        const rt = await client.launch();
        pid = rt.pid;
        expect(rt.version).toBe("0.0.0-slow");
        expect(performance.now() - t0).toBeGreaterThan(3900);
      } finally {
        killAll([pid]);
        t.cleanup();
      }
    },
    LONG,
  );

  test(
    "positive control: a launched program that ends without starting an app fails fast, naming launch.log and app.log",
    async () => {
      const t = tempDir();
      try {
        const client = new ApiClient({
          env: { AKOU_HOME: t.dir },
          client: "test",
          launch: [process.execPath, "-e", "process.exit(3)"],
        });
        const t0 = performance.now();
        const err = (await client.launch().catch((e: unknown) => e)) as Error;
        const ms = performance.now() - t0;
        expect(err).toBeInstanceOf(Error);
        const dir = join(t.dir, ".config", "akou");
        expect(err.message).toContain(join(dir, LAUNCH_LOG));
        expect(err.message).toContain(join(dir, APP_LOG));
        expect(err.message).toContain("exit code 3");
        // Well under the old 3 s budget, let alone the wait for a launch still in progress.
        expect(ms).toBeLessThan(2000);
      } finally {
        t.cleanup();
      }
    },
    LONG,
  );

  test(
    "a launch whose own program ends at once keeps waiting while an app that holds the lock starts",
    async () => {
      const t = tempDir();
      // The first app, still starting: it holds the lock, as a second app it refused would see.
      const first = spawn(process.execPath, [SLOW_APP, "--delay", "2500"], {
        stdio: "ignore",
        env: { ...process.env, AKOU_HOME: t.dir },
      });
      try {
        const lock = join(t.dir, ".config", "akou", "akou.lock");
        const until = performance.now() + 5000;
        while (!existsSync(lock) && performance.now() < until) await Bun.sleep(20);
        const client = new ApiClient({
          env: { AKOU_HOME: t.dir },
          client: "test",
          // The second app: finds the lock and exits 0.
          launch: [process.execPath, "-e", "0"],
        });
        const rt = await client.launch();
        expect(rt.pid).toBe(first.pid as number);
      } finally {
        killAll([first.pid as number]);
        t.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(process.platform === "win32")(
    "a bundle's first open: the CLI waits past `open` for the unpacked app, then stops the wrapper left behind, not the app's launcher (no ps on Windows)",
    async () => {
      const t = tempDir();
      const bundle = join(t.dir, "akou.app");
      const macos = join(bundle, "Contents", "MacOS");
      mkdirSync(macos, { recursive: true });
      symlinkSync(process.execPath, join(macos, "launcher"));
      const pids = join(t.dir, "pids.txt");
      try {
        const client = new ApiClient({
          env: { AKOU_HOME: t.dir },
          client: "test",
          launch: [
            process.execPath,
            FAKE_BUNDLE,
            "open",
            "-a",
            bundle,
            "--pids",
            pids,
            "--delay",
            "4000",
          ],
        });
        const rt = await client.launch();
        const p = rolePids(pids);
        expect(rt.version).toBe("0.0.0-slow");
        // The app and the launcher above it run on; the idle wrapper is gone.
        expect(processAlive(rt.pid)).toBe(true);
        expect(processAlive(p.launcher as number)).toBe(true);
        expect(processAlive(p.wrapper as number)).toBe(false);
        expect(p.app).toBe(rt.pid);
      } finally {
        killAll([], pids);
        t.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(process.platform === "win32")(
    "positive control: an open that starts nothing in the bundle fails fast (no ps on Windows)",
    async () => {
      const t = tempDir();
      const bundle = join(t.dir, "akou.app");
      mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
      const pids = join(t.dir, "pids.txt");
      try {
        const client = new ApiClient({
          env: { AKOU_HOME: t.dir },
          client: "test",
          launch: [
            process.execPath,
            FAKE_BUNDLE,
            "open",
            "-a",
            bundle,
            "--pids",
            pids,
            "--nothing",
          ],
        });
        const t0 = performance.now();
        await expect(client.launch()).rejects.toThrow("did not answer");
        expect(performance.now() - t0).toBeLessThan(2000);
      } finally {
        killAll([], pids);
        t.cleanup();
      }
    },
    LONG,
  );
});
