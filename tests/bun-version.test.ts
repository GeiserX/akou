/**
 * One Bun version for CI and every machine: `.bun-version` pins it, every workflow installs it and
 * `bun run check` refuses any other, each with the positive control that proves it can fail.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bunMismatch,
  PIN_FILE,
  pinnedBun,
  workflowBunVersions,
} from "../scripts/ci/bun-version.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const BUN_VERSION = join(ROOT, "scripts", "ci", "bun-version.ts");

function run(argv: string[]) {
  const r = Bun.spawnSync(argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("one Bun version for CI and every machine", () => {
  test("a different Bun is refused with the command that runs the pinned one", () => {
    expect(bunMismatch("1.4.2", "1.4.2")).toBeNull();
    expect(bunMismatch("1.4.2", "1.3.12")).toBe(
      "this repository pins Bun 1.4.2 (.bun-version) and this is Bun 1.3.12. Run the pinned one without installing it: bunx bun@1.4.2 run check",
    );
  });

  test("positive control: the check exits 1 under a pin this Bun is not, 0 under its own", () => {
    const t = tempDir();
    try {
      const other = join(t.dir, "other");
      writeFileSync(other, "0.0.1\n");
      const refused = run([process.execPath, BUN_VERSION, other]);
      expect(refused.code).toBe(1);
      expect(refused.out).toContain(`pins Bun 0.0.1 (.bun-version) and this is Bun ${Bun.version}`);
      const own = join(t.dir, "own");
      writeFileSync(own, `${Bun.version}\n`);
      expect(run([process.execPath, BUN_VERSION, own]).code).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  test("every workflow installs the pinned Bun", () => {
    const pin = pinnedBun(PIN_FILE);
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    const dir = join(ROOT, ".github", "workflows");
    const seen: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
      for (const v of workflowBunVersions(readFileSync(join(dir, f), "utf8"))) {
        seen.push(`${f}: ${v}`);
        expect([`${f}: ${pin}`, `${f}: file:.bun-version`]).toContain(`${f}: ${v}`);
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  test("package.json names no Bun but the pinned one", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const named = pkg.engines?.bun;
    if (named !== undefined) expect(named).toBe(pinnedBun(PIN_FILE));
  });

  test("positive control: a workflow on another Bun is seen", () => {
    const yaml = [
      "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0",
      "        with:",
      "          bun-version: 1.3.12",
      "  BUN_VERSION: 1.4.2",
      `          bun-version: \${{ env.BUN_VERSION }}`,
      "          bun-version-file: .bun-version",
    ].join("\n");
    expect(workflowBunVersions(yaml)).toEqual(["1.3.12", "1.4.2", "file:.bun-version"]);
  });
});
