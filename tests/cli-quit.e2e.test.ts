/**
 * akou-m23 and DK-M8: `akou quit` says "akou has quit" only once every process of the app is gone:
 * the app, the ElectroBun launcher above it, which once outlived it, and the helpers below it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** The quit fixture started on its own, with `args`; its pids, and a kill for the cleanup. */
async function startApp(home: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, APP, ...args], {
    env: { ...process.env, AKOU_HOME: home },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("ready\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const pid = (name: string) => Number(new RegExp(`${name} (\\d+)`).exec(text)?.[1] ?? 0);
  const out = { app: pid("app"), helper: pid("helper"), harness: pid("harness") };
  return {
    ...out,
    kill: () => {
      for (const p of Object.values(out)) if (p && processAlive(p)) process.kill(p, "SIGKILL");
    },
  };
}

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
  test.skipIf(process.platform === "win32")(
    "it waits for the app's process, not for runtime.json, which goes 6 s before the process does",
    async () => {
      const t = tempDir("akou-quit-");
      const a = await startApp(t.dir, ["--linger", "6000"]);
      try {
        const quit = await cliChild({ ...process.env, AKOU_HOME: t.dir }, ["quit"]);
        expect(quit.out.trim()).toBe("akou has quit");
        expect(quit.ms).toBeGreaterThan(6000);
        expect(processAlive(a.app)).toBe(false);
        expect(processAlive(a.helper)).toBe(false);
      } finally {
        a.kill();
        t.cleanup();
      }
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "an agent the app started that runs akou quit is left running, and so is the quit it ran",
    async () => {
      const t = tempDir("akou-quit-");
      const result = join(t.dir, "harness-quit.txt");
      const a = await startApp(t.dir, ["--harness", result]);
      try {
        const deadline = performance.now() + 20_000;
        while (!existsSync(result) && performance.now() < deadline) await Bun.sleep(100);
        expect(readFileSync(result, "utf8").trim()).toBe("0 akou has quit");
        expect(processAlive(a.app)).toBe(false);
        expect(processAlive(a.helper)).toBe(false);
        // Positive control of the rule: the harness was below the app when quit read the tree.
        expect(a.harness).toBeGreaterThan(0);
        expect(processAlive(a.harness)).toBe(true);
      } finally {
        a.kill();
        t.cleanup();
      }
    },
    30_000,
  );
  test.skipIf(process.platform === "win32")(
    "an app that never finishes quitting is stopped after the wait, and quit says so",
    async () => {
      const t = tempDir("akou-quit-");
      const a = await startApp(t.dir, ["--linger", "600000"]);
      try {
        const quit = await cliChild({ ...process.env, AKOU_HOME: t.dir }, ["quit"]);
        expect(quit.err).toContain("akou: akou did not finish quitting within 20 s; stopped it");
        expect(quit.out.trim()).toBe("akou has quit");
        expect(quit.code).toBe(0);
        expect(processAlive(a.app)).toBe(false);
        expect(processAlive(a.helper)).toBe(false);
      } finally {
        a.kill();
        t.cleanup();
      }
    },
    45_000,
  );

  test.skipIf(process.platform === "win32")(
    "positive control: an app that never finishes quitting while a call records is never stopped",
    async () => {
      const t = tempDir("akou-quit-");
      const audio = join(t.dir, "part-1.opus");
      const a = await startApp(t.dir, ["--linger", "600000", "--recording", audio]);
      try {
        const quit = await cliChild({ ...process.env, AKOU_HOME: t.dir }, ["quit"]);
        expect(quit.code).toBe(70);
        expect(quit.err).toContain(
          `akou: akou did not finish quitting within 20 s and a call is still recording (capture helper pid ${a.helper}), so nothing was stopped; kill -KILL ${a.app} stops it by hand, the audio so far stays`,
        );
        expect(processAlive(a.app)).toBe(true);
        expect(processAlive(a.helper)).toBe(true);
      } finally {
        a.kill();
        t.cleanup();
      }
    },
    45_000,
  );
  test.skipIf(process.platform === "win32")(
    "a helper left over from an ended call, its file not growing, does not keep a stuck app alive",
    async () => {
      const t = tempDir("akou-quit-");
      const a = await startApp(t.dir, [
        "--linger",
        "600000",
        "--stale-helper",
        join(t.dir, "old.opus"),
      ]);
      try {
        const quit = await cliChild({ ...process.env, AKOU_HOME: t.dir }, ["quit"]);
        expect(quit.err).toContain("akou did not finish quitting within 20 s; stopped it");
        expect(quit.code).toBe(0);
        expect(processAlive(a.app)).toBe(false);
        expect(processAlive(a.helper)).toBe(false);
      } finally {
        a.kill();
        t.cleanup();
      }
    },
    45_000,
  );

  test.skipIf(process.platform === "win32")(
    "a process list that cannot be read stops nothing: quit says so and names the kill",
    async () => {
      const t = tempDir("akou-quit-");
      const a = await startApp(t.dir, ["--linger", "600000"]);
      try {
        // No `ps` on this PATH: the list cannot be read.
        const empty = join(t.dir, "no-bin");
        mkdirSync(empty);
        const quit = await cliChild({ ...process.env, AKOU_HOME: t.dir, PATH: empty }, ["quit"]);
        expect(quit.code).toBe(70);
        expect(quit.err).toContain(
          `akou: akou did not finish quitting within 20 s, and the processes below it could not be listed (ps failed), so nothing was stopped; kill -KILL ${a.app} stops it by hand`,
        );
        expect(processAlive(a.app)).toBe(true);
      } finally {
        a.kill();
        t.cleanup();
      }
    },
    45_000,
  );
});
