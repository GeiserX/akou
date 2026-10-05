/**
 * The `akou` command line as one standalone binary (docs/DESIGN.md sections 6.1 and 9), built with
 * `bun build --compile` for the machine it runs on, then packed for the release:
 *
 *   bun scripts/build-cli.ts            # darwin-arm64 on a Mac, linux-x64 or linux-arm64 on Linux, windows-x64 on Windows
 *
 * - Bun must be 1.4.2 or newer: 1.4.0 and 1.4.1 write an invalid Mach-O signature and macOS kills
 *   the binary at exec (TRAPS "Compiled Bun binary killed on launch", oven-sh/bun#39764).
 * - On macOS the binary is re-signed and must pass `codesign --verify --strict`; either failing
 *   fails the build. With a Developer ID in `ELECTROBUN_DEVELOPER_ID` (the release) it is signed
 *   with it, the hardened runtime and the JIT entitlements Bun needs (`cli-entitlements.plist`),
 *   then notarized with the Apple credentials Hutch uses for the app. Without one it is ad-hoc.
 * - The binary must then run: `akou --version` prints `package.json`'s version.
 * - Out: `dist/release/akou-cli-<version>-<target>.tar.gz` (`.zip` on Windows), holding
 *   `akou-cli-<version>-<target>/akou[.exe]`, `LICENSE`, `NOTICE` and `README.md`.
 *
 * Built on the target's own runner, so the binary it checks is the one it ships.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sourceVersion } from "./stamp-version.ts";

const ROOT = join(import.meta.dir, "..");
export const MIN_BUN = "1.4.2";

/**
 * What a Developer ID signed binary may do under the hardened runtime: Bun's JIT needs the first two,
 * and `akou serve` loads native addons that are not signed by this team (the app gets the same three
 * from Hutch).
 */
export const CLI_ENTITLEMENTS = join(ROOT, "scripts", "cli-entitlements.plist");

type Env = Record<string, string | undefined>;

/** The Developer ID in `ELECTROBUN_DEVELOPER_ID`, or null when the build is ad-hoc signed (`-`). */
export function developerId(env: Env = process.env): string | null {
  const id = env.ELECTROBUN_DEVELOPER_ID ?? "";
  return id === "" || id === "-" ? null : id;
}

/**
 * `codesign`'s arguments for the CLI: the Developer ID with the hardened runtime, a secure
 * timestamp and Bun's entitlements, which notarization requires, or ad-hoc without one.
 */
export function cliSignArgs(env: Env = process.env): string[] {
  const id = developerId(env);
  if (id === null) return ["-s", "-", "-f"];
  return [
    "-s",
    id,
    "-f",
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    CLI_ENTITLEMENTS,
  ];
}

/** The release name of this machine, or null where no CLI is released. */
export function hostTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const targets: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
    "win32-x64": "windows-x64",
  };
  return targets[`${platform}-${arch}`] ?? null;
}

/** a >= b for plain `x.y.z` versions (a pre-release counts as its release's lower bound). */
export function atLeast(a: string, b: string): boolean {
  const parse = (v: string) => v.split("-")[0]?.split(".").map(Number) ?? [];
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return !a.includes("-") || b.includes("-");
}

function fail(msg: string): never {
  console.error(`build-cli: ${msg}`);
  process.exit(1);
}

