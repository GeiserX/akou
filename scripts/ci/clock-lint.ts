/**
 * No new code reads the wall clock directly (docs/TESTING.md TS-4, TRAPS [T4.31]).
 *
 *   bun scripts/ci/clock-lint.ts            fail when a file in src/ has more bare calls than its baseline
 *   bun scripts/ci/clock-lint.ts --write    write the counts of today as the baseline
 *
 * A bare call is `Date.now()`, `new Date()` with no argument, `setTimeout(` or `setInterval(` on a
 * line of code in `src/` with no `// clock: <reason>` on it or on the line just above. Code that
 * needs time takes it as an injected parameter (a clock, a `now`, a timer), so a test can drive it;
 * where real time is the point (a deadline on a process, a page's own animation), the reason says
 * so. Each file's count is held to `tests/clock-baseline.json`: a count above it fails, and a
 * count below it fails too until the baseline drops in the same diff, so the ratchet only turns
 * one way.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
export const BASELINE = join(ROOT, "tests", "clock-baseline.json");

const BARE =
  /Date\.now\(\)|new Date\(\)|(?<![\w.$])(?:(?:window|globalThis|self)\.)?set(?:Timeout|Interval)\(/g;

/** The bare calls of one file's text: line numbers, one entry per call. */
export function bareCalls(text: string): number[] {
  const out: number[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const code = line.trimStart();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
    if (line.includes("// clock:") || (lines[i - 1] ?? "").includes("// clock:")) continue;
    for (const _ of line.matchAll(BARE)) out.push(i + 1);
  }
  return out;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Bare calls per file under `src/`, as `src/...` paths with forward slashes; files with none left out. */
export function count(root = ROOT): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const f of sources(join(root, "src")).sort()) {
    const lines = bareCalls(readFileSync(f, "utf8"));
    if (lines.length > 0) out[relative(root, f).replaceAll("\\", "/")] = lines;
  }
  return out;
}

/** What is wrong against the baseline; empty when every file is at its baseline. */
export function judge(now: Record<string, number[]>, baseline: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [file, lines] of Object.entries(now)) {
    const allowed = baseline[file] ?? 0;
    if (lines.length > allowed)
      out.push(
        `${file}: ${lines.length} bare clock calls, the baseline is ${allowed} (lines ${lines.join(", ")}). Take the time as an injected parameter with a default, or put \`// clock: <why real time is right here>\` on the line or the line above`,
      );
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const n = now[file]?.length ?? 0;
    if (n < allowed)
      out.push(
        `${file}: ${n} bare clock calls, under the baseline of ${allowed}. Lower it in tests/clock-baseline.json in the same diff (\`bun scripts/ci/clock-lint.ts --write\`)`,
      );
  }
  return out;
}

if (import.meta.main) {
  const now = count();
  if (process.argv.includes("--write")) {
    const counts = Object.fromEntries(Object.entries(now).map(([f, l]) => [f, l.length]));
    writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`clock-lint: wrote ${Object.keys(counts).length} files to ${BASELINE}`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;
  const problems = judge(now, baseline);
  for (const p of problems) console.error(`clock-lint: ${p}`);
  if (problems.length > 0) process.exit(1);
  const total = Object.values(now).reduce((s, l) => s + l.length, 0);
  console.log(`clock-lint: ${total} bare clock calls in src/, none above the baseline`);
}
