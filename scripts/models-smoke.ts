/**
 * Downloads the pinned recognizer (every file checked against `models.ts`) and transcribes one
 * upstream test clip with it through the app's own `SherpaModels`, with beam search and a one-word
 * decode list: the mode that also loads a `bpe.vocab` (greedy, the default, loads a subset of what
 * beam does). The `models` workflow runs it on Linux,
 * Windows and macOS whenever the pins change, so a build that does not load in sherpa-onnx-node on
 * one of them fails before it ships. `bun run check` never downloads; this script does, on purpose.
 *
 *   bun scripts/models-smoke.ts <models dir>
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASR_RATE } from "../src/main/asr/engine.ts";
import { downloadFile, downloadModels, RECOGNIZER } from "../src/main/asr/models.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";
import { DEFAULT_BOOST } from "../src/main/vocab/decode-list.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: bun scripts/models-smoke.ts <models dir>");
// The download guard is off only here: `env` replaces the process environment, which has CI set.
const allow = { env: {} };

const t0 = performance.now();
await downloadModels(dir, [RECOGNIZER], allow);
const downloadS = (performance.now() - t0) / 1000;

// "Ask not what your country can do for you, ask what you can do for your country.", 24 kHz 16-bit.
const clip = join(dir, "smoke", "en.wav");
await downloadFile(
  "smoke",
  {
    name: "en.wav",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3/resolve/1a468a35cbba69418f126de829e75261dea4a4e4/test_wavs/en.wav",
    sha256: "148b936b43ce7c546a866e64da059f0458aee2d65e617f16e9d94f06e8d99ed6",
    size: 184608,
  },
  clip,
  allow,
);

/** The clip's 16-bit mono PCM at 24 kHz, linearly resampled to the recognizer's 16 kHz. */
function readClip(path: string): Float32Array {
  const b = readFileSync(path);
  const rate = b.readUInt32LE(24);
  let at = 12;
  while (b.toString("ascii", at, at + 4) !== "data") at += 8 + b.readUInt32LE(at + 4);
  const n = b.readUInt32LE(at + 4) / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(at + 8 + 2 * i) / 32768;
  const out = new Float32Array(Math.floor((n * ASR_RATE) / rate));
  for (let i = 0; i < out.length; i++) {
    const x = (i * rate) / ASR_RATE;
    const j = Math.floor(x);
    out[i] = (pcm[j] ?? 0) + ((pcm[j + 1] ?? pcm[j] ?? 0) - (pcm[j] ?? 0)) * (x - j);
  }
  return out;
}

const t1 = performance.now();
const models = new SherpaModels({
  dir,
  cacheDir: mkdtempSync(join(tmpdir(), "akou-smoke-")),
  decoding: "beam",
});
const prepared = models.prepare({
  model: RECOGNIZER,
  entries: [{ term: "Kubernetes", boost: DEFAULT_BOOST, tier: 1, source: "call" }],
  dropped: [],
  warnings: [],
});
const loadS = (performance.now() - t1) / 1000;
const t2 = performance.now();
const { text } = prepared.recognizer.decode(readClip(clip), prepared.arg);
const decodeS = (performance.now() - t2) / 1000;

const heard = text.toLowerCase().replace(/[^a-z ]/g, "");
const ok = heard.includes("ask not what your country can do for you");
console.log(
  JSON.stringify({
    ok,
    model: RECOGNIZER,
    platform: `${process.platform}-${process.arch}`,
    downloadS: Math.round(downloadS),
    loadS: Math.round(loadS * 100) / 100,
    decodeS: Math.round(decodeS * 100) / 100,
    text,
  }),
);
if (!ok) process.exit(1);
