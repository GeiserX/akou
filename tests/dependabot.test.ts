/**
 * Dependabot, grouped and weekly (docs/CI-CD.md CI-13): `.github/dependabot.yml` covers Bun, every
 * Rust crate under `native/` and the workflow actions; minor and patch updates arrive as one pull
 * request per ecosystem per week, majors alone, and every ignore says why in a comment above it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FILE = join(ROOT, ".github", "dependabot.yml");

interface Update {
  "package-ecosystem"?: string;
  directory?: string;
  directories?: string[];
  schedule?: { interval?: string };
  groups?: Record<string, { "update-types"?: string[] }>;
  ignore?: { "dependency-name"?: string }[];
}

/** Every crate under `native/`, as the directory Dependabot names (`/native/<crate>`). */
function crates(): string[] {
  const native = join(ROOT, "native");
  return readdirSync(native)
    .filter((d) => existsSync(join(native, d, "Cargo.toml")))
    .map((d) => `/native/${d}`)
    .sort();
}

/** What is wrong with a dependabot.yml against the CI-13 rules; empty when it holds. */
function problems(yaml: string, crateDirs: string[]): string[] {
  const out: string[] = [];
  const cfg = Bun.YAML.parse(yaml) as { version?: number; updates?: Update[] };
  if (cfg.version !== 2) out.push("version must be 2");
  const updates = cfg.updates ?? [];
  const eco = (name: string) => updates.find((u) => u["package-ecosystem"] === name);
  for (const name of ["bun", "cargo", "github-actions"]) {
    const u = eco(name);
    if (!u) {
      out.push(`${name}: no entry`);
      continue;
    }
    if (u.schedule?.interval !== "weekly") out.push(`${name}: not weekly`);
    const groups = Object.entries(u.groups ?? {});
    const minorPatch = groups.filter(
      ([, g]) => [...(g["update-types"] ?? [])].sort().join(",") === "minor,patch",
    );
    if (minorPatch.length !== 1) out.push(`${name}: needs one group of minor and patch updates`);
    for (const [id, g] of groups)
      if ((g["update-types"] ?? ["major"]).includes("major"))
        out.push(`${name}: group ${id} takes majors, which must come alone`);
  }
  const cargo = eco("cargo");
  const dirs = [...(cargo?.directories ?? []), ...(cargo?.directory ? [cargo.directory] : [])];
  for (const d of crateDirs) if (!dirs.includes(d)) out.push(`cargo: ${d} is not covered`);
  // An ignore needs its reason as a comment on the line above.
  const lines = yaml.split("\n");
  lines.forEach((l, i) => {
    const m = /^\s*- dependency-name:\s*"?([^"\s]+)/.exec(l);
    if (!m) return;
    const above = lines
      .slice(0, i)
      .reverse()
      .find((x) => x.trim() !== "");
    if (!above?.trim().startsWith("#")) out.push(`ignore ${m[1]}: no reason in a comment above it`);
  });
  return out;
}

describe("[CI-13] Dependabot, grouped and weekly", () => {
  test("the file covers bun, every native crate and the actions, grouped weekly, majors alone, every ignore with its reason", () => {
    expect(crates()).toEqual(["/native/akou-capture", "/native/akou-diarize"]);
    expect(problems(readFileSync(FILE, "utf8"), crates())).toEqual([]);
  });

  test("positive controls: a missing ecosystem, a new crate, a group that takes majors and an ignore without a reason each fail", () => {
    const yaml = readFileSync(FILE, "utf8");
    const noActions = yaml.replace(
      /package-ecosystem: "?github-actions"?/,
      "package-ecosystem: npm",
    );
    expect(problems(noActions, crates())).toContain("github-actions: no entry");
    expect(problems(yaml, [...crates(), "/native/akou-new"])).toEqual([
      "cargo: /native/akou-new is not covered",
    ]);
    const majors = yaml.replace(
      /update-types: \[minor, patch\]/,
      "update-types: [major, minor, patch]",
    );
    expect(majors).not.toBe(yaml);
    expect(problems(majors, crates()).join("\n")).toContain("takes majors");
    const bare = `${yaml.trimEnd()}\n    ignore:\n      - dependency-name: "left-pad"\n`;
    expect(problems(bare, crates())).toContain("ignore left-pad: no reason in a comment above it");
  });
});
