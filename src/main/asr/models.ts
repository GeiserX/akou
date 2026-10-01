/**
 * The speech models akou uses (docs/DESIGN.md section 3): what they are, where they come from, what
 * they weigh, their licences, and a downloader that checks every file against a pinned SHA-256.
 *
 * `MODELS` is the engine catalog (docs/research/asr-architecture.md section 2.2): each entry also
 * says which engine roles it serves, the runtime that runs it, the platforms and accelerators it
 * runs on, and the languages it hears. `modelsFor(settings, platform)` picks a machine's list.
 *
 * akou never bundles models. First run offers one explicit download into the user's models folder;
 * `akou models import <dir>` covers air-gapped machines. Every file is fetched from a URL pinned to
 * an exact revision, resumed from a `.part` file with an HTTP range request, and moved into place
 * only after its checksum matches. Tests and CI never download: `downloadModels` refuses any
 * non-loopback URL when `CI` is set or under `bun test`.
 *
 * Layout: `<models>/<model id>/<file>`.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DiarizerKind } from "./engine.ts";
import { LLAMA_CATALOG } from "./llama-catalog.ts";
import { MODEL_TEXT } from "./model-text.ts";

export interface ModelFileSpec {
  name: string;
  url: string;
  sha256: string;
  size: number;
}

export interface ModelSpecEntry {
  id: string;
  job: string;
  licence: string;
  /** Where the licence and the weights are described. */
  source: string;
  files: ModelFileSpec[];
}

/** The machines akou is released for, as `${process.platform}-${process.arch}`. */
export const PLATFORMS = ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * How an entry runs: in-process sherpa-onnx, the `akou-diarize` helper, or a `llama-server` child
 * process (llama.cpp), which is itself a catalog entry per platform and accelerator.
 */
export const RUNTIMES = ["sherpa-onnx", "akou-diarize", "llama-server"] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** The llama.cpp backends akou ships builds of (llama-builds.ts), in the order `asr.accelerator` lists them. */
export const ACCELERATORS = ["cpu", "metal", "vulkan", "cuda", "sycl", "rocm"] as const;
export type Accelerator = (typeof ACCELERATORS)[number];

/** The interfaces of engine.ts an entry serves; `runtime` is a program another entry runs on. */
export const ROLES = ["final", "live", "vad", "diarizer", "embedder", "runtime"] as const;
export type Role = (typeof ROLES)[number];

/** A catalog entry: a model with what runs it, where, and for which languages. */
export interface CatalogEntry extends ModelSpecEntry {
  serves: readonly Role[];
  runtime: Runtime;
  platforms: readonly Platform[];
  accelerators: readonly Accelerator[];
  /** ISO 639-1 codes the model recognizes, or `any` for a model that hears no words. */
  languages: "any" | readonly string[];
  /**
   * Fetched only when a preset, a job or `akou models pull` names it, never as part of a machine's
   * default download (`modelsFor`): Qwen and the llama-server builds weigh gigabytes a `fast`
   * machine never loads.
   */
  onDemand?: true;
  /** Its name where a person picks it (model-text.ts). */
  name?: string;
  /** A shorter name for the Record row's button; absent: `name`. */
  short?: string;
  /**
   * One plain line per slot it can fill, `live` and `review` (model-text.ts), as the live panel
   * and the Models page show it. A model in a slot with no line fails tests/live-setups.test.ts.
   */
  lines?: { live?: string; review?: string };
}

/** Parakeet TDT v3's 25 European languages, from its model card. */
export const PARAKEET_LANGUAGES: readonly string[] =
  "bg cs da de el en es et fi fr hr hu it lt lv mt nl pl pt ro ru sk sl sv uk".split(" ");

/** Nemotron 3.5's languages, from its model card. */
export const NEMOTRON_35_LANGUAGES: readonly string[] =
  "en es de fr it ar ja ko pt ru hi zh vi he nl cs da pl no sv th tr bg el et fi hr hu lt lv ro sk uk mt sl".split(
    " ",
  );

/** Every model today runs on the CPU on every released platform. */
const EVERYWHERE = { platforms: PLATFORMS, accelerators: ["cpu"] } as const;

const HF_PARAKEET =
  "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3/resolve/1a468a35cbba69418f126de829e75261dea4a4e4";
const HF_PARAKEET_UPSTREAM =
  "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/541d1f99c6b0c3cd0b11a95167540bb8edefd82b";
