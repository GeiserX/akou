/**
 * The agent skill (docs/DESIGN.md section 6.5) and `akou skill install` (section 6.1, TRAPS T3.0
 * and T3.1): the skill starts first, names only tools and commands that exist, carries the app's
 * version, and installs idempotently into each harness's skills folder, refusing any other version.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { codexEnv, run } from "../scripts/gates/pg-k1-codex-skills.ts";
import { APP_VERSION } from "../src/main/app-info.ts";
import { COMMANDS } from "../src/main/cli/cli.ts";
import type { ApiClient, ApiResponse } from "../src/main/cli/client.ts";
import {
  akouCommand,
  harnessSkillsDir,
  installSkill,
  SKILL_SOURCE,
  SKILLS_HOME,
  SKILLS_ROOT,
  SkillVersionError,
  skillName,
  skillsDirSpec,
  skillVersion,
} from "../src/main/cli/commands/skill.ts";
import { createMcpServer } from "../src/main/mcp/server.ts";
import { cli } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const SKILL = readFileSync(join(SKILL_SOURCE, "SKILL.md"), "utf8");
const VOCAB_SKILL = readFileSync(join(SKILLS_ROOT, "akou-vocab", "SKILL.md"), "utf8");
const PKG = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));

/** Every tool the server can list: its app reports a provider, so akou_ask is listed too. */
async function mcpToolNames(): Promise<string[]> {
  const withProvider = {
    request: async (_m: string, path: string): Promise<ApiResponse> => ({
      status: 200,
      body: path === "/status" ? { provider: { state: "available", id: "anthropic" } } : {},
      text: "",
      contentType: "application/json",
    }),
  } as unknown as ApiClient;
  const server = createMcpServer({ client: withProvider });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(a);
  // The provider is read from the app's status right after initialize.
  await new Promise((r) => setTimeout(r, 50));
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
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

describe("the learning skill, akou-vocab (REQUIREMENTS V7)", () => {
  test("[T3.0] every tool and command it names exists, and it carries the app's version", async () => {
    const tools = new Set(await mcpToolNames());
    const named = [...new Set(VOCAB_SKILL.match(/akou_[a-z_]+/g) ?? [])];
    expect(named.length).toBeGreaterThan(4);
    expect(named.filter((t) => !tools.has(t))).toEqual([]);
    const commands = new Set(COMMANDS.map((c) => c.name));
    const used = [...VOCAB_SKILL.matchAll(/`!? ?akou ([a-z-]+)/g)].map((m) => m[1] as string);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((c) => !commands.has(c))).toEqual([]);
    expect(skillVersion(VOCAB_SKILL)).toBe(APP_VERSION);
    expect(skillName(VOCAB_SKILL)).toBe("akou-vocab");
  });

  test("it learns from the invite, the user's documents, repositories and exports, confirms spellings on the web, and turns corrections into heard forms", () => {
    for (const must of [
      "invite",
      "attendees",
      "documents",
      "repository",
      "exported calls",
      "Confirm each spelling",
      "Corrections become heard forms",
      "frequency times rarity",
      "akou_vocab_suggest",
    ]) {
      expect(VOCAB_SKILL).toContain(must);
    }
  });

  test("it always ends in a proposal and never confirms a word without the user's yes", () => {
    expect(VOCAB_SKILL).toContain("Everything you find is a proposal");
    expect(VOCAB_SKILL).toContain("## 5. End with the proposal");
    expect(VOCAB_SKILL).toContain("akou_vocab_propose");
    // Approving is tied to the user's yes wherever the skill names it.
    const approve = VOCAB_SKILL.split("\n").filter((l) => l.includes("akou_vocab_approve"));
    expect(approve.length).toBeGreaterThan(0);
    for (const line of approve) expect(line).toMatch(/yes|approve exactly|ask which/i);
    // Adding to a file is never how an inferred word goes in: only a call-scoped add is named.
    for (const m of VOCAB_SKILL.matchAll(/akou_vocab_add \{[^}]*\}/g)) {
      expect(m[0]).toContain('scope: "call"');
    }
    // Positive control: a skill that approves on its own fails the check.
    const eager = `${VOCAB_SKILL}\nThen call akou_vocab_approve with every term.`;
    const bad = eager.split("\n").filter((l) => l.includes("akou_vocab_approve"));
    expect(bad.some((l) => !/yes|approve exactly|ask which/i.test(l))).toBe(true);
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
    expect(second.out).toBe(
      [
        `${join(dest, "akou")}: already version ${APP_VERSION}`,
        `${join(dest, "akou-vocab")}: already version ${APP_VERSION}`,
      ].join("\n"),
    );
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
    expect(harnessSkillsDir("claude", { ...env, CLAUDE_CONFIG_DIR: "/x/c" })).toBe(
      join("/x/c", "skills"),
    );
    expect(harnessSkillsDir("codex", { ...env, CODEX_HOME: "/x/o" })).toBe(join("/x/o", "skills"));
    // Neither harness is here: say so rather than guess, naming the folders looked for.
    const none = await cli(env, ["skill", "install"]);
    expect(none.code).toBe(69);
    expect((await cli(env, ["skill", "uninstall"])).out).toBe(
      "neither Claude Code (~/.claude) nor Codex (~/.codex) was found; nothing to remove",
    );
    mkdirSync(join(t.dir, ".codex"));
    const found = await cli(env, ["skill", "install", "--json"]);
    expect(found.code).toBe(0);
    expect(found.json.installed.map((r: { path: string }) => r.path)).toEqual([
      join(t.dir, ".codex", "skills", "akou"),
      join(t.dir, ".codex", "skills", "akou-vocab"),
    ]);
    const claude = await cli(env, ["skill", "install", "--harness", "claude"]);
    expect(claude.code).toBe(0);
    expect(existsSync(join(t.dir, ".claude", "skills", "akou", "SKILL.md"))).toBe(true);
    expect((await cli(env, ["skill", "install", "--harness", "cursor"])).code).toBe(64);
    t.cleanup();
  });
});

describe("[PG-K1] Codex finds the skill where akou writes it", () => {
  test("the Codex folder is `$CODEX_HOME/skills`, the folder the recorded check proved Codex loads", () => {
    const gate = readFileSync(
      join(import.meta.dir, "..", "docs", "gates", "pg-k1-codex-skills.md"),
      "utf8",
    );
    const checked = /^Checked folder: `([^`]+)`/m.exec(gate)?.[1];
    expect(gate).toMatch(/^Result: pass/m);
    expect(checked).toBe(skillsDirSpec(SKILLS_HOME.codex));
    expect(checked).toBe("$CODEX_HOME/skills (default ~/.codex/skills)");
    expect(harnessSkillsDir("codex", { HOME: "/h" })).toBe(join("/h", ".codex", "skills"));
    // Positive control: the folder Codex's docs name (`~/.agents/skills`) is not the checked one.
    expect(skillsDirSpec({ env: "HOME", home: ".agents" })).not.toBe(checked);
  });

  test("the gate script fails a case whose command fails, never reading its silence as an empty list", () => {
    const env = { PATH: "/usr/bin:/bin" };
    expect(run(["/bin/sh", "-c", "echo listed"], env)).toBe("listed\n");
    expect(() => run(["/bin/sh", "-c", "echo broken >&2; exit 3"], env)).toThrow(
      /exit 3[\s\S]*broken/,
    );
  });

  test("the gate script asks Codex with CODEX_HOME unset for case A, even when the shell has one", () => {
    const inherited = { ...process.env, CODEX_HOME: "/elsewhere" };
    expect("CODEX_HOME" in codexEnv("/h", undefined, inherited)).toBe(false);
    expect(codexEnv("/h", undefined, inherited).HOME).toBe("/h");
    // Positive control: a case that names its own CODEX_HOME keeps it.
    expect(codexEnv("/h", "/h/ch", inherited).CODEX_HOME).toBe("/h/ch");
  });
});

/** Fake `claude` and `codex` programs on a PATH of their own; see fixtures/fake-mcp-cli.ts. */
function fakeHarnesses(root: string, which: readonly ("claude" | "codex")[] = ["claude", "codex"]) {
  const bin = join(root, "fake-bin");
  const state = join(root, "fake-state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const fake = join(import.meta.dir, "fixtures", "fake-mcp-cli.ts");
  for (const kind of which) {
    if (process.platform === "win32") {
      // Windows finds a program through PATHEXT, so there it is `claude.cmd`.
      writeFileSync(
        join(bin, `${kind}.cmd`),
        `@"${process.execPath}" "${fake}" ${kind} "${state}" %*\r\n`,
      );
    } else {
      writeFileSync(
        join(bin, kind),
        `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${kind} "${state}" "$@"\n`,
        { mode: 0o755 },
      );
    }
  }
  const calls = (kind: string): string[][] => {
    const f = join(state, `${kind}.log`);
    return existsSync(f)
      ? readFileSync(f, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  };
  const entries = (kind: string): Record<string, { command: string; args: string[] }> => {
    const f = join(state, `${kind}.json`);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  };
  const adds = (kind: string) => calls(kind).filter((a) => a[0] === "mcp" && a[1] === "add");
  // SHELL is empty so the login shell can never find the real programs. Windows needs its own
  // few variables to start cmd.exe at all.
  const win =
    process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
        }
      : {};
  return { bin, state, calls, entries, adds, env: { HOME: root, PATH: bin, SHELL: "", ...win } };
}

describe("[PG-M1] akou skill install registers the akou tools with the harness", () => {
  test("calls each harness's own `mcp add` once with the absolute akou path and `mcp`; twice adds nothing; a moved akou is updated; uninstall removes both (TS-25)", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, ".claude"));
      mkdirSync(join(t.dir, ".codex"));
      const f = fakeHarnesses(t.dir);
      const akou = join(t.dir, "bin", "akou");
      const first = await cli(f.env, ["skill", "install", "--json"], { self: [akou] });
      expect([first.code, first.err]).toEqual([0, ""]);
      expect(f.adds("claude")).toEqual([["mcp", "add", "-s", "user", "akou", "--", akou, "mcp"]]);
      expect(f.adds("codex")).toEqual([["mcp", "add", "akou", "--", akou, "mcp"]]);
      expect(f.entries("claude")).toEqual({ akou: { command: akou, args: ["mcp"] } });
      expect(f.entries("codex")).toEqual({ akou: { command: akou, args: ["mcp"] } });
      expect(first.json.mcp.map((m: { harness: string; action: string }) => m.action)).toEqual([
        "added",
        "added",
      ]);
      expect(existsSync(join(t.dir, ".codex", "skills", "akou", "SKILL.md"))).toBe(true);

      // Run twice: nothing is added again.
      const second = await cli(f.env, ["skill", "install"], { self: [akou] });
      expect(second.code).toBe(0);
      expect(f.adds("claude")).toHaveLength(1);
      expect(f.adds("codex")).toHaveLength(1);
      expect(second.out).toContain("Claude Code: the akou tools are already registered");
      expect(second.out).toContain("Codex: the akou tools are already registered");

      // akou moved: the entry is replaced, still one.
      const moved = join(t.dir, "elsewhere", "akou");
      const third = await cli(f.env, ["skill", "install", "--json"], { self: [moved] });
      expect(third.code).toBe(0);
      expect(third.json.mcp.map((m: { action: string }) => m.action)).toEqual([
        "updated",
        "updated",
      ]);
      expect(f.entries("claude")).toEqual({ akou: { command: moved, args: ["mcp"] } });
      expect(f.entries("codex")).toEqual({ akou: { command: moved, args: ["mcp"] } });
      // The replaced command is named, so a checkout repointing an installed app's entry shows.
      expect(third.json.mcp.map((m: { previous?: string }) => m.previous)).toEqual([
        `${akou} mcp`,
        `${akou} mcp`,
      ]);
      const back = await cli(f.env, ["skill", "install"], { self: [akou] });
      expect(back.out).toContain(
        `Claude Code: registered the akou tools for this akou, replacing ${moved} mcp (`,
      );

      // Uninstall removes both entries and the skills.
      const gone = await cli(f.env, ["skill", "uninstall", "--json"], { self: [moved] });
      expect([gone.code, gone.err]).toEqual([0, ""]);
      expect(f.entries("claude")).toEqual({});
      expect(f.entries("codex")).toEqual({});
      expect(existsSync(join(t.dir, ".claude", "skills", "akou"))).toBe(false);
      expect(existsSync(join(t.dir, ".codex", "skills", "akou-vocab"))).toBe(false);
      // Uninstalling again finds nothing to remove, runs no remove, and still succeeds.
      const removes = () => f.calls("claude").filter((a) => a[1] === "remove").length;
      const before = removes();
      const again = await cli(f.env, ["skill", "uninstall"], { self: [moved] });
      expect(again.code).toBe(0);
      expect(removes()).toBe(before);
    } finally {
      t.cleanup();
    }
  }, 30_000);

  test("with neither program on PATH it prints the exact commands and exits 0", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, ".claude"));
      mkdirSync(join(t.dir, ".codex"));
      const empty = join(t.dir, "empty-bin");
      mkdirSync(empty);
      const akou = join(t.dir, "bin", "akou");
      const r = await cli({ HOME: t.dir, PATH: empty, SHELL: "" }, ["skill", "install"], {
        self: [akou],
      });
      expect(r.code).toBe(0);
      expect(r.out).toContain(`claude mcp add -s user akou -- ${akou} mcp`);
      expect(r.out).toContain(`codex mcp add akou -- ${akou} mcp`);
      // The folder was there, so only the program is missing, and the text says so.
      expect(r.out).toContain(
        "the `claude` program is not on your PATH; to give Claude Code the akou tools, run:",
      );
      expect(r.out).not.toContain("was not found");
      expect(existsSync(join(t.dir, ".claude", "skills", "akou", "SKILL.md"))).toBe(true);
      const j = await cli({ HOME: t.dir, PATH: empty, SHELL: "" }, ["skill", "install", "--json"], {
        self: [akou],
      });
      expect(j.json.mcp).toEqual([
        {
          harness: "claude",
          action: "manual",
          command: ["claude", "mcp", "add", "-s", "user", "akou", "--", akou, "mcp"],
        },
        {
          harness: "codex",
          action: "manual",
          command: ["codex", "mcp", "add", "akou", "--", akou, "mcp"],
        },
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("--harness registers that harness only, --dir none, and a failed add exits 69 with the command", async () => {
    const t = tempDir();
    try {
      const f = fakeHarnesses(t.dir);
      const akou = join(t.dir, "bin", "akou");
      const one = await cli(f.env, ["skill", "install", "--harness", "codex"], { self: [akou] });
      expect(one.code).toBe(0);
      expect(f.calls("claude")).toEqual([]);
      expect(f.adds("codex")).toHaveLength(1);
      const dir = await cli(f.env, ["skill", "install", "--dir", join(t.dir, "other")], {
        self: [akou],
      });
      expect(dir.code).toBe(0);
      expect(f.calls("claude")).toEqual([]);
      expect(f.adds("codex")).toHaveLength(1);
      writeFileSync(join(f.state, "fail"), "");
      const bad = await cli(f.env, ["skill", "install", "--harness", "claude"], { self: [akou] });
      // The harness, a program outside akou, refused: unavailable (69), not an akou bug (70).
      expect(bad.code).toBe(69);
      expect(bad.err).toContain("fake add failed on purpose");
      expect(bad.err).toContain(`claude mcp add -s user akou -- ${akou} mcp`);
    } finally {
      t.cleanup();
    }
  }, 30_000);

  test("an akou entry in Claude Code's local scope is left alone and named, on install and uninstall", async () => {
    const t = tempDir();
    try {
      const f = fakeHarnesses(t.dir, ["claude"]);
      const akou = join(t.dir, "bin", "akou");
      const other = join(t.dir, "checkout", "akou");
      // A local entry wins over the user one, so replacing the user entry would change nothing.
      writeFileSync(
        join(f.state, "claude-local.json"),
        JSON.stringify({ akou: { command: other, args: ["mcp"] } }),
      );
      for (let i = 0; i < 2; i++) {
        const r = await cli(f.env, ["skill", "install", "--harness", "claude", "--json"], {
          self: [akou],
        });
        expect([r.code, r.err]).toEqual([0, ""]);
        expect(r.json.mcp).toEqual([
          {
            harness: "claude",
            action: "other-scope",
            scope: "local",
            previous: `${other} mcp`,
            command: ["claude", "mcp", "add", "-s", "user", "akou", "--", akou, "mcp"],
          },
        ]);
      }
      const text = await cli(f.env, ["skill", "install", "--harness", "claude"], { self: [akou] });
      expect(text.out).toContain("claude mcp remove -s local akou");
      expect(text.out).toContain(`claude mcp add -s user akou -- ${akou} mcp`);
      expect(f.calls("claude").filter((a) => a[1] !== "get")).toEqual([]);
      expect(f.entries("claude")).toEqual({});

      // Uninstall does not report a failure for an entry it never added, and leaves it.
      const gone = await cli(f.env, ["skill", "uninstall", "--harness", "claude"], {
        self: [akou],
      });
      expect([gone.code, gone.err]).toEqual([0, ""]);
      expect(gone.out).toContain("claude mcp remove -s local akou");
      expect(JSON.parse(readFileSync(join(f.state, "claude-local.json"), "utf8"))).toEqual({
        akou: { command: other, args: ["mcp"] },
      });

      // The same local entry running this akou is already registered.
      writeFileSync(
        join(f.state, "claude-local.json"),
        JSON.stringify({ akou: { command: akou, args: ["mcp"] } }),
      );
      const same = await cli(f.env, ["skill", "install", "--harness", "claude", "--json"], {
        self: [akou],
      });
      expect(same.json.mcp[0].action).toBe("unchanged");
    } finally {
      t.cleanup();
    }
  }, 30_000);

  test("uninstall with a user entry under a local one removes the user entry and says the local one still wins", async () => {
    const t = tempDir();
    try {
      const f = fakeHarnesses(t.dir, ["claude"]);
      const akou = join(t.dir, "bin", "akou");
      const other = join(t.dir, "checkout", "akou");
      writeFileSync(
        join(f.state, "claude-local.json"),
        JSON.stringify({ akou: { command: other, args: ["mcp"] } }),
      );
      writeFileSync(
        join(f.state, "claude.json"),
        JSON.stringify({ akou: { command: akou, args: ["mcp"] } }),
      );
      const gone = await cli(f.env, ["skill", "uninstall", "--harness", "claude", "--json"], {
        self: [akou],
      });
      expect([gone.code, gone.err]).toEqual([0, ""]);
      expect(f.entries("claude")).toEqual({});
      // Claude Code still has the akou tools from the local entry, so this is not "removed".
      expect(gone.json.mcp).toEqual([
        {
          harness: "claude",
          action: "other-scope",
          scope: "local",
          previous: `${other} mcp`,
          userRemoved: true,
          command: ["claude", "mcp", "remove", "-s", "user", "akou"],
        },
      ]);
      writeFileSync(
        join(f.state, "claude.json"),
        JSON.stringify({ akou: { command: akou, args: ["mcp"] } }),
      );
      const text = await cli(f.env, ["skill", "uninstall", "--harness", "claude"], {
        self: [akou],
      });
      expect(text.out).toContain("Claude Code: removed the akou tools from its user config");
      expect(text.out).toContain("claude mcp remove -s local akou");
    } finally {
      t.cleanup();
    }
  }, 30_000);

  test("uninstall reaches a harness on PATH whose folder is gone: Claude Code keeps entries in ~/.claude.json", async () => {
    const t = tempDir();
    try {
      // No ~/.claude and no ~/.codex, but the programs are on PATH and Claude Code has the entry.
      const f = fakeHarnesses(t.dir);
      const akou = join(t.dir, "bin", "akou");
      writeFileSync(
        join(f.state, "claude.json"),
        JSON.stringify({ akou: { command: akou, args: ["mcp"] } }),
      );
      const gone = await cli(f.env, ["skill", "uninstall"], { self: [akou] });
      expect([gone.code, gone.err]).toEqual([0, ""]);
      expect(f.entries("claude")).toEqual({});
      expect(gone.out).toContain("Claude Code: removed the akou tools");
      // Install still needs the folder: it has nowhere to copy the skills.
      const install = await cli(f.env, ["skill", "install"], { self: [akou] });
      expect(install.code).toBe(69);
      expect(f.adds("claude")).toEqual([]);
    } finally {
      t.cleanup();
    }
  }, 30_000);

  test("the command registered is this akou: the compiled binary, or Bun on the CLI source", () => {
    const src = akouCommand();
    expect(src).toEqual([
      process.execPath,
      join(import.meta.dir, "..", "src", "main", "cli", "cli.ts"),
    ]);
    expect(src.every((p) => isAbsolute(p))).toBe(true);
    expect(existsSync(src[1] as string)).toBe(true);
    expect(akouCommand("/$bunfs/root", "/usr/local/bin/akou")).toEqual(["/usr/local/bin/akou"]);
  });
});
