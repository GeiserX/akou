/**
 * Fails the Linux check when line or function coverage drops under its floor (docs/TESTING.md
 * TS-8 and TS-8b). The floor makes a large untested change visible; it is not a number to chase.
 *
 *   bun test --coverage --coverage-reporter=lcov ...
 *   bun scripts/ci/coverage-floor.ts coverage/lcov.info
 *
 * Bun's own `coverageThreshold` is not used: it holds every file to the bar on its own, so one
 * small file under it fails the run whatever the total. The totals here are summed over the lcov
 * records of the app's code (`src/`), and the core (`src/core/`, the event log and its fold) has a
 * stricter line floor of its own.
 */

import { existsSync, readFileSync } from "node:fs";

export interface Totals {
  lines: number;
  linesHit: number;
  functions: number;
  functionsHit: number;
}

/** What each part of the code must keep, as fractions. */
export interface Floors {
  lines: number;
  functions: number;
  coreLines: number;
}

export const FLOORS: Floors = { lines: 0.9, functions: 0.88, coreLines: 0.98 };

/** Per file, the counts of one lcov file (`SF`, `LF`, `LH`, `FNF`, `FNH`, `end_of_record`). */
export function parseLcov(text: string): Map<string, Totals> {
  const out = new Map<string, Totals>();
  let file: string | null = null;
  let t: Totals = { lines: 0, linesHit: 0, functions: 0, functionsHit: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    const key = colon < 0 ? line : line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (key === "SF") {
      file = value.replace(/\\/g, "/");
      t = { lines: 0, linesHit: 0, functions: 0, functionsHit: 0 };
    } else if (key === "LF") t.lines = Number(value);
    else if (key === "LH") t.linesHit = Number(value);
    else if (key === "FNF") t.functions = Number(value);
    else if (key === "FNH") t.functionsHit = Number(value);
    else if (key === "end_of_record" && file !== null) {
      out.set(file, t);
      file = null;
    }
  }
  return out;
}

/** The summed counts of the files under `prefix`. */
export function sumUnder(files: Map<string, Totals>, prefix: string): Totals {
  const s: Totals = { lines: 0, linesHit: 0, functions: 0, functionsHit: 0 };
  for (const [f, t] of files) {
    if (!f.startsWith(prefix)) continue;
    s.lines += t.lines;
    s.linesHit += t.linesHit;
    s.functions += t.functions;
    s.functionsHit += t.functionsHit;
  }
  return s;
}

const pct = (hit: number, of: number) => `${((100 * hit) / of).toFixed(2)} %`;

/** One line per measure, and the problems: empty when every floor holds. */
export function judge(
  files: Map<string, Totals>,
  floors: Floors = FLOORS,
): { report: string[]; problems: string[] } {
  const all = sumUnder(files, "src/");
  const core = sumUnder(files, "src/core/");
  const checks: [string, number, number, number][] = [
    ["src/ lines", all.linesHit, all.lines, floors.lines],
    ["src/ functions", all.functionsHit, all.functions, floors.functions],
    ["src/core/ lines", core.linesHit, core.lines, floors.coreLines],
  ];
  const report: string[] = [];
  const problems: string[] = [];
  for (const [name, hit, of, floor] of checks) {
    if (of === 0) {
      problems.push(`${name}: no records; did bun test run with --coverage-reporter=lcov?`);
      continue;
    }
    report.push(`${name}: ${pct(hit, of)} (${hit} of ${of}), floor ${(100 * floor).toFixed(1)} %`);
    if (hit / of < floor)
      problems.push(
        `${name}: ${pct(hit, of)} is under the floor of ${(100 * floor).toFixed(1)} %. Test the code this change added, or, if the drop is intended, lower the floor in scripts/ci/coverage-floor.ts in the same diff`,
      );
  }
  return { report, problems };
}

if (import.meta.main) {
  const [lcov] = process.argv.slice(2);
  if (!lcov) {
    console.error("usage: bun scripts/ci/coverage-floor.ts <lcov.info>");
    process.exit(64);
  }
  if (!existsSync(lcov)) {
    console.error(`coverage-floor: ${lcov} is missing; did bun test run with --coverage?`);
    process.exit(1);
  }
  const { report, problems } = judge(parseLcov(readFileSync(lcov, "utf8")));
  for (const r of report) console.log(`coverage-floor: ${r}`);
  for (const p of problems) console.error(`coverage-floor: ${p}`);
  if (problems.length > 0) process.exit(1);
}
