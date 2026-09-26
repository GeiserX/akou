/**
 * `akou skill install` (docs/DESIGN.md sections 6.1 and 6.5, TRAPS T3.0 and T3.1): copies the
 * skills into the harness's skills folder: `skills/akou`, so the agent learns how to drive akou, and
 * `skills/akou-vocab`, the learning skill that proposes vocabulary from the user's own sources.
 *
 * The skill is version-locked to the app: its `metadata.version` must equal the app's version, or
 * the install is refused, because a skill written for other tooling tells the agent to call tools
 * that do not exist (the predecessor's skill drifted exactly that way). Installing the same version
 * twice changes nothing; a new version replaces the old files atomically.
 *
 * Where it goes (`SKILLS_HOME`):
 *
 * - Claude Code: `$CLAUDE_CONFIG_DIR/skills/<name>`, by default `~/.claude/skills/<name>`.
 * - Codex: `$CODEX_HOME/skills/<name>`, by default `~/.codex/skills/<name>`. Codex 0.151.0 loads
 *   user skills from this folder and from `~/.agents/skills`; the recorded check is
 *   `docs/gates/pg-k1-codex-skills.md` (PG-K1). This one follows `CODEX_HOME` and is where
 *   Codex's own skill installer writes.
 * - `--dir DIR`: `DIR/<name>`, for any other skills folder.
 *
 * `<name>` is the skill's own `name:` from its front matter.
 *
 * With neither `--harness` nor `--dir`, it installs for every harness whose folder exists.
 *
 * The skill drives the `akou_*` MCP tools, so installing for a harness also registers `akou mcp`
 * with it through the harness's own command (PG-M1): `claude mcp add -s user akou -- AKOU mcp`
 * and `codex mcp add akou -- AKOU mcp`, where AKOU is this akou's absolute path. An entry that
 * already runs this akou is left alone, and one that runs another (a checkout, an older install)
 * is replaced, with the replaced command named in the output. A harness whose program is not on
 * `PATH` gets the exact command printed instead. `akou skill uninstall` removes the skills and the
 * entries again (TS-25). `--dir` is for another harness, so it registers nothing.
 *
 * Claude Code's `mcp get` shows the entry that wins in the current folder, and a local or project
 * entry wins over the user one akou writes. Such an entry is left alone and named, with the
 * commands to replace it: rewriting the user entry would change nothing where it is shadowed.
 * `claude mcp get` is also a connection test, not a config read: it starts the registered command
 * (for akou, `akou mcp`, which asks the app for its status and never launches it), so a broken
 * registered command costs up to Claude Code's connect timeout, capped by `RUN_TIMEOUT_MS`.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import EMBEDDED_SKILL from "../../../../skills/akou/SKILL.md" with { type: "text" };
import EMBEDDED_VOCAB_SKILL from "../../../../skills/akou-vocab/SKILL.md" with { type: "text" };
import { findProgram } from "../../llm/harness.ts";
import { str } from "../args.ts";
import { EXIT, isCompiled } from "../client.ts";
import type { Command, Ctx } from "../context.ts";
import { usage } from "./calls.ts";

/** `skills/` in the repository. */
export const SKILLS_ROOT = join(import.meta.dir, "..", "..", "..", "..", "skills");
/** `skills/akou` in the repository. */
export const SKILL_SOURCE = join(SKILLS_ROOT, "akou");
export const SKILL_NAME = "akou";

/** Every skill akou ships, with the copy built into the program. */
const SHIPPED: Readonly<Record<string, string>> = {
  akou: EMBEDDED_SKILL,
  "akou-vocab": EMBEDDED_VOCAB_SKILL,
};
export const SKILL_NAMES = Object.keys(SHIPPED);

/**
 * The folder to install one skill from: the repository's, or, in the packaged app and the compiled
 * CLI where there is none, a private temporary copy of the `SKILL.md` built into the program.
 */
export function skillSourceDir(dir: string = SKILL_SOURCE, name = SKILL_NAME): string {
  if (existsSync(join(dir, "SKILL.md"))) return dir;
  const tmp = mkdtempSync(join(tmpdir(), "akou-skill-"));
  writeFileSync(join(tmp, "SKILL.md"), SHIPPED[name] ?? EMBEDDED_SKILL);
  return tmp;
}