function run(cmd: string[], cwd = ROOT): string {
  console.log(`build-cli: $ ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0] as string, cmd.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    fail(`${cmd[0]} exited ${r.status ?? r.signal}: ${(r.stderr || r.stdout).trim().slice(-800)}`);
  }
  return r.stdout.trim();
}

/**
 * `src/main/cli/cli.ts` as one binary at `exe`, signed on macOS (`cliSignArgs`), then run: it must say
 * `version`. Returns what it said. The app build uses it too, for the copy the app carries
 * (`build-app.ts`, DK-M6).
 */
export function compileCli(exe: string, target: string, version: string): string {
  if (!atLeast(Bun.version, MIN_BUN)) {
    fail(
      `Bun ${Bun.version} cannot build the CLI: ${MIN_BUN} or newer is required (1.4.0 and 1.4.1 write a Mach-O signature macOS kills at exec)`,
    );
  }
  run([
    process.execPath,
    "build",
    "--compile",
    `--target=bun-${target}`,
    join(ROOT, "src", "main", "cli", "cli.ts"),
    "--outfile",
    exe,
  ]);
  if (!existsSync(exe)) fail(`no binary at ${exe}`);

  if (process.platform === "darwin") {
    run(["/usr/bin/codesign", ...cliSignArgs(), exe]);
    run(["/usr/bin/codesign", "--verify", "--strict", exe]);
  }

  const said = run([exe, "--version"]);
  if (said !== version) fail(`the binary says ${JSON.stringify(said)}, package.json ${version}`);
  run([exe, "help"]);
  return said;
}

/**
 * Apple's notary service accepts the Developer ID signed binary, or the build fails. A bare binary
 * cannot be stapled, so it goes up in a zip and Gatekeeper finds the ticket online. The password
 * never reaches the log.
 */
export function notarizeCli(exe: string, env: Env = process.env): void {
  const appleId = env.ELECTROBUN_APPLEID ?? "";
  const password = env.ELECTROBUN_APPLEIDPASS ?? "";
  const team = env.ELECTROBUN_TEAMID ?? "";
  if (!appleId || !password || !team) {
    fail(
      "a Developer ID signed CLI must be notarized: set ELECTROBUN_APPLEID, ELECTROBUN_APPLEIDPASS and ELECTROBUN_TEAMID",
    );
  }
  const zip = `${exe}.zip`;
  rmSync(zip, { force: true });
  run(["/usr/bin/ditto", "-c", "-k", "--keepParent", exe, zip]);
  const auth = ["--apple-id", appleId, "--password", password, "--team-id", team];
  console.log(`build-cli: $ xcrun notarytool submit ${zip} --wait (Apple ID credentials)`);
  const r = spawnSync(
    "xcrun",
    ["notarytool", "submit", zip, ...auth, "--wait", "--output-format", "json"],
    { encoding: "utf8" },
  );
  rmSync(zip, { force: true });
  let said: { id?: string; status?: string } = {};
  try {
    said = JSON.parse(r.stdout);
  } catch {
    // Not JSON: the error is in stderr, reported below.
  }
  if (said.status !== "Accepted") {
    if (said.id) {
      const log = spawnSync("xcrun", ["notarytool", "log", said.id, ...auth], { encoding: "utf8" });
      console.error(log.stdout || log.stderr);
    }
    fail(
      `Apple did not notarize the CLI: ${said.status ?? (r.stderr || r.stdout).trim().slice(-800)}`,
    );
  }
  console.log(`build-cli: notarized (submission ${said.id})`);
}

function main(): void {
  const target = hostTarget();
  if (!target) fail(`no CLI is released for ${process.platform}-${process.arch}`);
  const version = sourceVersion(ROOT);
  const name = `akou-cli-${version}-${target}`;
  const out = join(ROOT, "dist", "cli");
  const dir = join(out, name);
  const exe = join(dir, process.platform === "win32" ? "akou.exe" : "akou");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const said = compileCli(exe, target, version);
  if (process.platform === "darwin" && developerId() !== null) notarizeCli(exe);

  copyFileSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
  copyFileSync(join(ROOT, "NOTICE"), join(dir, "NOTICE"));
  copyFileSync(join(ROOT, "README.md"), join(dir, "README.md"));
  const release = join(ROOT, "dist", "release");
  mkdirSync(release, { recursive: true });
  const archive = join(release, `${name}.${process.platform === "win32" ? "zip" : "tar.gz"}`);
  rmSync(archive, { force: true });
  // Windows' own bsdtar writes a zip for a .zip name with -a (Git's GNU tar, first on a runner's
  // PATH, cannot, and reads "D:" as a remote host).
  const winTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  run(
    process.platform === "win32"
      ? [winTar, "-a", "-c", "-f", archive, name]
      : ["tar", "-c", "-z", "-f", archive, name],
    out,
  );
  console.log(`build-cli: ${archive} (akou ${said}, ${target})`);
}

if (import.meta.main) main();
