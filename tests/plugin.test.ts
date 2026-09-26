/**
 * PG-K2 (docs/ux/PROGRAMMABILITY.md section 6): the repository is a Claude Code plugin and its own
 * marketplace, so `claude plugin marketplace add GeiserX/akou` then `claude plugin install
 * akou@akou` gives the akou skills and the `akou_*` tools with no other step. The run with the
 * real `claude` is recorded in docs/gates/pg-k2-claude-plugin.md; these tests hold the manifests to
 * what that run used. The plugin's version equals the app's through `scripts/stamp-version.ts`
 * (tests/release.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { SKILL_NAMES, skillName, skillVersion } from "../src/main/cli/commands/skill.ts";

const ROOT = join(import.meta.dir, "..");
const read = (f: string) => JSON.parse(readFileSync(join(ROOT, ".claude-plugin", f), "utf8"));

describe("[PG-K2] the Claude Code plugin", () => {
  test("plugin.json: named akou, the app's version, and one MCP server that runs `akou mcp`", () => {
    const m = read("plugin.json");
    expect(m.name).toBe("akou");
    expect(m.version).toBe(pkg.version);
    expect(m.license).toBe(pkg.license);
    expect(m.mcpServers).toEqual({ akou: { command: "akou", args: ["mcp"] } });
    // Nothing else a plugin can run: no hooks, agents or commands besides the tools and skills.
    for (const k of ["hooks", "agents", "commands", "lspServers"]) expect(m[k]).toBeUndefined();
    for (const d of ["hooks", "agents", "commands"]) expect(existsSync(join(ROOT, d))).toBe(false);
  });

  test("marketplace.json: the repository serves one plugin, akou, from its root, so akou@akou resolves", () => {
    const mk = read("marketplace.json");
    expect(mk.name).toBe("akou");
    expect(mk.plugins).toEqual([expect.objectContaining({ name: "akou", source: "./" })]);
    // The version lives in plugin.json alone, so the two cannot disagree.
    expect(mk.plugins[0].version).toBeUndefined();
  });

  test("the plugin's skills folder holds exactly the skills akou ships, each named after its folder", () => {
    const dirs = readdirSync(join(ROOT, "skills")).sort();
    expect(dirs).toEqual([...SKILL_NAMES].sort());
    for (const d of dirs) {
      const text = readFileSync(join(ROOT, "skills", d, "SKILL.md"), "utf8");
      expect([d, skillName(text)]).toEqual([d, d]);
      expect([d, skillVersion(text)]).toEqual([d, pkg.version]);
    }
  });
});
