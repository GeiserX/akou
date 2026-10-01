/**
 * DK-M8, TRAPS "An app that takes the connection and never answers": the watchdog inside the app.
 * A thread that stops beating for the silence is logged; with no call recording the process and
 * the processes below it end, with a call recording nothing ends. Work in bursts shorter than the
 * silence, and a process stopped and continued (a Mac asleep), never fire it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/core/log/writer.ts";
import { relaunchCommand } from "../src/main/watchdog.ts";
import { tempDir } from "./helpers.ts";

const APP = join(import.meta.dir, "fixtures", "watchdog-app.ts");
const LONG = 60_000;
const SILENCE = 1500;

async function run(flags: string[], dir?: string) {
  const t = dir ? { dir, cleanup: () => {} } : tempDir("akou-wd-");
  const log = join(t.dir, "app.log");
  const hangs = join(t.dir, "hangs");
  const proc = Bun.spawn(
    [process.execPath, APP, log, hangs, "--silence", String(SILENCE), ...flags],
    {
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("ready\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const child = Number(/child (\d+)/.exec(text)?.[1] ?? 0);
  const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  /** Resolves with the exit, or null when the process is still alive after `ms`. */
  const exitWithin = (ms: number) =>
    Promise.race([
      // Windows ends a process with no signal to report: its exit code stands in.
      proc.exited.then(() => proc.signalCode ?? `exit ${proc.exitCode}`),
      Bun.sleep(ms).then(() => null),
    ]);
  const cleanup = () => {
    for (const pid of [proc.pid, child]) {
      // A process can end between the check and the kill (an exiting child not yet reaped).
      try {
        if (pid && processAlive(pid)) process.kill(pid, "SIGKILL");
      } catch {}
    }
    t.cleanup();
  };
  return { proc, child, log: read, hangs, exitWithin, cleanup };
}

describe("[DK-M8] the watchdog inside the app", () => {
  test(
    "a stuck thread with no call recording: a log line, then the process and its children end",
    async () => {
      const r = await run(["--block", "30000"]);
      try {
        const ended = await r.exitWithin(SILENCE + 8000);
        expect(ended).toMatch(process.platform === "win32" ? /^exit \d+$/ : /^SIGKILL$/);
        const log = r.log();
        expect(log).toMatch(
          /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d error watchdog: the app's thread has not answered for \d+ s; no call is recording$/m,
        );
        expect(log).toContain(
          `warn watchdog: ending akou (pid ${r.proc.pid}), so the next command starts a fresh one`,
        );
        // Windows has no process tree to walk; the desktop app is macOS's.
        if (process.platform !== "win32") {
          await Bun.sleep(300);
          expect(processAlive(r.child)).toBe(false);
        }
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test(
    "positive control: without the watchdog the same stuck process stays alive",
    async () => {
      const r = await run(["--block", "30000", "--no-watchdog"]);
      try {
        expect(await r.exitWithin(SILENCE + 3000)).toBeNull();
        expect(r.log()).toBe("");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test(
    "with a call recording nothing ends: it logs, and logs again when the thread answers",
    async () => {
      const r = await run(["--block", String(SILENCE + 1500), "--recording"]);
      try {
        expect(await r.exitWithin(SILENCE + 3500)).toBeNull();
        expect(processAlive(r.child)).toBe(true);
        const log = r.log();
        expect(log).toMatch(
          /error watchdog: the app's thread has not answered for \d+ s; a call is recording/,
        );
        expect(log).toContain("akou keeps running, so the capture helper keeps writing the audio");
        expect(log).toMatch(/info watchdog: the app's thread answered again after about \d+ s/);
        expect(log).not.toContain("ending akou");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test(
    "work in bursts shorter than the silence never fires it",
    async () => {
      const r = await run(["--busy", String(SILENCE * 3)]);
      try {
        await r.proc.exited;
        expect(r.proc.exitCode).toBe(0);
        expect(r.log()).toBe("");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(process.platform === "win32")(
    "a process stopped and continued, as a Mac asleep, never fires it",
    async () => {
      const r = await run(["--busy", String(SILENCE * 4)]);
      try {
        process.kill(r.proc.pid, "SIGSTOP");
        await Bun.sleep(SILENCE * 2);
        process.kill(r.proc.pid, "SIGCONT");
        await r.proc.exited;
        expect(r.proc.exitCode).toBe(0);
        expect(r.log()).toBe("");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(process.platform !== "darwin")(
    "on macOS the hang leaves a sample of the stuck process beside the log",
    async () => {
      const r = await run(["--block", "30000", "--sample"]);
      try {
        expect(await r.exitWithin(SILENCE + 12_000)).toBe("SIGKILL");
        const files = readdirSync(r.hangs);
        expect(files.length).toBe(1);
        expect(readFileSync(join(r.hangs, files[0] as string), "utf8")).toContain(
          `[${r.proc.pid}]`,
        );
        // A sample names the process's threads and libraries: the owner's alone.
        expect(statSync(join(r.hangs, files[0] as string)).mode & 0o777).toBe(0o600);
        expect(r.log()).toContain("a sample of the stuck process is in");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );
  test.skipIf(process.platform === "win32")(
    "with the window open the app is opened again after it ends, at most once in ten minutes",
    async () => {
      const t = tempDir("akou-wd-");
      const marker = join(t.dir, "reopened.marker");
      try {
        const first = await run(["--block", "30000", "--window", "--reopen", marker], t.dir);
        expect(await first.exitWithin(SILENCE + 8000)).toMatch(/^SIGKILL$/);
        const deadline = performance.now() + 5000;
        while (!existsSync(marker) && performance.now() < deadline) await Bun.sleep(50);
        expect(readFileSync(marker, "utf8")).toBe("x");
        expect(first.log()).toContain(
          "info watchdog: opening akou again, because its window was open",
        );
        // The reopened app hangs too: it is ended, and not opened again.
        const second = await run(["--block", "30000", "--window", "--reopen", marker], t.dir);
        expect(await second.exitWithin(SILENCE + 8000)).toMatch(/^SIGKILL$/);
        await Bun.sleep(1000);
        expect(readFileSync(marker, "utf8")).toBe("x");
        expect(second.log()).toMatch(
          /warn watchdog: not opening akou again: it was reopened \d+ min ago/,
        );
      } finally {
        t.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(process.platform === "win32")(
    "positive control: with the window closed nothing is opened again",
    async () => {
      const t = tempDir("akou-wd-");
      const marker = join(t.dir, "reopened.marker");
      try {
        const r = await run(["--block", "30000", "--reopen", marker], t.dir);
        expect(await r.exitWithin(SILENCE + 8000)).toMatch(/^SIGKILL$/);
        await Bun.sleep(1000);
        expect(existsSync(marker)).toBe(false);
        expect(r.log()).not.toContain("opening akou again");
      } finally {
        t.cleanup();
      }
    },
    LONG,
  );

  test("the app is opened again through its bundle on macOS, and not at all elsewhere", () => {
    expect(relaunchCommand("/Applications/akou.app/Contents/MacOS/bun", "darwin")).toEqual([
      "/bin/sh",
      "-c",
      'sleep 1; exec /usr/bin/open -a "$1"',
      "sh",
      "/Applications/akou.app",
    ]);
    // The headless app the CLI starts from source, and other systems: the next command starts it.
    expect(relaunchCommand("/usr/local/bin/bun", "darwin")).toBeNull();
    expect(relaunchCommand("/Applications/akou.app/Contents/MacOS/bun", "linux")).toBeNull();
  });
});
