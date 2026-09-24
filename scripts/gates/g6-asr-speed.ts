/**
 * ROADMAP G6, recognizer speed, offline half: Parakeet TDT v3 int8 through the app's own
 * `SherpaModels`, in the production setting (`modified_beam_search`, a 12-word decode list at the
 * default boost, `asr.threads` threads), over a folder of speech clips.
 *
 * The real-time factor for both channels assumes the worst case, speech on both sides all the
 * time: the live Worker decodes both channels with one recognizer, so it spends twice the
 * one-channel decode time per second of call. Every clip is decoded once to warm up, then timed.
 *
 *   bun scripts/gates/g6-asr-speed.ts --models <models dir> --clips <dir of *.f32, 16 kHz mono>
 *     --words w1,w2,… [--threads 2] [--out result.json]
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASR_RATE } from "../../src/main/asr/engine.ts";
import { RECOGNIZER } from "../../src/main/asr/models.ts";
import { prepareSpan } from "../../src/main/asr/pad.ts";
import { SherpaModels } from "../../src/main/asr/sherpa.ts";
import { DEFAULT_BOOST, type DecodeList } from "../../src/main/vocab/decode-list.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const modelsDir = opt("--models");
const clipsDir = opt("--clips");
const words = (opt("--words") ?? "").split(",").filter((w) => w !== "");
const threads = Number(opt("--threads") ?? 2);
if (!modelsDir || !clipsDir || words.length === 0) {
  throw new Error("--models, --clips and --words are required");
}

const list: DecodeList = {
  model: RECOGNIZER,
  entries: words.map((term) => ({ term, boost: DEFAULT_BOOST, tier: 1, source: "call" })),
  dropped: [],
  warnings: [],
};

const clips = readdirSync(clipsDir)
  .filter((f) => f.endsWith(".f32"))
  .sort()
  .map((f) => {
    const b = readFileSync(join(clipsDir, f));
    return { name: f, samples: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) };
  });
if (clips.length === 0) throw new Error(`no .f32 clips in ${clipsDir}: nothing to measure`);

const tLoad = performance.now();
const models = new SherpaModels({
  dir: modelsDir,
  cacheDir: mkdtempSync(join(tmpdir(), "akou-g6-")),
  threads,
});
const prepared = models.prepare(list);
const loadMs = performance.now() - tLoad;

for (const c of clips) prepared.recognizer.decode(prepareSpan(c.samples), prepared.arg);

const rows = clips.map((c) => {
  const t = performance.now();
  const r = prepared.recognizer.decode(prepareSpan(c.samples), prepared.arg);
  const ms = performance.now() - t;
  const seconds = c.samples.length / ASR_RATE;
  return {
    clip: c.name,
    seconds: Math.round(seconds * 100) / 100,
    decodeMs: Math.round(ms),
    text: r.text,
  };
});

const audio = rows.reduce((a, r) => a + r.seconds, 0);
const decode = rows.reduce((a, r) => a + r.decodeMs, 0) / 1000;
const perClip = rows.map((r) => r.decodeMs).sort((a, b) => a - b);
const result = {
  model: RECOGNIZER,
  decoding: "modified_beam_search",
  threads,
  decodeList: { kept: prepared.entries, dropped: prepared.dropped },
  loadMs: Math.round(loadMs),
  clips: rows.length,
  audioSeconds: Math.round(audio * 10) / 10,
  decodeSeconds: Math.round(decode * 100) / 100,
  rtfOneChannel: Math.round((decode / audio) * 1000) / 1000,
  rtfBothChannelsWorstCase: Math.round(((2 * decode) / audio) * 1000) / 1000,
  decodeMsP50: perClip[Math.floor(perClip.length / 2)],
  decodeMsMax: perClip[perClip.length - 1],
  rows,
};
const text = JSON.stringify(result, null, 2);
const out = opt("--out");
if (out) writeFileSync(out, `${text}\n`);
console.log(text);
