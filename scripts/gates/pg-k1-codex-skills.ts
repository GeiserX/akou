/**
 * The PG-K1 check (docs/gates/pg-k1-codex-skills.md) in one command: does the installed Codex list
 * the akou skills from the folder `akou skill install --harness codex` writes, with `CODEX_HOME`
 * unset and set, and not from a copy that ignores `CODEX_HOME`?
 *
 *   bun scripts/gates/pg-k1-codex-skills.ts
 *
 * Needs `codex` on PATH. Every case runs in a throwaway HOME with its own CODEX_HOME, so no real
 * Codex config is read or changed, and the install runs with a PATH that has no `codex`, so it
 * registers nothing. "Listed" means the skill is in the prompt Codex builds for the model:
 * `codex debug prompt-input` prints it without calling a model. Prints the machine, the versions
 * and each case's list with the temporary root shown as `$T`, ready to paste into the gate file,
 * and exits 1 when a case lists something other than the expected skills.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "main", "cli", "cli.ts");
const T = realpathSync(mkdtempSync(join(tmpdir(), "akou-pg-k1-")));

function run(cmd: string[], env: Record<string, string>, cwd = T): string {
  const r = spawnSync(cmd[0] as string, cmd.slice(1), { env, cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/** The akou skills in the prompt Codex builds, as `name: file`, from `codex debug prompt-input`. */
export function listedSkills(prompt: string): string[] {
  const s = prompt.replaceAll("\\n", "\n");
  const roots = new Map([...s.matchAll(/- `(r\d+)` = `([^`]*)`/g)].map((m) => [m[1], m[2]]));
  const out = new Set<string>();
  for (const m of s.matchAll(/- (akou(?:-vocab)?): [^\n]*?\(file: (r\d+)\/([^)]*SKILL\.md)\)/g)) {
    out.add(`${m[1]}: ${roots.get(m[2] as string) ?? m[2]}/${m[3]}`);
  }
  return [...out].sort();
}

function codexList(home: string, codexHome: string): string[] {
  mkdirSync(join(home, "work"), { recursive: true });
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome } as Record<string, string>;
  return listedSkills(run(["codex", "debug", "prompt-input", "hi"], env, join(home, "work")));
}

function install(home: string, codexHome?: string): string {
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin", SHELL: "" };
  if (codexHome) env.CODEX_HOME = codexHome;
  return run([process.execPath, CLI, "skill", "install", "--harness", "codex"], env);
}

/** Machine paths as the gate file writes them, so the output can be pasted into a public file. */
const show = (s: string) =>
  s.replaceAll(T, "$T").replaceAll(process.execPath, "<bun>").replaceAll(ROOT, "<checkout>");
const expected = (dir: string) =>
  [`akou: ${dir}/akou/SKILL.md`, `akou-vocab: ${dir}/akou-vocab/SKILL.md`].sort();

try {
  const sh = (cmd: string[]) => run(cmd, process.env as Record<string, string>, ROOT).trim();
  console.log(`date: ${new Date().toISOString().slice(0, 10)}`);
  console.log(
    `machine: ${platform()} ${arch()} ${platform() === "darwin" ? sh(["sw_vers", "-productVersion"]) : ""}`.trim(),
  );
  console.log(`codex: ${sh(["codex", "--version"])}`);
  console.log(
    `akou: ${sh(["git", "rev-parse", "--short", "HEAD"])} (${sh(["git", "branch", "--show-current"])})`,
  );

  // A: akou's install, CODEX_HOME unset.
  const a = join(T, "A");
  console.log(`\n== install (A)\n${show(install(a)).trim()}`);
  // B: akou's install with CODEX_HOME set.
  const b = join(T, "B");
  install(b, join(b, "ch"));
  // C (control): the same skills in ~/.codex/skills while CODEX_HOME points elsewhere.
  const c = join(T, "C");
  mkdirSync(join(c, "ch"), { recursive: true });
  cpSync(join(a, ".codex", "skills"), join(c, ".codex", "skills"), { recursive: true });
  // D (baseline): a clean home.
  const d = join(T, "D");
  mkdirSync(join(d, ".codex"), { recursive: true });
  // E (the other folder): the same skills only in ~/.agents/skills.
  const e = join(T, "E");
  mkdirSync(join(e, ".codex"), { recursive: true });
  cpSync(join(a, ".codex", "skills"), join(e, ".agents", "skills"), { recursive: true });

  const cases: [string, string[], string[] | null][] = [
    ["A", codexList(a, join(a, ".codex")), expected(join(a, ".codex", "skills"))],
    ["B", codexList(b, join(b, "ch")), expected(join(b, "ch", "skills"))],
    ["C", codexList(c, join(c, "ch")), []],
    ["D", codexList(d, join(d, ".codex")), []],
    // Informational: Codex 0.151.0 reads this folder too, so it is not a control.
    ["E", codexList(e, join(e, ".codex")), null],
  ];
  const failed: string[] = [];
  console.log("");
  for (const [name, got, want] of cases) {
    console.log(`== ${name}`);
    for (const l of got) console.log(show(l));
    if (want && JSON.stringify(got) !== JSON.stringify(want)) failed.push(name);
  }
  console.log(failed.length === 0 ? "\nResult: pass" : `\nResult: fail (${failed.join(", ")})`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  rmSync(T, { recursive: true, force: true });
}
