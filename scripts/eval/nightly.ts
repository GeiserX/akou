/**
 * The nightly model evaluation (`models-nightly`, docs/TESTING.md TS-19 and TS-20): the real
 * recognizer and the real diarizer, through the app's own code, on public, openly licensed audio,
 * compared with the baselines committed in docs/gates/nightly-baselines.json.
 *
 *   bun scripts/eval/nightly.ts --models <dir> --data <dir> --diarize <akou-diarize> --nemotron <onnx>
 *                               [--qwen-models <dir>] [--only fleurs,ami,replay,qwen,dictation,biasing]
 *                               [--out results.json] [--latency-table <json>] [--biasing-out <json>]
 *                               [--machine <what>] [--accelerator cpu|vulkan|cuda|metal]
 *
 * What it measures, per OS:
 *
 * - WER per engine and language on the FLEURS subset of docs/research/asr-benchmark.md (150
 *   English and 150 Spanish test utterances, the ids in its JSON file), scored with the
 *   benchmark's normalizer. Gated at or below the baseline.
 * - Latency: each utterance's decode time, p50, p90 and p99, and the real-time factor. Recorded;
 *   the real-time factor of the default engines gates on its budget (0.5 on the 4-core x64 Linux
 *   runner, docs/TESTING.md 4.7) and nowhere else.
 * - Diarization error on two AMI Meeting Corpus test meetings, audio and annotations both
 *   CC-BY-4.0 (the only_words references of the standard AMI diarization setup at a pinned commit,
 *   0.25 s collar, overlap scored). Gated at or below the baseline.
 * - The replay recall of the query engine on five generated three-hour calls, with its 85 % floor.
 * - Qwen3-ASR-1.7B through the pinned llama-server, on macOS and Linux (ASR-5's acceptance,
 *   docs/research/asr-architecture.md section 9; on Windows only with `--accelerator`, the way the
 *   Windows gate ASR-12 runs it by hand, docs/gates/asr-12-windows.md): WER on
 *   30 FLEURS clips per language within +0.5 of the benchmark, no words on 25 silent AMI
 *   stretches, and llama-server's memory flat over 150 requests. The same requests on a server
 *   that keeps its default prompt cache are the failing control: its memory must pass the bound.
 *   And a five-minute unit of joined clips, which the engine sends in requests of at most
 *   `QWEN_MAX_REQUEST_SECONDS`, under a WER bound; the same unit sent uncut is the failing
 *   control, which must lose words past it.
 * - Dictation's release-to-text time per engine (DC-T3, `scripts/eval/dictation-latency.ts`): the
 *   streaming model, Qwen and a loopback remote akou, p50 and p95 for 3, 10 and 30 s of FLEURS
 *   speech. Recorded, and with `--latency-table` written as `docs/gates/dictation-latency.json`'s
 *   entry for this platform.
 * - Dictation biasing (DC-L7, `scripts/eval/dictation-biasing.ts`): Qwen3-ASR given the learned
 *   terms as context against none, on FLEURS clips, silence and noise: hits, false insertions, WER
 *   and echo rate per list size, with an overweighted positive control that must insert. It runs
 *   only when `--only` names it (360 decodes, too long for the scheduled night). With
 *   `--biasing-out` written as `docs/gates/dictation-biasing.json`; run `bunx biome format --write`
 *   on that file before committing it, or CI's biome check fails on JSON.stringify's layout.
 *
 * Every download is pinned by revision and checked by SHA-256: the published hash where the host
 * has one, and otherwise the hash of the file as first fetched (the AMI audio).
 * The job summary lists every number next to its baseline and ends with the licences. It exits 1
 * when any gated number is worse than its baseline, has none, or passes its bound.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEcho } from "../../src/core/dictation/echo.ts";
import { ASR_RATE } from "../../src/main/asr/engine.ts";
import { chooseLiveEngine } from "../../src/main/asr/live-engines.ts";
import { LiveAsr } from "../../src/main/asr/live-worker.ts";
import {
  llamaBuildId,
  QWEN_ASR,
  QWEN_MMPROJ_FILE,
  QWEN_MODEL_FILE,
} from "../../src/main/asr/llama-catalog.ts";
import {
  createLlamaServer,
  extractBuild,
  LlamaServer,
  resolveAccelerator,
} from "../../src/main/asr/llama-server.ts";
import {
  downloadModels,
  hostPlatform,
  MODELS,
  modelFile,
  modelsFor,
  RECOGNIZER,
} from "../../src/main/asr/models.ts";
import { NemotronDiarizer } from "../../src/main/asr/nemotron.ts";
import { QWEN_MAX_REQUEST_SECONDS, QwenEngine } from "../../src/main/asr/qwen.ts";
import { SherpaModels } from "../../src/main/asr/sherpa.ts";
import { BestEngine } from "../../src/main/dictation/best.ts";
import { LiveWords } from "../../src/main/dictation/live.ts";
import { RemoteUpload, testRemote } from "../../src/main/dictation/remote.ts";
import { replay } from "../../tests/eval/replay.ts";
import { silence as genSilence } from "../../tests/fixtures/asr-fake.ts";
import { roomNoise } from "../../tests/fixtures/audio.ts";
import { synthCall, synthQuestions } from "../../tests/synth.ts";
import {
  BIAS_CLIPS,
  BIASING_ABOUT,
  BIASING_SIZES,
  type BiasClip,
  type BiasScore,
  biasClip,
  listFor,
  overweighted,
  score,
  verdict,
  vocabulary,
  wrapped,
} from "./dictation-biasing.ts";
import {
  atPeak,
  DICTATION_LENGTHS,
  DICTATION_PEAK,
  DICTATIONS_PER_LENGTH,
  type Dictate,
  type EngineLatency,
  engineLatency,
  hold,
  type LatencyEngine,
  type LatencyTable,
  measure,
  utterances,
  withPlatform,
} from "./dictation-latency.ts";
import {
  compare,
  der,
  type Measure,
  parseRttm,
  percentile,
  summary,
  type Turn,
  type Verdict,
  wer,
} from "./score.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** FLEURS at a pinned revision of google/fleurs (CC-BY-4.0). */
export const FLEURS = {
  revision: "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
  licence: "FLEURS (google/fleurs): CC-BY-4.0",
  sets: {
    en: {
      config: "en_us",
      tsvSha256: "74c046239374deeb60fa63f258f907388093a32bcaa3140965f70ef05c79f7ca",
      tarSha256: "d9c2e37b41aacd41bc283554a0a82b5476b36887049774ecb2819dcaaa55a356",
      ids: "fleurs_en",
    },
    es: {
      config: "es_419",
      tsvSha256: "d107a93a4f54a18ac25cd470bb4cdadce14fb075b0c1d1542258e274d209ec09",
      tarSha256: "981802f6c828fd214fcf8bfc1036d80c9184b6eeb5650b3f7882f8affec046c9",
      ids: "fleurs_es",
    },
  },
} as const;