const HF_PYANNOTE =
  "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0";
const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
// NVIDIA publishes the checkpoint as `.nemo` and safetensors; this is its ONNX export by the
// parakeet-rs author, which akou-diarize runs. Checked against NeMo on real calls: the same speaker
// on 99.98 to 100 % of 10 ms frames.
const HF_NEMOTRON =
  "https://huggingface.co/altunenes/parakeet-rs/resolve/4d2a8bc71f5c896ec40faa59732e6716295edaf2/nemotron-3-diarization";

// sherpa-onnx's int8 exports of the streaming Nemotron models, one repository per chunk size.
const HF_NEMOTRON_EN_560 =
  "https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25/resolve/52056fdc070914a48dcd68b31b44d6a6f5b85902";
const HF_NEMOTRON_35_560 =
  "https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/ab43d895f5985b1bbab8b6eac8607fcdc05343f3";
const HF_NEMOTRON_35_1120 =
  "https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-1120ms-int8-2026-06-11/resolve/cba1c96ca5ef0e8393b50584ae153a79145dc492";

/**
 * The same two models exported at other chunk sizes, one repository each, pinned by revision. The
 * encoder differs per chunk size; the decoder, joiner and symbol table are the same bytes as the
 * 560 ms tier's. The live path drives them exactly as it drives the tiers above.
 */
const HF_STREAMING = "https://huggingface.co/csukuangfj2";
const HF_NEMOTRON_EN_TIER = (ms: number, rev: string) =>
  `${HF_STREAMING}/sherpa-onnx-nemotron-speech-streaming-en-0.6b-${ms}ms-int8-2026-04-25/resolve/${rev}`;
const HF_NEMOTRON_35_TIER = (ms: number, rev: string) =>
  `${HF_STREAMING}/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-${ms}ms-int8-2026-06-11/resolve/${rev}`;

/** A streaming Nemotron's symbol table (sherpa-onnx names it tokens.txt). */
const SYMBOLS_FILE = "tokens.txt";

/** One file of a streaming Nemotron export. */
function liveFile(
  base: string,
  name: string,
  pin: { sha256: string; size: number },
): ModelFileSpec {
  return { name, url: `${base}/${name}`, ...pin };
}

/** The decoder, joiner and symbol table the two Nemotron 3.5 tiers share, byte for byte. */
function nemotron35Shared(base: string): ModelFileSpec[] {
  return [
    liveFile(base, "decoder.int8.onnx", {
      sha256: "19f9c98fc6d0a2c33a65a43b36fdb2e914c26c0aa9764be3aebc502a1e982fb0",
      size: 14978075,
    }),
    liveFile(base, "joiner.int8.onnx", {
      sha256: "4101c7c679a0bc30483794b27a059e34e79232aa2068d78d51231a22c8b0d7ce",
      size: 9504438,
    }),
    liveFile(base, SYMBOLS_FILE, {
      sha256: "729cc103155bafa785f9cd45746cd41cabe97eab7182fc04d594129587958f8a",
      size: 131440,
    }),
  ];
}

/** The decoder, joiner and symbol table every English Nemotron tier shares, byte for byte. */
function nemotronEnShared(base: string): ModelFileSpec[] {
  return [
    liveFile(base, "decoder.int8.onnx", {
      sha256: "0be9702c2f427a2b6bb241d298e0d3836a558de1f5b9fd3018f1cce6e2b3fa98",
      size: 7257753,
    }),
    liveFile(base, "joiner.int8.onnx", {
      sha256: "a35eac38a22ebceb04d230ed7afe0d68f446ba6914a036b97f14fece95967e23",
      size: 1735862,
    }),
    liveFile(base, SYMBOLS_FILE, {
      sha256: "dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff",
      size: 8952,
    }),
  ];
}

/**
 * One more chunk size of a streaming Nemotron: its own encoder, the shared rest. Fetched only when
 * named, like every live model; `auto` never picks one (live-engines.ts).
 */
