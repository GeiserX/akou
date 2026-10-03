/**
 * ASR-12, the Windows gate (docs/gates/asr-12-windows.md): the streaming engine's speed on this
 * machine's processor. `nemotron-en-560` through the app's own `SherpaModels`, one stream per FLEURS
 * clip as the benchmark ran it, at 2 and 4 threads (`asr.threads`; the benchmark measured 0.091 and
 * 0.067 on an Apple M4), and its word error rate on the same clips so a broken build shows as
 * nonsense rather than as speed. One clip warms the engine up before each timed run.
 *
 *   bun scripts/gates/asr-12-stream-rtf.ts --models <dir> --data <dir> [--clips 30] [--out result.json]
 *
 * `--data` is the nightly's data folder (`scripts/eval/nightly.ts --data`); the clips are fetched
 * into it, and the model into `--models`, both checked against their pins.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { ASR_RATE, type LiveToken } from "../../src/main/asr/engine.ts";
import { tokenText } from "../../src/main/asr/live-stream.ts";
import { downloadModels } from "../../src/main/asr/models.ts";
import { prepareSpan } from "../../src/main/asr/pad.ts";
import { SherpaModels } from "../../src/main/asr/sherpa.ts";
import { fleurs, readWav } from "../eval/nightly.ts";
import { wer } from "../eval/score.ts";

const ENGINE = "nemotron-en-560";
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const modelsDir = opt("--models");
const dataDir = opt("--data");
const n = Number(opt("--clips") ?? 30);
if (!modelsDir || !dataDir) throw new Error("--models and --data are required");

await downloadModels(modelsDir, [ENGINE], { env: {} });
const clips = (await fleurs("en", dataDir)).slice(0, n).map((u) => ({
  ref: u.ref,
  samples: prepareSpan(readWav(new Uint8Array(readFileSync(u.wav)))),
}));
const audioS = clips.reduce((a, c) => a + c.samples.length, 0) / ASR_RATE;

const runs: { threads: number; rtf: number; wer: number }[] = [];
for (const threads of [2, 4]) {
  const models = new SherpaModels({ dir: modelsDir, cacheDir: join(modelsDir, ".cache"), threads });
  const engine = models.liveEngine(ENGINE);
  const decode = (x: Float32Array) => {
    const s = engine.open("en");
    const toks: LiveToken[] = [];
    for (let at = 0; at < x.length; at += 1600) toks.push(...s.push(x.subarray(at, at + 1600)));
    toks.push(...s.flush());
    s.close();
    return tokenText(toks);
  };
  decode((clips[0] as { samples: Float32Array }).samples);
  const t = performance.now();
  const hyps = clips.map((c) => decode(c.samples));
  const s = (performance.now() - t) / 1000;
  const r = {
    threads,
    rtf: s / audioS,
    wer: wer(clips.map((c, i) => ({ ref: c.ref, hyp: hyps[i] as string }))),
  };
  runs.push(r);
  console.log(
    `${ENGINE}, ${threads} threads: RTF ${r.rtf.toFixed(3)}, WER ${r.wer.toFixed(2)} on ${clips.length} clips (${audioS.toFixed(0)} s)`,
  );
  await models.release?.();
}

const result = {
  engine: ENGINE,
  platform: `${process.platform}-${process.arch}`,
  cpu: cpus()[0]?.model ?? "unknown",
  logicalCpus: cpus().length,
  clips: clips.length,
  audio_s: Math.round(audioS),
  runs,
};
const out = opt("--out");
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
