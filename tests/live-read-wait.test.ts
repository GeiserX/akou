/**
 * How long a read waits for the second pass (review before a read, `reviewForRead`), with the real
 * models: about five minutes of English FLEURS clips (1 s of silence between them) run through the
 * live pipeline, as a call read after a five-minute interval with nothing reviewed yet. A read
 * reviews the newest `reviewCap(300)` seconds of closed utterances, whole, and leaves the older
 * ones to the timer; this times that pass, and for comparison the whole backlog:
 *
 * - **Parakeet** decodes each utterance alone on the live pipeline's own recognizer, after three
 *   warm-up decodes.
 * - **Qwen** decodes the read's requests (`reviewBatches`, joined by `joinUtterances`) on a fresh
 *   llama-server, after a warm-up request of the same size, twice.
 *
 * It prints the recognizer's threads and the machine's load average before and after, since both
 * move the numbers.
 *
 *   AKOU_LIVE_MODELS=<models> AKOU_FLEURS=<data> bun test tests/live-read-wait.test.ts
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { FLEURS, readWav } from "../scripts/eval/nightly.ts";
import { ASR_RATE } from "../src/main/asr/engine.ts";
import { chooseLiveEngine, type LiveChoice } from "../src/main/asr/live-engines.ts";
import { type LiveOut, LivePipeline, type UpgradeOut } from "../src/main/asr/live-worker.ts";
import { QWEN_ASR, QWEN_MMPROJ_FILE, QWEN_MODEL_FILE } from "../src/main/asr/llama-catalog.ts";
import { createLlamaServer, llamaBuild } from "../src/main/asr/llama-server.ts";
import { type Accelerator, hostPlatform, modelFile } from "../src/main/asr/models.ts";
import { QwenEngine } from "../src/main/asr/qwen.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";
import { joinUtterances, reviewBatches, reviewCap } from "../src/main/asr/upgrade.ts";

const MODELS = process.env.AKOU_LIVE_MODELS;
const DATA = process.env.AKOU_FLEURS;
const ACCEL = (process.env.AKOU_LIVE_ACCEL ?? "metal") as Accelerator;
/** The recognizer's threads: `asr.threads`, 2 by default in the app. */
const THREADS = Number(process.env.AKOU_LIVE_THREADS ?? 2);
/** The interval the read comes after, s: its cap is what one read reviews. */
const EVERY = 300;
const READY = !!MODELS && !!DATA && existsSync(modelFile(MODELS, QWEN_ASR, QWEN_MODEL_FILE));

/** English FLEURS clips joined until about five minutes, 1 s of silence after each. */
function fiveMinutes(data: string): Float32Array {
  const set = FLEURS.sets.en;
  const dir = join(data, "fleurs", set.config);
  const bench = JSON.parse(readFileSync("docs/research/asr-benchmark.json", "utf8")) as {
    fleurs_ids: Record<string, string[]>;
  };
  const parts: Float32Array[] = [];
  let n = 0;
  for (const id of bench.fleurs_ids[set.ids] ?? []) {
    const w = readWav(new Uint8Array(readFileSync(join(dir, "test", `${id}.wav`))));
    parts.push(w, new Float32Array(ASR_RATE));
    n += w.length + ASR_RATE;
    if (n >= 300 * ASR_RATE) break;
  }
  const out = new Float32Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The newest utterances within `cap` seconds, whole, as `reviewForRead` takes them. */
function newest(utts: readonly UpgradeOut[], cap: number): UpgradeOut[] {
  let from = utts.length;
  let n = 0;
  while (from > 0) {
    const len = (utts[from - 1] as UpgradeOut).samples.length;
    if (from < utts.length && n + len > cap * ASR_RATE) break;
    n += len;
    from--;
  }
  return utts.slice(from);
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const load = () =>
  loadavg()
    .map((x) => x.toFixed(1))
    .join(" ");

test.skipIf(!READY)(
  "[ASR-7] a read's wait for the second pass over five minutes of pending speech, with the real models",
  async () => {
    const models = MODELS as string;
    const loadBefore = load();
    const sherpa = new SherpaModels({
      dir: models,
      cacheDir: join(models, ".cache"),
      threads: THREADS,
      diarizer: "embeddings",
    });
    const utts: UpgradeOut[] = [];
    const p = new LivePipeline(sherpa, {}, (o: LiveOut) => {
      if (o.type === "upgrade") utts.push(o);
    });
    p.setDecodeList(null, 0);
    const live = chooseLiveEngine("auto", ["en"], () => true).choice as LiveChoice;
    await p.beginCall({ centroids: [], merges: [], unmerged: [], ids: [], live, upgrade: true });
    const audio = fiveMinutes(DATA as string);
    for (let at = 0; at < audio.length; at += 1600)
      p.audio(1, "mic", at, audio.subarray(at, at + 1600), false);
    await p.flush();
    const speech = utts.reduce((n, u) => n + u.samples.length, 0) / ASR_RATE;
    const read = newest(utts, reviewCap(EVERY));
    const readSpeech = read.reduce((n, u) => n + u.samples.length, 0) / ASR_RATE;
    expect(read.length).toBeGreaterThan(0);

    // Parakeet: warm the recognizer, then the read's utterances, then the whole backlog.
    for (const u of utts.slice(0, 3)) p.decodeUtterance(u.samples);
    let t = performance.now();
    for (const u of read) p.decodeUtterance(u.samples);
    const parakeet = performance.now() - t;
    t = performance.now();
    for (const u of utts) p.decodeUtterance(u.samples);
    const parakeetAll = performance.now() - t;
    p.stop();

    // Qwen on a fresh llama-server: warm it on a request of the read's size, then time the read.
    const platform = hostPlatform();
    const build = llamaBuild(platform, ACCEL);
    if (!build) throw new Error(`no llama-server build for ${platform} ${ACCEL}`);
    const server = createLlamaServer({
      kind: "llama-server",
      engine: QWEN_ASR,
      model: modelFile(models, QWEN_ASR, QWEN_MODEL_FILE),
      mmproj: modelFile(models, QWEN_ASR, QWEN_MMPROJ_FILE),
      accelerator: ACCEL,
      build: {
        dir: join(models, build.id),
        archives: build.files.map((f) => modelFile(models, build.id, f.name)),
        platform,
      },
    });
    const qwen = new QwenEngine({ id: QWEN_ASR, server, allowed: ["en"] });
    const decode = (samples: Float32Array) => qwen.decode({ samples, lang: "en", glossary: [] });
    const pass = async (us: readonly UpgradeOut[]) => {
      const t0 = performance.now();
      for (const b of reviewBatches(us, reviewCap(EVERY)))
        await decode(joinUtterances(b.map((u) => u.samples)));
      return performance.now() - t0;
    };
    try {
      await server.url();
      await decode(joinUtterances(read.map((u) => u.samples)));
      const qwenRead = [await pass(read), await pass(read)];
      const qwenAll = await pass(utts);
      console.log(
        [
          `threads ${THREADS}, load average ${loadBefore} before and ${load()} after`,
          `pending: ${utts.length} utterances, ${speech.toFixed(0)} s of speech in ${seconds((audio.length / ASR_RATE) * 1000)} s; the read takes the newest ${readSpeech.toFixed(0)} s (${read.length} utterances)`,
          `read waits: Parakeet ${seconds(parakeet)} s (all ${speech.toFixed(0)} s: ${seconds(parakeetAll)} s); Qwen ${qwenRead.map(seconds).join(" s and ")} s (all: ${seconds(qwenAll)} s)`,
        ].join("\n"),
      );
    } finally {
      await server.stop();
    }
  },
  1_200_000,
);