/**
 * Two AMI Meeting Corpus test meetings, the headset mix at 16 kHz, four speakers each, about 31
 * minutes in all. The references are the `only_words` set of the AMI diarization setup (BUT's,
 * through pyannote's fork at a pinned commit), whose scoring region is the whole recording.
 */
export const AMI = {
  audio: "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus",
  rttm: "https://raw.githubusercontent.com/pyannote/AMI-diarization-setup/67c2d539286e89f68952d5dcf83912bd9f01dfae/only_words/rttms/test",
  licence:
    "AMI Meeting Corpus (audio and annotations): CC-BY-4.0; references from pyannote/AMI-diarization-setup@67c2d53 (Apache-2.0), derived from the AMI manual annotations 1.6.2",
  meetings: [
    {
      id: "ES2004a",
      wavSha256: "3e2560b19bee6952c7c7ce041b0f1ea8a7ea9468044c4eea79d2a2c67e24ab0f",
      rttmSha256: "9869c6146c2fd9595403edb36c2caeda65c12ffa2c0af4ce48d6814b673fd5a9",
    },
    {
      id: "IS1009a",
      wavSha256: "6eb5a0ede0d9e72794f976ce7bea5b78133eae969f99b4c5418b43c2468d25b1",
      rttmSha256: "ba38d35ca567f3f1e061d90fdc33579ce60d2060fc8664eaeb77d2e0fcd88b01",
    },
  ],
} as const;

