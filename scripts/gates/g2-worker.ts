/**
 * ROADMAP G2, recognition in the packaged app: sherpa-onnx-node loads in a Bun Worker inside the
 * built bundle and transcribes a fixture, while the main thread's timer never waits 100 ms or more.
 * Run on the machine that built the app, after `scripts/build-app.ts`:
 *
 *   bun scripts/gates/g2-worker.ts --models <models dir> [--out result.json]
 *
 * 1. The pinned recognizer is downloaded into `--models` (each file checked against
 *    src/main/asr/models.ts; an existing copy is only checked), with the same upstream clip
 *    `scripts/models-smoke.ts` uses ("Ask not what your country can do for you, ...").
 * 2. The built app is unpacked the way the smoke check does it (`unpackApp`), and
 *    `scripts/gates/g2-probe.ts` is bundled into its main folder with sherpa-onnx-node left to the
 *    app's own `node_modules`.
 * 3. The app's bundled Bun runs the probe twice. `worker`: the recognizer loads and decodes in a
 *    Worker while the main thread ticks every 1 ms; pass when the clip's words come back and the
 *    longest tick is under 100 ms. `main`, the positive control: the same decode on the main thread
 *    must leave a tick of 100 ms or more, or the measure could not see a blocked thread and the run
 *    fails.
 *
 * Prints one JSON object with both runs and the verdict; exits 1 unless the gate passes.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, downloadModels, RECOGNIZER } from "../../src/main/asr/models.ts";
import { readClip } from "../clip.ts";
import { unpackApp } from "../smoke-app.ts";

/**
 * About where a wait starts to be noticed. A blocked main thread waits as long as the decode,
 * 2.4 s or more in the control. One that only shares the CPU with the recognizer's two threads
 * waits a scheduler turn or two: up to 72 ms on a 4-core Windows runner (under 10 ms with no
 * recognizer running), so the 20 ms this was failed a third of the Windows runs on the OS.
 */
const LIMIT_MS = 100;
const PHRASE = "ask not what your country can do for you";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = opt("--models");
if (!dir)
  throw new Error("usage: bun scripts/gates/g2-worker.ts --models <dir> [--out result.json]");

// The download guard is off only here: `env` replaces the process environment, which has CI set.
const allow = { env: {} };
await downloadModels(dir, [RECOGNIZER], allow);
const wav = join(dir, "smoke", "en.wav");
await downloadFile(
  "smoke",
  {
    name: "en.wav",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3/resolve/1a468a35cbba69418f126de829e75261dea4a4e4/test_wavs/en.wav",
    sha256: "148b936b43ce7c546a866e64da059f0458aee2d65e617f16e9d94f06e8d99ed6",
    size: 184608,
  },
  wav,
  allow,
);

const work = mkdtempSync(join(tmpdir(), "akou-g2-"));
try {
  const clip = join(work, "clip.f32");
  writeFileSync(clip, readClip(wav));

  const app = unpackApp(work);
  if (typeof app === "string") throw new Error(app);
  const probe = join(app.main, "g2-probe.js");
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "g2-probe.ts")],
    target: "bun",
    format: "esm",
    // Loaded from the app's own node_modules, beside the probe, as the app's Workers load it.
    external: ["sherpa-onnx-node"],
  });
  if (!built.success || !built.outputs[0])
    throw new Error(`the probe does not build: ${built.logs}`);
  await Bun.write(probe, built.outputs[0]);

  const run = (mode: "worker" | "main") => {
    const r = spawnSync(app.bun, [probe, dir, clip, mode], { encoding: "utf8", timeout: 600_000 });
    try {
      return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
    } catch {
      return { mode, error: `exit ${r.status}: ${(r.stderr || r.stdout).trim().slice(-800)}` };
    }
  };
  const inWorker = run("worker");
  const onMain = run("main");

  const heard = (r: { text?: string }) =>
    (r.text ?? "")
      .toLowerCase()
      .replace(/[^a-z ]/g, "")
      .includes(PHRASE);
  const problems: string[] = [];
  if (inWorker.error) problems.push(`the Worker run failed: ${inWorker.error}`);
  else {
    if (!heard(inWorker)) problems.push(`the Worker did not hear the clip: ${inWorker.text}`);
    if (!(inWorker.tickMsMax < LIMIT_MS)) {
      problems.push(`the main thread waited ${inWorker.tickMsMax} ms, not under ${LIMIT_MS}`);
    }
  }
  if (onMain.error) problems.push(`the control run failed: ${onMain.error}`);
  else if (!(onMain.tickMsMax >= LIMIT_MS)) {
    problems.push(
      `control: a decode on the main thread left a longest tick of ${onMain.tickMsMax} ms, so the measure cannot see a blocked thread`,
    );
  }

  const result = {
    gate: "G2",
    platform: `${process.platform}-${process.arch}`,
    model: RECOGNIZER,
    limitMs: LIMIT_MS,
    worker: inWorker,
    control: onMain,
    verdict: problems.length === 0 ? "pass" : "fail",
    problems,
  };
  const text = JSON.stringify(result, null, 2);
  const out = opt("--out");
  if (out) writeFileSync(out, `${text}\n`);
  console.log(text);
  if (problems.length > 0) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
