/**
 * One Bun version for CI and every machine (docs/TESTING.md): `.bun-version` pins it, the
 * workflows install it (`bun-version-file`), and `bun run check` starts here and refuses to run
 * under any other Bun. Bun changes behaviour between minor versions (1.4 closes the socket on its
 * own 413), so a suite that passes on one Bun proves nothing about another.
 *
 * To run the pinned Bun without changing the one installed on the machine:
 *
 *   bunx bun@$(cat .bun-version) run check
 *
 *   bun scripts/ci/bun-version.ts [pin-file]   exit 1 unless this Bun is the pinned one
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PIN_FILE = join(import.meta.dir, "..", "..", ".bun-version");

/** The pinned version, from a `.bun-version` file. */
export function pinnedBun(file = PIN_FILE): string {
  return readFileSync(file, "utf8").trim();
}

/** Why `running` may not run the checks, or null when it is the pinned version. */
export function bunMismatch(pinned: string, running: string): string | null {
  if (pinned === running) return null;
  return `this repository pins Bun ${pinned} (.bun-version) and this is Bun ${running}. Run the pinned one without installing it: bunx bun@${pinned} run check`;
}

/**
 * The Bun versions a workflow installs: each `bun-version:` or `BUN_VERSION:` value, with
 * `${{ env.BUN_VERSION }}` left out (it names the other), and `bun-version-file:` as the file it
 * names.
 */
export function workflowBunVersions(yaml: string): string[] {
  const out: string[] = [];
  for (const m of yaml.matchAll(/^\s*(bun-version|BUN_VERSION|bun-version-file):\s*(\S+)/gm)) {
    const v = (m[2] as string).replace(/^["']|["']$/g, "");
    if (v.startsWith("${{")) continue;
    out.push(m[1] === "bun-version-file" ? `file:${v}` : v);
  }
  return out;
}

if (import.meta.main) {
  const problem = bunMismatch(pinnedBun(process.argv[2]), Bun.version);
  if (problem) {
    console.error(`bun-version: ${problem}`);
    process.exit(1);
  }
}
