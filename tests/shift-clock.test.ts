/**
 * The nightly clock-shift run (docs/TESTING.md TS-5): `scripts/ci/shift-clock.ts`, preloaded into
 * every `bun` through `BUN_OPTIONS`, moves the wall clock a year ahead in the test process and in
 * every process it spawns, and the clock keeps ticking. The positive control is a date bomb: a
 * test that passes today and only for 180 days fails the shifted run and passes the plain one.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

const PRELOAD = join(import.meta.dir, "..", "scripts", "ci", "shift-clock.ts");
const DAY = 24 * 60 * 60 * 1000;

/** This process's environment without any shift it may itself be running under. */
function env(shifted: boolean): Record<string, string> {
  const e = { ...process.env } as Record<string, string>;
  delete e.BUN_OPTIONS;
  delete e.AKOU_CLOCK_SHIFT_DAYS;
  if (shifted) e.BUN_OPTIONS = `--preload=${PRELOAD}`;
  return e;
}

function run(argv: string[], shifted: boolean, cwd?: string) {
  const r = Bun.spawnSync([process.execPath, ...argv], {
    env: env(shifted),
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** What a child sees: its `Date.now()` twice 100 ms apart, `new Date()`, and whether an mtime is a `Date`. */
const PROBE = `const a = Date.now(); await Bun.sleep(100); const b = Date.now();
const { statSync } = await import("node:fs");
console.log(JSON.stringify({ a, b, made: new Date().getTime(), mtime: statSync(".").mtime instanceof Date, called: typeof Date() }));`;

describe("[TS-5] the suites a year ahead", () => {
  test("the preload moves Date a year ahead in a spawned bun, and the clock keeps ticking", () => {
    const plain = JSON.parse(run(["-e", PROBE], false).out);
    const shifted = JSON.parse(run(["-e", PROBE], true).out);
    const ahead = shifted.a - plain.a;
    expect(ahead).toBeGreaterThanOrEqual(365 * DAY);
    expect(ahead).toBeLessThan(365 * DAY + 30_000);
    expect(shifted.made - shifted.a).toBeGreaterThanOrEqual(0);
    expect(shifted.made - shifted.a).toBeLessThan(30_000);
    // `setSystemTime` would stop the clock here and a deadline loop would never end.
    expect(shifted.b - shifted.a).toBeGreaterThanOrEqual(90);
    expect(shifted).toMatchObject({ mtime: true, called: "string" });
  });

  test("positive control: a 180-day date bomb passes the plain run and fails the shifted one", () => {
    const t = tempDir();
    const now = JSON.parse(run(["-e", PROBE], false).out).a as number;
    writeFileSync(
      join(t.dir, "bomb.test.ts"),
      `import { expect, test } from "bun:test";
// Written now and correct for 180 days: a fixture pinned to the calendar.
const WRITTEN = ${now};
test("a fixture that expires", () => {
  expect(Date.now() - WRITTEN).toBeLessThan(180 * ${DAY});
});
`,
    );
    const plain = run(["test", "bomb.test.ts"], false, t.dir);
    expect(plain.code).toBe(0);
    const shifted = run(["test", "bomb.test.ts"], true, t.dir);
    expect(shifted.code).toBe(1);
    expect(shifted.err).toContain("a fixture that expires");
    t.cleanup();
  });
});
