/**
 * Fetching a pinned llama.cpp build into a folder, for the Dockerfile's llama stage: each image
 * bakes in the build of its variant's ACCELERATOR at build time. The table itself lives in
 * llama-catalog.ts, the one table a native install downloads from and detection reads too.
 *
 * `fetchForHost(accelerator, dir)` fetches this machine's build into `dir`; the Dockerfile calls it.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LLAMA_BUILDS, LLAMA_RELEASE, type LlamaBuild, llamaUrl } from "./llama-catalog.ts";
import {
  ACCELERATORS,
  type Accelerator,
  type DownloadOptions,
  downloadFile,
  hostPlatform,
  PLATFORMS,
} from "./models.ts";

/** The build for a platform and backend, or null when the release has none. */
export function llamaBuild(platform: string, accelerator: string): LlamaBuild | null {
  return LLAMA_BUILDS.find((b) => b.platform === platform && b.accelerator === accelerator) ?? null;
}

/** The backends the release has a build for on a platform, in `ACCELERATORS` order. */
export function llamaAccelerators(platform: string): Accelerator[] {
  return ACCELERATORS.filter((a) => llamaBuild(platform, a) !== null);
}

/** What is wrong with the table, as `<platform>/<accelerator>: <problem>`; empty when whole. */
export function llamaBuildProblems(builds: readonly LlamaBuild[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of builds) {
    const key = `${b.platform}/${b.accelerator}`;
    const bad = (what: string) => out.push(`${key}: ${what}`);
    if (seen.has(key)) bad("duplicate");
    seen.add(key);
    if (!(PLATFORMS as readonly string[]).includes(b.platform)) bad("unknown platform");
    if (!(ACCELERATORS as readonly string[]).includes(b.accelerator)) bad("unknown accelerator");
    if (b.assets.length === 0) bad("no assets");
    for (const a of b.assets) {
      if (!/^[0-9a-f]{64}$/.test(a.sha256)) bad(`${a.name}: sha256 is not 64 hex digits`);
      if (!(Number.isInteger(a.size) && a.size > 0)) bad(`${a.name}: no size`);
      if (!a.name.includes(`-${LLAMA_RELEASE}-`) && !a.name.startsWith("cudart-llama-bin-win-")) {
        bad(`${a.name}: not an asset of release ${LLAMA_RELEASE}`);
      }
      if (!/\.(tar\.gz|zip)$/.test(a.name)) bad(`${a.name}: neither .tar.gz nor .zip`);
    }
  }
  return out;
}

/** llama-server's file name on a platform. */
export function llamaServerName(platform: string): string {
  return platform.startsWith("win32") ? "llama-server.exe" : "llama-server";
}

/** Unpacks one archive into `into`: a `.tar.gz` through Bun, a `.zip` through the system `tar`. */
async function unpack(file: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  if (file.endsWith(".tar.gz")) {
    await new Bun.Archive(await Bun.file(file).bytes()).extract(into);
    return;
  }
  // Windows 10 and later, and macOS, ship bsdtar, which reads zip.
  const r = Bun.spawnSync(["tar", "-xf", file, "-C", into], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`tar -xf ${file}: ${r.stderr.toString().trim()}`);
}

/** Moves what an archive held into `dir`, one top folder deep if the archive had just one. */
function flatten(from: string, dir: string): void {
  let root = from;
  const top = readdirSync(from, { withFileTypes: true });
  if (top.length === 1 && top[0]?.isDirectory()) root = join(from, top[0].name);
  for (const name of readdirSync(root)) {
    const to = join(dir, name);
    rmSync(to, { recursive: true, force: true });
    renameSync(join(root, name), to);
  }
}

export interface FetchOptions extends DownloadOptions {
  /** Where the assets are served instead of the GitHub release (tests: a loopback server). */
  base?: string;
}

/**
 * Downloads a build's archives into `dir/.download`, each checked against its pinned SHA-256 by the
 * model downloader, unpacks them into `dir` side by side (llama-server finds its libraries through
 * `$ORIGIN`), deletes the archives, and returns llama-server's path. A file that does not match its
 * digest throws before anything is unpacked. Tests and CI never reach the real release.
 */
export async function fetchLlamaBuild(
  build: LlamaBuild,
  dir: string,
  o: FetchOptions = {},
): Promise<string> {
  const download = join(dir, ".download");
  const files: string[] = [];
  for (const a of build.assets) {
    const url = o.base ? `${o.base}/${a.name}` : llamaUrl(a);
    const path = join(download, a.name);
    await downloadFile("llama-server", { ...a, url }, path, o);
    files.push(path);
  }
  for (const [i, file] of files.entries()) {
    const tmp = join(dir, `.unpack-${i}`);
    rmSync(tmp, { recursive: true, force: true });
    await unpack(file, tmp);
    flatten(tmp, dir);
    rmSync(tmp, { recursive: true, force: true });
  }
  rmSync(download, { recursive: true, force: true });
  const bin = join(dir, llamaServerName(build.platform));
  if (!existsSync(bin))
    throw new Error(`${build.assets[0]?.name} holds no ${llamaServerName(build.platform)}`);
  return bin;
}

/**
 * This machine's build for `accelerator`, fetched into `dir`: the Dockerfile's llama stage runs it
 * with the variant's ACCELERATOR. An unknown backend, or one this platform has no build of, throws.
 */
export async function fetchForHost(accelerator: string | undefined, dir: string): Promise<string> {
  const build = llamaBuild(hostPlatform(), accelerator ?? "");
  if (!build) {
    throw new Error(
      `no llama-server build for ${accelerator} on ${hostPlatform()}; there are ${llamaAccelerators(hostPlatform()).join(", ")}`,
    );
  }
  return fetchLlamaBuild(build, dir);
}
