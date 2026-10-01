/**
 * DK-M8: `app.log`, which the app writes itself because nothing reads the desktop app's stdout.
 * Its start, each call's start and end by id, the quit; never a title or a name; rotated at its
 * size cap into one older file.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppLog, logStamp } from "../src/main/app-log.ts";
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
      expect(log).toMatch(
        new RegExp(
          `^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\.\\d{3} [+-]\\d\\d:\\d\\d info akou ${rig.app.version.replace(/\./g, "\\.")} started \\(pid ${process.pid}, app, headless, API on port ${rig.port}\\)$`,
          "m",
        ),
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
});