/** The folders of every shipped skill. */
export function skillSources(root: string = SKILLS_ROOT): string[] {
  return SKILL_NAMES.map((n) => skillSourceDir(join(root, n), n));
}

/** The `name:` in a `SKILL.md` front matter, or null. */
export function skillName(text: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const m = fm ? /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(fm[1] as string) : null;
  return m ? (m[1] as string) : null;
}

export type Harness = "claude" | "codex";

/** The version in a `SKILL.md` front matter (`metadata:` then `version: "x.y.z"`), or null. */
export function skillVersion(text: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return null;
  const m = /^\s+version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(fm[1] as string);
  return m ? (m[1] as string) : null;
}

/**
 * Where each harness reads user skills: `skills` in the folder the variable names, or in the home
 * folder's default. The Codex line is the folder the PG-K1 check proved Codex loads.
 */
export const SKILLS_HOME = {
  claude: { env: "CLAUDE_CONFIG_DIR", home: ".claude" },
  codex: { env: "CODEX_HOME", home: ".codex" },
} as const satisfies Record<Harness, { env: string; home: string }>;

/** `$CODEX_HOME/skills (default ~/.codex/skills)`: how the gate records a folder. */
export function skillsDirSpec(s: { env: string; home: string }): string {
  return `$${s.env}/skills (default ~/${s.home}/skills)`;
}

export function harnessSkillsDir(h: Harness, env: Record<string, string | undefined>): string {
  const s = SKILLS_HOME[h];
  return join(env[s.env] ?? join(env.HOME ?? homedir(), s.home), "skills");
}

// ---------------------------------------------------------------------------
// Registering `akou mcp` with the harness (PG-M1)

const MCP_NAME = "akou";
const LABEL: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };
const RUN_TIMEOUT_MS = 30_000;

/** The akou a harness runs for `akou mcp`: this compiled binary, or Bun on the CLI source. */
export function akouCommand(dir: string = import.meta.dir, execPath = process.execPath): string[] {
  return isCompiled(dir) ? [execPath] : [execPath, join(dir, "..", "cli.ts")];
}

/** A harness's own command for akou's entry, without the program. */
function mcpArgs(h: Harness, verb: "get" | "add" | "remove", server: readonly string[] = []) {
  if (h === "claude") {
    if (verb === "get") return ["mcp", "get", MCP_NAME];
    if (verb === "remove") return ["mcp", "remove", "-s", "user", MCP_NAME];
    return ["mcp", "add", "-s", "user", MCP_NAME, "--", ...server];
  }
  if (verb === "get") return ["mcp", "get", MCP_NAME, "--json"];
  if (verb === "remove") return ["mcp", "remove", MCP_NAME];
  return ["mcp", "add", MCP_NAME, "--", ...server];
}

/** The command a harness has registered as `akou`, as `command args…`, from its `mcp get`. */
function registeredCommand(h: Harness, out: string): string | null {
  if (h === "codex") {
    try {
      const t = JSON.parse(out).transport;
      return [t.command, ...(t.args ?? [])].join(" ");
    } catch {
      return null;
    }
  }
  const cmd = /^\s*Command:[ \t]*(.*)$/m.exec(out)?.[1]?.trim();
  const args = /^\s*Args:[ \t]*(.*)$/m.exec(out)?.[1]?.trim();
  return cmd ? [cmd, ...(args ? [args] : [])].join(" ") : null;
}

/** The scope of the entry a harness's `mcp get` showed: Claude Code's `Scope:` line; Codex has one. */
function registeredScope(h: Harness, out: string): string {
  if (h === "codex") return "user";
  return /^\s*Scope:[ \t]*(\w+)/m.exec(out)?.[1]?.toLowerCase() ?? "user";
}