function streamingTier(
  family: "en" | "3.5",
  ms: number,
  rev: string,
  encoder: { sha256: string; size: number },
): CatalogEntry {
  const id = `nemotron-${family}-${ms}`;
  const base = family === "en" ? HF_NEMOTRON_EN_TIER(ms, rev) : HF_NEMOTRON_35_TIER(ms, rev);
  const en = family === "en";
  return {
    id,
    ...MODEL_TEXT[id],
    job: `live recognition, ${en ? "English" : "35 languages and switching between them"}, streaming at ${ms} ms (asr.live.engine)`,
    licence: en ? "NVIDIA Open Model License" : "OpenMDW-1.1",
    source: en
      ? "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b"
      : "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b",
    serves: ["live"],
    runtime: "sherpa-onnx",
    ...EVERYWHERE,
    languages: en ? ["en"] : NEMOTRON_35_LANGUAGES,
    onDemand: true,
    files: [
      liveFile(base, "encoder.int8.onnx", encoder),
      ...(en ? nemotronEnShared(base) : nemotron35Shared(base)),
    ],
  };
}

/**
 * The other chunk sizes of the two streaming Nemotrons: a shorter chunk writes a word sooner, a
 * longer one sees more audio before it writes. Their accuracy and speed in akou are not measured
 * (model-scores.ts); docs/research/model-catalog-2026-10.md lists them.
 */
const MORE_TIERS: readonly CatalogEntry[] = [
  streamingTier("en", 80, "2866f44b7af4fd6d0da5ce712772b3497b0871bf", {
    sha256: "29a6aaf9155f25562a08a1aeea1f1a1a5d24b2f44a1d68211faf8a92073d1df6",
    size: 652916847,
  }),
  streamingTier("en", 160, "237e551abd7a411ef92d3595454d9f6ab5fe7d6c", {
    sha256: "71111f61b18e1e65e01e369434a5c0434868d2f44892742ae54240600c681209",
    size: 652916849,
  }),
  streamingTier("en", 1120, "b0b6bae3da99ea3d81b315ba018e951501850c2c", {
    sha256: "7d2246da3c077e8b57698d398e09d8ca67f50de73b3468af397b22213ce72117",
    size: 652916852,
  }),
  streamingTier("3.5", 80, "2ac5952ae18a2cc010c25e3fd96ad20cf254bd09", {
    sha256: "411e1222810f4a4cf0a3704c7609597a12def5b4ad2c7347a24ccd40d895484d",
    size: 657601516,
  }),
  streamingTier("3.5", 160, "b3a4dbde84fba1a13cb4270e6730b525ac6a2db6", {
    sha256: "e1b39e5e16bef578a54ed2fba5f031438e000cc36c3ea2ca49d55699d5baebd4",
    size: 657601518,
  }),
  streamingTier("3.5", 320, "424ce58898995b713f84341f2e1492f9207a26aa", {
    sha256: "f79c3fcc149f268b54b7d5754bdc2ba5c47c16b1fc70d15728a56f6efbf60ca5",
    size: 657601518,
  }),
];

/** The live pass's streaming engines (live-engines.ts): fetched when a call's setting needs one. */
const LIVE_MODELS: readonly CatalogEntry[] = [
  {
    id: "nemotron-en-560",
    ...MODEL_TEXT["nemotron-en-560"],
    job: "live recognition, English, streaming at 560 ms (asr.live.engine)",
    licence: "NVIDIA Open Model License",
    source: "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b",
    serves: ["live"],
    runtime: "sherpa-onnx",
    ...EVERYWHERE,
    languages: ["en"],
    onDemand: true,
    files: [
      liveFile(HF_NEMOTRON_EN_560, "encoder.int8.onnx", {
        sha256: "7d932213491ad355c6e5576705dc3494731a52af87d7a1b954559340147909d8",
        size: 652916849,
      }),
      liveFile(HF_NEMOTRON_EN_560, "decoder.int8.onnx", {
        sha256: "0be9702c2f427a2b6bb241d298e0d3836a558de1f5b9fd3018f1cce6e2b3fa98",
        size: 7257753,
      }),
      liveFile(HF_NEMOTRON_EN_560, "joiner.int8.onnx", {
        sha256: "a35eac38a22ebceb04d230ed7afe0d68f446ba6914a036b97f14fece95967e23",
        size: 1735862,
      }),
      liveFile(HF_NEMOTRON_EN_560, SYMBOLS_FILE, {
        sha256: "dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff",
        size: 8952,
      }),
    ],
  },
  {
    id: "nemotron-3.5-560",
    ...MODEL_TEXT["nemotron-3.5-560"],
    job: "live recognition, 35 languages and switching between them, streaming at 560 ms (asr.live.engine)",
    licence: "OpenMDW-1.1",
    source: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b",
    serves: ["live"],
    runtime: "sherpa-onnx",
    ...EVERYWHERE,
    languages: NEMOTRON_35_LANGUAGES,
    onDemand: true,
    files: [
      liveFile(HF_NEMOTRON_35_560, "encoder.int8.onnx", {
        sha256: "012e9321373af99021415e0b0eb3ec827b4be3153be6f30d9b448fe65e896e68",
        size: 657601403,
      }),
      ...nemotron35Shared(HF_NEMOTRON_35_560),
    ],
  },
  {
    id: "nemotron-3.5-1120",
    ...MODEL_TEXT["nemotron-3.5-1120"],
    job: "live recognition, 35 languages, streaming at 1120 ms: the Spanish default (asr.live.engine)",
    licence: "OpenMDW-1.1",
    source: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b",
    serves: ["live"],
    runtime: "sherpa-onnx",
    ...EVERYWHERE,
    languages: NEMOTRON_35_LANGUAGES,
    onDemand: true,
    files: [
      liveFile(HF_NEMOTRON_35_1120, "encoder.int8.onnx", {
        sha256: "2fff2166acaa535bd969fb223c1f0783d71029f143cb298bc54c2afe85abf772",
        size: 657601521,
      }),
      ...nemotron35Shared(HF_NEMOTRON_35_1120),
    ],
  },
];

