/**
 * The agent skill (docs/DESIGN.md section 6.5) and `akou skill install` (section 6.1, TRAPS T3.0
 * and T3.1): the skill starts first, names only tools and commands that exist, carries the app's
 * version, and installs idempotently into each harness's skills folder, refusing any other version.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { APP_VERSION } from "../src/main/app-info.ts";
import { COMMANDS } from "../src/main/cli/cli.ts";
import type { ApiClient } from "../src/main/cli/client.ts";
import {
  harnessSkillsDir,
  installSkill,
  SKILL_SOURCE,
  SkillVersionError,
  skillVersion,
} from "../src/main/cli/commands/skill.ts";
import { createMcpServer } from "../src/main/mcp/server.ts";
import { cli } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const SKILL = readFileSync(join(SKILL_SOURCE, "SKILL.md"), "utf8");
const PKG = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));

async function mcpToolNames(): Promise<string[]> {
  const offline = {
    request: async () => {
      throw new Error("offline");
    },
  } as unknown as ApiClient;
  const server = createMcpServer({ client: offline });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(a);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  // akou_ask is registered but listed only with a provider.
  return [...names, "akou_ask"];
}

describe("the skill text", () => {
  test("[T3.6] Minutes to start: the first command block is `akou start`, before anything else", () => {
    const body = SKILL.replace(/^---[\s\S]*?\n---\n/, "");
    const firstBlock = /```[a-z]*\n([^\n]*)/.exec(body)?.[1] ?? "";
    expect(firstBlock).toMatch(/^akou start /);
    const firstTool = /akou_[a-z_]+/.exec(body)?.[0];
    expect(firstTool).toBe("akou_start");
    // Positive control: a skill that probes status first fails the same check.
    const probing = body.replace("```sh\nakou start", "```sh\nakou status\nakou start");
    expect(/```[a-z]*\n([^\n]*)/.exec(probing)?.[1]).not.toMatch(/^akou start /);
  });

  test("[T3.0] The skill drifts from the tooling: every tool and command it names exists", async () => {
    const tools = new Set(await mcpToolNames());
    const named = [...new Set(SKILL.match(/akou_[a-z_]+/g) ?? [])];
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter((t) => !tools.has(t))).toEqual([]);
    const commands = new Set(COMMANDS.map((c) => c.name));
    const used = [...SKILL.matchAll(/`!? ?akou ([a-z-]+)/g)].map((m) => m[1] as string);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((c) => !commands.has(c))).toEqual([]);
  });

  test("it carries the rules the design asks for", () => {
    for (const must of [
      "akou_context",
      "akou_read",
      "since",
      "akou_name_speaker",
      "akou_vocab_add",
      'scope: "call"',
      "akou_vocab_propose",
      "akou_remember",
      "akou_memo_put",
      "[15:41 Ben]",
      "DRAFT",
      "ENDED",
      "Never read files under the recordings folder",
      "akou_status",
    ]) {
      expect(SKILL).toContain(must);
    }
  });

  test("its version is the app's version, which is package.json's", () => {
    expect(skillVersion(SKILL)).toBe(APP_VERSION);
    expect(APP_VERSION).toBe(PKG.version);
  });
});

describe("akou skill install", () => {
  test("[T3.0] refuses a skill whose version differs from the app's, and writes nothing", async () => {
    const t = tempDir();
    const src = join(t.dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "SKILL.md"), SKILL.replace(/version: "[^"]+"/, 'version: "9.9.9"'));
    const dest = join(t.dir, "skills");
    expect(() => installSkill(src, dest, APP_VERSION)).toThrow(SkillVersionError);
    const r = await cli({ HOME: t.dir }, ["skill", "install", "--dir", dest], {
      skillSource: src,
    });
    expect(r.code).toBe(70);
    expect(r.err).toContain("version 9.9.9 but akou is");
    expect(existsSync(join(dest, "akou"))).toBe(false);
    // Positive control: the same source installs when the versions agree.
    expect(installSkill(src, dest, "9.9.9").action).toBe("installed");
    t.cleanup();
  });

  test("installing twice changes nothing; a changed copy is replaced", async () => {
    const t = tempDir();
    const dest = join(t.dir, "skills");
    const first = await cli({ HOME: t.dir }, ["skill", "install", "--dir", dest, "--json"]);
    expect(first.code).toBe(0);
    expect(first.json.installed[0]).toMatchObject({ action: "installed", version: APP_VERSION });
    const file = join(dest, "akou", "SKILL.md");
    expect(readFileSync(file, "utf8")).toBe(SKILL);
    const second = await cli({ HOME: t.dir }, ["skill", "install", "--dir", dest]);
    expect(second.out).toBe(`${join(dest, "akou")}: already version ${APP_VERSION}`);
    writeFileSync(file, SKILL.replace(/version: "[^"]+"/, 'version: "0.0.0-old"'));
    const third = await cli({ HOME: t.dir }, ["skill", "install", "--dir", dest, "--json"]);
    expect(third.json.installed[0]).toMatchObject({ action: "updated", previous: "0.0.0-old" });
    expect(readFileSync(file, "utf8")).toBe(SKILL);
    t.cleanup();
  });

  test("goes to each harness's folder: CLAUDE_CONFIG_DIR, CODEX_HOME, or the ones that exist", async () => {
    const t = tempDir();
    const env = { HOME: t.dir };
    expect(harnessSkillsDir("claude", env)).toBe(join(t.dir, ".claude", "skills"));
    expect(harnessSkillsDir("codex", env)).toBe(join(t.dir, ".codex", "skills"));
    expect(harnessSkillsDir("claude", { ...env, CLAUDE_CONFIG_DIR: "/x/c" })).toBe("/x/c/skills");
    expect(harnessSkillsDir("codex", { ...env, CODEX_HOME: "/x/o" })).toBe("/x/o/skills");
    // Neither harness is here: say so rather than guess.
    const none = await cli(env, ["skill", "install"]);
    expect(none.code).toBe(69);
    mkdirSync(join(t.dir, ".codex"));
    const found = await cli(env, ["skill", "install", "--json"]);
    expect(found.code).toBe(0);
    expect(found.json.installed.map((r: { path: string }) => r.path)).toEqual([
      join(t.dir, ".codex", "skills", "akou"),
    ]);
    const claude = await cli(env, ["skill", "install", "--harness", "claude"]);
    expect(claude.code).toBe(0);
    expect(existsSync(join(t.dir, ".claude", "skills", "akou", "SKILL.md"))).toBe(true);
    expect((await cli(env, ["skill", "install", "--harness", "cursor"])).code).toBe(64);
    t.cleanup();
  });
});
