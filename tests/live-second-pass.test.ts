/**
 * The second pass (`asr.review.model`), with the real models: streaming Nemotron alone, against
 * Parakeet and against Qwen reviewing the closed utterances every `AKOU_REVIEW_EVERY` seconds.
 * The FLEURS clips are joined into one call-length stream per language (1 s of silence between
 * clips), as in tests/live-upgrade-minute.test.ts, and the live pipeline runs once per language.
 *
 * The same closed utterances then go to each reviewer by the host's rule: `every` seconds after an
 * utterance closes with no review armed, the utterances closed by then, whole, in requests of at
 * most `reviewCap(every)` seconds of audio (`reviewBatches`, joined by `joinUtterances`), each
 * request's words cut back into its lines by `splitToLines`. Utterances whose review would come
 * after the call's audio has ended are never reviewed, as in the app: the final pass covers them.
 *
 * - **Parakeet** decodes a request on the live pipeline's own recognizer two ways: each utterance
 *   alone (`decodeUtterance`, what the app does), and, for comparison, the joined request cut at
 *   pauses into spans of at most 30 s by the dictation VAD (`dictationSpans`), which read worse
 *   than the stream alone.
 * - **Qwen** decodes it on a fresh llama-server.
 *
 * Time is the call's audio clock: a request is ready at its tick, starts when its reviewer is
 * free, and ends its measured decode time later. It reports WER (stream, reviewed, and a
 * reversed-words control that must be worse than the stream), the delay from a word spoken to its
 * reviewed text (p50, p95), the reviewer's busy share (decode time over the call's length), for
 * Parakeet the CPU cores it used on average, and the memory it added: for Qwen llama-server's peak
 * physical footprint, for Parakeet the growth of this process's resident memory over the pass.
 *
 *   AKOU_LIVE_MODELS=<models> AKOU_FLEURS=<data> AKOU_LIVE_CLIPS=150 AKOU_REVIEW_EVERY=60,120 \
 *     bun test tests/live-second-pass.test.ts
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEURS, readWav } from "../scripts/eval/nightly.ts";
import { percentile, wer } from "../scripts/eval/score.ts";
import { ASR_RATE } from "../src/main/asr/engine.ts";
import { chooseLiveEngine, type LiveChoice } from "../src/main/asr/live-engines.ts";
import { type LiveOut, LivePipeline, type UpgradeOut } from "../src/main/asr/live-worker.ts";
import { QWEN_ASR, QWEN_MMPROJ_FILE, QWEN_MODEL_FILE } from "../src/main/asr/llama-catalog.ts";
import { createLlamaServer, llamaBuild } from "../src/main/asr/llama-server.ts";
import { type Accelerator, hostPlatform, modelFile } from "../src/main/asr/models.ts";
import { QwenEngine } from "../src/main/asr/qwen.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";
import { joinUtterances, reviewBatches, reviewCap, splitToLines } from "../src/main/asr/upgrade.ts";

const MODELS = process.env.AKOU_LIVE_MODELS;
const DATA = process.env.AKOU_FLEURS;
const CLIPS = Number(process.env.AKOU_LIVE_CLIPS ?? 20);
const EVERY = (process.env.AKOU_REVIEW_EVERY ?? "60,120").split(",").map(Number);
const LANGS = (process.env.AKOU_REVIEW_LANGS ?? "en,es").split(",") as ("en" | "es")[];
const GAP = 1;
const ACCEL = (process.env.AKOU_LIVE_ACCEL ?? "metal") as Accelerator;
const LONG = 6 * 60 * 60_000;
/** The recognizer's threads: `asr.threads`, 2 by default in the app. */
const THREADS = Number(process.env.AKOU_LIVE_THREADS ?? 2);
/** `parakeet` measures Parakeet's pass alone, without Qwen. */
const ONLY = process.env.AKOU_REVIEW_ONLY ?? "";
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

/** One review request: its utterances and when it may start (s). */
interface Req {
  ready: number;
  utts: Utt[];
}

/**
 * The host's rule: `every` seconds after an utterance closes with no review armed, the utterances
 * closed by then, whole, in requests of at most `reviewCap(every)`. A tick past `end` never comes:
 * the call has ended.
 */