/**
 * The full-precision (fp32) export: a third fewer word errors in English and a fifth fewer in Spanish
 * than the int8 build on FLEURS, and more names found under biasing (docs/research/asr-benchmark.md).
 */
export const RECOGNIZER = "parakeet-tdt-0.6b-v3-fp32";
export const NEMOTRON = "nemotron-3-diarization";
export const NEMOTRON_FILE = "nemotron3_diar_v3.onnx";

/**
 * Model folders an earlier akou downloaded and nothing reads any more. They are deleted once every
 * current file is in place and verified, never before, so an interrupted download leaves them be.
 */
export const RETIRED_MODELS: readonly string[] = ["parakeet-tdt-0.6b-v3-int8"];

export const MODELS: readonly CatalogEntry[] = [
  {
    id: RECOGNIZER,
    ...MODEL_TEXT["parakeet-tdt-0.6b-v3-fp32"],
    job: "live and final recognition, 25 European languages",
    licence: "CC-BY-4.0",
    source: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
    serves: ["final", "live"],
    runtime: "sherpa-onnx",
    ...EVERYWHERE,
    languages: PARAKEET_LANGUAGES,
    files: [
      {
        name: "encoder.onnx",
        url: `${HF_PARAKEET}/encoder.onnx`,
        sha256: "3eed7ce424bf8339ad09233533c687e2dbd07e74ccf5027b5e7344019ea373b0",
        size: 41766257,
      },
      {
        // The encoder's weights, over protobuf's 2 GB limit. encoder.onnx names this file, so it
        // must keep this exact name and sit in the same folder.
        name: "encoder.weights",
        url: `${HF_PARAKEET}/encoder.weights`,
        sha256: "3af3f51af5f2d01dbbf5af47d42c7962a2c205f11004254bb4f2b979862f39a8",
        size: 2435420160,
      },
      {
        name: "decoder.onnx",
        url: `${HF_PARAKEET}/decoder.onnx`,
        sha256: "d593cdb0e571f5a457ec2219af9968cbf6b0e8198e8f7839b40a8754593bf68c",
        size: 47233743,
      },
      {
        name: "joiner.onnx",
        url: `${HF_PARAKEET}/joiner.onnx`,
        sha256: "b9b0bcf88ac571902e69a6536223ed2d94885e981b85045410f1403d53121a63",
        size: 25286330,
      },
      {
        name: "tokens.txt",
        url: `${HF_PARAKEET}/tokens.txt`,
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        size: 93939,
      },
      {
        // The model's own tokenizer, from which akou builds the `bpe.vocab` biasing needs.
        name: "tokenizer.json",
        url: `${HF_PARAKEET_UPSTREAM}/tokenizer.json`,
        sha256: "bd321b096832a3f270bd3b2a88823957920f1a5c5ada71114a26ea729d0cbe91",
        size: 1159960,
      },
    ],
  },
  {
    id: "silero-vad",
    job: "voice activity: cut points only",
    licence: "MIT",
    source: "https://github.com/snakers4/silero-vad",
    serves: ["vad"],
    runtime: "sherpa-onnx",
    ...EVERYWHERE,
    languages: "any",
    files: [
      {
        name: "silero_vad.onnx",
        url: `${GH}/asr-models/silero_vad.onnx`,
        sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
        size: 643854,
      },
    ],
  },
  {
    id: NEMOTRON,
    job: "speaker labels, live and final (asr.diarizer nemotron)",
    licence: "OpenMDW-1.1",
    source: "https://huggingface.co/nvidia/Nemotron-3-Diarization",
    serves: ["diarizer"],
    runtime: "akou-diarize",
    ...EVERYWHERE,
    languages: "any",
    files: [
      {
        name: NEMOTRON_FILE,
        url: `${HF_NEMOTRON}/${NEMOTRON_FILE}`,
        sha256: "915e4fa23b0192ed9fadeb1cdd26847df986d50c92012d177be28d0343bbe03a",
        size: 400506656,
      },
    ],
  },
  {
    id: "pyannote-segmentation-3.0",
    job: "speaker segmentation for the final pass (asr.diarizer embeddings)",
    licence: "MIT",
    source: "https://huggingface.co/pyannote/segmentation-3.0",
    serves: ["diarizer"],
    runtime: "sherpa-onnx",
    ...EVERYWHERE,
    languages: "any",
    files: [
      {
        name: "model.onnx",
        url: `${HF_PYANNOTE}/model.onnx`,
        sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
        size: 5992913,
      },
    ],
  },
  {
    id: "titanet-small",
    job: "speaker embeddings: live clusters, final diarization with pyannote, and names across a restart with Nemotron",
    licence: "CC-BY-4.0",
    source: "https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_small",
    serves: ["embedder"],
    runtime: "sherpa-onnx",
    ...EVERYWHERE,
    languages: "any",
    files: [
      {
        name: "nemo_en_titanet_small.onnx",
        url: `${GH}/speaker-recongition-models/nemo_en_titanet_small.onnx`,
        sha256: "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e",
        size: 40257283,
      },
    ],
  },
  ...LIVE_MODELS,
  ...MORE_TIERS,
  ...LLAMA_CATALOG,
];

