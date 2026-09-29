/**
 * The final pass's memory, measured: what the app keeps after one pass, after several in a row
 * (the catch-up at start runs every unfinalized call back to back), and after it sits idle.
 *
 * The method, so the number can be reproduced:
 *
 * 1. `--calls` generated calls, each of `--parts` copies of one Opus part (`--opus`, written by
 *    `akou-capture run --from-wav`), ended, with no final layer.
 * 2. Each call's final pass through `finalizeCall`, one after the other, the way the catch-up
 *    runs them: its own Worker, Parakeet and Silero on sherpa-onnx, Nemotron through
 *    `akou-diarize`, the parts decoded by `akou-capture decode`.
 * 3. This process's footprint (macOS `footprint`: dirty memory, swapped or compressed included,
 *    which is what fills a disk with swap) after each pass, every two minutes during one, and every
 *    minute for `--idle` seconds after the last.
 *
 * It needs the real models and both helpers, and holds a model set in memory per pass (about 3 GB
 * with Parakeet fp32): run it on a machine with room to spare. No test runs it;
 * `tests/asr-final.test.ts` checks that a pass lets go of its models.
 *
 *   bun scripts/measure-final-memory.ts --models DIR --capture PATH --diarize PATH --opus PART
 *     [--calls 3] [--parts 2] [--part-seconds 1200] [--idle 600] [--work DIR]
 */

import { heapStats } from "bun:jsc";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { EventDraft } from "../src/core/log/events.ts";
import { LogWriter } from "../src/core/log/writer.ts";
import { finalizeCall } from "../src/main/asr/finalize-worker.ts";
import { partFile } from "../src/main/call/folder.ts";

const { values: a } = parseArgs({
  options: {
    models: { type: "string" },
    capture: { type: "string" },
    diarize: { type: "string" },
    opus: { type: "string" },
    calls: { type: "string", default: "3" },
    parts: { type: "string", default: "2" },
    "part-seconds": { type: "string", default: "1200" },
    idle: { type: "string", default: "600" },
    work: { type: "string" },
  },
});
const { models, capture, diarize, opus } = a;
if (!models || !capture || !diarize || !opus) {
  console.error("usage: --models DIR --capture PATH --diarize PATH --opus PART (see the header)");
  process.exit(2);
}
const calls = Number(a.calls);
const parts = Number(a.parts);
const partSeconds = Number(a["part-seconds"]);
const idle = Number(a.idle);
const work = a.work ?? mkdtempSync(join(tmpdir(), "akou-final-memory-"));

function memory(): string {
  const r = Bun.spawnSync(["footprint", "-f", "bytes", "-p", String(process.pid)]);
  const fp = /Footprint:\s*(\d+)\s*B/.exec(r.stdout.toString())?.[1];
  Bun.gc(true);
  const h = heapStats();
  const mib = (b: number) => `${Math.round(b / 2 ** 20)} MiB`;
  return `footprint ${fp ? mib(Number(fp)) : "?"}, JS heap ${mib(h.heapSize)}`;
}
const t0 = performance.now();
const report = (what: string) =>
  console.log(`[${Math.round((performance.now() - t0) / 1000)} s] ${what}: ${memory()}`);

report("start");
const tick = setInterval(() => report("during a pass"), 120_000);
for (let c = 1; c <= calls; c++) {
  const dir = join(work, `call-${c}`);
  mkdirSync(join(dir, "audio"), { recursive: true });
  const w = LogWriter.open(dir);
  const files: Record<number, string> = {};
  const start = Date.now() - calls * parts * partSeconds * 1000;
  w.append({
    type: "call.created",
    id: `memory-${c}`,
    schema: 1,
    workspace: "",
    title: `Call ${c}`,
    tz: "UTC",
    user: "me",
    akou: "measure",
  } as EventDraft);
  for (let p = 1; p <= parts; p++) {
    const file = join(dir, partFile(p));
    copyFileSync(opus, file);
    files[p] = file;
    w.append({
      type: "part.started",
      part: p,
      file: partFile(p),
      wallStart: start + (p - 1) * partSeconds * 1000,
      monoStart: (p - 1) * partSeconds * 1000,
      mic: "Mic",
      call: { mode: "system" },
      capture: "file",
    } as EventDraft);
    w.append({
      type: "part.ended",
      part: p,
      reason: "stop",
      fileSeconds: partSeconds,
    } as EventDraft);
  }
  w.append({ type: "call.ended", reason: "stop" } as EventDraft);
  const t = performance.now();
  const r = await finalizeCall(
    { dir, record: (d) => w.append(d), holdWriter: () => () => {} },
    {
      models: {
        kind: "sherpa",
        dir: models,
        cacheDir: join(work, "cache"),
        diarizer: "nemotron",
        decoding: "greedy",
        diarizeHelper: [diarize],
      },
      audio: { kind: "opus", command: [capture], files },
      onLog: (level, msg) => level !== "info" && console.log(`  ${level}: ${msg}`),
    },
  );
  w.close();
  const s = Math.round((performance.now() - t) / 1000);
  report(`pass ${c} ${r.ok ? "done" : `failed (${r.error})`} in ${s} s`);
}
clearInterval(tick);
for (let s = 60; s <= idle; s += 60) {
  await Bun.sleep(60_000);
  report(`idle ${s} s`);
}
if (!a.work) rmSync(work, { recursive: true, force: true });