function ticks(utts: readonly Utt[], every: number, end: number): Req[] {
  const out: Req[] = [];
  let i = 0;
  while (i < utts.length) {
    const tick = (utts[i] as Utt).at + every;
    const due: Utt[] = [];
    while (i < utts.length && (utts[i] as Utt).at <= tick) due.push(utts[i++] as Utt);
    if (tick > end) break;
    for (const b of reviewBatches(due, reviewCap(every))) out.push({ ready: tick, utts: b });
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
  reviewed: string;
  control: string;
}

interface Result {
  wer: number;
  control: number;
  delays: number[];
  requests: number;
  reviewedUtts: number;
  busy: number;
  cores: number;
  waited: number;
  memMb: number;
  decodeS: number[];
}

/** What decodes one request, from its utterances' audio: its words. */
type Decoder = (parts: readonly Float32Array[], lang: "en" | "es") => Promise<string[]>;

/** Runs the requests through one reviewer, one at a time, on the call's clock. */
async function review(
  reqs: readonly Req[],
  segs: ReadonlyMap<number, Line>,
  ref: string,
  seconds: number,
  lang: "en" | "es",
  decode: Decoder,
): Promise<Omit<Result, "memMb">> {
  const lines = new Map([...segs].map(([k, l]) => [k, { ...l }]));
  const delays: number[] = [];
  const decodeS: number[] = [];
  let cpu = 0;
  let waited = 0;
  let now = 0;
  for (const job of reqs) {
    if (now > job.ready) waited++;
    now = Math.max(now, job.ready);
    const t = performance.now();
    const c0 = process.cpuUsage();
    const words = await decode(
      job.utts.map((x) => x.samples),
      lang,
    );
    const c1 = process.cpuUsage(c0);
    cpu += (c1.user + c1.system) / 1e6;
    const d = (performance.now() - t) / 1000;
    decodeS.push(d);
    now += d;
    const keys = job.utts.flatMap((x) => x.u.keys);
    const texts = job.utts.flatMap((x) => x.u.lines);
    const apply = (k: "reviewed" | "control", ws: string[]) => {
      const parts = splitToLines(texts, ws);
      keys.forEach((key, j) => {
        const cur = lines.get(key);
        const text = (parts[j] ?? "").trim();
        if (cur && text !== "") cur[k] = text;
      });
    };
    apply("reviewed", words);
    apply("control", [...words].reverse());
    for (const key of keys) {
      const l = lines.get(key);
      if (!l) continue;
      const n = l.stream.split(/\s+/).filter(Boolean).length;
      for (let w = 0; w < n; w++) delays.push(now - (l.a0 + ((w + 0.5) / n) * (l.a1 - l.a0)));
    }
  }
  const all = [...lines.values()];
  const text = (k: keyof Line) => all.map((l) => l[k]).join(" ");
  const busy = decodeS.reduce((a, b) => a + b, 0);
  return {
    wer: wer([{ ref, hyp: text("reviewed") }]),
    control: wer([{ ref, hyp: text("control") }]),
    delays,
    requests: decodeS.length,
    reviewedUtts: reqs.reduce((a, r) => a + r.utts.length, 0),
    busy: busy / seconds,
    cores: cpu / seconds,
    waited,
    decodeS,
  };
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w !== "");
}

