/**
 * Downloads the pinned recognizer (every file checked against `models.ts`) and transcribes one
 * upstream test clip with it through the app's own `SherpaModels` twice, with a one-word decode list:
 * once with beam search, which also loads a `bpe.vocab` and takes the list, and once greedy, the
 * default, which takes none. Both must hear the phrase. The `models` workflow runs it on Linux,
 * Windows and macOS whenever the pins change, so a build that does not load in sherpa-onnx-node on
 * one of them fails before it ships. `bun run check` never downloads; this script does, on purpose.
 *
 *   bun scripts/models-smoke.ts <models dir>
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, downloadModels, RECOGNIZER } from "../src/main/asr/models.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";
import { DEFAULT_BOOST } from "../src/main/vocab/decode-list.ts";
import { readClip } from "./clip.ts";

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

const samples = readClip(clip);
const runs = (["beam", "greedy"] as const).map((decoding) => {
  const t1 = performance.now();
  const models = new SherpaModels({
    dir,
    cacheDir: mkdtempSync(join(tmpdir(), "akou-smoke-")),
    decoding,
  });
  const prepared = models.prepare({
    model: RECOGNIZER,
    entries: [{ term: "Kubernetes", boost: DEFAULT_BOOST, tier: 1, source: "call" }],
    dropped: [],
    warnings: [],
  });
  const loadS = (performance.now() - t1) / 1000;
  const t2 = performance.now();
  const { text } = prepared.recognizer.decode(samples, prepared.arg);
  const decodeS = (performance.now() - t2) / 1000;
  const heard = text.toLowerCase().replace(/[^a-z ]/g, "");
  return {
    decoding,
    ok: heard.includes("ask not what your country can do for you"),
    hotwords: prepared.arg !== undefined,
    loadS: Math.round(loadS * 100) / 100,
    decodeS: Math.round(decodeS * 100) / 100,
    text,
  };
});
// Beam must take the list and greedy must not, or the run did not test the two modes it names.
const ok = runs.every((r) => r.ok && r.hotwords === (r.decoding === "beam"));
console.log(
  JSON.stringify({
    ok,
    model: RECOGNIZER,
    platform: `${process.platform}-${process.arch}`,
    downloadS: Math.round(downloadS),
    runs,
  }),
);
if (!ok) process.exit(1);
