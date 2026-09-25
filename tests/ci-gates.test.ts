/**
 * The gates that keep the suite honest (docs/TESTING.md TS-2, TRAPS T4.20), each with the positive
 * control that proves it can fail: a job that ran too few tests or skipped too many fails its
 * floor, and a committed `test.only` or `test.skip` fails `bun run check`.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countsOf, judge, scaled } from "../scripts/ci/test-floor.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const FLOOR = join(ROOT, "scripts", "ci", "test-floor.ts");
/** Biome's launcher, which picks the platform's binary; run by this Bun on every OS. */
const BIOME = [process.execPath, join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome")];

function run(argv: string[]) {
  const r = Bun.spawnSync(argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

/** A JUnit file as `bun test --reporter=junit` writes it, with these totals. */
function junit(tests: number, failures: number, skipped: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="${tests}" assertions="${tests}" failures="${failures}" skipped="${skipped}" time="0.1">
  <testsuite name="a.test.ts" file="a.test.ts" tests="${tests}" assertions="${tests}" failures="${failures}" skipped="${skipped}" time="0.1">
  </testsuite>
</testsuites>
`;
}

describe("[T4.20] a job that runs too few tests fails", () => {
  test("the totals are read from the run's root element", () => {
    expect(countsOf(junit(846, 0, 9))).toEqual({ tests: 846, failures: 0, skipped: 9, pass: 837 });
    expect(() => countsOf("<testsuite tests='1'/>")).toThrow("no <testsuites>");
  });

  test("at the floor passes; one below it, or one skip too many, fails", () => {
    const c = countsOf(junit(846, 0, 9));
    expect(judge("check:linux", c, { minPass: 837, maxSkip: 9 })).toEqual([]);
    expect(judge("check:linux", c, { minPass: 838, maxSkip: 9 })).toEqual([
      "check:linux: 837 tests passed, the floor is 838",
    ]);
    expect(judge("check:linux", c, { minPass: 837, maxSkip: 8 })).toEqual([
      "check:linux: 9 tests skipped, at most 8 may be",
    ]);
    expect(judge("check:linux", c, undefined)).toEqual([
      "no floor for check:linux in tests/floors.json",
    ]);
    // A dispatch that ran every test 50 times is held to 50 times the floor.
    expect(scaled({ minPass: 837, maxSkip: 9 }, 50)).toEqual({ minPass: 41_850, maxSkip: 450 });
  });

  test("positive control: the script fails a job whose floor is one above the real count", () => {
    const t = tempDir();
    try {
      const xml = join(t.dir, "junit.xml");
      writeFileSync(xml, junit(20, 0, 0));
      const key = `capture-e2e:${process.platform}`;
      const floors = (minPass: number) => {
        const f = join(t.dir, `floors-${minPass}.json`);
        writeFileSync(f, JSON.stringify({ [key]: { minPass, maxSkip: 0 } }));
        return f;
      };
      const at = run([process.execPath, FLOOR, "capture-e2e", xml, floors(20)]);
      expect(at.code).toBe(0);
      expect(at.out).toContain("20 passed (floor 20)");
      const above = run([process.execPath, FLOOR, "capture-e2e", xml, floors(21)]);
      expect(above.code).toBe(1);
      expect(above.out).toContain("20 tests passed, the floor is 21");
      // A job with no floor, and a run that wrote no JUnit file, fail too.
      expect(run([process.execPath, FLOOR, "no-such-job", xml, floors(20)]).code).toBe(1);
      expect(run([process.execPath, FLOOR, "capture-e2e", join(t.dir, "none.xml")]).code).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  test("every floor names a job and a platform, with whole counts", () => {
    const floors = JSON.parse(readFileSync(join(ROOT, "tests", "floors.json"), "utf8"));
    for (const [key, f] of Object.entries(floors as Record<string, Record<string, unknown>>)) {
      expect(key).toMatch(/^[a-z0-9-]+:(darwin|linux|win32)$/);
      expect(Number.isInteger(f.minPass) && (f.minPass as number) > 0).toBe(true);
      expect(Number.isInteger(f.maxSkip) && (f.maxSkip as number) >= 0).toBe(true);
    }
  });
});

describe("[T4.20] a focused or skipped test fails the lint", () => {
  /**
   * Lints `body` as a scratch test file under `tests/` with the repository's Biome configuration.
   * The scratch folder is git-ignored, so `bun run check` never sees it; here the ignore file is
   * turned off so this one file is linted exactly as a committed test would be.
   */
  function lint(body: string) {
    mkdirSync(join(ROOT, "tests", ".tmp"), { recursive: true });
    const dir = mkdtempSync(join(ROOT, "tests", ".tmp", "lint-"));
    try {
      const file = join(dir, "scratch.test.ts");
      writeFileSync(file, `import { describe, test } from "bun:test";\n\n${body}\n`);
      return run([...BIOME, "lint", "--vcs-use-ignore-file=false", file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("positive control: a scratch test.only or describe.only fails", () => {
    const only = lint('test.only("focused", () => {});');
    expect(only.code).not.toBe(0);
    expect(only.out).toContain("noFocusedTests");
    expect(lint('describe.only("focused", () => {});').out).toContain("noFocusedTests");
  });

  test("positive control: a scratch test.skip fails; test.skipIf with its reason passes", () => {
    const skip = lint('test.skip("skipped", () => {});');
    expect(skip.code).not.toBe(0);
    expect(skip.out).toContain("noSkippedTests");
    const gated = lint(
      'test.skipIf(process.platform === "win32")("POSIX modes (skipped on Windows)", () => {});',
    );
    expect(gated.code).toBe(0);
  });
});
