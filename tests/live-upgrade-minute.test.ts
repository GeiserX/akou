/**
 * ASR-7, per-minute review against per-utterance review, with the real models. The FLEURS clips of
 * tests/live-upgrade-qwen.test.ts are joined into one call-length stream per language (1 s of
 * silence between clips), so minute windows are real. The live pipeline runs once per language on
 * the `upgrade` setup; the same closed utterances then go to Qwen two ways:
 *
 * - **per utterance** (#171): each utterance, as it closes, one request;
 * - **per minute**, as the host does it now: a minute after an utterance closes with no review
 *   armed, the utterances closed since the last review, whole, in requests of at most the cap
 *   (`reviewBatches`, joined by `joinUtterances`), their words cut back into every line of the
 *   request by the same `splitToLines`. What is left when the call's audio ends goes then.
 *
 * Qwen runs for real, one request at a time, on a fresh llama-server per cadence. Time is the
 * call's audio clock: a request is ready when its utterance closed (or at its minute), starts when
 * the server is free, and ends its measured decode time later; a queue past 6 drops its oldest, as
 * the per-utterance host did. `waited` counts requests that found Qwen still busy. It reports WER (stream, reviewed, and a reversed-words
 * control that must be worse than the stream), the delay from a word spoken to its reviewed text
 * (p50, p95), Qwen requests per minute, the GPU busy share (Qwen's decode time over the call's
 * length) and llama-server's peak memory footprint.
 *
 *   AKOU_LIVE_MODELS=<models> AKOU_FLEURS=<data> bun test tests/live-upgrade-minute.test.ts
 *
 * `AKOU_LIVE_CLIPS` (20) clips per language; `AKOU_MINUTE_CAP` (90) seconds of audio per request.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEURS, readWav } from "../scripts/eval/nightly.ts";
import { percentile, wer } from "../scripts/eval/score.ts";
import { ASR_RATE, type Hypothesis } from "../src/main/asr/engine.ts";
import { chooseLiveEngine, type LiveChoice } from "../src/main/asr/live-engines.ts";
import { type LiveOut, LivePipeline, type UpgradeOut } from "../src/main/asr/live-worker.ts";
import { QWEN_ASR, QWEN_MMPROJ_FILE, QWEN_MODEL_FILE } from "../src/main/asr/llama-catalog.ts";
import { createLlamaServer, llamaBuild } from "../src/main/asr/llama-server.ts";
import { type Accelerator, hostPlatform, modelFile } from "../src/main/asr/models.ts";
import { QwenEngine } from "../src/main/asr/qwen.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";
import { joinUtterances, reviewBatches, splitToLines } from "../src/main/asr/upgrade.ts";

const MODELS = process.env.AKOU_LIVE_MODELS;
const DATA = process.env.AKOU_FLEURS;
const CLIPS = Number(process.env.AKOU_LIVE_CLIPS ?? 20);
const CAP = Number(process.env.AKOU_MINUTE_CAP ?? 90);
const EVERY = 60;
const GAP = 1;
const ACCEL = (process.env.AKOU_LIVE_ACCEL ?? "metal") as Accelerator;
const LONG = 3 * 60 * 60_000;
/** The per-utterance host's queue: past this many waiting, the oldest kept the streaming text. */
const QUEUE_MAX = 6;
const READY = !!MODELS && !!DATA && existsSync(modelFile(MODELS, QWEN_ASR, QWEN_MODEL_FILE));

/** The first `n` FLEURS clips of a language joined into one stream, and the joined reference. */
function call(lang: "en" | "es", n: number): { ref: string; samples: Float32Array } {
  const set = FLEURS.sets[lang];
  const dir = join(DATA as string, "fleurs", set.config);
  const refs = new Map<string, string>();
  for (const line of readFileSync(join(dir, "test.tsv"), "utf8").split("\n")) {
    const c = line.split("\t");
    if (c[1]) refs.set(c[1].replace(/\.wav$/, ""), c[2] ?? "");
  }
  const ids = (
    JSON.parse(
      readFileSync(join(import.meta.dir, "..", "docs", "research", "asr-benchmark.json"), "utf8"),
    ) as { fleurs_ids: Record<string, string[]> }
  ).fleurs_ids[set.ids] as string[];
  const parts = ids
    .slice(0, n)
    .map((id) => readWav(new Uint8Array(readFileSync(join(dir, "test", `${id}.wav`)))));
  const gap = GAP * ASR_RATE;
  const samples = new Float32Array(parts.reduce((a, p) => a + p.length + gap, 0));
  let at = 0;
  for (const p of parts) {
    samples.set(p, at);
    at += p.length + gap;
  }
  return {
    ref: ids
      .slice(0, n)
      .map((id) => refs.get(id) ?? "")
      .join(" "),
    samples,
  };
}

const noSpeakers = { centroids: [], merges: [], unmerged: [], ids: [] };

