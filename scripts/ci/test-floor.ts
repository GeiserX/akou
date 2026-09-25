/**
 * Fails a job that ran too few tests or skipped too many (docs/TESTING.md TS-2, TRAPS T4.20). A
 * job whose tests silently stop running, because a file stopped matching, a gate turned into a
 * skip or a describe went missing, passes `bun test`; it does not pass this.
 *
 *   bun test --reporter=junit --reporter-outfile=.junit-<job>.xml
 *   bun scripts/ci/test-floor.ts <job> .junit-<job>.xml [floors.json]
 *
 * The floor is `tests/floors.json` at `<job>:<platform>` (`check:linux`, `ui:linux`, ...):
 * `{ minPass, maxSkip }`. Adding tests needs no edit; a new skip needs `maxSkip` raised in the same
 * diff. A job with no floor fails, so a new job cannot run without one. `TEST_REPEAT=<n>` (a CI
 * dispatch that runs every test n times with `--rerun-each`) scales both bounds by n.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Floor {
  minPass: number;
  maxSkip: number;
}

export interface Counts {
  tests: number;
  failures: number;
  skipped: number;
  pass: number;
}

/** The run's totals, from the root `<testsuites>` element Bun writes. */
export function countsOf(xml: string): Counts {
  const root = /<testsuites\b([^>]*)>/.exec(xml)?.[1];
  if (root === undefined) throw new Error("no <testsuites> element in the JUnit file");
  const attr = (name: string): number => {
    const v = new RegExp(`\\b${name}="(\\d+)"`).exec(root)?.[1];
    if (v === undefined) throw new Error(`no ${name} count on <testsuites>`);
    return Number(v);
  };
  const tests = attr("tests");
  const failures = attr("failures");
  const skipped = attr("skipped");
  return { tests, failures, skipped, pass: tests - failures - skipped };
}

/** The floor of a run where every test ran `repeat` times. */
export function scaled(floor: Floor, repeat: number): Floor {
  return { minPass: floor.minPass * repeat, maxSkip: floor.maxSkip * repeat };
}

/** What is wrong with a run against its floor; empty when it passes. */
export function judge(key: string, c: Counts, floor: Floor | undefined): string[] {
  if (!floor) return [`no floor for ${key} in tests/floors.json`];
  const out: string[] = [];
  if (c.pass < floor.minPass)
    out.push(`${key}: ${c.pass} tests passed, the floor is ${floor.minPass}`);
  if (c.skipped > floor.maxSkip)
    out.push(`${key}: ${c.skipped} tests skipped, at most ${floor.maxSkip} may be`);
  return out;
}

if (import.meta.main) {
  const [job, junit, floorsPath = join(import.meta.dir, "..", "..", "tests", "floors.json")] =
    process.argv.slice(2);
  if (!job || !junit) {
    console.error("usage: bun scripts/ci/test-floor.ts <job> <junit.xml> [floors.json]");
    process.exit(64);
  }
  if (!existsSync(junit)) {
    console.error(`test-floor: ${junit} is missing; did bun test run with --reporter=junit?`);
    process.exit(1);
  }
  const key = `${job}:${process.platform}`;
  const repeat = Number(process.env.TEST_REPEAT || "1");
  if (!Number.isInteger(repeat) || repeat < 1) {
    console.error(`test-floor: TEST_REPEAT must be a whole number from 1, not ${repeat}`);
    process.exit(64);
  }
  const floors = JSON.parse(readFileSync(floorsPath, "utf8")) as Record<string, Floor>;
  const floor = floors[key] && scaled(floors[key], repeat);
  const c = countsOf(readFileSync(junit, "utf8"));
  const problems = judge(key, c, floor);
  if (problems.length > 0) {
    for (const p of problems) console.error(`test-floor: ${p}`);
    process.exit(1);
  }
  const f = floor as Floor;
  console.log(
    `test-floor: ${key}: ${c.pass} passed (floor ${f.minPass}), ${c.skipped} skipped (at most ${f.maxSkip})`,
  );
}
