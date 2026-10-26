/**
 * The word-time aligner's pinned files (bead akou-chp.15): Qwen3-ForcedAligner-0.6B as a q4_k
 * GGUF, and the CrispASR builds that run it, every file pinned by SHA-256 and size. Qwen3-ASR gives
 * no word times; the aligner takes Qwen's text and the same audio and puts a start and an end on
 * every word (`aligner.ts`). Like llama-catalog.ts this file imports only types, so the Dockerfile's
 * llama stage, which fetches the image's build from it, stays small.
 *
 * Why this route (docs/research/asr-architecture.md, "Word times for Qwen"): transcribe-cpp has no
 * forced aligner and llama.cpp does not run its timestamp head; onnxruntime has no Metal or Vulkan
 * provider. CrispASR (MIT) runs it from one program with `--align-only`. Measured through akou on
 * LibriSpeech test-clean against forced-aligner reference times: median start error 0.023 s,
 * 99.97 % of words within 0.2 s, the same on Metal and on Vulkan.
 *
 * Only two builds: Metal on Apple silicon and Vulkan on x64 Linux. The CPU build gave times far
 * outside the audio under load with more than one thread, and runs at about real time with one;
 * CUDA, arm64 Linux and Windows are not measured. Elsewhere Qwen's words keep null times and the
 * result says why.
 */

import { existsSync } from "node:fs";
import type { LlamaBuild } from "./llama-catalog.ts";
import { MODEL_TEXT } from "./model-text.ts";
import type { CatalogEntry } from "./models.ts";

export const ALIGNER = "qwen3-forced-aligner-0.6b";
/**
 * CrispASR picks the aligner's family from the file name: the same GGUF under another name is read
 * as a Canary CTC aligner and fails. The file keeps its published name.
 */
export const ALIGNER_FILE = "qwen3-forced-aligner-0.6b-q4_k.gguf";

/** The aligner's 11 languages, from its model card. */
export const ALIGNER_LANGUAGES: readonly string[] = "zh en yue fr de it ja ko pt ru es".split(" ");

/** The CrispASR release every build comes from, published 2026-10-21. */
export const CRISPASR_RELEASE = "v0.8.44";
const RELEASES = "https://github.com/CrispStrobe/CrispASR/releases/download";

const HF_ALIGNER =
  "https://huggingface.co/cstr/qwen3-forced-aligner-0.6b-GGUF/resolve/1ec5110602ccab18c878ddebedab0891e290a95c";

// Sizes and digests from the release's own asset list (GitHub API `digest`), read 2026-10-25.
export const CRISPASR_BUILDS: readonly LlamaBuild[] = [
  {
    platform: "darwin-arm64",
    accelerator: "metal",
    assets: [
      {
        name: "crispasr-macos-arm64.tar.gz",
        size: 18058008,
        sha256: "9127979ec1275f266c007034023c96db849ecde0e5e3d1cedf9e093bf57a2b28",
      },
    ],
  },
  {
    platform: "linux-x64",
    accelerator: "vulkan",
    assets: [
      {
        name: "crispasr-linux-x86_64-vulkan.tar.gz",
        size: 70886854,
        sha256: "f77200bcceca3044bcbe0471442197f4bdae12593ca928ea54c8d5c290d8423c",
      },
    ],
  },
];

export function crispasrUrl(name: string): string {
  return `${RELEASES}/${CRISPASR_RELEASE}/${name}`;
}

/** The catalog id of the CrispASR build for a platform and accelerator. */
export function crispasrBuildId(platform: string, accelerator: string): string {
  return `crispasr-${CRISPASR_RELEASE}-${platform}-${accelerator}`;
}

/** The build for a platform and accelerator, or null where the aligner does not run. */
export function crispasrBuild(platform: string, accelerator: string): LlamaBuild | null {
  return (
    CRISPASR_BUILDS.find((b) => b.platform === platform && b.accelerator === accelerator) ?? null
  );
}

/** CrispASR's file name on a platform. */
export function crispasrName(platform: string): string {
  return platform.startsWith("win32") ? "crispasr.exe" : "crispasr";
}

export const ALIGNER_CATALOG: readonly CatalogEntry[] = [
  {
    id: ALIGNER,
    ...MODEL_TEXT[ALIGNER],
    job: "word times for the best preset's Qwen3-ASR words, 11 languages, run by CrispASR on Metal or Vulkan",
    licence: "Apache-2.0",
    source: "https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B",
    serves: ["aligner"],
    runtime: "crispasr",
    platforms: [...new Set(CRISPASR_BUILDS.map((b) => b.platform))],
    accelerators: [...new Set(CRISPASR_BUILDS.map((b) => b.accelerator))],
    languages: ALIGNER_LANGUAGES,
    onDemand: true,
    files: [
      {
        name: ALIGNER_FILE,
        url: `${HF_ALIGNER}/${ALIGNER_FILE}`,
        sha256: "a7bb4cbeacc6414f11a5d23dc7661a51a941a71e6d559dc7b408b52473f2ae84",
        size: 529001216,
      },
    ],
  },
  ...CRISPASR_BUILDS.map(
    ({ platform, accelerator, assets }): CatalogEntry => ({
      id: crispasrBuildId(platform, accelerator),
      job: `CrispASR ${CRISPASR_RELEASE} for ${platform} on ${accelerator}, which runs the word-time aligner`,
      licence: "MIT",
      source: `https://github.com/CrispStrobe/CrispASR/releases/tag/${CRISPASR_RELEASE}`,
      serves: ["runtime"],
      runtime: "crispasr",
      platforms: [platform],
      accelerators: [accelerator],
      languages: "any",
      onDemand: true,
      files: assets.map((a) => ({ ...a, url: crispasrUrl(a.name) })),
    }),
  ),
];

/** Where the aligner's CrispASR comes from here, or why the aligner cannot run. */
export type AlignerPlan =
  | { command: readonly string[] }
  | { build: CatalogEntry }
  | { why: string };

/**
 * The aligner on this machine, by the backend Qwen's llama-server runs (`accelerator`): only Metal
 * and Vulkan. An image runs the build it carries (`AKOU_CRISPASR`), else the pinned build for the
 * platform and backend is downloaded with the best preset.
 */
export function alignerPlan(o: {
  accelerator: string;
  platform: string;
  /** `AKOU_CRISPASR`: the build an image carries. */
  image?: string;
}): AlignerPlan {
  if (o.accelerator !== "metal" && o.accelerator !== "vulkan") {
    const on = o.accelerator === "cpu" ? "the CPU" : o.accelerator;
    return { why: `the aligner runs only on Metal or Vulkan, and Qwen runs on ${on} here` };
  }
  if (o.image) return { command: [o.image] };
  const build = ALIGNER_CATALOG.find((m) => m.id === crispasrBuildId(o.platform, o.accelerator));
  return build
    ? { build }
    : { why: `there is no aligner build for ${o.platform} on ${o.accelerator}` };
}

/** The catalog ids the best preset fetches besides Qwen for word times: none when it cannot run. */
export function alignerIds(plan: AlignerPlan): string[] {
  if ("why" in plan) return [];
  return "build" in plan ? [ALIGNER, plan.build.id] : [ALIGNER];
}

/**
 * `AKOU_CRISPASR` when the file is there: every image sets it, and only the Vulkan one on amd64
 * carries the build, so on the others it names nothing.
 */
export function imageAligner(path: string | undefined): string | undefined {
  return path && existsSync(path) ? path : undefined;
}