function qwenServer() {
  const dir = MODELS as string;
  const platform = hostPlatform();
  const build = llamaBuild(platform, ACCEL);
  if (!build) throw new Error(`no ${ACCEL} llama-server build for ${platform}`);
  return createLlamaServer({
    kind: "llama-server",
    engine: QWEN_ASR,
    model: modelFile(dir, QWEN_ASR, QWEN_MODEL_FILE),
    mmproj: modelFile(dir, QWEN_ASR, QWEN_MMPROJ_FILE),
    accelerator: ACCEL,
    build: {
      dir: join(dir, build.id),
      archives: build.files.map((f) => modelFile(dir, build.id, f.name)),
      platform,
    },
  });
}

/** A closed utterance and the call time (s) it closed at. */
interface Utt {
  at: number;
  u: UpgradeOut;
  samples: Float32Array;
}

/** One Qwen request: its utterances and when it may start (s). */
interface Req {
  ready: number;
  utts: Utt[];
}

/** Each utterance alone, when it closes. */
function perUtterance(utts: readonly Utt[]): Req[] {
  return utts.map((x) => ({ ready: x.at, utts: [x] }));
}

/**
 * The host's rule: `every` seconds after an utterance closes with no review armed, the utterances
 * closed by then, whole, in requests of at most `cap` seconds of audio; what is left at `end` goes
 * then.
 */
function perMinute(utts: readonly Utt[], every: number, cap: number, end: number): Req[] {
  const out: Req[] = [];
  let i = 0;
  while (i < utts.length) {
    const tick = Math.min((utts[i] as Utt).at + every, end);
    const due: Utt[] = [];
    while (i < utts.length && (utts[i] as Utt).at <= tick) due.push(utts[i++] as Utt);
    for (const b of reviewBatches(due, cap)) out.push({ ready: tick, utts: b });
  }
  return out;
}

/** llama-server's physical footprint in bytes, from `footprint`. */
function footprint(pid: number): number {
  const r = spawnSync("footprint", [String(pid)], { encoding: "utf8" });
  const m = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)/.exec(r.stdout ?? "");
  if (!m) return 0;
  const k = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2] as "B"];
  return Number(m[1]) * k;
}

interface Line {
  a0: number;
  a1: number;
  stream: string;
  qwen: string;
  control: string;
}

interface Result {
  wer: number;
  control: number;
  delays: number[];
  requests: number;
  asks: number;
  busy: number;
  dropped: number;
  waited: number;
  peakMb: number;
  decodeS: number[];
}

/** Runs the requests through a fresh Qwen, one at a time, on the call's clock. */
async function review(
  lang: "en" | "es",
  reqs: readonly Req[],
  segs: ReadonlyMap<number, Line>,
  ref: string,
  seconds: number,
): Promise<Result> {
  const lines = new Map([...segs].map(([k, l]) => [k, { ...l }]));
  const server = qwenServer();
  let asks = 0;
  const counted = {
    url: () => {
      asks++;
      return server.url();
    },
    restart: () => server.restart(),
  };
  const qwen = new QwenEngine({ id: QWEN_ASR, server: counted, allowed: [lang] });
  await server.url();
  // A warm-up request, not counted: Metal compiles its kernels on the first one.
  await qwen.decode({ samples: new Float32Array(ASR_RATE), lang, glossary: [] });
  asks = 0;
  let peak = 0;
  const pid = server.pid();
  const sample = setInterval(() => {
    if (pid) peak = Math.max(peak, footprint(pid));
  }, 500);
  const delays: number[] = [];
  const decodeS: number[] = [];
  let dropped = 0;
  let waited = 0;
  let now = 0;
  let i = 0;
  const q: Req[] = [];
  try {
    while (i < reqs.length || q.length > 0) {
      if (q.length === 0) now = Math.max(now, (reqs[i] as Req).ready);
      while (i < reqs.length && (reqs[i] as Req).ready <= now) {
        q.push(reqs[i++] as Req);
        if (q.length > QUEUE_MAX) {
          dropped++;
          q.shift();
        }
      }
      const job = q.shift() as Req;
      if (now > job.ready) waited++;
      const t = performance.now();
      const samples = joinUtterances(job.utts.map((x) => x.samples));
      const h = await qwen.decode({ samples, lang, glossary: [] });
      const d = (performance.now() - t) / 1000;
      decodeS.push(d);
      now += d;
      const keys = job.utts.flatMap((x) => x.u.keys);
      const texts = job.utts.flatMap((x) => x.u.lines);
      const apply = (k: "qwen" | "control", hyp: Hypothesis) => {
        const words = hyp.words.length > 0 ? hyp.words.map((x) => x.w) : hyp.text.split(/\s+/);
        const parts = splitToLines(
          texts,
          words.filter((x) => x !== ""),
        );
        keys.forEach((key, j) => {
          const cur = lines.get(key);
          if (cur && parts[j]) cur[k] = parts[j] as string;
        });
      };
      apply("qwen", h);
      apply("control", { ...h, words: [...h.words].reverse() });
      for (const key of keys) {
        const l = lines.get(key);
        if (!l) continue;
        const n = l.stream.split(/\s+/).filter(Boolean).length;
        for (let w = 0; w < n; w++) delays.push(now - (l.a0 + ((w + 0.5) / n) * (l.a1 - l.a0)));
      }
    }
  } finally {
    clearInterval(sample);
    if (pid) peak = Math.max(peak, footprint(pid));
    await server.stop();
  }
  const all = [...lines.values()];
  const text = (k: keyof Line) => all.map((l) => l[k]).join(" ");
  return {
    wer: wer([{ ref, hyp: text("qwen") }]),
    control: wer([{ ref, hyp: text("control") }]),
    delays,
    requests: decodeS.length,
    asks,
    busy: decodeS.reduce((a, b) => a + b, 0) / seconds,
    dropped,
    waited,
    peakMb: peak / 1024 ** 2,
    decodeS,
  };
}

