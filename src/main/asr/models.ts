/**
 * The speech models akou uses (docs/DESIGN.md section 3): what they are, where they come from, what
 * they weigh, their licences, and a downloader that checks every file against a pinned SHA-256.
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
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DiarizerKind } from "./engine.ts";

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

export const MODELS: readonly ModelSpecEntry[] = [
  {
    id: RECOGNIZER,
    job: "live and final recognition, 25 European languages",
    licence: "CC-BY-4.0",
    source: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
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
    files: [
      {
        name: "nemo_en_titanet_small.onnx",
        url: `${GH}/speaker-recongition-models/nemo_en_titanet_small.onnx`,
        sha256: "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e",
        size: 40257283,
      },
    ],
  },
];

/** The models only one speaker-label engine needs. */
const ONLY: Readonly<Record<DiarizerKind, readonly string[]>> = {
  nemotron: [NEMOTRON],
  embeddings: ["pyannote-segmentation-3.0"],
};

/**
 * The models a machine needs for its `asr.diarizer`: the recognizer, the VAD and TitaNet always,
 * then Nemotron or pyannote. `akou models pull` fetches these and `akou doctor` checks them.
 */
export function modelsFor(diarizer: DiarizerKind): readonly ModelSpecEntry[] {
  const other = diarizer === "nemotron" ? ONLY.embeddings : ONLY.nemotron;
  return MODELS.filter((m) => !other.includes(m.id));
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
