/**
 * `akou skill install` (docs/DESIGN.md sections 6.1 and 6.5, TRAPS T3.0 and T3.1): copies
 * `skills/akou` into the harness's skills folder, so the agent learns how to drive akou.
 *
 * The skill is version-locked to the app: its `metadata.version` must equal the app's version, or
 * the install is refused, because a skill written for other tooling tells the agent to call tools
 * that do not exist (the predecessor's skill drifted exactly that way). Installing the same version
 * twice changes nothing; a new version replaces the old files atomically.
 *
 * Where it goes:
 *
 * - Claude Code: `$CLAUDE_CONFIG_DIR/skills/akou`, by default `~/.claude/skills/akou`.
 * - Codex: `$CODEX_HOME/skills/akou`, by default `~/.codex/skills/akou`.
 * - `--dir DIR`: `DIR/akou`, for any other skills folder.
 *
 * With neither `--harness` nor `--dir`, it installs for every harness whose folder exists.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import EMBEDDED_SKILL from "../../../../skills/akou/SKILL.md" with { type: "text" };
import { str } from "../args.ts";
import { EXIT } from "../client.ts";
import type { Command, Ctx } from "../context.ts";
import { usage } from "./calls.ts";

/** `skills/akou` in the repository. */
export const SKILL_SOURCE = join(import.meta.dir, "..", "..", "..", "..", "skills", "akou");

/**
 * The folder to install from: the repository's, or, in the packaged app and the compiled CLI where
 * there is none, a private temporary copy of the `SKILL.md` built into the program.
 */
export function skillSourceDir(dir: string = SKILL_SOURCE): string {
  if (existsSync(join(dir, "SKILL.md"))) return dir;
  const tmp = mkdtempSync(join(tmpdir(), "akou-skill-"));
  writeFileSync(join(tmp, "SKILL.md"), EMBEDDED_SKILL);
  return tmp;
}
export const SKILL_NAME = "akou";

export type Harness = "claude" | "codex";

/** The version in a `SKILL.md` front matter (`metadata:` then `version: "x.y.z"`), or null. */
export function skillVersion(text: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return null;
  const m = /^\s+version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(fm[1] as string);
  return m ? (m[1] as string) : null;
}

export function harnessSkillsDir(h: Harness, env: Record<string, string | undefined>): string {
  const home = env.HOME ?? homedir();
  if (h === "claude") return join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "skills");
  return join(env.CODEX_HOME ?? join(home, ".codex"), "skills");
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

/** Copies the skill's files into `<skillsDir>/akou`. Refuses a version other than `version`. */
export function installSkill(source: string, skillsDir: string, version: string): InstallResult {
  const main = join(source, "SKILL.md");
  const text = readFileSync(main, "utf8");
  const found = skillVersion(text);
  if (found !== version) {
    throw new SkillVersionError(
      `the skill in ${source} is version ${found ?? "(none)"} but akou is ${version}; refusing to install a skill that does not match the app`,
    );
  }
  const dest = join(skillsDir, SKILL_NAME);
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

export const skillCommand: Command = {
  name: "skill",
  summary: "Install the akou skill into Claude Code's or Codex's skills folder",
  usage: "akou skill install [--harness claude|codex] [--dir DIR] [--json]",
  flags: { harness: { type: "string" }, dir: { type: "string" } },
  run: async (ctx: Ctx, p) => {
    if (p.positional[0] !== "install" || p.positional.length > 1) {
      return usage(ctx, "skill needs install");
    }
    const harness = str(p, "harness");
    const dir = str(p, "dir");
    if (harness !== undefined && harness !== "claude" && harness !== "codex") {
      return usage(ctx, "--harness is claude or codex");
    }
    let targets: string[];
    if (dir !== undefined) targets = [dir];
    else if (harness !== undefined) targets = [harnessSkillsDir(harness, ctx.io.env)];
    else {
      targets = (["claude", "codex"] as const)
        .map((h) => harnessSkillsDir(h, ctx.io.env))
        .filter((d) => existsSync(join(d, "..")));
      if (targets.length === 0) {
        const msg =
          "neither Claude Code (~/.claude) nor Codex (~/.codex) was found; pass --harness or --dir";
        if (ctx.json) ctx.io.out(JSON.stringify({ error: "no_harness", message: msg }));
        else ctx.io.err(`akou: ${msg}`);
        return EXIT.unavailable;
      }
    }
    const results: InstallResult[] = [];
    try {
      for (const t of targets) {
        results.push(installSkill(ctx.skillSource ?? skillSourceDir(), t, ctx.version));
      }
    } catch (err) {
      const msg = (err as Error).message;
      const code = err instanceof SkillVersionError ? "skill_version" : "install_failed";
      if (ctx.json) ctx.io.out(JSON.stringify({ error: code, message: msg }));
      else ctx.io.err(`akou: ${msg}`);
      return (err as NodeJS.ErrnoException).code === "EACCES" ? EXIT.permission : EXIT.software;
    }
    if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, installed: results }));
    else {
      for (const r of results) {
        ctx.io.out(
          r.action === "unchanged"
            ? `${r.path}: already version ${r.version}`
            : r.action === "updated"
              ? `${r.path}: updated from ${r.previous ?? "an unversioned copy"} to ${r.version}`
              : `${r.path}: installed version ${r.version}`,
        );
      }
    }
    return EXIT.ok;
  },
};
