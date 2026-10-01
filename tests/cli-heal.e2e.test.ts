/**
 * DK-M8, TRAPS "An app that takes the connection and never answers": the real `akou` entry point
 * against a hung app (`fixtures/hung-app.ts`: the port accepts, nothing answers, SIGTERM does
 * nothing). A command that changes something restarts it within the heal budget and runs; a read
 * says so and stops nothing unless `--restart` is given; a recording in progress is never stopped.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/core/log/writer.ts";
import {
  descendants,
  HEAL_BUDGET_MS,
  launcherOf,
  parsePs,
  recordingOut,
  stopAll,
} from "../src/main/cli/heal.ts";
import { FAKE_HELPER, writeSettings } from "./api-helpers.ts";
import { cliChild } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const LONG = 60_000;
const HUNG = join(import.meta.dir, "fixtures", "hung-app.ts");
const POSIX = process.platform !== "win32";

/** A home with a hung app in it; `record` gives the app a helper writing that file. */
async function hungHome(record?: string) {
  const t = tempDir("akou-hung-");
  writeSettings(t.dir, {
    "api.port": 0,
    "capture.helper": [process.execPath, FAKE_HELPER],
    "provider.kind": "none",
    "dictation.enabled": false,
  });
  const env = { ...process.env, AKOU_HOME: t.dir, AKOU_HEADLESS: undefined };
  const proc = Bun.spawn([process.execPath, HUNG, ...(record ? ["--record", record] : [])], {
    env: { ...process.env, AKOU_HOME: t.dir },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("ready\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the hung app exited: ${text}`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const helper = Number(/helper (\d+)/.exec(text)?.[1] ?? 0);
  const cfg = join(t.dir, ".config", "akou");
  const cleanup = () => {
    for (const pid of [proc.pid, helper])
      if (pid && processAlive(pid)) process.kill(pid, "SIGKILL");
    try {
      const now = JSON.parse(readFileSync(join(cfg, "runtime.json"), "utf8")) as { pid: number };
      if (now.pid !== proc.pid && processAlive(now.pid)) process.kill(now.pid, "SIGKILL");
    } catch {}
    t.cleanup();
  };
  try {
    // The fixture blocks 50 ms after `ready`.
    await Bun.sleep(300);
    const rt = JSON.parse(readFileSync(join(cfg, "runtime.json"), "utf8")) as { port: number };
    // Proof the fixture is hung, so the checks below can fail: the port takes the connection and
    // a status request gets nothing back.
    const silent = await fetch(`http://127.0.0.1:${rt.port}/v1/status`, {
      signal: AbortSignal.timeout(1000),
    }).then(
      () => false,
      (e) => (e as Error).name === "TimeoutError",
    );
    expect(silent).toBe(true);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { env, cfg, pid: proc.pid, helper, proc, cleanup };
}

describe("[DK-M8] An app that takes the connection and never answers", () => {
  test.skipIf(!POSIX)(
    "akou start restarts a hung app within the heal budget and records, with one line saying so",
    async () => {
      const h = await hungHome();
      try {
        const start = await cliChild(h.env, ["start", "-t", "Heal", "--without-models", "--json"]);
        console.log(`akou start against a hung app: ${start.ms.toFixed(0)} ms`);
        expect(start.err).toMatch(/^akou: akou was not answering; restarted it \(\d+ s\)$/m);
        expect(start.code).toBe(0);
        expect(JSON.parse(start.out).part).toBe(1);
        // The budget is the heal's; the CLI's own start and the request come on top.
        expect(start.ms).toBeLessThan(HEAL_BUDGET_MS + 3000);
        await h.proc.exited;
        expect(processAlive(h.pid)).toBe(false);
        const rt = JSON.parse(readFileSync(join(h.cfg, "runtime.json"), "utf8"));
        expect(rt.pid).not.toBe(h.pid);
        if (process.platform === "darwin") {
          // The hang left evidence: a sample of the hung process.
          const hangs = readdirSync(join(h.cfg, "hangs"));
          expect(hangs.length).toBe(1);
          expect(readFileSync(join(h.cfg, "hangs", hangs[0] as string), "utf8")).toContain(
            `[${h.pid}]`,
          );
        }
        const quit = await cliChild(h.env, ["quit"]);
        expect(quit.code).toBe(0);
      } finally {
        h.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(!POSIX)(
    "a read says the app is not answering and stops nothing; with --restart it restarts the app",
    async () => {
      const h = await hungHome();
      try {
        const read = await cliChild(h.env, ["status"]);
        expect(read.code).toBe(69);
        expect(read.err).toContain(
          `akou: akou is not answering: it took the connection and sent nothing back for 3 s (pid ${h.pid}); nothing was restarted, as this command only reads: run it again with --restart to restart akou`,
        );
        // Three seconds, not the request's 60.
        expect(read.ms).toBeLessThan(10_000);
        expect(processAlive(h.pid)).toBe(true);
        const again = await cliChild(h.env, ["status", "--restart", "--json"]);
        expect(again.err).toMatch(/akou was not answering; restarted it \(\d+ s\)/);
        expect(again.code).toBe(0);
        expect(JSON.parse(again.out).app.pid).not.toBe(h.pid);
        await cliChild(h.env, ["quit"]);
      } finally {
        h.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(!POSIX)(
    "a hung app with a call recording is never stopped: the CLI says the audio is still being written",
    async () => {
      const t = tempDir("akou-rec-");
      const file = join(t.dir, "part-1.opus");
      const h = await hungHome(file);
      try {
        expect(h.helper).toBeGreaterThan(0);
        const start = await cliChild(h.env, ["start", "-t", "Busy", "--without-models"]);
        expect(start.code).toBe(69);
        expect(start.err).toContain(
          `akou: akou is not answering while a call is recording (pid ${h.pid}); the capture helper (pid ${h.helper}) is still writing the audio, so nothing was restarted. To restart akou by hand, which ends this recording and keeps the audio so far: kill -KILL ${h.pid}, then run the command again`,
        );
        expect(processAlive(h.pid)).toBe(true);
        expect(processAlive(h.helper)).toBe(true);
        const size = statSync(file).size;
        await Bun.sleep(400);
        expect(statSync(file).size).toBeGreaterThan(size);
        // `--restart` asks to restart a hung app; it never ends a recording.
        const forced = await cliChild(h.env, ["status", "--restart"]);
        expect(forced.code).toBe(69);
        expect(processAlive(h.pid)).toBe(true);
        expect(existsSync(join(h.cfg, "hangs"))).toBe(false);
      } finally {
        h.cleanup();
        t.cleanup();
      }
    },
    LONG,
  );
  test.skipIf(!POSIX)(
    "akou quit on a hung app stops it and starts no other",
    async () => {
      const h = await hungHome();
      try {
        const quit = await cliChild(h.env, ["quit"]);
        expect(quit.err).toMatch(/^akou: akou was not answering; stopped it \(\d+ s\)$/m);
        expect(quit.out.trim()).toBe("akou has quit");
        expect(quit.code).toBe(0);
        await h.proc.exited;
        expect(processAlive(h.pid)).toBe(false);
        // No app took its place.
        const rt = JSON.parse(readFileSync(join(h.cfg, "runtime.json"), "utf8")) as { pid: number };
        expect(rt.pid).toBe(h.pid);
      } finally {
        h.cleanup();
      }
    },
    LONG,
  );
});

describe("[DK-M8] the process tree the CLI reads without the API", () => {
  const ps = parsePs(
    [
      "    1     0 /sbin/launchd",
      "  500     1 /Applications/akou.app/Contents/MacOS/launcher",
      "  501   500 /Applications/akou.app/Contents/MacOS/bun /Applications/akou.app/Contents/MacOS/../Resources/main.js",
      "  502   501 /Applications/akou.app/Contents/Resources/app/bun/akou-capture run --out /r/a/part-1.opus --mic default",
      "  503   501 /Applications/akou.app/Contents/Resources/app/bun/akou-capture dictate",
      "  504   502 /usr/bin/true",
      "  600     1 /usr/local/bin/bun src/main/index.ts",
    ].join("\n"),
  );

  test("descendants, the launcher above the app, and the helper that records", () => {
    expect(descendants(ps, 501)).toEqual([502, 503, 504]);
    expect(launcherOf(ps, 501)).toBe(500);
    // The headless app from the command line has no launcher above it.
    expect(launcherOf(ps, 600)).toBeNull();
    expect(recordingOut(ps.find((r) => r.pid === 502)?.args ?? "")).toBe("/r/a/part-1.opus");
    // Dictation's helper is not a recording.
    expect(recordingOut(ps.find((r) => r.pid === 503)?.args ?? "")).toBeNull();
  });

  test.skipIf(!POSIX)(
    "stopAll ends a process that ignores SIGTERM with SIGKILL after the grace",
    async () => {
      const p = Bun.spawn(
        [process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      await Bun.sleep(300);
      const t0 = performance.now();
      expect(await stopAll([p.pid], 300)).toEqual([]);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(290);
      await p.exited;
      expect(p.signalCode).toBe("SIGKILL");
    },
  );
});
