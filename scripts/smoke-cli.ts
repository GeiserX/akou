/**
 * Checks the compiled `akou` binary `build-cli.ts` made, headless, in a throwaway home:
 *
 *   bun scripts/smoke-cli.ts
 *
 * - `LICENSE` and `NOTICE` sit beside the binary, as the archive ships them;
 * - `akou --version` prints `package.json`'s version;
 * - `akou doctor --json` answers a report with the settings, token, models and helper checks, and
 *   with no app running and no helper on PATH the helper line is not a failure;
 * - `akou models list --json` lists the models folder, without downloading anything;
 * - `akou skill install --dir DIR` installs the `SKILL.md` built into the binary, at the version;
 * - `akou start --json`, with no app running and none installed, exits 69 and says the app must be
 *   opened: the compiled CLI never tries to be the app.
 *
 * Nothing here starts the app or opens a window.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hostTarget } from "./build-cli.ts";
import { sourceVersion } from "./stamp-version.ts";

const ROOT = join(import.meta.dir, "..");
let failures = 0;
function check(ok: boolean, what: string, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

const version = sourceVersion(ROOT);
const target = hostTarget();
const exe = join(
  ROOT,
  "dist",
  "cli",
  `akou-cli-${version}-${target}`,
  process.platform === "win32" ? "akou.exe" : "akou",
);
if (!existsSync(exe)) {
  console.error(`smoke-cli: no binary at ${exe}; run bun scripts/build-cli.ts first`);
  process.exit(1);
}

for (const f of ["LICENSE", "NOTICE"]) {
  check(existsSync(join(exe, "..", f)), `${f} beside the binary`);
}

const home = mkdtempSync(join(tmpdir(), "akou-cli-smoke-"));
const env = {
  ...process.env,
  AKOU_HOME: home,
  AKOU_MODELS_DIR: join(home, "models"),
  AKOU_NO_DOWNLOAD: "1",
};
function akou(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(exe, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), json };
}

try {
  const v = akou(["--version"]);
  check(v.code === 0 && v.out === version, `akou --version is ${version}`, v.out);

  // No helper on PATH and no login-shell lookup: the released CLI's situation on a user's Mac.
  const doctor = akou(["doctor", "--json"], { PATH: "/usr/bin:/bin", SHELL: "" });
  const lines =
    (doctor.json as { checks?: { name: string; state: string; detail: string }[] })?.checks ?? [];
  const checks = lines.map((c) => c.name);
  check(
    ["settings", "token", "api", "models", "helper"].every((n) => checks.includes(n)),
    "akou doctor --json reports settings, token, api, models and helper",
    checks.join(", ") || doctor.err,
  );
  // The helper ships inside the app; with no app running doctor cannot check it, so it must not fail.
  const helper = lines.find((c) => c.name === "helper");
  check(
    helper !== undefined && helper.state !== "fail",
    "akou doctor does not fail the helper it cannot see from outside the app",
    helper ? `${helper.state}: ${helper.detail}` : "(no helper line)",
  );

  const models = akou(["models", "list", "--json"]);
  const listed = (models.json as { models?: { state: string }[] })?.models ?? [];
  check(
    models.code === 0 && listed.length > 0 && listed.every((m) => m.state !== "present"),
    "akou models list --json lists the models, none downloaded",
    `${listed.length} models`,
  );

  const skills = join(home, "skills");
  const skill = akou(["skill", "install", "--dir", skills, "--json"]);
  for (const name of ["akou", "akou-vocab"]) {
    const skillFile = join(skills, name, "SKILL.md");
    check(
      skill.code === 0 &&
        existsSync(skillFile) &&
        readFileSync(skillFile, "utf8").includes(`version: "${version}"`),
      `akou skill install writes the built-in ${name} SKILL.md at the version`,
      skill.out || skill.err,
    );
  }

  // With an akou.app installed, `start` would open it; this check is for machines without one.
  const installed = ["/Applications/akou.app", join(homedir(), "Applications", "akou.app")].filter(
    (p) => process.platform === "darwin" && existsSync(p),
  );
  if (installed.length > 0) {
    console.log(`SKIP akou start: ${installed[0]} is installed and would be opened`);
  } else {
    const start = akou(["start", "--json"]);
    const msg = (start.json as { message?: string })?.message ?? start.err;
    check(
      start.code === 69 && /cannot start it/.test(msg),
      "akou start with no app exits 69 and says to open the app",
      `exit ${start.code}: ${msg}`,
    );
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`smoke-cli: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("smoke-cli: every check passed");