/** The models only one speaker-label engine needs. */
const ONLY: Readonly<Record<DiarizerKind, readonly string[]>> = {
  nemotron: [NEMOTRON],
  embeddings: ["pyannote-segmentation-3.0"],
};

/** This machine in the catalog's terms; a machine akou is not released for matches no entry. */
export function hostPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * The models a machine needs for its settings (`asr.diarizer`) on its platform: the recognizer, the
 * VAD and TitaNet always, then Nemotron or pyannote, each only where it runs. An `onDemand` entry
 * (Qwen, the llama-server builds) is never in it. Given `chosen`, the speech models the chosen
 * setups use (`chosenModels` in model-set.ts), Parakeet is in it only when a setup uses it, and the
 * on-demand models they name (Qwen, its llama-server, a streaming Nemotron) are in it too. `akou models pull`
 * fetches these and `akou doctor` checks them. Tests pass their own registry, which loses the other
 * engine's entries the same way; an entry with no `platforms` (a test's) runs everywhere.
 */
export function modelsFor<T extends ModelSpecEntry>(
  settings: { readonly "asr.diarizer": string },
  platform: string,
  registry: readonly T[] = MODELS as unknown as readonly T[],
  chosen?: readonly string[],
): readonly T[] {
  const diarizer = settings["asr.diarizer"] as DiarizerKind;
  const other = diarizer === "nemotron" ? ONLY.embeddings : ONLY.nemotron;
  return registry.filter((m) => {
    const c = m as Partial<CatalogEntry>;
    const platforms = c.platforms as readonly string[] | undefined;
    if (other.includes(m.id) || (platforms !== undefined && !platforms.includes(platform)))
      return false;
    // With the chosen setups' models (model-set.ts): Parakeet, the one model of the default set a
    // setup may not use, only when one does, and the on-demand models they name.
    if (chosen) return chosen.includes(m.id) || (!c.onDemand && m.id !== RECOGNIZER);
    return !c.onDemand;
  });
}

