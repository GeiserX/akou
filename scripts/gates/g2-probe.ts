/**
 * ROADMAP G2, the half that runs inside the packaged app. `g2-worker.ts` bundles it into the app's
 * main folder with sherpa-onnx-node left out, so the app's own `node_modules` serves it exactly as
 * it serves the app's Workers, and runs it with the app's bundled Bun:
 *
 *   <bundled bun> <main folder>/g2-probe.js <models dir> <clip.f32> (worker | main)
 *
 * The main thread runs a 1 ms interval and records the time between its ticks while the app's
 * recognizer (`SherpaModels`, Parakeet) loads and decodes the clip: in a Bun Worker made the way
 * the app makes its own (`worker`, the gate), or on the main thread itself (`main`, the positive
 * control, whose decode must show up as one long gap). Prints one JSON line.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerData } from "node:worker_threads";
import { RECOGNIZER } from "../../src/main/asr/models.ts";
import { SherpaModels } from "../../src/main/asr/sherpa.ts";

interface Decoded {
  text: string;
  loadMs: number;
  decodeMs: number;
}

function decode(models: string, clip: string): Decoded {
  const b = readFileSync(clip);
  const samples = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const t0 = performance.now();
  const sherpa = new SherpaModels({
    dir: models,
    cacheDir: mkdtempSync(join(tmpdir(), "akou-g2-")),
  });
  const prepared = sherpa.prepare({ model: RECOGNIZER, entries: [], dropped: [], warnings: [] });
  const t1 = performance.now();
  const { text } = prepared.recognizer.decode(samples, prepared.arg);
  return { text, loadMs: Math.round(t1 - t0), decodeMs: Math.round(performance.now() - t1) };
}

// The Worker entry: this same file, started below as a Worker with the paths in `workerData`.
declare const self: Worker;
if (!Bun.isMainThread) {
  const { models, clip } = workerData as { models: string; clip: string };
  self.postMessage(decode(models, clip));
} else {
  const [models, clip, mode] = process.argv.slice(2) as [string, string, string];
  // Every interval between two ticks, from the moment the recognizer starts until it answers.
  const gaps: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 1);
  // A moment of idle ticks first: the interval this machine's timer keeps when nothing blocks it.
  await new Promise((r) => setTimeout(r, 300));
  const idle = gaps.splice(0).sort((a, b) => a - b);
  last = performance.now();
  const finish = (r: Decoded | { error: string }) => {
    // The gap still open when the answer arrived counts too.
    gaps.push(performance.now() - last);
    clearInterval(timer);
    const sorted = gaps.sort((a, b) => a - b);
    const at = (s: number[], q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
    const ms = (x: number) => Math.round(x * 10) / 10;
    console.log(
      JSON.stringify({
        mode,
        bun: Bun.version,
        platform: `${process.platform}-${process.arch}`,
        ...r,
        ticks: sorted.length,
        idleTickMsP50: ms(at(idle, 0.5)),
        idleTickMsMax: ms(idle.at(-1) ?? 0),
        tickMsP50: ms(at(sorted, 0.5)),
        tickMsP99: ms(at(sorted, 0.99)),
        tickMsMax: ms(sorted.at(-1) ?? 0),
      }),
    );
    process.exit("error" in r ? 1 : 0);
  };
  if (mode === "main") {
    finish(decode(models, clip));
  } else {
    // As the app makes its Workers (src/main/asr/live-worker.ts): Bun's Worker on a module file.
    const w = new Worker(new URL(import.meta.url).href, {
      workerData: { models, clip },
    } as WorkerOptions);
    w.onmessage = (e: MessageEvent<Decoded>) => finish(e.data);
    w.onerror = (e) => finish({ error: String(e.message ?? e) });
  }
}
