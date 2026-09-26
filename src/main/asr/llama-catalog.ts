/**
 * The llama-server runtime's pinned files (docs/research/asr-architecture.md section 2.3; bead
 * akou-5an.94): Qwen3-ASR-1.7B as llama.cpp's Q8_0 GGUF with its audio projector, and the one table
 * of llama.cpp builds, per platform and backend, every file pinned by SHA-256 and size, from one
 * release. Everything that needs a build reads this table: `models.ts` lists each build in `MODELS`
 * (so it downloads, verifies, sits on disk and expires like every other model), accelerator.ts
 * offers a native install exactly the backends it has, and the Dockerfile's llama stage fetches an
 * image's build from it (llama-builds.ts). This file imports only types, so that stage stays small.
 *
 * Why Qwen3-ASR-1.7B: it is the first open-weight model on the Open ASR Leaderboard's English table
 * (mean WER 4.31 over 8 sets, results file of 2026-09-25), no newer Qwen ASR release exists, and on
 * our own FLEURS Spanish it scored 2.89 through llama.cpp, against 3.1 for Parakeet v3
 * (asr-architecture.md section 2.3). Q8_0 measured the same as bf16 within the bootstrap range.
 *
 * The builds come from https://github.com/ggml-org/llama.cpp/releases/tag/b11200 (2026-09-26). A
 * CUDA build is two archives, llama.cpp's and the matching CUDA runtime (cudart, cuBLAS), so the
 * host needs only the NVIDIA driver. A Mac's one archive serves Metal and the CPU alike. SYCL and
 * ROCm builds need Intel's oneAPI or AMD's ROCm runtime on the host; `auto` never picks them. The
 * OpenVINO build is not here: its llama.cpp backend runs text models only, so it cannot run
 * Qwen3-ASR's audio encoder (llama.cpp docs/backend/OPENVINO.md, 2026-09).
 */

import type { Accelerator, CatalogEntry, Platform } from "./models.ts";

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

export const QWEN_ASR = "qwen3-asr-1.7b";
export const QWEN_MODEL_FILE = "Qwen3-ASR-1.7B-Q8_0.gguf";
export const QWEN_MMPROJ_FILE = "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf";

const HF_QWEN =
  "https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/36a678687ba7d07a74ca70ccb0e36902e005fb80";

/** Qwen3-ASR's 30 languages, from its model card (its 22 Chinese dialects answer as Chinese). */
export const QWEN_LANGUAGE_CODES: readonly string[] =
  "zh en yue ar de fr es pt id it ko ru th vi ja tr hi ms nl sv da fi pl cs fil fa el hu mk ro".split(
    " ",
  );

/** The catalog id of the llama-server build for a platform and accelerator. */
export function llamaBuildId(platform: string, accelerator: string): string {
  return `llama-server-${LLAMA_RELEASE}-${platform}-${accelerator}`;
}

export const LLAMA_CATALOG: readonly CatalogEntry[] = [
  {
    id: QWEN_ASR,
    job: "the best preset's recognizer: 30 languages, run by llama-server on Metal, Vulkan, CUDA, SYCL, ROCm or the CPU",
    licence: "Apache-2.0",
    source: "https://huggingface.co/Qwen/Qwen3-ASR-1.7B",
    serves: ["final"],
    runtime: "llama-server",
    platforms: [...new Set(LLAMA_BUILDS.map((b) => b.platform))],
    accelerators: [...new Set(LLAMA_BUILDS.map((b) => b.accelerator))],
    languages: QWEN_LANGUAGE_CODES,
    onDemand: true,
    files: [
      {
        name: QWEN_MODEL_FILE,
        url: `${HF_QWEN}/${QWEN_MODEL_FILE}`,
        sha256: "58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57",
        size: 2165034944,
      },
      {
        // The audio encoder and its projection into the language model (llama.cpp's mtmd).
        name: QWEN_MMPROJ_FILE,
        url: `${HF_QWEN}/${QWEN_MMPROJ_FILE}`,
        sha256: "46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d",
        size: 355709344,
      },
    ],
  },
  // One entry per row of the table: the build a native install downloads is the one detection saw.
  ...LLAMA_BUILDS.map(
    ({ platform, accelerator, assets }): CatalogEntry => ({
      id: llamaBuildId(platform, accelerator),
      job: `llama-server ${LLAMA_RELEASE} for ${platform} on ${accelerator === "cpu" ? "the CPU" : accelerator}, which runs Qwen3-ASR`,
      licence: "MIT",
      source: `https://github.com/ggml-org/llama.cpp/releases/tag/${LLAMA_RELEASE}`,
      serves: ["runtime"],
      runtime: "llama-server",
      platforms: [platform],
      accelerators: [accelerator],
      languages: "any",
      onDemand: true,
      files: assets.map((a) => ({
        name: a.name,
        url: llamaUrl(a),
        sha256: a.sha256,
        size: a.size,
      })),
    }),
  ),
];
