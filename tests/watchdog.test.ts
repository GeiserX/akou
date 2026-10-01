/**
 * DK-M8, TRAPS "An app that takes the connection and never answers": the watchdog inside the app.
 * A thread that stops beating for the silence is logged; with no call recording the process and
 * the processes below it end, with a call recording nothing ends. Work in bursts shorter than the
 * silence, and a process stopped and continued (a Mac asleep), never fire it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/core/log/writer.ts";
import { tempDir } from "./helpers.ts";

const APP = join(import.meta.dir, "fixtures", "watchdog-app.ts");
const LONG = 60_000;
const SILENCE = 1500;

async function run(flags: string[]) {
  const t = tempDir("akou-wd-");
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
    Promise.race([proc.exited.then(() => proc.signalCode), Bun.sleep(ms).then(() => null)]);
  const cleanup = () => {
    for (const pid of [proc.pid, child]) if (pid && processAlive(pid)) process.kill(pid, "SIGKILL");
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
        const sig = await r.exitWithin(SILENCE + 8000);
        expect(sig).toBe("SIGKILL");
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
        expect(r.log()).toContain("a sample of the stuck process is in");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );
});