/** The replay floor (DESIGN 5.4): below it, embeddings are needed. */
export const REPLAY_FLOOR = 0.85;
/** The real-time factor budget of the default engines on the 4-core x64 Linux runner. */
export const RTF_BUDGET_LINUX_X64 = 0.5;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function get(url: string, headers: Record<string, string> = {}): Promise<Uint8Array> {
  const r = await fetch(url, { headers, redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * A file fetched once into `path` and checked by SHA-256 every time it is used. A fresh download
 * reaches `path` only after its hash matches, so a truncated fetch never sits in the cache.
 */
export async function pinned(url: string, path: string, sha: string): Promise<Uint8Array> {
  const fresh = !existsSync(path);
  const b = fresh ? await get(url) : new Uint8Array(readFileSync(path));
  const got = sha256(b);
  if (got !== sha) throw new Error(`${url}: SHA-256 ${got}, pinned ${sha}`);
  if (fresh) {
    writeFileSync(`${path}.part`, b);
    renameSync(`${path}.part`, path);
  }
  return b;
}

/**
 * Mono samples at `ASR_RATE` from a PCM WAV (16-bit or 32-bit float, any rate and channels). Any
 * other sample format (24-bit, the extensible tag) is refused rather than read as 16-bit. The
 * resampling is linear with no low-pass filter, which is exact for the 16 kHz sets it reads today.
 */
export function readWav(b: Uint8Array): Float32Array {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let rate = 0;
  let channels = 1;
  let bits = 16;
  let format = 1;
  let o = 12;
  while (o + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(o, o + 4));
    const size = v.getUint32(o + 4, true);
    if (id === "fmt ") {
      format = v.getUint16(o + 8, true);
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
    } else if (id === "data") {
      if (!((format === 1 && bits === 16) || (format === 3 && bits === 32)))
        throw new Error(
          `WAV format ${format} with ${bits} bits: only 16-bit PCM (1) and 32-bit float (3) are read`,
        );
      const width = bits / 8;
      const n = Math.floor(Math.min(size, b.length - o - 8) / (width * channels));
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) {
          const at = o + 8 + (i * channels + c) * width;
          s += format === 3 ? v.getFloat32(at, true) : v.getInt16(at, true) / 32768;
        }
        mono[i] = s / channels;
      }
      if (rate === ASR_RATE) return mono;
      const out = new Float32Array(Math.floor((n * ASR_RATE) / rate));
      for (let i = 0; i < out.length; i++) {
        const x = (i * rate) / ASR_RATE;
        const j = Math.floor(x);
        const a = mono[j] ?? 0;
        out[i] = a + ((mono[j + 1] ?? a) - a) * (x - j);
      }
      return out;
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("not a PCM WAV with a data chunk");
}

// --- FLEURS ------------------------------------------------------------------------------------

export interface Utterance {
  id: string;
  ref: string;
  wav: string;
}

/** The pinned FLEURS utterances of one language, extracted into `dir` once and cached there. */
export async function fleurs(
  lang: keyof typeof FLEURS.sets,
  dataDir: string,
): Promise<Utterance[]> {
  const set = FLEURS.sets[lang];
  const dir = join(dataDir, "fleurs", set.config);
  mkdirSync(dir, { recursive: true });
  const base = `https://huggingface.co/datasets/google/fleurs/resolve/${FLEURS.revision}/data/${set.config}`;
  const tsv = new TextDecoder().decode(
    await pinned(`${base}/test.tsv`, join(dir, "test.tsv"), set.tsvSha256),
  );
  const refs = new Map<string, string>();
  for (const line of tsv.split("\n")) {
    const c = line.split("\t");
    if (c[1]) refs.set(c[1].replace(/\.wav$/, ""), c[2] ?? "");
  }
  const ids = (
    JSON.parse(readFileSync(join(ROOT, "docs", "research", "asr-benchmark.json"), "utf8")) as {
      fleurs_ids: Record<string, string[]>;
    }
  ).fleurs_ids[set.ids] as string[];
  const missing = ids.filter((id) => !existsSync(join(dir, "test", `${id}.wav`)));
  if (missing.length > 0) {
    const tar = join(dir, "test.tar.gz");
    await pinned(`${base}/audio/test.tar.gz`, tar, set.tarSha256);
    // Relative paths from `dir`: Git for Windows' GNU tar reads `C:` in a path as a remote host.
    const r = Bun.spawnSync(
      ["tar", "-xzf", "test.tar.gz", ...missing.map((id) => `test/${id}.wav`)],
      {
        cwd: dir,
        stderr: "pipe",
      },
    );
    if (r.exitCode !== 0) throw new Error(`tar: ${r.stderr.toString()}`);
    rmSync(tar);
  }
  return ids.map((id) => {
    const ref = refs.get(id);
    if (ref === undefined) throw new Error(`FLEURS ${set.config}: ${id} is not in test.tsv`);
    return { id, ref, wav: join(dir, "test", `${id}.wav`) };
  });
}

// --- AMI ---------------------------------------------------------------------------------------

interface Conversation {
  id: string;
  wav: string;
  ref: Turn[];
}

/** The pinned AMI meetings, fetched into `dir` once and checked by SHA-256 on every run. */
async function ami(dataDir: string): Promise<Conversation[]> {
  const dir = join(dataDir, "ami");
  mkdirSync(dir, { recursive: true });
  const out: Conversation[] = [];
  for (const m of AMI.meetings) {
    const wav = join(dir, `${m.id}.wav`);
    await pinned(`${AMI.audio}/${m.id}/audio/${m.id}.Mix-Headset.wav`, wav, m.wavSha256);
    const rttm = await pinned(`${AMI.rttm}/${m.id}.rttm`, join(dir, `${m.id}.rttm`), m.rttmSha256);
    out.push({ id: m.id, wav, ref: parseRttm(new TextDecoder().decode(rttm)) });
  }
  return out;
}

// --- Qwen3-ASR through llama-server -----------------------------------------------------------

/**
 * ASR-5's acceptance (docs/research/asr-architecture.md section 9). The WER bounds are the
 * benchmark's 150-clip numbers plus 0.5 (3.79 / 2.89, macOS Metal). Memory is llama-server's
 * (`memoryMb`), from after the first `warm` requests to after the last: the prompt cache it keeps
 * by default grows with every distinct request, which is how it ran a machine out of memory. On a
 * Mac mini (M4, Metal) the server grew 4 MB over 150 requests with `--cache-ram 0` and 2,648 MB
 * with the default, about 18 MB a request.
 */
export const QWEN_GATE = {
  clips: 30,
  wer: { en: 4.29, es: 3.39 },
  requests: 150,
  warm: 10,
  /** Growth in MB the real server stays under, and the control must pass. */
  flatMb: 200,
  /** Requests the control makes: about 700 MB of cache at 18 MB each, over three times the bound. */
  controlRequests: 50,
  /**
   * The long unit: English clips joined into five minutes, past the 4096-token context. Cut into
   * requests by the engine it read 4.41 % WER on an M4; sent uncut, 86.18 % (100 of 679 words).
   */
  longSeconds: 300,
  /** The WER the long unit stays under, and the uncut control must pass. */
  longWer: 15,
  /**
   * One FLEURS clip's request limit. The app's 120 s is a wait a person sits through; here it only
   * cut off a slow runner. On GitHub's macOS runner (3 cores, 7 GB, a paravirtual GPU) a clip of
   * 13 to 27 s took up to 94 s in a passing night. The nights that ended with no summary died in
   * the long unit instead: a request past about 360 s, Bun's own limit on a silent response, which
   * the engine now turns off (issue #349).
   */
  requestMs: 600_000,
} as const;

/**
 * The benchmark's silence set (asr-architecture.md section 1.1): the 25 stretches of two AMI test
 * meetings (the headset mix, CC-BY-4.0) with no reference segment within 0.5 s, cut to 3 to 8 s,
 * as [start, end] in seconds. Qwen answered "None" on all 25 in the benchmark. These are the
 * benchmark's meetings, not the diarization's two.
 */
export const SILENCE: {
  meetings: readonly {
    id: string;
    wavSha256: string;
    stretches: readonly (readonly [number, number])[];
  }[];
} = {
  meetings: [
    {
      id: "ES2004b",
      wavSha256: "ad0cf07c42b1694ccf7bea8f1a37348d9cfab194787abc7d050b29ba56e365c8",
      stretches: [
        [11.3, 19.3],
        [40.22, 47.18],
        [49.68, 54.95],
        [56.36, 64.36],
        [183.91, 191.05],
        [205.11, 208.84],
        [539.49, 543.99],
        [545.99, 553.99],
        [573.48, 581.48],
        [597.63, 602.05],
        [784.85, 788.05],
        [793.89, 801.89],
        [821.17, 826.1],
        [1045.35, 1050.6],
        [2242.42, 2248.32],
      ],
    },
    {
      id: "IS1009b",
      wavSha256: "07c2891ae6ad7c507b2a4f15b2dcd0a2343491df9e4e6a58f9db0d0b2c5e1382",
      stretches: [
        [67.83, 74.89],
        [87.14, 95.09],
        [575.48, 580.32],
        [584.29, 590.42],
        [1142.66, 1146.65],
        [1166.96, 1172.34],
        [1181.6, 1189.6],
        [1203.91, 1209.86],
        [1445.63, 1452.75],
        [1506.52, 1514.52],
      ],
    },
  ],
};

/** The silence set's clips, the meetings fetched into `dir` once and checked by SHA-256. */
async function silence(dataDir: string): Promise<Float32Array[]> {
  const dir = join(dataDir, "ami");
  mkdirSync(dir, { recursive: true });
  const out: Float32Array[] = [];
  for (const m of SILENCE.meetings) {
    const wav = join(dir, `${m.id}.wav`);
    const x = readWav(
      await pinned(`${AMI.audio}/${m.id}/audio/${m.id}.Mix-Headset.wav`, wav, m.wavSha256),
    );
    for (const [start, end] of m.stretches)
      out.push(x.slice(Math.floor(start * ASR_RATE), Math.floor(end * ASR_RATE)));
  }
  return out;
}

/**
 * A process's memory in MB, counting what the system compressed or swapped out: macOS's
 * `footprint` (which also counts the Metal buffers the process owns), Linux's resident plus
 * swapped size, Windows' private bytes (its commit, resident or paged out). `ps`'s resident size
 * alone misses compressed memory, so a growing cache can read flat.
 */
export function memoryMb(pid: number, platform = process.platform): number {
  if (platform === "win32") {
    const r = Bun.spawnSync(
      ["powershell", "-NoProfile", "-Command", `(Get-Process -Id ${pid}).PrivateMemorySize64`],
      { stderr: "pipe" },
    );
    const bytes = Number(r.stdout.toString().trim());
    if (!(bytes > 0))
      throw new Error(`powershell: no private bytes for pid ${pid}: ${r.stderr.toString()}`);
    return bytes / 2 ** 20;
  }
  if (platform === "darwin") {
    const r = Bun.spawnSync(["footprint", "-f", "bytes", "-p", String(pid)], { stderr: "pipe" });
    const m = /Footprint:\s*(\d+)\s*B/.exec(r.stdout.toString());
    if (!m) throw new Error(`footprint: no footprint for pid ${pid}: ${r.stderr.toString()}`);
    return Number(m[1]) / 2 ** 20;
  }
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = (field: string) =>
    Number(new RegExp(`^${field}:\\s*(\\d+) kB`, "m").exec(status)?.[1] ?? 0);
  const total = kb("VmRSS") + kb("VmSwap");
  if (!(total > 0)) throw new Error(`/proc/${pid}/status: no resident size`);
  return total / 1024;
}

/**
 * Qwen on this machine's pinned llama-server build, the one `asr.accelerator` `auto` runs (Metal on
 * a Mac, the CPU elsewhere), with the files fetched into `dir` and checked against their pins.
 */
async function qwenServers(
  dir: string,
  platform: string,
  setting = "auto",
): Promise<{ make(promptCache: boolean): LlamaServer; accelerator: string }> {
  const { accelerator, note } = resolveAccelerator(setting, platform);
  if (note) throw new Error(note);
  const buildId = llamaBuildId(platform, accelerator);
  const build = MODELS.find((m) => m.id === buildId);
  if (!build) throw new Error(`no llama-server build for ${platform}`);
  await downloadModels(dir, [QWEN_ASR, buildId], { env: {} });
  const archives = build.files.map((f) => modelFile(dir, buildId, f.name));
  return {
    accelerator,
    make: (promptCache) =>
      new LlamaServer({
        command: () => [extractBuild(join(dir, buildId), archives, platform)],
        model: modelFile(dir, QWEN_ASR, QWEN_MODEL_FILE),
        mmproj: modelFile(dir, QWEN_ASR, QWEN_MMPROJ_FILE),
        accelerator,
        lockDir: join(dir, buildId),
        promptCache,
        log: (level, msg) => {
          if (level !== "info") console.error(msg);
        },
      }),
  };
}

/** A restart or a request given up, with the time, so a red night says which request and why. */
const qwenLog = (level: string, msg: string) => {
  if (level !== "info") console.error(`${new Date().toISOString()} ${msg}`);
};

/** Decodes each clip on `server`, one request each, and reads its memory after every request. */
async function qwenRun(
  server: LlamaServer,
  clips: readonly { samples: Float32Array; lang: string }[],
): Promise<{ texts: string[]; ms: number[]; mem: number[] }> {
  const engine = new QwenEngine({
    id: QWEN_ASR,
    server,
    allowed: ["en", "es"],
    timeoutMs: QWEN_GATE.requestMs,
    log: qwenLog,
  });
  const out = { texts: [] as string[], ms: [] as number[], mem: [] as number[] };
  try {
    for (const c of clips) {
      const h = await engine.decode({ samples: c.samples, lang: c.lang, glossary: [] });
      out.texts.push(h.text);
      out.ms.push(h.ms);
      out.mem.push(memoryMb(server.pid() as number));
    }
  } finally {
    await server.stop();
  }
  return out;
}

/** Growth from after the warm-up requests to after the last. */
const growth = (mem: readonly number[]) =>
  (mem[mem.length - 1] as number) - (mem[QWEN_GATE.warm - 1] as number);

async function qwenStage(
  modelsDir: string,
  dataDir: string,
  platform: string,
  measures: Measure[],
  notes: string[],
  setting = "auto",
): Promise<void> {
  const { make, accelerator } = await qwenServers(modelsDir, platform, setting);
  const load = (u: Utterance, lang: string) => ({
    samples: readWav(new Uint8Array(readFileSync(u.wav))),
    lang,
  });
  const en = (await fleurs("en", dataDir)).slice(0, QWEN_GATE.requests);
  const es = (await fleurs("es", dataDir)).slice(0, QWEN_GATE.clips);
  const quiet = (await silence(dataDir)).map((samples) => ({ samples, lang: "auto" }));

  // One server for every request, as a call's final pass runs it; English first, all 150 clips.
  const server = make(false);
  const english = en.map((u) => load(u, "en"));
  const spanish = es.map((u) => load(u, "es"));
  const run = await qwenRun(server, [...english, ...spanish, ...quiet]);
  const restarts = server.starts - 1;
  const n = english.length;
  const k = QWEN_GATE.clips;
  const scored = {
    en: { pairs: en.slice(0, k).map((u, i) => ({ ref: u.ref, hyp: run.texts[i] as string })) },
    es: { pairs: es.map((u, i) => ({ ref: u.ref, hyp: run.texts[n + i] as string })) },
  };
  for (const lang of ["en", "es"] as const) {
    measures.push({
      key: `wer.fleurs_${lang}_${k}.${QWEN_ASR}`,
      value: wer(scored[lang].pairs),
      unit: "%",
      better: "lower",
      gate: "record",
      bound: QWEN_GATE.wer[lang],
    });
  }
  const silentWords = run.texts
    .slice(n + spanish.length)
    .reduce((a, t) => a + t.split(/\s+/).filter(Boolean).length, 0);
  measures.push(
    {
      key: `words.ami_silence_${quiet.length}.${QWEN_ASR}`,
      value: silentWords,
      unit: "words",
      better: "lower",
      gate: "record",
      bound: 0,
    },
    {
      key: `latency.fleurs_en.${QWEN_ASR}.p50`,
      value: percentile(run.ms.slice(0, n), 50),
      unit: "ms",
      better: "lower",
      gate: "record",
    },
    // A restart empties the prompt cache, which would hide its growth.
    {
      key: `restarts.${QWEN_ASR}`,
      value: restarts,
      unit: "",
      better: "lower",
      gate: "record",
      bound: 0,
    },
    {
      key: `memory_growth.${n}_requests.${QWEN_ASR}`,
      value: growth(run.mem.slice(0, n)),
      unit: "MB",
      better: "lower",
      gate: "record",
      bound: QWEN_GATE.flatMb,
    },
  );

  // The failing control: the same English clips on a server that keeps its default prompt cache.
  const control = await qwenRun(make(true), english.slice(0, QWEN_GATE.controlRequests));
  measures.push({
    key: `memory_growth.${QWEN_GATE.controlRequests}_requests.${QWEN_ASR}.default_cache_control`,
    value: growth(control.mem),
    unit: "MB",
    better: "higher",
    gate: "record",
    bound: QWEN_GATE.flatMb,
  });

  // The long unit: the engine cuts it into requests of at most QWEN_MAX_REQUEST_SECONDS; the same
  // audio in one request is the failing control, whose answer stops when the context is full.
  const long = joinClips(
    en.map((u, i) => ({ samples: (english[i] as { samples: Float32Array }).samples, ref: u.ref })),
    QWEN_GATE.longSeconds,
  );
  const longSeconds = Math.round(long.samples.length / ASR_RATE);
  for (const uncut of [false, true]) {
    const server = make(false);
    const engine = new QwenEngine({
      id: QWEN_ASR,
      server,
      allowed: ["en", "es"],
      timeoutMs: 1_800_000,
      ...(uncut ? { maxSeconds: Number.POSITIVE_INFINITY } : {}),
      log: qwenLog,
    });
    try {
      const h = await engine.decode({ samples: long.samples, lang: "en", glossary: [] });
      measures.push({
        key: `wer.fleurs_en_long${QWEN_GATE.longSeconds}.${QWEN_ASR}${uncut ? ".uncut_control" : ""}`,
        value: wer([{ ref: long.ref, hyp: h.text }]),
        unit: "%",
        better: uncut ? "higher" : "lower",
        gate: "record",
        bound: QWEN_GATE.longWer,
      });
    } finally {
      await server.stop();
    }
  }
  notes.push(
    `Qwen3-ASR-1.7B Q8_0 on llama-server (${accelerator}): WER on the first ${k} FLEURS clips per language, language set to the clip's; the benchmark's ${quiet.length} silent AMI stretches on auto among en and es; memory over ${n} requests, then ${QWEN_GATE.controlRequests} with the default --cache-ram as the control, which must grow past ${QWEN_GATE.flatMb} MB; a ${longSeconds} s unit of joined English clips in requests of at most ${QWEN_MAX_REQUEST_SECONDS} s, then uncut as the control, which must lose words past ${QWEN_GATE.longWer} % WER`,
  );
}

/** Clips joined in order, 0.3 s of silence after each, until `seconds` of audio; their refs joined. */
export function joinClips(
  clips: readonly { samples: Float32Array; ref: string }[],
  seconds: number,
): { samples: Float32Array; ref: string } {
  const gap = Math.round(0.3 * ASR_RATE);
  const taken: { samples: Float32Array; ref: string }[] = [];
  let n = 0;
  for (const c of clips) {
    if (n >= seconds * ASR_RATE) break;
    taken.push(c);
    n += c.samples.length + gap;
  }
  const samples = new Float32Array(n);
  let at = 0;
  for (const c of taken) {
    samples.set(c.samples, at);
    at += c.samples.length + gap;
  }
  return { samples, ref: taken.map((c) => c.ref).join(" ") };
}

// --- dictation latency (DC-T3) ----------------------------------------------------------------

/** The streaming model a dictation's words come from by default: `auto` over any language. */
async function liveDictate(
  modelsDir: string,
  dataDir: string,
): Promise<{ model: string; dictate: Dictate; close(): Promise<void> }> {
  const choice = chooseLiveEngine("auto", [], () => true).choice;
  if (!choice) throw new Error("no streaming model for dictation");
  await downloadModels(modelsDir, ["silero-vad", choice.engine], { env: {} });
  const asr = new LiveAsr(
    { models: { kind: "sherpa", dir: modelsDir, cacheDir: join(dataDir, "sherpa-cache") } },
    () => undefined,
  );
  await asr.warmDictation(choice);
  return {
    model: choice.engine,
    dictate: async (samples) => {
      const words = new LiveWords(
        (onWords) => asr.openDictation(choice, [], onWords),
        () => {},
      );
      await hold(samples, (p) => words.push(p));
      const t = performance.now();
      const d = await words.finish();
      if (d.text.trim() === "") throw new Error("the streaming model heard nothing");
      return performance.now() - t;
    },
    close: () => asr.close(),
  };
}

/** Qwen on its warm llama-server, as `best` runs it for dictation. */
async function qwenDictate(
  modelsDir: string,
  platform: string,
): Promise<{ model: string; dictate: Dictate; close(): Promise<void> }> {
  const { accelerator } = resolveAccelerator("auto", platform);
  const buildId = llamaBuildId(platform, accelerator);
  const build = MODELS.find((m) => m.id === buildId);
  if (!build) throw new Error(`no llama-server build for ${platform}`);
  await downloadModels(modelsDir, [QWEN_ASR, buildId], { env: {} });
  const spec = {
    kind: "llama-server" as const,
    engine: QWEN_ASR,
    model: modelFile(modelsDir, QWEN_ASR, QWEN_MODEL_FILE),
    mmproj: modelFile(modelsDir, QWEN_ASR, QWEN_MMPROJ_FILE),
    accelerator,
    build: {
      dir: join(modelsDir, buildId),
      archives: build.files.map((f) => modelFile(modelsDir, buildId, f.name)),
      platform,
    },
  };
  const best = new BestEngine({
    spec: () => spec,
    fast: () => null,
    settings: () => ({ timeoutSeconds: 120, idleMinutes: 0, languages: [] }),
    keepWarm: () => true,
    clock: { setTimeout, clearTimeout },
    server: (s) => createLlamaServer(s),
    onLog: (level, msg) => {
      if (level !== "info") console.error(msg);
    },
  });
  return {
    model: `${QWEN_ASR} (${accelerator})`,
    dictate: async (samples) => {
      const t = performance.now();
      // `dictation.language` is `auto` by default: no language is forced.
      const d = await best.decode(samples, {});
      if (d.engine !== "best") throw new Error(`best answered as ${d.engine}`);
      return performance.now() - t;
    },
    close: () => best.stop(),
  };
}

/** A free TCP port on the loopback. */
function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/**
 * Another akou on this machine's loopback (`akou serve`, its own default engine), reached as the
 * desktop app reaches a remote: the audio streamed during the hold, the tail and the answer timed.
 */
async function remoteDictate(
  modelsDir: string,
  dataDir: string,
): Promise<{ model: string; dictate: Dictate; close(): Promise<void> }> {
  // A job on `akou serve` waits for every model of the machine's set, the speaker labels' too, and
  // the server downloads nothing under CI: they are fetched here. The labels are not timed (the
  // dictation asks for no speakers), so the small `embeddings` set stands in for Nemotron's 400 MB.
  const diarizer = "embeddings";
  const set = modelsFor({ "asr.diarizer": diarizer }, hostPlatform()).map((m) => m.id);
  await downloadModels(modelsDir, set, { env: {} });
  const home = join(dataDir, "dictation-remote-home");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, ".config", "akou"), { recursive: true });
  const port = freePort();
  writeFileSync(
    join(home, ".config", "akou", "config.json"),
    JSON.stringify({ "api.bind": "127.0.0.1", "api.port": port, "asr.diarizer": diarizer }),
  );
  const env = { ...process.env, AKOU_HOME: home, AKOU_MODELS_DIR: modelsDir };
  const cli = [process.execPath, join(ROOT, "src", "main", "cli", "cli.ts")];
  const serve = Bun.spawn([...cli, "serve"], {
    env,
    stdin: "ignore",
    stdout: Bun.file(join(home, "serve.log")),
    stderr: Bun.file(join(home, "serve.err")),
  });
  const close = async () => {
    serve.kill();
    await serve.exited;
  };
  try {
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (
        await fetch(`${url}/healthz`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      if (Date.now() > deadline) throw new Error("akou serve: no /healthz within 120 s");
      await Bun.sleep(500);
    }
    const made = Bun.spawnSync(
      [...cli, "keys", "create", "--name", "eval", "--scope", "jobs", "--json"],
      { env },
    );
    if (made.exitCode !== 0) throw new Error(`akou keys create: ${made.stderr.toString()}`);
    const key = (JSON.parse(made.stdout.toString()) as { key: string }).key;
    const test = await testRemote({ url, key });
    if (!test.ok) throw new Error(`the remote's Test failed: ${test.error}`);
    return {
      model: `akou serve on loopback (${test.engine} on ${test.accelerator})`,
      dictate: async (samples) => {
        const up = new RemoteUpload({ url, key, timeoutSeconds: 120 });
        await hold(samples, (p) => up.push(p));
        const t = performance.now();
        const r = await up.finish(samples);
        if (r.text.trim() === "") throw new Error("the remote heard nothing");
        return performance.now() - t;
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

async function dictationStage(
  o: { modelsDir: string; qwenModelsDir: string; dataDir: string; platform: string },
  measures: Measure[],
  notes: string[],
): Promise<{ out: Partial<Record<LatencyEngine, EngineLatency>>; failed: StageFailure[] }> {
  // Most FLEURS clips are recorded quietly (a peak of a few thousandths), where the streaming model
  // hears nothing and answers at once, which says nothing about the time. Each clip is brought to
  // the same peak, as a microphone's gain would.
  const clips = (await fleurs("en", o.dataDir))
    .map((u) => readWav(new Uint8Array(readFileSync(u.wav))))
    .map((x) => atPeak(x, DICTATION_PEAK))
    .filter((x): x is Float32Array => x !== null);
  // Each length takes its utterances from the clips in order, so the three sets differ.
  const byLength = new Map<number, Float32Array[]>();
  let from = 0;
  for (const s of DICTATION_LENGTHS) {
    const need = Math.ceil((s * DICTATIONS_PER_LENGTH) / 5) + 2;
    byLength.set(s, utterances(clips.slice(from, from + need), s, DICTATIONS_PER_LENGTH));
    from += need;
  }
  type Make = () => ReturnType<typeof liveDictate>;
  // The streaming model goes with Qwen, outside the nightly's cached recognizer folder.
  const engines: [LatencyEngine, Make][] = [
    ["live", () => liveDictate(o.qwenModelsDir, o.dataDir)],
  ];
  if (!o.platform.startsWith("win32"))
    engines.push(["qwen", () => qwenDictate(o.qwenModelsDir, o.platform)]);
  engines.push(["remote", () => remoteDictate(o.modelsDir, o.dataDir)]);
  const r = await timeEngines(engines, async (name, e) => {
    const times = await measure(e.dictate, byLength, (line) => console.error(`${name} ${line}`));
    return engineLatency(e.model, times);
  });
  for (const [name, row] of Object.entries(r.out) as [LatencyEngine, EngineLatency][]) {
    for (const [s, t] of Object.entries(row.seconds)) {
      for (const p of ["p50", "p95"] as const) {
        measures.push({
          key: `dictation.release_to_text.${s}s.${name}.${p}`,
          value: t[p],
          unit: "ms",
          better: "lower",
          gate: "record",
        });
      }
    }
    notes.push(`Dictation ${name}: ${row.model}`);
  }
  for (const f of r.failed) notes.push(`Dictation ${f.engine}: failed, ${f.why}`);
  notes.push(
    `Dictation release-to-text: ${DICTATIONS_PER_LENGTH} dictations each of ${DICTATION_LENGTHS.join(", ")} s of FLEURS en_us speech, held at real-time pace, after one warm-up`,
  );
  return r;
}

/** What a stage could not do: one row each, so the night is red and says why. */
export interface StageFailure {
  engine: string;
  why: string;
}

/**
 * Times each dictation engine in turn. One that fails to start or to finish is left out with why,
 * and the ones after it still run, so the night keeps the other engines' numbers and the latency
 * table still gets them; the failure is returned, for the run to fail on.
 */
export async function timeEngines<E extends { model: string; close(): Promise<void> }>(
  engines: readonly (readonly [LatencyEngine, () => Promise<E>])[],
  time: (name: LatencyEngine, e: E) => Promise<EngineLatency>,
): Promise<{ out: Partial<Record<LatencyEngine, EngineLatency>>; failed: StageFailure[] }> {
  const out: Partial<Record<LatencyEngine, EngineLatency>> = {};
  const failed: StageFailure[] = [];
  for (const [name, make] of engines) {
    let e: E | null = null;
    try {
      e = await make();
      out[name] = await time(name, e);
    } catch (err) {
      failed.push({ engine: name, why: (err as Error).message });
    } finally {
      await e?.close().catch(() => {});
    }
  }
  return { out, failed };
}

/** The night's verdicts: each measure against its baseline, then every failed stage's row. */
export function nightVerdicts(
  measures: readonly Measure[],
  baselines: Readonly<Record<string, number>>,
  failures: readonly Verdict[],
): Verdict[] {
  return [...compare(measures, baselines), ...failures];
}

/** `main`'s exit code: 1 when any verdict is not ok, a failed stage included. */
export function exitCode(verdicts: readonly Verdict[]): number {
  return verdicts.every((v) => v.ok) ? 0 : 1;
}

/** A failed stage as a verdict row: never ok, so `main` exits 1 and the summary lists it first. */
export function failureVerdicts(stage: string, failed: readonly StageFailure[]): Verdict[] {
  return failed.map((f) => ({
    key: `${stage}.${f.engine}`,
    value: 0,
    unit: "",
    baseline: null,
    ok: false,
    why: `failed: ${f.why}`,
  }));
}

// --- dictation biasing (DC-L7) ------------------------------------------------------------------

/** What the biasing stage measured: each setting's score and WER, and the ship rule's verdict. */
export interface BiasingResult {
  clips: { speech: number; quiet: number; terms: number; soundAlikes: number };
  settings: Record<string, BiasScore & { wer: number; echoRate: number }>;
  verdict: ReturnType<typeof verdict>;
}

async function biasingStage(
  qwenDir: string,
  dataDir: string,
  platform: string,
  measures: Measure[],
  notes: string[],
): Promise<BiasingResult> {
  const { make, accelerator } = await qwenServers(qwenDir, platform);
  const clips: { c: BiasClip; samples: Float32Array; lang: string; pool: string[] }[] = [];
  const pools: Record<string, string[]> = {};
  for (const lang of ["en", "es"] as const) {
    const utts = await fleurs(lang, dataDir);
    // Common words are counted over the whole test set, read from the transcript list fleurs() keeps.
    const tsv = readFileSync(join(dataDir, "fleurs", FLEURS.sets[lang].config, "test.tsv"), "utf8");
    const vocab = vocabulary(tsv.split("\n").map((line) => line.split("\t")[2] ?? ""));
    const mine = utts.slice(0, BIAS_CLIPS).map((u) => ({
      c: biasClip(u.id, lang, u.ref, vocab),
      samples: readWav(new Uint8Array(readFileSync(u.wav))),
      lang,
    }));
    // Distractors: every term of the language's other clips, the names a user may have taught.
    pools[lang] = utts.flatMap((u) => biasClip(u.id, lang, u.ref, vocab).terms);
    for (const m of mine) clips.push({ ...m, pool: pools[lang] as string[] });
  }
  // The generated silence and noise of DC-E6's tests, which get distractors only.
  for (let i = 0; i < 5; i++) {
    for (const [kind, samples] of [
      ["silence", genSilence(3)],
      ["noise", roomNoise(3, 11 + i)],
    ] as const) {
      const c: BiasClip = { id: `${kind}-${i}`, lang: "en", ref: "", terms: [], soundAlikes: [] };
      clips.push({ c, samples, lang: "auto", pool: [...(pools.en ?? []), ...(pools.es ?? [])] });
    }
  }
  const lists = (size: number) => clips.map((x, i) => listFor(x.c, size, x.pool, i + 1));
  const atCap = lists(BIASING_SIZES[BIASING_SIZES.length - 1] as number);
  const settings: [string, (i: number) => string[], string[][]][] = [
    ["none", () => [], atCap],
    ...BIASING_SIZES.map((size) => {
      const l = lists(size);
      return [String(size), (i: number) => wrapped(l[i] as string[]), l] as [
        string,
        (i: number) => string[],
        string[][],
      ];
    }),
    ["control", (i: number) => overweighted(atCap[i] as string[], clips[i]?.c), atCap],
  ];
  const server = make(false);
  const engine = new QwenEngine({ id: QWEN_ASR, server, allowed: ["en", "es"] });
  const out: BiasingResult["settings"] = {};
  try {
    for (const [name, context, listed] of settings) {
      const answers: string[] = [];
      const echoed: boolean[] = [];
      for (const [i, x] of clips.entries()) {
        const decode = (glossary: string[]) =>
          engine.decode({ samples: x.samples, lang: x.lang, glossary });
        let h = await decode(context(i));
        // The answer the app inserts: one that echoes its context is decoded again with none (DC-E6).
        const echo = isEcho(h.text, listed[i]);
        if (echo) h = await decode([]);
        answers.push(h.text);
        echoed.push(echo);
      }
      const s = score(
        clips.map((x) => x.c),
        answers,
        listed,
        echoed,
      );
      const speech = clips.flatMap((x, i) =>
        x.c.ref === "" ? [] : [{ ref: x.c.ref, hyp: answers[i] as string }],
      );
      out[name] = { ...s, wer: wer(speech), echoRate: s.echoes / s.answers };
      console.error(`biasing ${name}: ${JSON.stringify(out[name])}`);
    }
  } finally {
    await server.stop();
  }
  const cap = String(BIASING_SIZES[BIASING_SIZES.length - 1]);
  const v = verdict(out.none as BiasScore, out[cap] as BiasScore, out.control as BiasScore);
  for (const [name, s] of Object.entries(out)) {
    for (const [what, value, unit, better] of [
      ["hits", s.hits, "terms", "higher"],
      ["insertions", s.insertions, "terms", "lower"],
      ["wer", s.wer, "%", "lower"],
      ["echo_rate", s.echoRate, "share", "lower"],
    ] as const) {
      measures.push({
        key: `dictation.biasing.${name}.${what}`,
        value,
        unit,
        better,
        gate: "record",
      });
    }
  }
  const speech = clips.filter((x) => x.c.ref !== "");
  notes.push(
    `Dictation biasing (DC-L7) on Qwen3-ASR (${accelerator}): ${speech.length} FLEURS clips and ${clips.length - speech.length} of silence and noise, lists of ${BIASING_SIZES.join(" and ")}; ${v.pass ? "passes" : `fails: ${v.reasons.join("; ")}`}`,
  );
  return {
    clips: {
      speech: speech.length,
      quiet: clips.length - speech.length,
      terms: speech.reduce((a, x) => a + x.c.terms.length, 0),
      soundAlikes: speech.reduce((a, x) => a + x.c.soundAlikes.length, 0),
    },
    settings: out,
    verdict: v,
  };
}

// --- the run -----------------------------------------------------------------------------------

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** The default recognizer on FLEURS en and es: WER, latency percentiles and the real-time factor. */
async function fleursStage(
  models: SherpaModels,
  dataDir: string,
  platform: string,
  measures: Measure[],
  notes: string[],
): Promise<void> {
  const prepared = models.prepare({ model: RECOGNIZER, entries: [], dropped: [], warnings: [] });
  for (const lang of ["en", "es"] as const) {
    const utts = await fleurs(lang, dataDir);
    const pairs: { ref: string; hyp: string }[] = [];
    const ms: number[] = [];
    let audio = 0;
    let busy = 0;
    for (const u of utts) {
      const x = readWav(new Uint8Array(readFileSync(u.wav)));
      const t0 = performance.now();
      const { text } = prepared.recognizer.decode(x, prepared.arg);
      const t = performance.now() - t0;
      ms.push(t);
      busy += t / 1000;
      audio += x.length / ASR_RATE;
      pairs.push({ ref: u.ref, hyp: text });
    }
    const engine = RECOGNIZER;
    measures.push(
      {
        key: `wer.fleurs_${lang}.${engine}`,
        value: wer(pairs),
        unit: "%",
        better: "lower",
        gate: "baseline",
      },
      ...([50, 90, 99] as const).map(
        (p): Measure => ({
          key: `latency.fleurs_${lang}.${engine}.p${p}`,
          value: percentile(ms, p),
          unit: "ms",
          better: "lower",
          gate: "record",
        }),
      ),
      {
        key: `rtf.fleurs_${lang}.${engine}`,
        value: busy / audio,
        unit: "",
        better: "lower",
        gate: "record",
        // The budget gates the default engine on the 4-core x64 Linux runner only.
        ...(platform === "linux-x64" ? { bound: RTF_BUDGET_LINUX_X64 } : {}),
      },
    );
    notes.push(
      `FLEURS ${FLEURS.sets[lang].config}: ${utts.length} utterances, ${(audio / 60).toFixed(1)} min`,
    );
  }
}

async function main(argv: string[]): Promise<number> {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const modelsDir = flag("--models");
  const dataDir = flag("--data");
  // `biasing` runs only when named: its 360 Qwen decodes would take the scheduled night past its timeout.
  const only = new Set((flag("--only") ?? "fleurs,ami,replay,qwen,dictation").split(","));
  if (!modelsDir || !dataDir) {
    console.error(
      "usage: bun scripts/eval/nightly.ts --models <dir> --data <dir> [--diarize <akou-diarize> --nemotron <onnx>] [--qwen-models <dir>] [--only fleurs,ami,replay,qwen,dictation,biasing] [--out results.json] [--latency-table <json>] [--biasing-out <json>] [--machine <what>]",
    );
    return 64;
  }
  const platform = platformKey();
  const measures: Measure[] = [];
  const notes: string[] = [];
  /** Stages that failed outright, as rows that are never ok. */
  const stageFailures: Verdict[] = [];

  if (only.has("fleurs")) {
    // The download guard is off only here: `env` replaces the process environment, which has CI set.
    await downloadModels(modelsDir, [RECOGNIZER], { env: {} });
    const models = new SherpaModels({ dir: modelsDir, cacheDir: join(dataDir, "sherpa-cache") });
    await fleursStage(models, dataDir, platform, measures, notes);
    // The fp32 recognizer is about 2.5 GB. Kept, it sat in swap through the Qwen stage on the 7 GB
    // macOS runner, which then had a few hundred MB of swap left under the default-cache control.
    const before = memoryMb(process.pid);
    await models.release();
    notes.push(
      `${RECOGNIZER} let go before the next stage: this process at ${Math.round(before)} MB, then ${Math.round(memoryMb(process.pid))} MB`,
    );
    notes.push(FLEURS.licence);
  }

  if (only.has("ami")) {
    const helper = flag("--diarize");
    const model = flag("--nemotron");
    if (!helper || !model) throw new Error("--only ami needs --diarize and --nemotron");
    const diarizer = new NemotronDiarizer({ command: [helper], model, threads: 2 });
    let speech = 0;
    let errors = 0;
    let audio = 0;
    for (const c of await ami(dataDir)) {
      const x = readWav(new Uint8Array(readFileSync(c.wav)));
      audio += x.length / ASR_RATE;
      const hyp = (await diarizer.process(x)).map((t) => ({ ...t, speaker: String(t.speaker) }));
      const d = der(c.ref, hyp);
      speech += d.speech;
      errors += d.missed + d.falseAlarm + d.confusion;
    }
    measures.push({
      key: "der.ami_test2.nemotron-3-diarization",
      value: (100 * errors) / speech,
      unit: "%",
      better: "lower",
      gate: "baseline",
    });
    notes.push(
      `AMI: ${AMI.meetings.map((m) => m.id).join(" and ")}, headset mix, ${(audio / 60).toFixed(1)} min, collar 0.25 s, overlap scored`,
    );
    notes.push(AMI.licence);
  }

  if (only.has("replay")) {
    let hits = 0;
    let total = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const call = synthCall({ hours: 3, seed });
      const r = replay(call.events, synthQuestions(call), { now: call.end + 60_000 });
      if (r.overBound > 0)
        throw new Error(`replay seed ${seed}: ${r.overBound} packs over the bound`);
      hits += r.hits;
      total += r.total;
    }
    measures.push({
      key: "replay.recall.synthetic",
      value: hits / total,
      unit: "",
      better: "higher",
      gate: "record",
      bound: REPLAY_FLOOR,
    });
    notes.push(`Replay: ${total} questions over five generated three-hour calls`);
  }

  if (only.has("qwen")) {
    const accelerator = flag("--accelerator");
    // Windows runs Qwen by hand only, with its backend named (the gate, ASR-12), not each night.
    if (platform.startsWith("win32") && !accelerator)
      notes.push(
        "Qwen3-ASR: not run on Windows each night; the Windows gate (ASR-12) runs it by hand with --accelerator",
      );
    else
      await qwenStage(
        flag("--qwen-models") ?? modelsDir,
        dataDir,
        platform,
        measures,
        notes,
        accelerator ?? "auto",
      );
  }

  if (only.has("dictation")) {
    const { out: engines, failed } = await dictationStage(
      {
        modelsDir,
        qwenModelsDir: flag("--qwen-models") ?? modelsDir,
        dataDir,
        platform,
      },
      measures,
      notes,
    );
    const tableFile = flag("--latency-table");
    if (tableFile) {
      const old = existsSync(tableFile)
        ? (JSON.parse(readFileSync(tableFile, "utf8")) as LatencyTable)
        : null;
      const day = new Date().toISOString().slice(0, 10);
      const entry = { measured: `${day}, ${flag("--machine") ?? platform}`, engines };
      writeFileSync(tableFile, `${JSON.stringify(withPlatform(old, platform, entry), null, 2)}\n`);
    }
    // An engine that failed leaves the others' numbers above; the night is red for it.
    stageFailures.push(...failureVerdicts("dictation", failed));
  }

  if (only.has("biasing")) {
    if (platform.startsWith("win32"))
      notes.push(
        "Dictation biasing: not run on Windows, where Qwen3-ASR does not run yet (ASR-12)",
      );
    else {
      const r = await biasingStage(
        flag("--qwen-models") ?? modelsDir,
        dataDir,
        platform,
        measures,
        notes,
      );
      const file = flag("--biasing-out");
      if (file) {
        const day = new Date().toISOString().slice(0, 10);
        const measured = `${day}, ${flag("--machine") ?? platform}`;
        writeFileSync(
          file,
          `${JSON.stringify({ _about: BIASING_ABOUT, measured, ...r }, null, 2)}\n`,
        );
      }
    }
  }

  notes.push(
    "Not built yet: the vocabulary evaluation with its boost-5 positive control (no generator for its synthetic set is in the repository)",
  );
  const baselines =
    (
      JSON.parse(readFileSync(join(ROOT, "docs", "gates", "nightly-baselines.json"), "utf8")) as {
        platforms: Record<string, Record<string, number>>;
      }
    ).platforms[platform] ?? {};
  const verdicts = nightVerdicts(measures, baselines, stageFailures);
  const text = summary(`models-nightly on ${platform}`, verdicts, notes);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, text, { flag: "a" });
  const out = flag("--out");
  if (out) writeFileSync(out, `${JSON.stringify({ platform, verdicts }, null, 2)}\n`);
  return exitCode(verdicts);
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
