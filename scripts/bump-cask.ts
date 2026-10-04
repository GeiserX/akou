/**
 * Bumps the Homebrew cask (docs/CI-CD.md CI-25, DESIGN section 9): writes `Casks/akou.rb` in the
 * tap for package.json's version and its DMG's checksum, commits it and pushes it.
 *
 *   TAP_PUSH_TOKEN=... bun scripts/bump-cask.ts --sums SHA256SUMS [--dry-run] [--tap <git url or path>]
 *
 * The tap is another repository, which the workflow's own token cannot push to, so the push uses
 * TAP_PUSH_TOKEN, a token limited to the tap. Without it the bump stops with an error naming the
 * secret, dry run included (TRAPS "Homebrew tap push without a token"). `--dry-run` does everything
 * but push.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceVersion } from "./stamp-version.ts";

export const TAP = "GeiserX/homebrew-akou";

/** The DMG's name, as `build-app.ts` writes it (`releaseName`; a test holds the two together). */
export const dmgName = (version: string) => `akou-${version}-macos-arm64.dmg`;

/** The cask for `version`, whose DMG has the SHA-256 `sha256`. */
export function renderCask(version: string, sha256: string): string {
  return `# Written by the akou release (https://github.com/GeiserX/akou/blob/main/scripts/bump-cask.ts).
cask "akou" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/GeiserX/akou/releases/download/v#{version}/${dmgName("#{version}")}"
  name "akou"
  desc "Records calls locally, transcribes them live and answers questions about them"
  homepage "https://github.com/GeiserX/akou"

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "akou.app"

  caveats <<~EOS
    akou is not signed by Apple yet, so macOS refuses its first open.
    The step that lets it open is in
      https://github.com/GeiserX/akou/blob/main/docs/getting-started.md
  EOS
end
`;
}

/** The DMG's SHA-256 in a `SHA256SUMS` file, or null. */
export function dmgSum(sums: string, version: string): string | null {
  const dmg = dmgName(version);
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m?.[2] === dmg) return m[1] as string;
  }
  return null;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
}

export function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): number {
  const token = env.TAP_PUSH_TOKEN ?? "";
  if (token === "") {
    console.error(
      `::error::bump-cask: TAP_PUSH_TOKEN is not set. The cask lives in ${TAP}, which the workflow's own token cannot push to. Add a token that can push to that repository only as the TAP_PUSH_TOKEN secret, then rerun the release's failed jobs`,
    );
    return 1;
  }
  const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const sumsFile = at("--sums");
  if (!sumsFile) {
    console.error("usage: bun scripts/bump-cask.ts --sums SHA256SUMS [--dry-run] [--tap <url>]");
    return 64;
  }
  const version = sourceVersion(join(import.meta.dir, ".."));
  const sha256 = dmgSum(readFileSync(sumsFile, "utf8"), version);
  if (!sha256) {
    console.error(`bump-cask: ${sumsFile} has no line for ${dmgName(version)}`);
    return 1;
  }
  const tap = at("--tap") ?? `https://x-access-token:${token}@github.com/${TAP}.git`;
  const dir = mkdtempSync(join(tmpdir(), "akou-tap-"));
  try {
    git(dir, "clone", "--quiet", "--depth", "1", tap, ".");
    mkdirSync(join(dir, "Casks"), { recursive: true });
    writeFileSync(join(dir, "Casks", "akou.rb"), renderCask(version, sha256));
    git(dir, "add", "Casks/akou.rb");
    const changed = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: dir }).status === 1;
    if (!changed) {
      console.log(`bump-cask: the cask already says ${version}`);
      return 0;
    }
    git(
      dir,
      "-c",
      "user.name=GeiserX",
      "-c",
      "user.email=9169332+GeiserX@users.noreply.github.com",
      "commit",
      "--quiet",
      "-m",
      `chore(cask): akou ${version}`,
    );
    const dryRun = argv.includes("--dry-run");
    git(dir, "push", "--quiet", ...(dryRun ? ["--dry-run"] : []), "origin", "HEAD");
    console.log(
      `bump-cask: ${dryRun ? "would push" : "pushed"} akou ${version} (${sha256}) to ${TAP}`,
    );
    return 0;
  } catch (e) {
    // A token in the clone URL never reaches the log.
    console.error(`bump-cask: ${(e as Error).message.replaceAll(token, "***")}`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
