/**
 * Two gates over a test run's own output, each with the positive control that proves it can fail:
 * coverage under its floor (docs/TESTING.md TS-8, TS-8b) and a reached trap without a test that ran
 * and asserted (TS-6).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLOORS, judge as judgeCoverage, parseLcov } from "../scripts/ci/coverage-floor.ts";
import {
  casesOf,
  idsIn,
  judge,
  listedWhy,
  report,
  type Trap,
  trapsOf,
} from "../scripts/trap-coverage.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");

function run(argv: string[]) {
  const r = Bun.spawnSync(argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

/** One lcov record as `bun test --coverage-reporter=lcov` writes it. */
const record = (file: string, lf: number, lh: number, fnf: number, fnh: number) =>
  `TN:\nSF:${file}\nFNF:${fnf}\nFNH:${fnh}\nDA:1,1\nLF:${lf}\nLH:${lh}\nend_of_record\n`;

describe("[TS-8] coverage under its floor fails the Linux check", () => {
  const healthy =
    record("src/core/log/fold.ts", 1000, 995, 50, 50) +
    record("src/main/api/server.ts", 1000, 920, 100, 90) +
    // Test files and scripts are outside the measure.
    record("tests/helpers.ts", 1000, 0, 100, 0);

  test("the totals are summed per measure from every record of the lcov file", () => {
    const files = parseLcov(healthy);
    expect(files.size).toBe(3);
    const { report: lines, problems } = judgeCoverage(files);
    expect(problems).toEqual([]);
    expect(lines).toEqual([
      "src/ lines: 95.75 % (1915 of 2000), floor 90.0 %",
      "src/ functions: 93.33 % (140 of 150), floor 88.0 %",
      "src/core/ lines: 99.50 % (995 of 1000), floor 98.0 %",
    ]);
  });

  test("one small file far under the bar does not fail a total above it", () => {
    // Bun's own coverageThreshold would fail this run: it holds each file to the bar on its own.
    const files = parseLcov(`${healthy}${record("src/main/tiny.ts", 10, 2, 2, 0)}`);
    expect(judgeCoverage(files).problems).toEqual([]);
  });

  test("positive control: a floor of 99 % fails, naming the measure", () => {
    const { problems } = judgeCoverage(parseLcov(healthy), {
      ...FLOORS,
      lines: 0.99,
      functions: 0.99,
    });
    expect(problems.map((p) => p.split(":")[0])).toEqual(["src/ lines", "src/ functions"]);
  });

  test("an empty or missing lcov fails instead of passing", () => {
    expect(judgeCoverage(parseLcov("")).problems).toHaveLength(3);
    const t = tempDir();
    const r = run([process.execPath, "scripts/ci/coverage-floor.ts", join(t.dir, "nope.info")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("is missing");
    t.cleanup();
  });
});

describe("[TS-8b] the core keeps 98 % of its lines covered", () => {
  test("positive control: the core under 98 % fails while the whole is far above its floor", () => {
    const lcov =
      record("src/core/log/fold.ts", 1000, 970, 50, 50) +
      record("src/main/api/server.ts", 9000, 9000, 100, 100);
    const { problems } = judgeCoverage(parseLcov(lcov));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("src/core/ lines: 97.00 % is under the floor of 98.0 %");
  });

  test("the script exits 1 on it and prints every measure", () => {
    const t = tempDir();
    const f = join(t.dir, "lcov.info");
    writeFileSync(f, record("src/core/fold.ts", 100, 97, 1, 1));
    const r = run([process.execPath, "scripts/ci/coverage-floor.ts", f]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/core/ lines: 97.00 % (97 of 100), floor 98.0 %");
    writeFileSync(f, record("src/core/fold.ts", 100, 99, 1, 1));
    expect(run([process.execPath, "scripts/ci/coverage-floor.ts", f]).code).toBe(0);
    t.cleanup();
  });
});

/** A JUnit file as Bun writes it: one test case per entry. */
function junit(cases: { name: string; skipped?: boolean; assertions?: number }[]): string {
  const body = cases
    .map((c) => {
      const open = `    <testcase name="${c.name.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" classname="traps" time="0" file="a.test.ts" line="1" assertions="${c.assertions ?? 1}"`;
      return c.skipped ? `${open}>\n      <skipped />\n    </testcase>` : `${open} />`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${cases.length}">\n  <testsuite name="a.test.ts">\n${body}\n  </testsuite>\n</testsuites>\n`;
}

describe("[TS-6] every reached trap has a test that ran and asserted", () => {
  const traps = trapsOf(readFileSync(join(ROOT, "docs", "TRAPS.md"), "utf8"));
  /** One passing, asserting test for every trap the check holds to a test. */
  const full = traps
    .filter((t) => listedWhy(t) === null)
    .map((t) => ({ name: `[${t.ids.join(", ")}] ${t.title}` }));
  const t431 = traps.find((t) => t.ids.includes("T4.31")) as Trap;

  test("TRAPS.md parses into traps with ids and milestones, and stops at the kept invariants", () => {
    expect(traps.length).toBeGreaterThan(80);
    expect(t431.milestone).toBeNull();
    expect(traps.find((t) => t.ids.includes("T0.9"))?.milestone).toBe("M0");
    expect(traps.some((t) => /crash-safe containers/.test(t.title))).toBe(false);
    expect(full.length).toBeGreaterThan(40);
  });

  test("ids are read from every bracket of a test's name and describe", () => {
    expect([...idsIn("[T1.9, T4.19] Short spans > [F2.50] torn")]).toEqual([
      "T1.9",
      "T4.19",
      "F2.50",
    ]);
    const [c] = casesOf(junit([{ name: "[T4.31] a & b", assertions: 3 }]));
    expect(c).toEqual({
      name: "a.test.ts: traps > [T4.31] a & b",
      ids: new Set(["T4.31"]),
      skipped: false,
      failed: false,
      assertions: 3,
    });
  });

  test("with a test for every reached trap the check passes", () => {
    expect(report(judge(traps, casesOf(junit(full)))).failed).toBe(0);
  });

  test("positive control: renaming the [T4.31] test makes it fail", () => {
    const renamed = full.map((c) =>
      c.name.startsWith("[T4.31]") ? { name: c.name.replace("[T4.31]", "[T4.3l]") } : c,
    );
    const { lines, failed } = report(judge(traps, casesOf(junit(renamed))));
    expect(failed).toBe(1);
    expect(lines.filter((l) => l.startsWith("FAIL"))).toEqual([
      `FAIL    [T4.31] ${t431.title}: no test with its id in the name ran`,
    ]);
  });

  test("positive control: a skipped test, or one with zero assertions, does not count", () => {
    const only = (patch: { skipped?: boolean; assertions?: number }) =>
      judge([t431], casesOf(junit([{ name: "[T4.31] hangs", ...patch }])))[0]?.status;
    expect(only({ skipped: true })).toBe("skipped");
    expect(only({ assertions: 0 })).toBe("no-assertions");
    expect(only({})).toBe("ok");
  });

  test("a hardware or checklist trap with no test is listed, not failed; a named test settles it", () => {
    const grant = traps.find((t) => t.ids.includes("T0.18")) as Trap;
    expect(judge([grant], [])[0]).toMatchObject({
      status: "listed",
      why: "its test is a hardware, checklist or nightly step",
    });
    expect(judge([grant], casesOf(junit([{ name: "[T0.18] grant" }])))[0]?.status).toBe("ok");
    const later: Trap = { title: "x", ids: ["T9.9"], milestone: "M4", text: "Test: a unit test." };
    expect(judge([later], [])[0]).toMatchObject({ status: "listed" });
    expect(judge([{ ...later, milestone: "M1" }], [])[0]?.status).toBe("missing");
  });

  test("the script reads several JUnit files and exits 1 on a missing trap test", () => {
    const t = tempDir();
    const a = join(t.dir, "a.xml");
    const b = join(t.dir, "b.xml");
    const half = Math.floor(full.length / 2);
    writeFileSync(a, junit(full.slice(0, half)));
    writeFileSync(b, junit(full.slice(half)));
    expect(run([process.execPath, "scripts/trap-coverage.ts", a, b]).code).toBe(0);
    const r = run([process.execPath, "scripts/trap-coverage.ts", a]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("without a test that ran and asserted");
    t.cleanup();
  });

  test("every JUnit file the traps job reads is uploaded, dotfile and all", () => {
    // upload-artifact leaves dotfiles out unless told: the first run uploaded no `.junit-*.xml`
    // and the traps job, given no file, failed on its usage line.
    const yaml = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const uploads = yaml
      .split(/\n(?= {6}- )/)
      .filter((step) => step.includes("actions/upload-artifact@") && step.includes(".junit-"));
    expect(uploads.length).toBe(3);
    for (const step of uploads) {
      const name = step.match(/name: (\S+)/)?.[1];
      expect({ name, hidden: /\n {10}include-hidden-files: true\n/.test(step) }).toEqual({
        name,
        hidden: true,
      });
    }
  });
});
