/**
 * The catalog entries of the llama-server runtime (docs/research/asr-architecture.md section 2.3):
 * Qwen3-ASR-1.7B as llama.cpp's Q8_0 GGUF with its audio projector, and one pinned llama-server
 * build per platform and accelerator from llama.cpp's own release. `models.ts` lists them in
 * `MODELS`, so they download, verify, sit on disk and expire like every other model.
 *
 * Why Qwen3-ASR-1.7B: it is the first open-weight model on the Open ASR Leaderboard's English table
 * (mean WER 4.31 over 8 sets, results file of 2026-09-25), no newer Qwen ASR release exists, and on
 * our own FLEURS Spanish it scored 2.89 through llama.cpp, against 3.1 for Parakeet v3
 * (asr-architecture.md section 2.3). Q8_0 measured the same as bf16 within the bootstrap range.
 *
 * The builds, from https://github.com/ggml-org/llama.cpp/releases/tag/b11200 (2026-09-26), with the
 * SHA-256 digests GitHub publishes per asset. A build is an archive; `llama-server.ts` unpacks it
 * beside itself on first use. Windows CUDA also needs NVIDIA's runtime DLLs, published as a second
 * archive; the Linux CUDA build expects the CUDA 12 runtime on the host, which NVIDIA's runtime
 * images (the `-cuda` image, SV-P2) carry.
 */

import type { Accelerator, CatalogEntry, Platform } from "./models.ts";

export const LLAMA_RELEASE = "b11200";
export const QWEN_ASR = "qwen3-asr-1.7b";
export const QWEN_MODEL_FILE = "Qwen3-ASR-1.7B-Q8_0.gguf";
export const QWEN_MMPROJ_FILE = "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf";

const HF_QWEN =
  "https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/36a678687ba7d07a74ca70ccb0e36902e005fb80";
const GH_LLAMA = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}`;

/** Qwen3-ASR's 30 languages, from its model card (its 22 Chinese dialects answer as Chinese). */
export const QWEN_LANGUAGE_CODES: readonly string[] =
  "zh en yue ar de fr es pt id it ko ru th vi ja tr hi ms nl sv da fi pl cs fil fa el hu mk ro".split(
    " ",
  );

/** The catalog id of the llama-server build for a platform and accelerator. */
export function llamaBuildId(platform: string, accelerator: string): string {
  return `llama-server-${LLAMA_RELEASE}-${platform}-${accelerator}`;
}

/** One release asset: its name, size and SHA-256 as GitHub lists them. */
type Asset = [name: string, size: number, sha256: string];

const BUILDS: readonly [Platform, Accelerator, readonly Asset[]][] = [
  [
    "darwin-arm64",
    "metal",
    [
      [
        "llama-b11200-bin-macos-arm64.tar.gz",
        11755479,
        "caa654dcae608fa2a3047da4fccbe3c8a1aab1dcc3832313286024cb13182124",
      ],
    ],
  ],
  [
    "linux-x64",
    "cpu",
    [
      [
        "llama-b11200-bin-ubuntu-x64.tar.gz",
        17402021,
        "d6fbb47c57ce3495ca246b21010e1c46223f3f501b8465cd0b47139888b9f1fe",
      ],
    ],
  ],
  [
    "linux-x64",
    "vulkan",
    [
      [
        "llama-b11200-bin-ubuntu-vulkan-x64.tar.gz",
        31345803,
        "376b003154a33bf1139302f66865fcd3dd0ce19a9b5b956dcc8b52b0962515ea",
      ],
    ],
  ],
  [
    "linux-x64",
    "cuda",
    [
      [
        "llama-b11200-bin-ubuntu-cuda-12.8-x64.tar.gz",
        170908770,
        "6b66856858958d88465fb99850b2e5f031f0a11df6d68ee5fc2bc0de7b81f0dd",
      ],
    ],
  ],
  [
    "linux-arm64",
    "cpu",
    [
      [
        "llama-b11200-bin-ubuntu-arm64.tar.gz",
        13500290,
        "5e5457b79e9e35817a69a77e6b382402e4d63487bac26eff5294ad03ee89cbb4",
      ],
    ],
  ],
  [
    "linux-arm64",
    "vulkan",
    [
      [
        "llama-b11200-bin-ubuntu-vulkan-arm64.tar.gz",
        24669610,
        "faec84c83ec4773de346318e6e9418ac8707c3ae508024aaed81fec6aaa0f2ce",
      ],
    ],
  ],
  [
    "win32-x64",
    "cpu",
    [
      [
        "llama-b11200-bin-win-cpu-x64.zip",
        19154722,
        "b958c2f249b59335048a57993802b292faeffaee55555b71e59616d6c2c399ca",
      ],
    ],
  ],
  [
    "win32-x64",
    "vulkan",
    [
      [
        "llama-b11200-bin-win-vulkan-x64.zip",
        33062078,
        "670a1f9bf5272c43dbbd7b0004a12dd3d3f6f575246fd23b733f06c064f1b96b",
      ],
    ],
  ],
  [
    "win32-x64",
    "cuda",
    [
      [
        "llama-b11200-bin-win-cuda-12.4-x64.zip",
        263038371,
        "8f9fcdb185dcd99a63cdfa3716f1ab12584060baef96a48bc6db157a4db843d1",
      ],
      [
        "cudart-llama-bin-win-cuda-12.4-x64.zip",
        391443627,
        "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
      ],
    ],
  ],
];

export const LLAMA_CATALOG: readonly CatalogEntry[] = [
  {
    id: QWEN_ASR,
    job: "the best preset's recognizer: 30 languages, run by llama-server on Metal, Vulkan, CUDA or the CPU",
    licence: "Apache-2.0",
    source: "https://huggingface.co/Qwen/Qwen3-ASR-1.7B",
    serves: ["final"],
    runtime: "llama-server",
    platforms: [...new Set(BUILDS.map(([p]) => p))],
    accelerators: [...new Set(BUILDS.map(([, a]) => a))],
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
  ...BUILDS.map(
    ([platform, accelerator, assets]): CatalogEntry => ({
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
      files: assets.map(([name, size, sha256]) => ({
        name,
        url: `${GH_LLAMA}/${name}`,
        sha256,
        size,
      })),
    }),
  ),
];