if (!READY) {
  test.skipIf(!READY)(
    "[ASR-7] per-minute review against per-utterance review on FLEURS with the real models (skipped: needs AKOU_LIVE_MODELS with Qwen, and AKOU_FLEURS)",
    () => {},
  );
} else {
  describe("[ASR-7] per-minute review against per-utterance review with the real models", () => {
    for (const lang of ["en", "es"] as const) {
      test(
        `${lang}: ${CLIPS} FLEURS clips joined into one call`,
        async () => {
          const choice = chooseLiveEngine("auto", [lang], () => true).choice as LiveChoice;
          const models = new SherpaModels({
            dir: MODELS as string,
            cacheDir: join(MODELS as string, ".cache"),
            threads: 4,
            diarizer: "embeddings",
          });
          const { ref, samples } = call(lang, CLIPS);
          const seconds = samples.length / ASR_RATE;
          let pos = 0;
          const segs = new Map<number, Line>();
          const utts: Utt[] = [];
          const p = new LivePipeline(models, {}, (o: LiveOut) => {
            if (o.type === "log" && o.level === "error") throw new Error(o.msg);
            if (o.type === "seg" && o.key !== undefined) {
              segs.set(o.key, {
                a0: o.a0,
                a1: o.a1,
                stream: o.text,
                qwen: o.text,
                control: o.text,
              });
            }
            if (o.type === "upgrade") utts.push({ at: pos / ASR_RATE, u: o, samples: o.samples });
          });
          p.setDecodeList(null, 0);
          try {
            await p.beginCall({ ...noSpeakers, live: choice, upgrade: true });
            const audio = new Float32Array(samples.length + ASR_RATE);
            audio.set(samples);
            for (let at = 0; at < audio.length; at += 1600) {
              pos = Math.min(audio.length, at + 1600);
              p.audio(1, "mic", at, audio.subarray(at, at + 1600), false);
            }
            await p.flush();
          } finally {
            p.stop();
          }
          const stream = wer([
            {
              ref,
              hyp: [...segs.values()].map((l) => l.stream).join(" "),
            },
          ]);
          const utt = await review(lang, perUtterance(utts), segs, ref, seconds);
          const min = await review(
            lang,
            perMinute(utts, EVERY, CAP, audioEnd(seconds)),
            segs,
            ref,
            seconds,
          );
          const row = (name: string, r: Result) =>
            `${name}: WER ${r.wer.toFixed(2)} (reversed control ${r.control.toFixed(2)}); delay p50 ${percentile(r.delays, 50).toFixed(1)} s, p95 ${percentile(r.delays, 95).toFixed(1)} s; ${((r.requests * 60) / seconds).toFixed(2)} requests/min (${r.asks} asks for ${r.requests}); GPU busy ${(100 * r.busy).toFixed(1)} %; decode p50 ${percentile(r.decodeS, 50).toFixed(2)} s, max ${Math.max(...r.decodeS).toFixed(2)} s; dropped ${r.dropped}, waited ${r.waited}; llama-server peak ${r.peakMb.toFixed(0)} MB`;
          console.log(
            [
              `minute-review ${choice.engine} ${lang}: ${CLIPS} clips, ${(seconds / 60).toFixed(1)} min, ${utts.length} utterances, cap ${CAP} s`,
              `  stream alone: WER ${stream.toFixed(2)}`,
              `  ${row("per utterance", utt)}`,
              `  ${row("per minute", min)}`,
            ].join("\n"),
          );
          expect(utt.control).toBeGreaterThan(stream);
          expect(min.control).toBeGreaterThan(stream);
        },
        LONG,
      );
    }
  });
}

/** The call's end on its clock: the joined audio plus the 1 s the test feeds after it. */
function audioEnd(seconds: number): number {
  return seconds + 1;
}
