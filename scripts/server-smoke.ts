/**
 * Inside the server image (docs/ux/SERVER.md SV-P6): one upstream English clip is encoded here with
 * the image's ffmpeg as an Ogg Opus voice note, an M4A, an MP3 and a WebM, and each is decoded
 * through `decodeAudio` and transcribed by the pinned recognizer through the app's own
 * `SherpaModels`, in the production setting. Every container must give the clip's sentence back.
 *
 *   bun scripts/server-smoke.ts [models dir]     # default: $AKOU_MODELS_DIR
 *
 * The models must already be there (`akou models pull fast`); only the 185 KB clip is fetched, by
 * its pinned SHA-256. The server CI job runs it with the repository's scripts folder mounted.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAudio } from "../src/main/asr/decode.ts";
import { downloadFile, RECOGNIZER, verifyModels } from "../src/main/asr/models.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";
import { DEFAULT_BOOST } from "../src/main/vocab/decode-list.ts";

const dir = process.argv[2] ?? process.env.AKOU_MODELS_DIR;
if (!dir) throw new Error("usage: bun scripts/server-smoke.ts <models dir>");
const bad = (await verifyModels(dir, [RECOGNIZER])).filter((f) => f.state !== "ok");
if (bad.length > 0) {
  console.error(`server-smoke: run \`akou models pull fast\` first: ${JSON.stringify(bad)}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "akou-server-smoke-"));
// "Ask not what your country can do for you, ask what you can do for your country.", 24 kHz 16-bit.
const clip = join(work, "en.wav");
await downloadFile(
  "smoke",
  {
    name: "en.wav",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3/resolve/1a468a35cbba69418f126de829e75261dea4a4e4/test_wavs/en.wav",
    sha256: "148b936b43ce7c546a866e64da059f0458aee2d65e617f16e9d94f06e8d99ed6",
    size: 184608,
  },
  clip,
  // The download guard is off only here: the clip is a pinned test file, not a model.
  { env: {} },
);

const containers: [string, string[]][] = [
  ["note.ogg", ["-c:a", "libopus", "-b:a", "24k"]],
  ["note.m4a", ["-c:a", "aac"]],
  ["note.mp3", ["-c:a", "libmp3lame"]],
  ["note.webm", ["-c:a", "libopus"]],
];

const models = new SherpaModels({ dir, cacheDir: mkdtempSync(join(tmpdir(), "akou-smoke-")) });
const prepared = models.prepare({
  model: RECOGNIZER,
  entries: [{ term: "Kubernetes", boost: DEFAULT_BOOST, tier: 1, source: "call" }],
  dropped: [],
  warnings: [],
});

let failed = 0;
for (const [name, codec] of containers) {
  const file = join(work, name);
  const enc = Bun.spawnSync([
    "ffmpeg",
    "-nostdin",
    "-loglevel",
    "error",
    "-i",
    clip,
    ...codec,
    file,
  ]);
  if (enc.exitCode !== 0) {
    console.log(JSON.stringify({ file: name, ok: false, error: enc.stderr.toString().trim() }));
    failed++;
    continue;
  }
  const t0 = performance.now();
  const pcm = await decodeAudio(file);
  const { text } = prepared.recognizer.decode(pcm, prepared.arg);
  const heard = text.toLowerCase().replace(/[^a-z ]/g, "");
  const ok = heard.includes("ask not what your country can do for you");
  if (!ok) failed++;
  console.log(
    JSON.stringify({
      file: name,
      ok,
      seconds: Math.round((pcm.length / 16000) * 100) / 100,
      decodeS: Math.round(performance.now() - t0) / 1000,
      text,
    }),
  );
}
if (failed > 0) {
  console.error(`server-smoke: ${failed} of ${containers.length} containers did not transcribe`);
  process.exit(1);
}
console.log(`server-smoke: all ${containers.length} containers transcribed (${process.arch})`);
