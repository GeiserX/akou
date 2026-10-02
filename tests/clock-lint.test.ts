/**
 * No new code reads the wall clock directly (docs/TESTING.md TS-4): `scripts/ci/clock-lint.ts`
 * holds every file in src/ to `tests/clock-baseline.json`, with the positive controls that prove
 * it can fail.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE, bareCalls, count, judge } from "../scripts/ci/clock-lint.ts";
import { tempDir } from "./helpers.ts";

describe("[TS-4] no new code reads the wall clock directly", () => {
  test("src/ is at its baseline, and the baseline is empty: every call is injected or has its reason", () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    expect(judge(count(), baseline)).toEqual([]);
    expect(baseline).toEqual({});
  });

  test("the four calls count, wherever they sit on a line; injected ones and arguments do not", () => {
    const src = [
      "const a = Date.now();",
      "const b = new Date();",
      "const c = new Date(at);",
      "setTimeout(fn, 10); window.setInterval(fn, 10);",
      "clock.setTimeout(fn, 10);",
      "const later = (ms) => this.timers.setTimeout(fn, ms);",
      "clearTimeout(t);",
      "// Date.now() in a comment",
      " * new Date() in a doc comment",
    ].join("\n");
    expect(bareCalls(src)).toEqual([1, 2, 4, 4]);
  });

  test("a `// clock:` reason on the line or the line above lets a call through", () => {
    expect(
      bareCalls("// clock: a deadline on a process\nconst t = setTimeout(kill, 5000);"),
    ).toEqual([]);
    expect(bareCalls("const now = Date.now(); // clock: the page's own clock")).toEqual([]);
    // Two lines above is too far: the reason sits next to what it excuses.
    expect(bareCalls("// clock: far away\n\nconst now = Date.now();")).toEqual([3]);
  });

  test("positive control: one bare Date.now() in a scratch file fails, and lowering asks for the baseline to drop", () => {
    const t = tempDir();
    mkdirSync(join(t.dir, "src", "main"), { recursive: true });
    writeFileSync(join(t.dir, "src", "main", "scratch.ts"), "export const at = Date.now();\n");
    const now = count(t.dir);
    expect(now).toEqual({ "src/main/scratch.ts": [1] });
    const [problem] = judge(now, {});
    expect(problem).toStartWith(
      "src/main/scratch.ts: 1 bare clock calls, the baseline is 0 (lines 1)",
    );
    expect(judge(now, { "src/main/scratch.ts": 1 })).toEqual([]);
    expect(judge({}, { "src/main/scratch.ts": 1 })[0]).toContain("under the baseline of 1");
    t.cleanup();
  });
});
