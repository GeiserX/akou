/**
 * The nightly model evaluation (`models-nightly`, docs/TESTING.md TS-19 and TS-20): the real
 * recognizer and the real diarizer, through the app's own code, on public, openly licensed audio,
 * compared with the baselines committed in docs/gates/nightly-baselines.json.
 *
 *   bun scripts/eval/nightly.ts --models <dir> --data <dir> --diarize <akou-diarize> --nemotron <onnx>
 *                               [--qwen-models <dir>] [--only fleurs,ami,replay,qwen] [--out results.json]
 *                               [--accelerator cpu|vulkan|cuda|metal]
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
 *
 * Every download is pinned by revision and checked by SHA-256: the published hash where the host
 * has one, and otherwise the hash of the file as first fetched (the AMI audio).
 * The job summary lists every number next to its baseline and ends with the licences. It exits 1
 * when any gated number is worse than its baseline, has none, or passes its bound.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASR_RATE } from "../../src/main/asr/engine.ts";
import {
  llamaBuildId,
  QWEN_ASR,
  QWEN_MMPROJ_FILE,
  QWEN_MODEL_FILE,
} from "../../src/main/asr/llama-catalog.ts";
import { extractBuild, LlamaServer, resolveAccelerator } from "../../src/main/asr/llama-server.ts";
import { downloadModels, MODELS, modelFile, RECOGNIZER } from "../../src/main/asr/models.ts";
import { NemotronDiarizer } from "../../src/main/asr/nemotron.ts";
import { QwenEngine } from "../../src/main/asr/qwen.ts";
import { SherpaModels } from "../../src/main/asr/sherpa.ts";
import { replay } from "../../tests/eval/replay.ts";
import { synthCall, synthQuestions } from "../../tests/synth.ts";
import {
  compare,
  der,
  type Measure,
  parseRttm,
  percentile,
  summary,
  type Turn,
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

/** Decodes each clip on `server`, one request each, and reads its memory after every request. */
async function qwenRun(
  server: LlamaServer,
  clips: readonly { samples: Float32Array; lang: string }[],
): Promise<{ texts: string[]; ms: number[]; mem: number[] }> {
  const engine = new QwenEngine({ id: QWEN_ASR, server, allowed: ["en", "es"] });
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
  notes.push(
    `Qwen3-ASR-1.7B Q8_0 on llama-server (${accelerator}): WER on the first ${k} FLEURS clips per language, language set to the clip's; the benchmark's ${quiet.length} silent AMI stretches on auto among en and es; memory over ${n} requests, then ${QWEN_GATE.controlRequests} with the default --cache-ram as the control, which must grow past ${QWEN_GATE.flatMb} MB`,
  );
}

// --- the run -----------------------------------------------------------------------------------

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

async function main(argv: string[]): Promise<number> {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const modelsDir = flag("--models");
  const dataDir = flag("--data");
  const only = new Set((flag("--only") ?? "fleurs,ami,replay,qwen").split(","));
  if (!modelsDir || !dataDir) {
    console.error(
      "usage: bun scripts/eval/nightly.ts --models <dir> --data <dir> [--diarize <akou-diarize> --nemotron <onnx>] [--qwen-models <dir>] [--only fleurs,ami,replay,qwen] [--out results.json]",
    );
    return 64;
  }
  const platform = platformKey();
  const measures: Measure[] = [];
  const notes: string[] = [];

  if (only.has("fleurs")) {
    // The download guard is off only here: `env` replaces the process environment, which has CI set.
    await downloadModels(modelsDir, [RECOGNIZER], { env: {} });
    const models = new SherpaModels({ dir: modelsDir, cacheDir: join(dataDir, "sherpa-cache") });
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

  notes.push(
    "Not built yet: the vocabulary evaluation with its boost-5 positive control (no generator for its synthetic set is in the repository)",
  );
  const baselines =
    (
      JSON.parse(readFileSync(join(ROOT, "docs", "gates", "nightly-baselines.json"), "utf8")) as {
        platforms: Record<string, Record<string, number>>;
      }
    ).platforms[platform] ?? {};
  const verdicts = compare(measures, baselines);
  const text = summary(`models-nightly on ${platform}`, verdicts, notes);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, text, { flag: "a" });
  const out = flag("--out");
  if (out) writeFileSync(out, `${JSON.stringify({ platform, verdicts }, null, 2)}\n`);
  return verdicts.every((v) => v.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