/** What is wrong with each catalog entry, as `<id>: <problem>`; empty when every entry is whole. */
export function catalogProblems(registry: readonly CatalogEntry[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const known = <T extends string>(all: readonly T[], xs: readonly string[]) =>
    xs.length > 0 && xs.every((x) => (all as readonly string[]).includes(x));
  for (const m of registry) {
    const bad = (what: string) => out.push(`${m.id}: ${what}`);
    if (seen.has(m.id)) bad("duplicate id");
    seen.add(m.id);
    if (!m.job?.trim()) bad("no job");
    if (!m.licence?.trim()) bad("no licence");
    if (!m.source?.trim()) bad("no source");
    if (!m.files?.length) bad("no files");
    if (!(RUNTIMES as readonly string[]).includes(m.runtime)) bad(`unknown runtime ${m.runtime}`);
    if (!known(PLATFORMS, m.platforms ?? [])) bad("platforms missing or unknown");
    if (!known(ACCELERATORS, m.accelerators ?? [])) bad("accelerators missing or unknown");
    if (!known(ROLES, m.serves ?? [])) bad("serves no known role");
    const langs = m.languages;
    if (langs !== "any" && !(langs?.length && langs.every((l) => /^[a-z]{2,3}$/.test(l)))) {
      bad("languages must be `any` or ISO 639 codes");
    }
  }
  return out;
}

export function modelEntry(id: string): ModelSpecEntry {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model ${id}`);
  return m;
}

export function modelFile(dir: string, id: string, name: string): string {
  return join(dir, id, name);
}

/**
 * Deletes the retired model folders in `dir` (`RETIRED_MODELS`) and returns the ids it removed.
 * Callers run it only after every current file is verified. A folder that cannot be removed (a file
 * held open on Windows) is left for the next pull, never failing the one that just succeeded.
 */
export function pruneRetiredModels(
  dir: string,
  retired: readonly string[] = RETIRED_MODELS,
): string[] {
  const removed: string[] = [];
  for (const id of retired) {
    const path = join(dir, id);
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(id);
    } catch {
      // Left in place; the next pull tries again.
    }
  }
  return removed;
}

/** `~/.local/share/akou/models` on Linux, `~/Library/Application Support/akou/models` on macOS. */
export function defaultModelsDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  if (env.AKOU_MODELS_DIR) return env.AKOU_MODELS_DIR;
  if (platform === "win32") return join(env.LOCALAPPDATA ?? homedir(), "akou", "models");
  if (platform === "darwin")
    return join(homedir(), "Library", "Application Support", "akou", "models");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "akou", "models");
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** The first-run download of the speech models (`GET /models`, `POST /models/pull`). */
export interface ModelsStatus {
  state: "missing" | "downloading" | "ready" | "failed";
  dir: string;
  /** Bytes on disk of every file, and the total the registry declares. */
  bytes: number;
  total: number;
  /** The file being fetched, while downloading. */
  file?: string;
  error?: string;
}

export interface FileState {
  model: string;
  name: string;
  path: string;
  state: "ok" | "missing" | "size" | "checksum";
}

/** Checks every file of the given models on disk: presence, size, then SHA-256. */
export async function verifyModels(
  dir: string,
  ids: readonly string[] = MODELS.map((m) => m.id),
  registry: readonly ModelSpecEntry[] = MODELS,
): Promise<FileState[]> {
  const out: FileState[] = [];
  for (const id of ids) {
    const m = registry.find((x) => x.id === id);
    if (!m) throw new Error(`unknown model ${id}`);
    for (const f of m.files) {
      const path = modelFile(dir, id, f.name);
      const base = { model: id, name: f.name, path };
      if (!existsSync(path)) out.push({ ...base, state: "missing" });
      else if (statSync(path).size !== f.size) out.push({ ...base, state: "size" });
      else if ((await sha256File(path)) !== f.sha256) out.push({ ...base, state: "checksum" });
      else out.push({ ...base, state: "ok" });
    }
  }
  return out;
}

export class DownloadRefused extends Error {
  override name = "DownloadRefused";
}

export class ChecksumError extends Error {
  override name = "ChecksumError";
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** True under `bun test` or in CI, where akou must never fetch a model. */
export function networkForbidden(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.CI || env.NODE_ENV === "test" || env.AKOU_NO_DOWNLOAD === "1";
}

export interface DownloadProgress {
  model: string;
  name: string;
  bytes: number;
  total: number;
}

export interface DownloadOptions {
  fetch?: typeof fetch;
  onProgress?(p: DownloadProgress): void;
  env?: NodeJS.ProcessEnv;
  /** Stops the download; the partial file stays, so the next one resumes from it. */
  signal?: AbortSignal;
}

/**
 * Fetches one file into `path`, resuming from `path.part`, and moves it into place only once its
 * size and SHA-256 match. A mismatch deletes the partial file and throws.
 */
export async function downloadFile(
  model: string,
  f: ModelFileSpec,
  path: string,
  o: DownloadOptions = {},
): Promise<void> {
  if (networkForbidden(o.env) && !isLoopback(f.url)) {
    throw new DownloadRefused(`refusing to download ${f.url}: downloads are off in tests and CI`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > f.size) {
    rmSync(part);
    have = 0;
  }
  if (have < f.size) {
    const res = await (o.fetch ?? fetch)(f.url, {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      redirect: "follow",
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (res.status === 200 && have > 0)
      have = 0; // the server ignored the range: start over
    else if (res.status !== 200 && res.status !== 206) {
      throw new Error(`download of ${f.url} failed: HTTP ${res.status}`);
    }
    const fh = await open(part, have > 0 ? "a" : "w");
    try {
      let bytes = have;
      if (!res.body) throw new Error(`download of ${f.url} returned no body`);
      for await (const chunk of res.body) {
        o.signal?.throwIfAborted();
        await fh.write(chunk);
        bytes += chunk.byteLength;
        if (bytes > f.size) throw new ChecksumError(`${f.name} is larger than ${f.size} bytes`);
        o.onProgress?.({ model, name: f.name, bytes, total: f.size });
      }
    } finally {
      await fh.close();
    }
  }
  const size = statSync(part).size;
  const sum = size === f.size ? await sha256File(part) : "";
  if (sum !== f.sha256) {
    rmSync(part, { force: true });
    throw new ChecksumError(
      size !== f.size
        ? `${f.name}: got ${size} bytes, expected ${f.size}`
        : `${f.name}: SHA-256 ${sum} does not match the pinned ${f.sha256}`,
    );
  }
  renameSync(part, path);
}

/** Downloads every missing or bad file of the given models. Files already verified are skipped. */
export async function downloadModels(
  dir: string,
  ids: readonly string[] = MODELS.map((m) => m.id),
  o: DownloadOptions & { registry?: readonly ModelSpecEntry[] } = {},
): Promise<FileState[]> {
  const registry = o.registry ?? MODELS;
  const out: FileState[] = [];
  for (const id of ids) {
    const m = registry.find((x) => x.id === id);
    if (!m) throw new Error(`unknown model ${id}`);
    for (const f of m.files) {
      const path = modelFile(dir, id, f.name);
      if (
        existsSync(path) &&
        statSync(path).size === f.size &&
        (await sha256File(path)) === f.sha256
      ) {
        out.push({ model: id, name: f.name, path, state: "ok" });
        continue;
      }
      if (existsSync(path)) rmSync(path);
      await downloadFile(id, f, path, o);
      out.push({ model: id, name: f.name, path, state: "ok" });
    }
  }
  return out;
}

/**
 * `models import DIR` and `POST /models/import`: copies every file of `catalog` whose SHA-256
 * matches from `from/<model>/<file>` or `from/<file>` into `dir`, for machines that cannot
 * download. Answers the files copied and the files still missing.
 */
export async function importModels(
  from: string,
  dir: string,
  catalog: readonly ModelSpecEntry[],
): Promise<{ copied: string[]; missing: string[] }> {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const m of catalog) {
    for (const f of m.files) {
      const target = modelFile(dir, m.id, f.name);
      const source = [join(from, m.id, f.name), join(from, f.name)].find(
        (s) => existsSync(s) && statSync(s).size === f.size,
      );
      if (!source || (await sha256File(source)) !== f.sha256) {
        // A file already there counts only at its full size, as `models list` reads it.
        if (!existsSync(target) || statSync(target).size !== f.size) {
          missing.push(`${m.id}/${f.name}`);
        }
        continue;
      }
      mkdirSync(join(dir, m.id), { recursive: true });
      const tmp = `${target}.import`;
      copyFileSync(source, tmp);
      renameSync(tmp, target);
      copied.push(`${m.id}/${f.name}`);
    }
  }
  return { copied, missing };
}
