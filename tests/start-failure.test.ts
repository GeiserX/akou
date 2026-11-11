/**
 * A desktop start that fails must say so where a person looks (docs/TRAPS.md [ST-1]): `app.log`
 * gets the reason and a notification with fixed text says akou did not start.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { reportStartFailure, START_FAILED_TITLE } from "../src/main/window/start-failure.ts";
import { appRig } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";

describe("[ST-1] a desktop start that fails", () => {
  test("a taken API port: app.log ends with the reason and one notification is posted", async () => {
    // A port this test holds, so the app's listen() fails as it does when another program has it.
    const held = createServer();
    await new Promise<void>((ok) => held.listen(0, "127.0.0.1", ok));
    const port = (held.address() as { port: number }).port;
    const t = tempDir("akou-start-");
    const configDir = join(t.dir, ".config", "akou");
    const notes: { title: string; body: string }[] = [];
    try {
      let err: unknown = null;
      try {
        const rig = await appRig({ home: t.dir, settings: { "api.port": port } });
        await rig.close();
      } catch (e) {
        err = e;
      }
      expect(err).not.toBeNull();
      reportStartFailure(err, { configDir: () => configDir, notify: (n) => notes.push(n) });
      const last = readFileSync(join(configDir, "app.log"), "utf8").trimEnd().split("\n").at(-1);
      expect(last).toContain(" error cannot start: ");
      expect(last).toContain((err as Error).message);
      expect(notes).toEqual([
        { title: START_FAILED_TITLE, body: "The reason is in app.log in akou's config folder." },
      ]);
    } finally {
      held.close();
      t.cleanup();
    }
  });

  test("positive control: with the port free the start works, and nothing is reported", async () => {
    const t = tempDir("akou-start-");
    try {
      const rig = await appRig({ home: t.dir });
      expect(rig.port).toBeGreaterThan(0);
      await rig.close();
    } finally {
      t.cleanup();
    }
  });

  test("a config folder that cannot be written: the notification alone, and it does not point at app.log", () => {
    const t = tempDir("akou-start-");
    // A file where the folder should be: nothing can be written under it.
    const blocked = join(t.dir, "not-a-folder");
    writeFileSync(blocked, "");
    const notes: { title: string; body: string }[] = [];
    try {
      reportStartFailure(new Error("EACCES"), {
        configDir: () => blocked,
        notify: (n) => notes.push(n),
      });
      expect(notes).toEqual([
        { title: START_FAILED_TITLE, body: "akou cannot write to its config folder." },
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("the desktop entry reports a start that fails before it quits", () => {
    // main.ts is the entry no test imports: a scan proves its catch still calls the report.
    const reportsBeforeQuit = (src: string): boolean => {
      const tail = src.slice(src.lastIndexOf("} catch (err) {"));
      const branch = tail.slice(Math.max(0, tail.indexOf("} else {")));
      const report = branch.indexOf("reportStartFailure(");
      return tail.includes("} else {") && report >= 0 && branch.indexOf("ui.quit()") > report;
    };
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "main", "window", "main.ts"),
      "utf8",
    );
    expect(reportsBeforeQuit(src)).toBe(true);
    // Positive control: the same entry without the call is caught.
    const removed = src.replace(/reportStartFailure\([\s\S]*?\}\);\n/, "");
    expect(removed).not.toBe(src);
    expect(reportsBeforeQuit(removed)).toBe(false);
  });

  test("a config folder that throws and a notifier that throws still return, so the quit follows", () => {
    expect(() =>
      reportStartFailure(new Error("bad env"), {
        configDir: () => {
          throw new Error("no home");
        },
        notify: () => {
          throw new Error("no toolkit");
        },
      }),
    ).not.toThrow();
  });
});
