/**
 * The gates that keep the suite honest (docs/TESTING.md TS-2, TRAPS T4.20), each with the positive
 * control that proves it can fail: a job that ran too few tests or skipped too many fails its
 * floor, a `test.todo` fails its job, and a committed `test.only` or `test.skip` fails
 * `bun run check`.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countsOf, judge, scaled, skippedOf } from "../scripts/ci/test-floor.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const FLOOR = join(ROOT, "scripts", "ci", "test-floor.ts");
/** Biome's launcher, which picks the platform's binary; run by this Bun on every OS. */
const BIOME = [process.execPath, join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome")];

function run(argv: string[]) {
  const r = Bun.spawnSync(argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

/**
 * A JUnit file as `bun test --reporter=junit` writes it, with these totals and these skipped test
 * cases (a `test.todo` is written as `<skipped message="TODO" />`, a skip as `<skipped />`).
 */
function junit(
  tests: number,
  failures: number,
  skipped: number,
  cases: { name: string; todo?: boolean }[] = [],
): string {
  const body = cases
    .map(
      (c) =>
        `    <testcase name="${c.name}" classname="gates" time="0" file="a.test.ts" line="1" assertions="0">\n      <skipped${c.todo ? ' message="TODO"' : ""} />\n    </testcase>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="${tests}" assertions="${tests}" failures="${failures}" skipped="${skipped}" time="0.1">
  <testsuite name="a.test.ts" file="a.test.ts" tests="${tests}" assertions="${tests}" failures="${failures}" skipped="${skipped}" time="0.1">
${body}
  </testsuite>
</testsuites>
`;
}

describe("[T4.20] a job that runs too few tests fails", () => {
  test("the totals are read from the run's root element", () => {
    expect(countsOf(junit(846, 0, 9))).toEqual({
      tests: 846,
      failures: 0,
      skipped: 9,
      todo: 0,
      pass: 837,
    });
    expect(() => countsOf("<testsuite tests='1'/>")).toThrow("no <testsuites>");
  });

  test("at the floor passes; one below it, or one skip too many, fails", () => {
    const c = countsOf(junit(846, 0, 9));
    expect(judge("check:linux", c, { minPass: 837, maxSkip: 9 })).toEqual([]);
    // Each message says what to do, not only what is wrong.
    expect(judge("check:linux", c, { minPass: 838, maxSkip: 9 })).toEqual([
      "check:linux: 837 tests passed, the floor is 838. A test stopped running or was removed; if that is intended, lower minPass in tests/floors.json in the same diff",
    ]);
    expect(judge("check:linux", c, { minPass: 837, maxSkip: 8 })).toEqual([
      "check:linux: 9 tests skipped, at most 8 may be. A new skip raises maxSkip in tests/floors.json in the same diff; the floor counts CI's skips, so a machine without a model, device or network skips more (the skipped tests are listed below)",
    ]);
    expect(judge("check:linux", c, undefined)).toEqual([
      'no floor for check:linux: add { "minPass": <passed>, "maxSkip": <skipped> } for it to tests/floors.json',
    ]);
    // A dispatch that ran every test 50 times is held to 50 times the floor.
    expect(scaled({ minPass: 837, maxSkip: 9 }, 50)).toEqual({ minPass: 41_850, maxSkip: 450 });
  });

  test("a test.todo fails the job however much room the skip floor has", () => {
    const xml = junit(3, 0, 2, [{ name: "gated (no model)" }, { name: "later", todo: true }]);
    const c = countsOf(xml);
    expect(c).toMatchObject({ skipped: 2, todo: 1, pass: 1 });
    expect(skippedOf(xml)).toEqual([
      { name: "a.test.ts: gates > gated (no model)", todo: false },
      { name: "a.test.ts: gates > later", todo: true },
    ]);
    // Names are unescaped from the XML.
    expect(skippedOf(junit(1, 0, 1, [{ name: "the &quot;x&quot; &amp; &lt;y&gt; case" }]))).toEqual(
      [{ name: 'a.test.ts: gates > the "x" & <y> case', todo: false }],
    );
    expect(judge("check:linux", c, { minPass: 1, maxSkip: 5 })).toEqual([
      "check:linux: 1 test.todo placeholder; write the test or delete it",
    ]);
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
      // Too many skips, or a todo, fails and names every skipped test.
      writeFileSync(
        xml,
        junit(22, 0, 2, [{ name: "gated (no model)" }, { name: "later", todo: true }]),
      );
      const todo = run([process.execPath, FLOOR, "capture-e2e", xml, floors(20)]);
      expect(todo.code).toBe(1);
      expect(todo.out).toContain("2 tests skipped, at most 0 may be");
      expect(todo.out).toContain("1 test.todo placeholder");
      expect(todo.out).toContain("skipped: a.test.ts: gates > gated (no model)");
      expect(todo.out).toContain("skipped: a.test.ts: gates > later (test.todo)");
      // A job with no floor, and a run that wrote no JUnit file, fail too.
      expect(run([process.execPath, FLOOR, "no-such-job", xml, floors(20)]).code).toBe(1);
      expect(run([process.execPath, FLOOR, "capture-e2e", join(t.dir, "none.xml")]).code).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  test("every job ci.yml hands to the floor script has a floor", () => {
    const yaml = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const floors = Object.keys(
      JSON.parse(readFileSync(join(ROOT, "tests", "floors.json"), "utf8")),
    );
    const jobs = [...yaml.matchAll(/test-floor\.ts ((?:\$\{\{[^}]*\}\}|[^\s$])+) /g)].map(
      (m) => m[1] as string,
    );
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      // A job named from the matrix (`capture-live-${{ matrix.server }}`) matches any value.
      const name = new RegExp(`^${job.replace(/\$\{\{[^}]*\}\}/g, "[a-z0-9-]+")}:`);
      expect({ job, floors: floors.filter((k) => name.test(k)).length > 0 }).toEqual({
        job,
        floors: true,
      });
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

describe("a ci.yml step that reads $NAME never falls to PowerShell by default", () => {
  type Step = { name?: string; run?: string; shell?: string };
  type Job = {
    "runs-on"?: unknown;
    strategy?: unknown;
    defaults?: { run?: { shell?: string } };
    steps?: Step[];
  };

  /**
   * Steps of a job that can run on Windows whose script reads an environment variable the POSIX
   * way (`$NAME`, `"$NAME"`) but would run in PowerShell, where `$NAME` is an unset PowerShell
   * variable and expands to nothing. Windows' default shell is pwsh unless the step, the job or
   * the workflow names one; a step that names pwsh means PowerShell's `$env:NAME` on purpose.
   */
  function posixStepsOutsideBash(yaml: string): string[] {
    const wf = Bun.YAML.parse(yaml) as {
      defaults?: { run?: { shell?: string } };
      jobs: Record<string, Job>;
    };
    const out: string[] = [];
    for (const [id, job] of Object.entries(wf.jobs)) {
      const where = JSON.stringify([job["runs-on"], job.strategy]);
      if (!where.includes("windows")) continue;
      for (const step of job.steps ?? []) {
        if (!step.run || !/\$[A-Za-z_]/.test(step.run)) continue;
        const shell = step.shell ?? job.defaults?.run?.shell ?? wf.defaults?.run?.shell;
        if (shell === undefined) out.push(`${id}: ${step.name ?? step.run.split("\n")[0]}`);
      }
    }
    return out;
  }

  test("every such step in ci.yml names its shell, itself or through its job", () => {
    const yaml = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(posixStepsOutsideBash(yaml)).toEqual([]);
  });

  test("positive control: a $NAME step on a Windows leg with no shell is caught", () => {
    const yaml = `
jobs:
  check:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: bun test --rerun-each "$TEST_REPEAT"
      - run: bun run check
      - shell: bash
        run: echo "$TEST_REPEAT"
      - shell: pwsh
        run: echo $env:TEST_REPEAT
  linux:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$HOME"
`;
    expect(posixStepsOutsideBash(yaml)).toEqual(['check: bun test --rerun-each "$TEST_REPEAT"']);
  });
});

describe("[CI-2] one workflow, one required check", () => {
  type Wf = {
    jobs: Record<
      string,
      { needs?: string | string[]; if?: string; steps?: { id?: string; run?: string }[] }
    >;
  };
  const ciYaml = () => readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

  /** The pattern the `changes` job greps: a changed file it matches is documentation. */
  function docsPattern(yaml: string): RegExp {
    const wf = Bun.YAML.parse(yaml) as Wf;
    const run = wf.jobs.changes?.steps?.find((s) => s.id === "diff")?.run ?? "";
    const m = /grep -qvE '([^']+)'/.exec(run);
    if (!m) throw new Error("the changes job has no `grep -qvE '<pattern>'`");
    return new RegExp(m[1] as string);
  }
  /** What the `changes` job answers for a pull request that changed these files. */
  const needsCode = (re: RegExp, files: string[]) => files.some((f) => !re.test(f));

  test("docs, top-level Markdown and the tracker's .beads/ export are documentation; anything else is code", () => {
    const re = docsPattern(ciYaml());
    // PR #27 changed only these and ran every heavy leg.
    expect(needsCode(re, [".beads/issues.jsonl", ".beads/interactions.jsonl"])).toBe(false);
    expect(
      needsCode(re, ["docs/TESTING.md", "README.md", "CHANGELOG.md", ".beads/config.yaml"]),
    ).toBe(false);
    for (const code of [
      "src/main/index.ts",
      "tests/floors.json",
      ".github/workflows/ci.yml",
      "package.json",
      "native/akou-capture/README.md",
      "scripts/.beads/x.ts",
    ])
      expect({ code, needsCode: needsCode(re, ["docs/INDEX.md", code]) }).toEqual({
        code,
        needsCode: true,
      });
  });

  test("positive control: the filter before the fix counted a tracker-only change as code", () => {
    const before = ciYaml().replace("^(docs/|\\.beads/|[^/]+\\.md$)", "^(docs/|[^/]+\\.md$)");
    expect(before).not.toBe(ciYaml());
    expect(needsCode(docsPattern(before), [".beads/issues.jsonl"])).toBe(true);
  });

  /** Jobs that are neither the aggregate nor in its `needs`: a leg that could fail unseen. */
  function outsideAggregate(yaml: string): string[] {
    const wf = Bun.YAML.parse(yaml) as Wf;
    const agg = wf.jobs["ci-ok"];
    if (!agg) return ["ci-ok is missing"];
    const needs = new Set([agg.needs ?? []].flat());
    const out = Object.keys(wf.jobs).filter((j) => j !== "ci-ok" && !needs.has(j));
    if (agg.if !== "always()") out.push("ci-ok must run with if: always()");
    return out;
  }

  test("ci-ok needs every other job and always runs, so a failed leg turns it red", () => {
    expect(outsideAggregate(ciYaml())).toEqual([]);
  });

  test("positive control: a leg left out of ci-ok's needs is caught", () => {
    const extra = ciYaml().replace(
      /\n {2}ci-ok:\n/,
      "\n  stray:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: exit 1\n\n  ci-ok:\n",
    );
    expect(outsideAggregate(extra)).toEqual(["stray"]);
  });
});