/** One command line a person can paste: words with spaces or shell characters are quoted. */
export function shellLine(argv: readonly string[]): string {
  return argv
    .map((a) => (/^[\w@%+=:,./\\~-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`))
    .join(" ");
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Runs a found program; a `.cmd` or `.bat` on Windows runs through cmd.exe, as the shell would. */
function runProgram(path: string, args: string[], env: Record<string, string | undefined>): Ran {
  const opts = {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8" as const,
    timeout: RUN_TIMEOUT_MS,
  };
  const r =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(path)
      ? spawnSync(
          env.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", `"${[path, ...args].map((a) => `"${a}"`).join(" ")}"`],
          { ...opts, windowsVerbatimArguments: true },
        )
      : spawnSync(path, args, opts);
  return {
    code: r.status ?? -1,
    out: r.stdout ?? "",
    err: `${r.stderr ?? ""}${r.error ? r.error.message : ""}`,
  };
}

export interface McpResult {
  harness: Harness;
  action:
    | "added"
    | "updated"
    | "unchanged"
    | "manual"
    | "failed"
    | "removed"
    | "absent"
    | "other-scope";
  /** The harness command that does (or would do) it, with the program's name. */
  command: string[];
  /** The command the entry ran before, when akou replaced it or left it alone. */
  previous?: string;
  /** For `other-scope`: Claude Code's scope of the entry akou left alone, `local` or `project`. */
  scope?: string;
  /** For `other-scope` on uninstall: whether a user entry under that one was removed. */
  userRemoved?: boolean;
  error?: string;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  );
}

/** Registers `akou mcp` with a harness once; see the file comment. */
export function registerMcp(
  h: Harness,
  server: readonly string[],
  env: Record<string, string | undefined>,
): McpResult {
  const command = [h, ...mcpArgs(h, "add", server)];
  const path = findProgram(h, env);
  if (!path) return { harness: h, action: "manual", command };
  const got = runProgram(path, mcpArgs(h, "get"), env);
  const current = got.code === 0 ? registeredCommand(h, got.out) : null;
  if (current === server.join(" ")) return { harness: h, action: "unchanged", command };
  const previous = current ?? undefined;
  if (got.code === 0) {
    const scope = registeredScope(h, got.out);
    if (scope !== "user") return { harness: h, action: "other-scope", command, previous, scope };
    runProgram(path, mcpArgs(h, "remove"), env);
  }
  const added = runProgram(path, mcpArgs(h, "add", server), env);
  if (added.code !== 0) {
    const why = firstLine(added.err) || firstLine(added.out) || `exit ${added.code}`;
    return { harness: h, action: "failed", command, error: why };
  }
  return got.code === 0
    ? { harness: h, action: "updated", command, previous }
    : { harness: h, action: "added", command };
}

/** Removes akou's entry from a harness, when it has one. */
export function unregisterMcp(h: Harness, env: Record<string, string | undefined>): McpResult {
  const command = [h, ...mcpArgs(h, "remove")];
  const path = findProgram(h, env);
  if (!path) return { harness: h, action: "manual", command };
  const got = runProgram(path, mcpArgs(h, "get"), env);
  if (got.code !== 0) return { harness: h, action: "absent", command };
  const scope = registeredScope(h, got.out);
  const r = runProgram(path, mcpArgs(h, "remove"), env);
  // The entry shown is one akou never adds, and it still gives the harness the akou tools; a user
  // entry under it, if any, was removed.
  if (scope !== "user") {
    const previous = registeredCommand(h, got.out) ?? undefined;
    return {
      harness: h,
      action: "other-scope",
      command,
      previous,
      scope,
      userRemoved: r.code === 0,
    };
  }
  if (r.code !== 0) {
    const why = firstLine(r.err) || firstLine(r.out) || `exit ${r.code}`;
    return { harness: h, action: "failed", command, error: why };
  }
  return { harness: h, action: "removed", command };
}

function mcpText(r: McpResult): string {
  const who = LABEL[r.harness];
  const line = shellLine(r.command);
  const adding = r.command.includes("add");
  switch (r.action) {
    case "added":
      return `${who}: registered the akou tools (${line})`;
    case "updated":
      return `${who}: registered the akou tools for this akou, replacing ${r.previous ?? "another command"} (${line})`;
    case "other-scope": {
      const drop = shellLine([r.harness, "mcp", "remove", "-s", r.scope ?? "local", MCP_NAME]);
      return adding
        ? `${who}: left alone the akou entry in its ${r.scope} config, which runs ${r.previous ?? "another command"} and wins over the one akou adds; to use this akou, run: ${drop}, then: ${line}`
        : `${who}: ${r.userRemoved ? `removed the akou tools from its user config (${line}), and ` : ""}left alone the akou entry in its ${r.scope} config, which akou does not add; to remove it, run: ${drop}`;
    }
    case "unchanged":
      return `${who}: the akou tools are already registered`;
    case "removed":
      return `${who}: removed the akou tools (${line})`;
    case "absent":
      return `${who}: the akou tools were not registered`;
    case "manual":
      return adding
        ? `the \`${r.harness}\` program is not on your PATH; to give ${who} the akou tools, run: ${line}`
        : `the \`${r.harness}\` program is not on your PATH; if ${who} has the akou tools, run: ${line}`;
    case "failed":
      return `${who} refused (${r.error}); run: ${line}`;
  }
}

export class SkillVersionError extends Error {
  override name = "SkillVersionError";
}

export interface InstallResult {
  path: string;
  action: "installed" | "updated" | "unchanged";
  version: string;
  previous: string | null;
}

function checkVersion(source: string, text: string, version: string): void {
  const found = skillVersion(text);
  if (found !== version) {
    throw new SkillVersionError(
      `the skill in ${source} is version ${found ?? "(none)"} but akou is ${version}; refusing to install a skill that does not match the app`,
    );
  }
}

/**
 * Copies the skill's files into `<skillsDir>/<name>`, the name from its front matter. Refuses a
 * version other than `version`.
 */
export function installSkill(source: string, skillsDir: string, version: string): InstallResult {
  const main = join(source, "SKILL.md");
  const text = readFileSync(main, "utf8");
  checkVersion(source, text, version);
  const dest = join(skillsDir, skillName(text) ?? SKILL_NAME);
  const destMain = join(dest, "SKILL.md");
  const previous = existsSync(destMain) ? skillVersion(readFileSync(destMain, "utf8")) : null;
  const existed = existsSync(destMain);
  mkdirSync(dest, { recursive: true });
  let changed = false;
  for (const e of readdirSync(source, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const bytes = readFileSync(join(source, e.name));
    const target = join(dest, e.name);
    if (existsSync(target) && readFileSync(target).equals(bytes)) continue;
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
    changed = true;
  }
  return {
    path: dest,
    action: !changed ? "unchanged" : existed ? "updated" : "installed",
    version,
    previous,
  };
}

/** A skills folder, and the harness it belongs to (none for `--dir`). */
interface Target {
  dir: string;
  harness?: Harness;
}

/** Removes the shipped skills from a folder: only folders whose `SKILL.md` names that skill. */
function removeSkills(skillsDir: string): string[] {
  const removed: string[] = [];
  for (const name of SKILL_NAMES) {
    const dest = join(skillsDir, name);
    const main = join(dest, "SKILL.md");
    if (!existsSync(main) || skillName(readFileSync(main, "utf8")) !== name) continue;
    rmSync(dest, { recursive: true, force: true });
    removed.push(dest);
  }
  return removed;
}

export const skillCommand: Command = {
  name: "skill",
  summary:
    "Install the akou skills into Claude Code's or Codex's skills folder and register the akou tools with it, or uninstall both",
  usage: "akou skill install|uninstall [--harness claude|codex] [--dir DIR] [--json]",
  flags: {
    harness: { type: "string", value: "H", desc: "claude or codex (default: every one installed)" },
    dir: { type: "string", value: "DIR", desc: "install into this skills folder instead" },
  },
  examples: ["akou skill install --harness claude", "akou skill uninstall"],
  run: async (ctx: Ctx, p) => {
    const sub = p.positional[0];
    if ((sub !== "install" && sub !== "uninstall") || p.positional.length > 1) {
      return usage(ctx, "skill needs install or uninstall");
    }
    const harness = str(p, "harness");
    const dir = str(p, "dir");
    if (harness !== undefined && harness !== "claude" && harness !== "codex") {
      return usage(ctx, "--harness is claude or codex");
    }
    const env = ctx.io.env;
    let targets: Target[];
    if (dir !== undefined) targets = [{ dir }];
    else if (harness !== undefined) targets = [{ dir: harnessSkillsDir(harness, env), harness }];
    else {
      targets = (["claude", "codex"] as const)
        .map((h) => ({ dir: harnessSkillsDir(h, env), harness: h }))
        // Uninstall also reaches a harness on PATH whose folder is gone: Claude Code keeps its
        // user entries in ~/.claude.json, outside ~/.claude.
        .filter(
          (t) =>
            existsSync(join(t.dir, "..")) ||
            (sub === "uninstall" && findProgram(t.harness, env) !== null),
        );
      if (targets.length === 0) {
        if (sub === "uninstall") {
          if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, removed: [], mcp: [] }));
          else {
            ctx.io.out(
              "neither Claude Code (~/.claude) nor Codex (~/.codex) was found; nothing to remove",
            );
          }
          return EXIT.ok;
        }
        const msg =
          "neither Claude Code (~/.claude) nor Codex (~/.codex) was found; pass --harness or --dir";
        if (ctx.json) ctx.io.out(JSON.stringify({ error: "no_harness", message: msg }));
        else ctx.io.err(`akou: ${msg}`);
        return EXIT.unavailable;
      }
    }
    const harnesses = targets.flatMap((t) => (t.harness ? [t.harness] : []));
    const server = [...(ctx.self ?? akouCommand()), "mcp"];

    if (sub === "uninstall") {
      const removed = targets.flatMap((t) => removeSkills(t.dir));
      const mcp = harnesses.map((h) => unregisterMcp(h, env));
      return report(ctx, { ok: true, removed, mcp }, [
        ...removed.map((r) => `${r}: removed`),
        ...mcp.map(mcpText),
      ]);
    }

    const results: InstallResult[] = [];
    const sources = ctx.skillSource ? [ctx.skillSource] : skillSources();
    try {
      // Every source is checked before any is copied, so a refused version installs nothing.
      for (const src of sources) {
        checkVersion(src, readFileSync(join(src, "SKILL.md"), "utf8"), ctx.version);
      }
      for (const t of targets) {
        for (const src of sources) results.push(installSkill(src, t.dir, ctx.version));
      }
    } catch (err) {
      const msg = (err as Error).message;
      const code = err instanceof SkillVersionError ? "skill_version" : "install_failed";
      if (ctx.json) ctx.io.out(JSON.stringify({ error: code, message: msg }));
      else ctx.io.err(`akou: ${msg}`);
      return (err as NodeJS.ErrnoException).code === "EACCES" ? EXIT.permission : EXIT.software;
    }
    const mcp = harnesses.map((h) => registerMcp(h, server, env));
    return report(ctx, { ok: true, installed: results, mcp }, [
      ...results.map((r) =>
        r.action === "unchanged"
          ? `${r.path}: already version ${r.version}`
          : r.action === "updated"
            ? `${r.path}: updated from ${r.previous ?? "an unversioned copy"} to ${r.version}`
            : `${r.path}: installed version ${r.version}`,
      ),
      ...mcp.map(mcpText),
    ]);
  },
};

/**
 * Prints the result; a harness that refused goes to stderr and makes the exit 69: a program
 * outside akou was unavailable for the step, not an akou failure (docs/ux/CLI.md section 6).
 */
function report(ctx: Ctx, body: { mcp: McpResult[] } & Record<string, unknown>, lines: string[]) {
  const failed = body.mcp.some((m) => m.action === "failed");
  if (ctx.json) ctx.io.out(JSON.stringify(failed ? { ...body, ok: false } : body));
  else {
    const bad = new Set(body.mcp.filter((m) => m.action === "failed").map(mcpText));
    const ok = lines.filter((l) => !bad.has(l));
    if (ok.length > 0) ctx.io.out(ok.join("\n"));
    for (const l of bad) ctx.io.err(`akou: ${l}`);
  }
  return failed ? EXIT.unavailable : EXIT.ok;
}
