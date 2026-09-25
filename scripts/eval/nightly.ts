/**
 * The nightly model evaluation (`models-nightly`, docs/TESTING.md TS-19 and TS-20): the real
 * recognizer and the real diarizer, through the app's own code, on public, openly licensed audio,
 * compared with the baselines committed in docs/gates/nightly-baselines.json.
 *
 *   bun scripts/eval/nightly.ts --models <dir> --data <dir> --diarize <akou-diarize> --nemotron <onnx>
 *                               [--only fleurs,voxconverse,replay] [--out results.json]
 *
 * What it measures, per OS:
 *
 * - WER per engine and language on the FLEURS subset of docs/research/asr-benchmark.md (150
 *   English and 150 Spanish test utterances, the ids in its JSON file), scored with the
 *   benchmark's normalizer. Gated at or below the baseline.
 * - Latency: each utterance's decode time, p50, p90 and p99, and the real-time factor. Recorded;
 *   the real-time factor of the default engines gates on its budget (0.5 on the 4-core x64 Linux
 *   runner, docs/TESTING.md 4.7) and nowhere else.
 * - Diarization error on a VoxConverse dev subset (RTTM references from the dataset's repository
 *   at a pinned commit, 0.25 s collar, overlap scored). Gated at or below the baseline.
 * - The replay recall of the query engine on five generated three-hour calls, with its 85 % floor.
 *
 * Every download is pinned by revision and checked by SHA-256 where the host publishes one; the
 * VoxConverse audio is read out of the dataset's zip with range requests and checked by size.
 * The job summary lists every number next to its baseline and ends with the licences. It exits 1
 * when any gated number is worse than its baseline, has none, or passes its bound.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ASR_RATE } from "../../src/main/asr/engine.ts";
import { downloadModels, RECOGNIZER } from "../../src/main/asr/models.ts";
import { NemotronDiarizer } from "../../src/main/asr/nemotron.ts";
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

/** VoxConverse dev files with two to five speakers, about 17 minutes in all. */
export const VOXCONVERSE = {
  zip: "https://www.robots.ox.ac.uk/~vgg/data/voxconverse/data/voxconverse_dev_wav.zip",
  zipSize: 1988647478,
  rttm: "https://raw.githubusercontent.com/joonson/voxconverse/24bf60be297701cd7e4ef18550c6d390c1b87365/dev",
  licence:
    "VoxConverse (dev, RTTM v0.3 at joonson/voxconverse@24bf60b): CC-BY-4.0, for research; the copyright of the audio stays with the original video owners",
  files: [
    "tucrg",
    "qpylu",
    "whmpa",
    "bkwns",
    "szsyz",
    "fxgvy",
    "gwtwd",
    "rtvuw",
    "syiwe",
    "cobal",
    "oenox",
    "bwzyf",
    "plbbw",
    "jiqvr",
    "wjhgf",
    "jyirt",
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

/** A file fetched once into `path` and checked by SHA-256 every time it is used. */
async function pinned(url: string, path: string, sha: string): Promise<Uint8Array> {
  if (!existsSync(path)) writeFileSync(path, await get(url));
  const b = new Uint8Array(readFileSync(path));
  const got = sha256(b);
  if (got !== sha) throw new Error(`${url}: SHA-256 ${got}, pinned ${sha}`);
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

interface Utterance {
  id: string;
  ref: string;
  wav: string;
}

/** The pinned FLEURS utterances of one language, extracted into `dir` once and cached there. */
async function fleurs(lang: keyof typeof FLEURS.sets, dataDir: string): Promise<Utterance[]> {
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

// --- VoxConverse, read out of the zip with range requests -------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

async function range(url: string, from: number, to: number): Promise<Uint8Array> {
  const b = await get(url, { range: `bytes=${from}-${to}` });
  if (b.length !== to - from + 1)
    throw new Error(`${url}: asked ${to - from + 1} bytes, got ${b.length}`);
  return b;
}

/** The central directory of a zip at `url` of `size` bytes (no ZIP64: the file is under 4 GB). */
export async function zipDirectory(url: string, size: number): Promise<ZipEntry[]> {
  // The end record sits in the last 22 bytes plus a comment of at most 65,535.
  const tail = await range(url, Math.max(0, size - 65_557), size - 1);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (tv.getUint32(i, true) === 0x06054b50) {
      e = i;
      break;
    }
  if (e < 0) throw new Error(`${url}: no end of central directory`);
  const cdSize = tv.getUint32(e + 12, true);
  const cdOffset = tv.getUint32(e + 16, true);
  const cd = await range(url, cdOffset, cdOffset + cdSize - 1);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out: ZipEntry[] = [];
  for (let o = 0; o + 46 <= cd.length && v.getUint32(o, true) === 0x02014b50; ) {
    const nameLen = v.getUint16(o + 28, true);
    const extra = v.getUint16(o + 30, true);
    const comment = v.getUint16(o + 32, true);
    out.push({
      name: new TextDecoder().decode(cd.subarray(o + 46, o + 46 + nameLen)),
      method: v.getUint16(o + 10, true),
      compressed: v.getUint32(o + 20, true),
      size: v.getUint32(o + 24, true),
      offset: v.getUint32(o + 42, true),
    });
    o += 46 + nameLen + extra + comment;
  }
  return out;
}

/** One file out of the zip: its local header, then its data, stored or deflated. */
export async function zipFile(url: string, entry: ZipEntry): Promise<Uint8Array> {
  const head = await range(url, entry.offset, entry.offset + 29);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (hv.getUint32(0, true) !== 0x04034b50) throw new Error(`${entry.name}: no local header`);
  const start = entry.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  const raw = await range(url, start, start + entry.compressed - 1);
  const data =
    entry.method === 0
      ? raw
      : entry.method === 8
        ? new Uint8Array(inflateRawSync(raw))
        : (() => {
            throw new Error(`${entry.name}: compression method ${entry.method}`);
          })();
  if (data.length !== entry.size)
    throw new Error(`${entry.name}: ${data.length} bytes, want ${entry.size}`);
  return data;
}

interface Conversation {
  id: string;
  wav: string;
  ref: Turn[];
}

async function voxconverse(dataDir: string): Promise<Conversation[]> {
  const dir = join(dataDir, "voxconverse");
  mkdirSync(dir, { recursive: true });
  let entries: ZipEntry[] | null = null;
  const out: Conversation[] = [];
  for (const id of VOXCONVERSE.files) {
    const wav = join(dir, `${id}.wav`);
    if (!existsSync(wav)) {
      entries ??= await zipDirectory(VOXCONVERSE.zip, VOXCONVERSE.zipSize);
      const e = entries.find((x) => x.name.endsWith(`/${id}.wav`) || x.name === `${id}.wav`);
      if (!e) throw new Error(`VoxConverse: ${id}.wav is not in the zip`);
      writeFileSync(wav, await zipFile(VOXCONVERSE.zip, e));
    }
    const rttmPath = join(dir, `${id}.rttm`);
    if (!existsSync(rttmPath)) writeFileSync(rttmPath, await get(`${VOXCONVERSE.rttm}/${id}.rttm`));
    out.push({ id, wav, ref: parseRttm(readFileSync(rttmPath, "utf8")) });
  }
  return out;
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
  const only = new Set((flag("--only") ?? "fleurs,voxconverse,replay").split(","));
  if (!modelsDir || !dataDir) {
    console.error(
      "usage: bun scripts/eval/nightly.ts --models <dir> --data <dir> [--diarize <akou-diarize> --nemotron <onnx>] [--only fleurs,voxconverse,replay] [--out results.json]",
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

  if (only.has("voxconverse")) {
    const helper = flag("--diarize");
    const model = flag("--nemotron");
    if (!helper || !model) throw new Error("--only voxconverse needs --diarize and --nemotron");
    const diarizer = new NemotronDiarizer({ command: [helper], model, threads: 2 });
    let speech = 0;
    let errors = 0;
    let audio = 0;
    for (const c of await voxconverse(dataDir)) {
      const x = readWav(new Uint8Array(readFileSync(c.wav)));
      audio += x.length / ASR_RATE;
      const hyp = (await diarizer.process(x)).map((t) => ({ ...t, speaker: String(t.speaker) }));
      const d = der(c.ref, hyp);
      speech += d.speech;
      errors += d.missed + d.falseAlarm + d.confusion;
    }
    measures.push({
      key: "der.voxconverse_dev16.nemotron-3-diarization",
      value: (100 * errors) / speech,
      unit: "%",
      better: "lower",
      gate: "baseline",
    });
    notes.push(
      `VoxConverse: ${VOXCONVERSE.files.length} dev files, ${(audio / 60).toFixed(1)} min, collar 0.25 s, overlap scored`,
    );
    notes.push(VOXCONVERSE.licence);
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