if (!READY) {
  test.skipIf(!READY)(
    "[ASR-7] the second pass, Parakeet against Qwen, on FLEURS with the real models (skipped: needs AKOU_LIVE_MODELS with Qwen, and AKOU_FLEURS)",
    () => {},
  );
} else {
  describe("[ASR-7] the second pass, Parakeet against Qwen, with the real models", () => {
    for (const lang of LANGS) {
      test(
        `${lang}: ${CLIPS} FLEURS clips joined into one call, every ${EVERY.join(" and ")} s`,
        async () => {
          const choice = chooseLiveEngine("auto", [lang], () => true).choice as LiveChoice;
          const models = new SherpaModels({
            dir: MODELS as string,
            cacheDir: join(MODELS as string, ".cache"),
            threads: THREADS,
            diarizer: "embeddings",
          });
          const { ref, samples } = call(lang, CLIPS);
          const seconds = samples.length / ASR_RATE;
          // The call's end on its clock: the joined audio plus the 1 s fed after it.
          const end = seconds + 1;
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
                reviewed: o.text,
                control: o.text,
              });
            }
            if (o.type === "upgrade") utts.push({ at: pos / ASR_RATE, u: o, samples: o.samples });
          });
          p.setDecodeList(null, 0);
          const rows: string[] = [];
          const stream = () =>
            wer([{ ref, hyp: [...segs.values()].map((l) => l.stream).join(" ") }]);
          const results: Result[] = [];
          const row = (name: string, r: Result) =>
            `${name}: WER ${r.wer.toFixed(2)} (reversed control ${r.control.toFixed(2)}); delay p50 ${percentile(r.delays, 50).toFixed(1)} s, p95 ${percentile(r.delays, 95).toFixed(1)} s; ${r.requests} requests (${r.reviewedUtts} of ${utts.length} utterances); busy ${(100 * r.busy).toFixed(1)} %, ${r.cores.toFixed(2)} cores; decode p50 ${percentile(r.decodeS, 50).toFixed(2)} s, max ${Math.max(0, ...r.decodeS).toFixed(2)} s; waited ${r.waited}; memory ${r.memMb.toFixed(0)} MB`;
          try {
            await p.beginCall({ ...noSpeakers, live: choice, upgrade: true });
            const audio = new Float32Array(samples.length + ASR_RATE);
            audio.set(samples);
            for (let at = 0; at < audio.length; at += 1600) {
              pos = Math.min(audio.length, at + 1600);
              p.audio(1, "mic", at, audio.subarray(at, at + 1600), false);
            }
            await p.flush();
            // Parakeet on the joined request cut at pauses into spans of at most 30 s, as a
            // dictation is: the comparison.
            const spans: Decoder = async (parts) => {
              const s = joinUtterances(parts);
              const out: string[] = [];
              for (const span of p.dictationSpans(s))
                out.push(...words(p.decodeDictationSpan(s, span).text));
              return out;
            };
            // Each utterance of the request decoded alone (at most 30 s each), as the app does.
            let slowest = 0;
            const each: Decoder = async (parts) =>
              parts.flatMap((s) => {
                const r = p.decodeUtterance(s);
                slowest = Math.max(slowest, r.ms);
                return words(r.text);
              });
            const parakeets: [string, Decoder][] = [
              ["Parakeet (pause-cut spans)", spans],
              ["Parakeet (each utterance)", each],
            ];
            for (const every of EVERY) {
              const reqs = ticks(utts, every, end);
              for (const [name, decode] of parakeets) {
                const rss0 = process.memoryUsage().rss;
                let rss = rss0;
                const sample = setInterval(() => {
                  rss = Math.max(rss, process.memoryUsage().rss);
                }, 200);
                const pk = await review(reqs, segs, ref, seconds, lang, decode);
                clearInterval(sample);
                const pr: Result = { ...pk, memMb: (rss - rss0) / 1024 ** 2 };
                results.push(pr);
                rows.push(`  ${row(`${name} every ${every} s (cap ${reviewCap(every)} s)`, pr)}`);
              }
            }
            rows.push(
              `  Parakeet at ${THREADS} threads: the slowest single utterance held the Worker ${slowest.toFixed(0)} ms`,
            );
          } finally {
            p.stop();
          }
          for (const every of ONLY === "parakeet" ? [] : EVERY) {
            const reqs = ticks(utts, every, end);
            const server = qwenServer();
            const qwen = new QwenEngine({ id: QWEN_ASR, server, allowed: [lang] });
            await server.url();
            // A warm-up request, not counted: Metal compiles its kernels on the first one.
            await qwen.decode({ samples: new Float32Array(ASR_RATE), lang, glossary: [] });
            let peak = 0;
            const pid = server.pid();
            const sample = setInterval(() => {
              if (pid) peak = Math.max(peak, footprint(pid));
            }, 500);
            try {
              const q = await review(reqs, segs, ref, seconds, lang, async (parts) => {
                const h = await qwen.decode({ samples: joinUtterances(parts), lang, glossary: [] });
                return h.words.length > 0 ? h.words.map((w) => w.w) : words(h.text);
              });
              if (pid) peak = Math.max(peak, footprint(pid));
              const qr: Result = { ...q, memMb: peak / 1024 ** 2 };
              results.push(qr);
              rows.push(`  ${row(`Qwen every ${every} s (cap ${reviewCap(every)} s)`, qr)}`);
            } finally {
              clearInterval(sample);
              await server.stop();
            }
          }
          const s = stream();
          console.log(
            [
              `second-pass ${choice.engine} ${lang}: ${CLIPS} clips, ${(seconds / 60).toFixed(1)} min, ${utts.length} utterances`,
              `  stream alone: WER ${s.toFixed(2)}`,
              ...rows,
            ].join("\n"),
          );
          for (const r of results) expect(r.control).toBeGreaterThan(s);
        },
        LONG,
      );
    }
  });
}
