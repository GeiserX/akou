/**
 * akou-m23 and DK-M8: `akou quit` says "akou has quit" only once every process of the app is gone:
 * the app, the ElectroBun launcher above it, which once outlived it, and the helpers below it.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/core/log/writer.ts";
import { cliChild } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const APP = join(import.meta.dir, "fixtures", "quit-app.ts");

/** A launcher like ElectroBun's (`…/Contents/MacOS/launcher`) that starts the app and outlives it. */
const LAUNCHER = `
const { spawn } = require("node:child_process");
const c = spawn(process.execPath, [${JSON.stringify(APP)}], { stdio: ["ignore", "pipe", "inherit"] });
c.stdout.on("data", (d) => process.stdout.write(d));
setInterval(() => {}, 1000);
`;

describe("[DK-M8] akou quit takes every process of the app down (akou-m23)", () => {
  test.skipIf(process.platform === "win32")(
    "it returns once the app, the launcher that outlives it and a helper that would stay are gone",
    async () => {
      const t = tempDir("akou-quit-");
      const macos = join(t.dir, "akou.app", "Contents", "MacOS");
      mkdirSync(macos, { recursive: true });
      writeFileSync(join(macos, "launcher"), LAUNCHER);
      const launcher = Bun.spawn([process.execPath, join(macos, "launcher")], {
        env: { ...process.env, AKOU_HOME: t.dir },
        stdout: "pipe",
        stderr: "inherit",
      });
      const reader = launcher.stdout.getReader();
      let text = "";
      while (!text.includes("ready\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      const app = Number(/app (\d+)/.exec(text)?.[1]);
      const helper = Number(/helper (\d+)/.exec(text)?.[1]);
      try {
        expect([app, helper, launcher.pid].every(processAlive)).toBe(true);
        const quit = await cliChild({ ...process.env, AKOU_HOME: t.dir }, ["quit"]);
        expect(quit.out.trim()).toBe("akou has quit");
        expect(quit.code).toBe(0);
        // The app took 1.5 s past removing runtime.json: the answer waited for it.
        expect(quit.ms).toBeGreaterThan(1500);
        await launcher.exited;
        expect(processAlive(app)).toBe(false);
        expect(processAlive(launcher.pid)).toBe(false);
        expect(processAlive(helper)).toBe(false);
      } finally {
        for (const pid of [app, helper, launcher.pid]) {
          if (pid && processAlive(pid)) process.kill(pid, "SIGKILL");
        }
        t.cleanup();
      }
    },
    30_000,
  );
});
