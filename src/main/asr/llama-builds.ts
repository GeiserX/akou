/**
 * The pinned llama.cpp builds akou runs llama-server from (docs/research/asr-architecture.md section
 * 2.3; bead akou-5an.94): one per platform and backend, every file pinned by SHA-256 and size, from
 * one release. `asr.accelerator` picks the backend (accelerator.ts); the images bake theirs in at
 * build time (the Dockerfile runs this file), and a native install fetches its own on demand.
 *
 * A CUDA build is two archives: llama.cpp's and the matching CUDA runtime (cudart, cuBLAS), so the
 * host needs only the NVIDIA driver. A Mac's one build serves Metal and the CPU alike. SYCL and ROCm
 * builds need Intel's oneAPI or AMD's ROCm runtime on the host; auto never picks them.
 *
 * The OpenVINO build is not here: its llama.cpp backend runs text models only, so it cannot run
 * Qwen3-ASR's audio encoder (llama.cpp docs/backend/OPENVINO.md, 2026-09).
 *
 * `fetchForHost(accelerator, dir)` fetches this machine's build into `dir`; the Dockerfile calls it.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ACCELERATORS,
  type Accelerator,
  type DownloadOptions,
  downloadFile,
  hostPlatform,
  PLATFORMS,
  type Platform,
} from "./models.ts";

/** The llama.cpp release every build comes from, published 2026-09-26. */
export const LLAMA_RELEASE = "b11200";
const RELEASES = "https://github.com/ggml-org/llama.cpp/releases/download";

export interface LlamaAsset {
  name: string;
  sha256: string;
  size: number;
}

export interface LlamaBuild {
  platform: Platform;
  accelerator: Accelerator;
  /** llama.cpp's archive first, then the CUDA runtime for a CUDA build. */
  assets: readonly LlamaAsset[];
}

export function llamaUrl(a: LlamaAsset): string {
  return `${RELEASES}/${LLAMA_RELEASE}/${a.name}`;
}

const asset = (name: string, size: number, sha256: string): LlamaAsset => ({ name, size, sha256 });
const rel = (suffix: string) => `llama-${LLAMA_RELEASE}-bin-${suffix}`;

// Sizes and digests from the release's own asset list (GitHub API `digest`), read 2026-09-26.
const MACOS = asset(
  rel("macos-arm64.tar.gz"),
  11755479,
  "caa654dcae608fa2a3047da4fccbe3c8a1aab1dcc3832313286024cb13182124",
);

export const LLAMA_BUILDS: readonly LlamaBuild[] = [
  { platform: "darwin-arm64", accelerator: "cpu", assets: [MACOS] },
  { platform: "darwin-arm64", accelerator: "metal", assets: [MACOS] },
  {
    platform: "linux-x64",
    accelerator: "cpu",
    assets: [
      asset(
        rel("ubuntu-x64.tar.gz"),
        17402021,
        "d6fbb47c57ce3495ca246b21010e1c46223f3f501b8465cd0b47139888b9f1fe",
      ),
    ],
  },
  {
    platform: "linux-x64",
    accelerator: "vulkan",
    assets: [
      asset(
        rel("ubuntu-vulkan-x64.tar.gz"),
        31345803,
        "376b003154a33bf1139302f66865fcd3dd0ce19a9b5b956dcc8b52b0962515ea",
      ),
    ],
  },
  {
    // CUDA 12.8, the widest driver support of the two x64 CUDA builds (driver 570 or newer).
    platform: "linux-x64",
    accelerator: "cuda",
    assets: [
      asset(
        rel("ubuntu-cuda-12.8-x64.tar.gz"),
        170908770,
        "6b66856858958d88465fb99850b2e5f031f0a11df6d68ee5fc2bc0de7b81f0dd",
      ),
      asset(
        `cudart-${rel("ubuntu-cuda-12.8-x64.tar.gz")}`,
        594377948,
        "3ce37c6ecaa231cdf85938ffa8d6d04007ea61094cb2708c4e57f957c7bdeb50",
      ),
    ],
  },
  {
    platform: "linux-x64",
    accelerator: "sycl",
    assets: [
      asset(
        rel("ubuntu-sycl-fp16-x64.tar.gz"),
        55707863,
        "5b7c8f3c9e684e7a96c1ab548d1c7467d2438b4b409d948395de19da6514b2b2",
      ),
    ],
  },
  {
    platform: "linux-x64",
    accelerator: "rocm",
    assets: [
      asset(
        rel("ubuntu-rocm-10.0-x64.tar.gz"),
        240621073,
        "70e254a9138225625b2667c7df71b5b89d432a294d0aa34279608e2b430b057d",
      ),
    ],
  },
  {
    platform: "linux-arm64",
    accelerator: "cpu",
    assets: [
      asset(
        rel("ubuntu-arm64.tar.gz"),
        13500290,
        "5e5457b79e9e35817a69a77e6b382402e4d63487bac26eff5294ad03ee89cbb4",
      ),
    ],
  },
  {
    platform: "linux-arm64",
    accelerator: "vulkan",
    assets: [
      asset(
        rel("ubuntu-vulkan-arm64.tar.gz"),
        24669610,
        "faec84c83ec4773de346318e6e9418ac8707c3ae508024aaed81fec6aaa0f2ce",
      ),
    ],
  },
  {
    // The only arm64 CUDA build is 13.4.
    platform: "linux-arm64",
    accelerator: "cuda",
    assets: [
      asset(
        rel("ubuntu-cuda-13.4-arm64.tar.gz"),
        146958166,
        "6c01fc3035cb80e275008e4821937d945c856b55a0d5e36d3c920def0d7323bc",
      ),
      asset(
        `cudart-${rel("ubuntu-cuda-13.4-arm64.tar.gz")}`,
        552521363,
        "273b7437baa7700a83d9718bc7e44a24688b5cc3613def6f13ec043e78515450",
      ),
    ],
  },
  {
    platform: "win32-x64",
    accelerator: "cpu",
    assets: [
      asset(
        rel("win-cpu-x64.zip"),
        19154722,
        "b958c2f249b59335048a57993802b292faeffaee55555b71e59616d6c2c399ca",
      ),
    ],
  },
  {
    platform: "win32-x64",
    accelerator: "vulkan",
    assets: [
      asset(
        rel("win-vulkan-x64.zip"),
        33062078,
        "670a1f9bf5272c43dbbd7b0004a12dd3d3f6f575246fd23b733f06c064f1b96b",
      ),
    ],
  },
  {
    platform: "win32-x64",
    accelerator: "cuda",
    assets: [
      asset(
        rel("win-cuda-12.4-x64.zip"),
        263038371,
        "8f9fcdb185dcd99a63cdfa3716f1ab12584060baef96a48bc6db157a4db843d1",
      ),
      // The release names its Windows CUDA runtime without the build number.
      asset(
        "cudart-llama-bin-win-cuda-12.4-x64.zip",
        391443627,
        "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
      ),
    ],
  },
  {
    platform: "win32-x64",
    accelerator: "sycl",
    assets: [
      asset(
        rel("win-sycl-x64.zip"),
        120815015,
        "4617886da18964323846d509a46ec5a32dac6d9ece633a292531b3b11dbcd965",
      ),
    ],
  },
  {
    platform: "win32-x64",
    accelerator: "rocm",
    assets: [
      asset(
        rel("win-rocm-10.0-x64.zip"),
        257329562,
        "ca0aabc00240dd4588cbf7afb65d4df311458bb2f6391884aec00269ed652ef2",
      ),
    ],
  },
];

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
