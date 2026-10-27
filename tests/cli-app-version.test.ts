/**
 * The installed app the compiled CLI would start on macOS (`open -a akou.app`) is checked first:
 * one older than the CLI is never started, so a 1.3 command line cannot end up talking to a 0.6
 * app (#455). The bundles here are fake folders with a generated `Info.plist`, and the "launcher"
 * is a script that only leaves a mark, so nothing real is opened.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClient, bundleVersion, olderThan, Unreachable } from "../src/main/cli/client.ts";
import { tempDir } from "./helpers.ts";

const CLI = "1.3.1";

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleExecutable</key>
\t<string>launcher</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${version}</string>
\t<key>CFBundleVersion</key>
\t<string>${version}</string>
</dict>
</plist>
`;
}

/** A fake `akou.app` in `dir` whose `Info.plist` is `contents`, or none when null. */
function bundle(dir: string, contents: string | null): string {
  const app = join(dir, "akou.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  if (contents !== null) writeFileSync(join(app, "Contents", "Info.plist"), contents);
  return app;
}

/** A client whose launch runs a script that writes `mark`, with `-a BUNDLE` as `open` gets it. */
function client(dir: string, app: string, notes: string[] = []) {
  const mark = join(dir, "launched");
  const script = join(dir, "launcher.ts");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "");\n`);
  const c = new ApiClient({
    env: { AKOU_HOME: dir },
    client: "test",
    launch: [process.execPath, script, "-g", "-j", "-a", app, "--env", "AKOU_HEADLESS=1"],
    launchBudgetMs: 1500,
    version: CLI,
    note: (line) => notes.push(line),
  });
  return { c, mark };
}

describe("[T4.11] Login agent does not start mid-session: an installed app older than the CLI is not started (#455)", () => {
  test("bundleVersion reads CFBundleShortVersionString, and null for a plist it cannot read", () => {
    const t = tempDir();
    try {
      expect(bundleVersion(bundle(join(t.dir, "a"), plist("0.6.2")))).toBe("0.6.2");
      expect(bundleVersion(bundle(join(t.dir, "b"), plist("1.4.0-rc.1")))).toBe("1.4.0-rc.1");
      expect(bundleVersion(bundle(join(t.dir, "c"), null))).toBeNull();
      expect(bundleVersion(bundle(join(t.dir, "d"), "bplist00\u0000\u0001garbage"))).toBeNull();
      expect(bundleVersion(bundle(join(t.dir, "e"), plist("unknown")))).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("olderThan orders by major, minor and patch, and a prerelease before its release", () => {
    expect(olderThan("0.6.2", CLI)).toBe(true);
    expect(olderThan("1.3.0", CLI)).toBe(true);
    expect(olderThan("1.3.1-rc.1", CLI)).toBe(true);
    expect(olderThan(CLI, CLI)).toBe(false);
    expect(olderThan("1.3.2", CLI)).toBe(false);
    expect(olderThan("1.4.0-rc.1", CLI)).toBe(false);
    expect(olderThan("10.0.0", "9.9.9")).toBe(false);
  });

  test("an older app is refused before anything is launched, naming both versions and the update", async () => {
    const t = tempDir();
    try {
      const app = bundle(t.dir, plist("0.6.2"));
      const { c, mark } = client(t.dir, app);
      const err = (await c.request("GET", "/status").catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Unreachable);
      expect(err.message).toContain("0.6.2");
      expect(err.message).toContain(CLI);
      expect(err.message).toContain(app);
      expect(err.message).toContain("brew upgrade --cask geiserx/akou/akou");
      expect(err.message).toContain("https://github.com/GeiserX/akou/releases");
      // Nothing was started: the launcher never ran.
      expect(existsSync(mark)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  for (const [name, version] of [
    ["the same version", CLI],
    ["a newer version", "1.4.0"],
  ] as const) {
    test(`an app of ${name} is launched as before (positive control)`, async () => {
      const t = tempDir();
      try {
        const notes: string[] = [];
        const { c, mark } = client(t.dir, bundle(t.dir, plist(version)), notes);
        const err = (await c.request("GET", "/status").catch((e: unknown) => e)) as Error;
        // The fake launcher starts no app, so the launch fails, but after it ran.
        expect(err).toBeInstanceOf(Unreachable);
        expect(err.message).not.toContain("older than this command line");
        expect(existsSync(mark)).toBe(true);
        expect(notes).toEqual([]);
      } finally {
        t.cleanup();
      }
    });
  }

  test("an app whose version cannot be read is launched as before, with a warning", async () => {
    const t = tempDir();
    try {
      const notes: string[] = [];
      const app = bundle(t.dir, null);
      const { c, mark } = client(t.dir, app, notes);
      const err = (await c.request("GET", "/status").catch((e: unknown) => e)) as Error;
      expect(err.message).not.toContain("older than this command line");
      expect(existsSync(mark)).toBe(true);
      expect(notes).toEqual([`cannot read the version of ${app}; starting it anyway`]);
    } finally {
      t.cleanup();
    }
  });
});
