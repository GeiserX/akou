/**
 * A stable release needs its evidence on record (docs/CI-CD.md CI-28): for a version outside 0.x,
 * `stamp-version.ts --check` fails unless the newest row of the terms table in providers.md is
 * dated after the previous stable tag, and every M0 gate G1 to G8 has a Pass verdict in the
 * summary table of docs/gates/M0-results.md. Prereleases are never blocked.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateProblems,
  isStable,
  main,
  previousStable,
  termsProblems,
} from "../scripts/stamp-version.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const PROVIDERS = "docs/providers.md";
const GATES = "docs/gates/M0-results.md";

/** The files `--check` reads, copied from the repository as they are today. */
function repoCopy(): { dir: string; cleanup(): void } {
  const t = tempDir();
  for (const f of [
    "package.json",
    "src/main/app-info.ts",
    "skills/akou/SKILL.md",
    "skills/akou-vocab/SKILL.md",
    PROVIDERS,
    GATES,
  ]) {
    mkdirSync(join(t.dir, f, ".."), { recursive: true });
    cpSync(join(ROOT, f), join(t.dir, f));
  }
  return t;
}

/** Runs `main`, returning its exit code and everything it printed. */
function check(argv: string[]): { code: number; out: string } {
  const [log, err] = [console.log, console.error];
  const lines: string[] = [];
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    return { code: main(argv), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/**
 * A git repository at `dir` with one commit, and each of `tags` as an annotated tag on it made on
 * its date. Two git processes in all (`init`, then one `fast-import` stream), because every git
 * start costs seconds on a loaded laptop.
 */
function withTags(dir: string, tags: [string, string][]): void {
  // The user's own git settings (hooks, signing) never reach these scratch repositories. The
  // global config is an empty file, not the null device: git on Windows cannot open `\\.\nul`.
  const empty = join(dir, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1" };
  const run = (args: string[], stdin?: string) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], {
      env,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  run(["init", "-q"]);
  const who = (date: string) =>
    `t <t@example.invalid> ${Date.parse(`${date}T12:00:00Z`) / 1000} +0000`;
  const stream = [
    "commit refs/heads/main",
    "mark :1",
    `committer ${who("2026-01-01")}`,
    "data 4",
    "base",
    ...tags.flatMap(([tag, date]) => [
      `tag ${tag}`,
      "from :1",
      `tagger ${who(date)}`,
      `data ${tag.length}`,
      tag,
    ]),
    "",
  ].join("\n");
  run(["fast-import", "--quiet"], stream);
}

const TERMS_HEAD = "| Date checked | Anthropic | OpenAI | Change made |\n|---|---|---|---|\n";
const terms = (...rows: string[]) =>
  `# Providers\n\n${TERMS_HEAD}${rows.map((r) => `| ${r} | ok | ok | none |`).join("\n")}\n`;
const gates = (rows: [string, string][]) =>
  `# M0\n\n## Summary\n\n| Gate | Verdict | Key numbers |\n|---|---|---|\n${rows
    .map(([g, v]) => `| ${g} | ${v} | n |`)
    .join("\n")}\n\n## Other\n\n| Gate | Verdict |\n|---|---|\n| G1 | Pass |\n`;
/** Each test below runs git a few times; a loaded laptop takes a second per call. */
const GIT_TIMEOUT = 30_000;

const ALL_PASS: [string, string][] = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"].map((g) => [
  g,
  "Pass",
]);

describe("[CI-28] a stable release needs the terms check and every M0 gate on record", () => {
  test("stable means 1.0.0 or later with no prerelease part", () => {
    expect(isStable("1.0.0")).toBe(true);
    expect(isStable("2.3.4+build.5")).toBe(true);
    expect(isStable("0.9.0")).toBe(false);
    expect(isStable("1.0.0-rc.1")).toBe(false);
  });

  test("the terms table's newest dated row must be later than the previous stable tag", () => {
    expect(termsProblems(terms("2027-02-01"), null)).toEqual([]);
    expect(termsProblems(terms("2027-01-01", "2027-03-01"), "2027-02-15")).toEqual([]);
    expect(termsProblems(terms("2027-03-01", "2027-01-01"), "2027-02-15")).toEqual([]);
    expect(termsProblems(terms("2027-02-15"), "2027-02-15")).toEqual([
      "docs/providers.md: the newest terms check is dated 2027-02-15, not after the previous stable release (2027-02-15); read the current terms and add a dated row",
    ]);
    expect(termsProblems(terms("not yet checked"), null)).toEqual([
      "docs/providers.md: the terms table has no dated row; read the current terms and add one (YYYY-MM-DD)",
    ]);
    expect(termsProblems("# Providers\n", null)).toEqual([
      "docs/providers.md: no terms table (| Date checked | ...)",
    ]);
  });

  test("every gate G1 to G8 needs a row whose verdict is Pass, in the summary table only", () => {
    expect(gateProblems(gates(ALL_PASS))).toEqual([]);
    // A qualified pass is a pass; the verdict's first word decides.
    const qualified = ALL_PASS.map(([g, v]): [string, string] =>
      g === "G6" ? ["G6", "Pass (M-series half)"] : [g, v],
    );
    expect(gateProblems(gates(qualified))).toEqual([]);
    const some = ALL_PASS.filter(([g]) => g !== "G2").map(([g, v]): [string, string] =>
      g === "G3" ? ["G3 (lite)", "Partial"] : g === "G4" ? ["G4", "Passable"] : [g, v],
    );
    expect(gateProblems(gates(some))).toEqual([
      "docs/gates/M0-results.md: G2 has no row in the summary table",
      "docs/gates/M0-results.md: G3 is Partial, not Pass",
      "docs/gates/M0-results.md: G4 is Passable, not Pass",
    ]);
    expect(gateProblems("# M0\n")).toEqual([
      "docs/gates/M0-results.md: no summary table (## Summary, then | Gate | Verdict | ...)",
    ]);
  });

  test(
    "positive control: a v1.0.0 dry run fails today on both counts",
    () => {
      const t = repoCopy();
      try {
        expect(check(["--set", "1.0.0", "--root", t.dir]).code).toBe(0);
        const r = check(["--check", "--tag", "v1.0.0", "--root", t.dir]);
        expect(r.code).toBe(1);
        expect(r.out).toContain("docs/providers.md: the terms table has no dated row");
        for (const g of ["G1", "G2", "G7"])
          expect(r.out).toContain(`docs/gates/M0-results.md: ${g} has no row in the summary table`);
        expect(r.out).toContain("docs/gates/M0-results.md: G3 is Partial, not Pass");
        expect(r.out).toContain("docs/gates/M0-results.md: G4 is Partial, not Pass");
        // G5, G6 and G8 are on record as passed.
        for (const g of ["G5", "G6", "G8"]) expect(r.out).not.toContain(`: ${g} `);
        // Outside a checkout it also says it could not read the tags, and still lists the rest.
        expect(r.out).toContain("cannot list the tags");
      } finally {
        t.cleanup();
      }
    },
    GIT_TIMEOUT,
  );

  test(
    "with the evidence on record the same dry run passes, and a prerelease never waits for it",
    () => {
      const t = repoCopy();
      try {
        expect(check(["--set", "1.0.0-rc.1", "--root", t.dir]).code).toBe(0);
        expect(check(["--check", "--tag", "v1.0.0-rc.1", "--root", t.dir]).code).toBe(0);
        expect(check(["--set", "1.0.0", "--root", t.dir]).code).toBe(0);
        writeFileSync(join(t.dir, PROVIDERS), terms("not yet checked", "2027-02-01"));
        writeFileSync(join(t.dir, GATES), gates(ALL_PASS));
        withTags(t.dir, [["v0.9.0", "2027-01-01"]]);
        const r = check(["--check", "--tag", "v1.0.0", "--root", t.dir]);
        expect(r.out).toContain("places say 1.0.0");
        expect(r.code).toBe(0);
      } finally {
        t.cleanup();
      }
    },
    GIT_TIMEOUT,
  );

  test(
    "the previous stable tag comes from git: the newest stable tag below this version",
    () => {
      const t = repoCopy();
      try {
        withTags(t.dir, [
          ["v0.9.0", "2027-01-01"],
          ["v1.0.0", "2027-02-01"],
          ["v1.1.0-rc.1", "2027-03-01"],
          ["v1.1.0", "2027-03-10"],
          ["v2.0.0", "2027-05-01"],
        ]);
        expect(previousStable(t.dir, "1.2.0")).toEqual({ tag: "v1.1.0", date: "2027-03-10" });
        expect(previousStable(t.dir, "1.1.0")).toEqual({ tag: "v1.0.0", date: "2027-02-01" });
        expect(previousStable(t.dir, "1.0.0")).toBeNull();
        // Terms read on 2027-03-05, before v1.1.0 shipped: 1.2.0 must wait for a new reading.
        expect(check(["--set", "1.2.0", "--root", t.dir]).code).toBe(0);
        writeFileSync(join(t.dir, PROVIDERS), terms("2027-03-05"));
        writeFileSync(join(t.dir, GATES), gates(ALL_PASS));
        const stale = check(["--check", "--root", t.dir]);
        expect(stale.code).toBe(1);
        expect(stale.out).toContain("not after the previous stable release (2027-03-10)");
        writeFileSync(join(t.dir, PROVIDERS), terms("2027-03-05", "2027-03-11"));
        expect(check(["--check", "--root", t.dir]).code).toBe(0);
      } finally {
        t.cleanup();
      }
    },
    GIT_TIMEOUT,
  );

  test(
    "a stable version outside a git checkout fails rather than guess the previous release",
    () => {
      const t = repoCopy();
      try {
        expect(check(["--set", "1.0.0", "--root", t.dir]).code).toBe(0);
        writeFileSync(join(t.dir, PROVIDERS), terms("2027-02-01"));
        writeFileSync(join(t.dir, GATES), gates(ALL_PASS));
        const r = check(["--check", "--root", t.dir]);
        expect(r.code).toBe(1);
        expect(r.out).toContain("cannot list the tags");
        // A folder inside a checkout is not its top: its tags would belong to another project.
        withTags(t.dir, [["v1.0.0", "2027-01-01"]]);
        expect(previousStable(t.dir, "1.1.0")).toEqual({ tag: "v1.0.0", date: "2027-01-01" });
        expect(() => previousStable(join(t.dir, "docs"), "1.1.0")).toThrow(
          "not the top of a git checkout",
        );
      } finally {
        t.cleanup();
      }
    },
    GIT_TIMEOUT,
  );

  test(
    "a shallow clone fails rather than read as the first stable release",
    () => {
      const t = repoCopy();
      try {
        withTags(t.dir, []);
        // Positive control: a full history with no tags is a first stable release.
        expect(previousStable(t.dir, "1.0.0")).toBeNull();
        // A shallow clone lists no tags either; git marks it with .git/shallow.
        const head = Bun.spawnSync(["git", "-C", t.dir, "rev-parse", "HEAD"]).stdout.toString();
        writeFileSync(join(t.dir, ".git", "shallow"), head);
        expect(() => previousStable(t.dir, "1.0.0")).toThrow("shallow clone");
      } finally {
        t.cleanup();
      }
    },
    GIT_TIMEOUT,
  );

  test("the release workflow's version check sees every tag", () => {
    const wf = Bun.YAML.parse(
      readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
    ) as { jobs: { version: { steps: { uses?: string; with?: { "fetch-depth"?: number } }[] } } };
    const checkout = wf.jobs.version.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    // A shallow checkout (the default depth of 1) has no earlier tag, so every stable release
    // would read as the first one and pass a stale terms check.
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  test("the release checklist carries the same two lines", () => {
    const list = readFileSync(join(ROOT, "scripts", "release-checklist.md"), "utf8");
    expect(list).toContain("docs/providers.md");
    expect(list).toContain("docs/gates/M0-results.md");
    expect(list).toMatch(/terms[^\n]*dated[^\n]*after the previous stable/i);
    expect(list).toMatch(/G1 to G8[^\n]*Pass/);
  });
});
