/**
 * A main thread that ticks every 1 ms while a Worker loads the native addon `entry`, for
 * tests/native-warm.test.ts. With `warm` 1 the Worker first loads it in a child (`warmNativeLoad`),
 * as sherpa.ts does. Prints one JSON line: the main thread's longest wait between two ticks, the
 * Worker's own load and its wait for the child.
 *
 *   bun tests/fixtures/addon-load-stall.ts <entry> <warm: 0|1>
 */

import { createRequire } from "node:module";
import { workerData } from "node:worker_threads";
import { warmNativeLoad } from "../../src/main/asr/native-warm.ts";

declare const self: Worker;
if (!Bun.isMainThread) {
  const { entry, warm } = workerData as { entry: string; warm: boolean };
  const t = performance.now();
  if (warm) warmNativeLoad(entry);
  const l = performance.now();
  createRequire(import.meta.url)(entry);
  self.postMessage({ warmMs: Math.round(l - t), loadMs: Math.round(performance.now() - l) });
} else {
  const [entry, warm] = process.argv.slice(2) as [string, string];
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 1);
  await Bun.sleep(100);
  const w = new Worker(new URL(import.meta.url).href, {
    workerData: { entry, warm: warm === "1" },
  } as WorkerOptions);
  w.onmessage = async (e: MessageEvent<{ warmMs: number; loadMs: number }>) => {
    await Bun.sleep(50);
    clearInterval(timer);
    console.log(JSON.stringify({ maxGapMs: Math.round(max), ...e.data }));
    process.exit(0);
  };
}
