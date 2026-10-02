/**
 * DK-M8: `app.log`, which the app writes itself because nothing reads the desktop app's stdout.
 * Its start, each call's start and end by id, the quit; never a title or a name; rotated at its
 * size cap into one older file.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppLog, logStamp } from "../src/main/app-log.ts";
import { ApiClient, LAUNCH_LOG, LAUNCH_LOG_MAX_BYTES, rotate } from "../src/main/cli/client.ts";
import { appRig } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";

const TITLE = "Zq7-title-marker";

describe("[DK-M8] app.log", () => {
  test("the app writes its start, a call's start and end by id, and its quit; no title, no name", async () => {
    const rig = await appRig({ supervise: true, settings: { "user.name": "Zq7-name-marker" } });
    const file = join(rig.home, ".config", "akou", "app.log");
    try {
      const id = await rig.startCall({ title: TITLE });
      expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
      await rig.app.quit();
      const log = readFileSync(file, "utf8");
      // The start line: a stamp, then the exact words, compared as text (no pattern built from them).
      const started = log.split("\n").find((l) => l.includes(" info akou ")) ?? "";
      expect(started).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d info /);
      expect(started.slice(started.indexOf(" info ") + 1)).toBe(
        `info akou ${rig.app.version} started (pid ${process.pid}, app, headless, API on port ${rig.port})`,
      );
      expect(log).toContain(`info call ${id}: started`);
      expect(log).toContain(`info call ${id}: a part started`);
      expect(log).toContain(`info call ${id}: ended`);
      expect(log).toMatch(/info quitting\n/);
      expect(log.trimEnd().split("\n").at(-1)).toMatch(/info akou .* quit \(pid \d+\)$/);
      expect(log).not.toContain(TITLE);
      expect(log).not.toContain("Zq7-name-marker");
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      await rig.close();
    }
  });

  test("positive control: an app started as tests start it writes no app.log", async () => {
    const rig = await appRig();
    try {
      await rig.startCall({ title: TITLE });
      await rig.api("POST", "/calls/live/stop");
      expect(existsSync(join(rig.home, ".config", "akou", "app.log"))).toBe(false);
    } finally {
      await rig.close();
    }
  });

  test("at its size cap the log moves to app.log.1, replacing the older one", () => {
    const t = tempDir();
    try {
      const file = join(t.dir, "app.log");
      writeFileSync(`${file}.1`, "the oldest\n");
      const log = new AppLog(file, 200, () => new Date(2026, 9, 1, 9, 5, 3, 7));
      for (let i = 0; i < 12; i++) log.line("info", `line ${i}`);
      const now = readFileSync(file, "utf8");
      const older = readFileSync(`${file}.1`, "utf8");
      expect(statSync(file).size).toBeLessThanOrEqual(200);
      expect(older).not.toContain("the oldest");
      expect(now).toContain("line 11");
      expect(older + now).not.toContain("line 0\n");
      expect(now.split("\n")[0]).toMatch(/^2026-10-01 09:05:03\.007 [+-]\d\d:\d\d info line \d+$/);
      // A line never carries a line break of its own.
      log.line("warn", "two\nlines");
      expect(readFileSync(file, "utf8")).toContain("warn two lines\n");
    } finally {
      t.cleanup();
    }
  });

  test("the stamp is local wall-clock time with its offset", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(logStamp(d)).toStartWith("2026-01-02 03:04:05.006 ");
  });
  test("launch.log, what a program the CLI launches prints, moves to launch.log.1 at 1 MB", async () => {
    const t = tempDir();
    try {
      const dir = join(t.dir, ".config", "akou");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, LAUNCH_LOG);
      writeFileSync(file, "x".repeat(LAUNCH_LOG_MAX_BYTES));
      const client = new ApiClient({
        env: { AKOU_HOME: t.dir },
        client: "test",
        launch: [process.execPath, "-e", "console.log('launched')"],
        launchBudgetMs: 300,
      });
      // Nothing answers: the launch is refused, after it ran.
      await expect(client.launch()).rejects.toThrow("did not answer");
      expect(statSync(`${file}.1`).size).toBe(LAUNCH_LOG_MAX_BYTES);
      const deadline = performance.now() + 3000;
      while (!readFileSync(file, "utf8").includes("launched") && performance.now() < deadline) {
        await Bun.sleep(50);
      }
      expect(readFileSync(file, "utf8")).toBe("launched\n");
      // Positive control: a log under the cap stays where it is.
      rmSync(`${file}.1`);
      rotate(file, LAUNCH_LOG_MAX_BYTES);
      expect(existsSync(`${file}.1`)).toBe(false);
    } finally {
      t.cleanup();
    }
  });
  test("the cap counts bytes, not characters: accented text never carries the file past it", () => {
    const t = tempDir();
    try {
      const file = join(t.dir, "app.log");
      const log = new AppLog(file, 250, () => new Date(2026, 9, 1, 9, 5, 3, 7));
      log.line("info", "short");
      // About 140 characters but 240 bytes once written.
      log.line("info", "é".repeat(100));
      expect(statSync(file).size).toBeLessThanOrEqual(250);
      expect(existsSync(`${file}.1`)).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("with app.log on, a line goes to app.log and not to a stderr that is not a terminal", async () => {
    const seen: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => void seen.push(a.join(" "));
    const on = await appRig({ supervise: true });
    const off = await appRig();
    try {
      // The rigs pass onLog; the entry points do not, which is the case under test.
      for (const r of [on, off])
        (r.app as unknown as { o: { onLog?: unknown } }).o.onLog = undefined;
      on.app.logLine("warn", "Zq7-supervised");
      off.app.logLine("warn", "Zq7-plain");
      expect(readFileSync(join(on.home, ".config", "akou", "app.log"), "utf8")).toContain(
        "warn Zq7-supervised",
      );
      if (!process.stderr.isTTY) expect(seen.join("\n")).not.toContain("Zq7-supervised");
      // Positive control: without app.log the line still goes to stderr.
      expect(seen.join("\n")).toContain("akou warn: Zq7-plain");
    } finally {
      console.error = real;
      await on.close();
      await off.close();
    }
  });
});
