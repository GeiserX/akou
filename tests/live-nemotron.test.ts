/**
 * ASR-4 against the real streaming Nemotron models, through the app's own live pipeline (causal
 * gain, one stream per channel, the line cutter): word error rate on public FLEURS clips, and how
 * long a word takes to show when the audio arrives in real time. Model-gated, so it never runs in
 * CI's test jobs and never downloads anything. It needs:
 *
 * - `AKOU_LIVE_MODELS`: a models folder with `nemotron-en-560`, `nemotron-3.5-560`,
 *   `nemotron-3.5-1120`, `silero-vad` and `titanet-small` (`akou models pull <id>` fetches each);
 * - `AKOU_FLEURS`: the FLEURS clips the nightly evaluation extracts (`scripts/eval/nightly.ts`
 *   `--only fleurs --data <dir>`), as `<dir>/fleurs/<config>/test.tsv` and `test/<id>.wav`.
 *
 *   AKOU_LIVE_MODELS=<models> AKOU_FLEURS=<data> bun test tests/live-nemotron.test.ts
 *
 * `AKOU_LIVE_CLIPS` sets how many clips per language (20). Run it on a machine that can take the
 * load: the latency test feeds audio at real time, about two minutes.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEURS, readWav } from "../scripts/eval/nightly.ts";
import { percentile, wer } from "../scripts/eval/score.ts";
import {
  ASR_RATE,
  type LiveEngine,
  type LiveStream,
  type LiveToken,
} from "../src/main/asr/engine.ts";
import { chooseLiveEngine, type LiveChoice } from "../src/main/asr/live-engines.ts";
import { tokenText } from "../src/main/asr/live-stream.ts";
import { type LiveOut, LivePipeline } from "../src/main/asr/live-worker.ts";
import { prepareSpan } from "../src/main/asr/pad.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";

const MODELS = process.env.AKOU_LIVE_MODELS;
const DATA = process.env.AKOU_FLEURS;
const CLIPS = Number(process.env.AKOU_LIVE_CLIPS ?? 20);
const LONG = 30 * 60_000;

/**
 * How far the pipeline may fall behind the engine decoding each clip whole: the benchmark's
 * tolerance. The benchmark's own figures (8.15 / 4.75) are number-normalized, which this scorer
 * is not, so the gate compares the pipeline with the same engine on the same clips and scorer.
 */
const TOLERANCE = 0.5;

/**
 * A call is one stream, and one stream over many utterances loses words that a fresh stream per
 * clip keeps: the first 40 English clips joined with 0.9 s of silence read 12.84 as one call,
 * against 8.05 run one call each (docs/research/asr-architecture.md section 3.1, the reference
 * Mac mini, this scorer). The joined case is gated at that figure plus the tolerance.
 */
const JOINED = { clips: 40, gapSeconds: 0.9, measured: 12.84 };

/** Clips joined into one clip, `gapSeconds` of silence between them, their references joined. */
function joined(set: readonly Clip[], gapSeconds: number): Clip {
  const gap = Math.round(gapSeconds * ASR_RATE);
  const samples = new Float32Array(
    set.reduce((n, c) => n + c.samples.length, 0) + gap * Math.max(0, set.length - 1),
  );
  let at = 0;
  for (const c of set) {
    samples.set(c.samples, at);
    at += c.samples.length + gap;
  }
  return { id: "joined", ref: set.map((c) => c.ref).join(" "), samples };
}

interface Clip {
  id: string;
  ref: string;
  samples: Float32Array;
}

/** The first `n` clips of the benchmark's FLEURS subset of a language. */
function clips(lang: "en" | "es", n: number): Clip[] {
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
  return ids.slice(0, n).map((id) => {
    const wav = join(dir, "test", `${id}.wav`);
    if (!existsSync(wav)) throw new Error(`${wav} is missing: run the nightly's FLEURS step first`);
    return { id, ref: refs.get(id) ?? "", samples: readWav(new Uint8Array(readFileSync(wav))) };
  });
}

const noSpeakers = { centroids: [], merges: [], unmerged: [], ids: [] };

function rig(): { models: SherpaModels; out: LiveOut[]; p: LivePipeline } {
  const models = new SherpaModels({
    dir: MODELS as string,
    cacheDir: join(MODELS as string, ".cache"),
    threads: 4,
    diarizer: "embeddings",
  });
  const out: LiveOut[] = [];
  const p = new LivePipeline(models, {}, (x) => out.push(x));
  return { models, out, p };
}

/** One clip as one call on the mic channel, fed as fast as the engine takes it. */
async function transcribe(r: ReturnType<typeof rig>, choice: LiveChoice, clip: Clip) {
  await r.p.beginCall({ ...noSpeakers, live: choice });
  const from = r.out.length;
  const audio = new Float32Array(clip.samples.length + ASR_RATE);
  audio.set(clip.samples);
  for (let at = 0; at < audio.length; at += 1600) {
    r.p.audio(1, "mic", at, audio.subarray(at, at + 1600), false);
  }
  await r.p.flush();
  return r.out
    .slice(from)
    .flatMap((o) => (o.type === "seg" ? [o.text] : []))
    .join(" ");
}

/** The engine on its own: the whole clip gained by `prepareSpan`, one stream, then a flush. */
function alone(models: SherpaModels, choice: LiveChoice, clip: Clip): string {
  const s = models.liveEngine(choice.engine).open(choice.lang);
  const x = prepareSpan(clip.samples);
  const toks: LiveToken[] = [];
  for (let at = 0; at < x.length; at += 1600) toks.push(...s.push(x.subarray(at, at + 1600)));
  toks.push(...s.flush());
  s.close();
  return tokenText(toks);
}

/** An engine whose streams lose every fifth token: what a pipeline that drops words looks like. */
function lossy(engine: LiveEngine): LiveEngine {
  let n = 0;
  const drop = (toks: LiveToken[]) => toks.filter(() => ++n % 5 !== 0);
  return {
    ...engine,
    open: (lang) => {
      const s = engine.open(lang);
      return { push: (x) => drop(s.push(x)), flush: () => drop(s.flush()), close: () => s.close() };
    },
  };
}

/** Records when each token came back, in wall-clock milliseconds. */
function timed(engine: LiveEngine, shown: { t: number; at: number }[]): LiveEngine {
  const wrap = (s: LiveStream): LiveStream => {
    const note = (toks: LiveToken[]) => {
      const at = performance.now();
      for (const k of toks) shown.push({ t: k.t, at });
      return toks;
    };
    return {
      push: (x) => note(s.push(x)),
      flush: () => note(s.flush()),
      close: () => s.close(),
    };
  };
  return {
    id: engine.id,
    tierMs: engine.tierMs,
    languages: engine.languages,
    open: (lang) => wrap(engine.open(lang)),
  };
}

/**
 * Seconds from when a word's audio reached the app to when the word showed, p50, with both
 * channels fed in 100 ms blocks at real time. `lateMs` holds each block back that much after its
 * audio was said: the failing control.
 */
async function shownLatency(clipsIn: Clip[], choice: LiveChoice, lateMs: number): Promise<number> {
  const r = rig();
  const shown: { t: number; at: number }[] = [];
  const real = r.models.liveEngine.bind(r.models);
  r.models.liveEngine = (id: string) => timed(real(id), shown);
  const delays: number[] = [];
  for (const clip of clipsIn) {
    shown.length = 0;
    await r.p.beginCall({ ...noSpeakers, live: choice });
    const audio = new Float32Array(clip.samples.length + ASR_RATE);
    audio.set(clip.samples);
    const start = performance.now();
    for (let at = 0; at < audio.length; at += 1600) {
      // The block ends at (at + 1600): it is complete, so said, then.
      const said = start + ((at + 1600) / ASR_RATE) * 1000;
      const wait = said + lateMs - performance.now();
      if (wait > 0) await Bun.sleep(wait);
      const block = audio.subarray(at, at + 1600);
      r.p.audio(1, "mic", at, block);
      r.p.audio(1, "call", at, block);
    }
    await r.p.flush();
    // Each word against the moment the audio at its time had been said.
    for (const s of shown) delays.push((s.at - (start + s.t * 1000)) / 1000);
  }
  return percentile(delays, 50);
}

if (!MODELS || !DATA) {
  test.skipIf(!MODELS || !DATA)(
    "[ASR-4] streaming Nemotron on FLEURS and at real time (skipped: needs AKOU_LIVE_MODELS and AKOU_FLEURS)",
    () => {},
  );
} else {
  describe("[ASR-4] streaming Nemotron through the live pipeline", () => {
    for (const lang of ["en", "es"] as const) {
      test(
        `${lang}: ${CLIPS} FLEURS clips through the pipeline within +${TOLERANCE} of the engine alone; a lossy stream fails that`,
        async () => {
          const choice = chooseLiveEngine("auto", [lang], () => true).choice as LiveChoice;
          const set = clips(lang, CLIPS);
          const r = rig();
          const whole = wer(set.map((c) => ({ ref: c.ref, hyp: alone(r.models, choice, c) })));
          const piped: { ref: string; hyp: string }[] = [];
          for (const c of set) piped.push({ ref: c.ref, hyp: await transcribe(r, choice, c) });
          const got = wer(piped);
          // Positive control: the same run through a stream that loses a fifth of its tokens.
          const bad = rig();
          const real = bad.models.liveEngine.bind(bad.models);
          bad.models.liveEngine = (id: string) => lossy(real(id));
          const lost: { ref: string; hyp: string }[] = [];
          for (const c of set) lost.push({ ref: c.ref, hyp: await transcribe(bad, choice, c) });
          console.log(
            `live ${choice.engine} ${lang}, ${set.length} clips: pipeline WER ${got.toFixed(2)}, engine alone ${whole.toFixed(2)}, lossy control ${wer(lost).toFixed(2)}`,
          );
          expect(got).toBeLessThanOrEqual(whole + TOLERANCE);
          expect(wer(lost)).toBeGreaterThan(whole + TOLERANCE);
        },
        LONG,
      );
    }

    test(
      `en: ${JOINED.clips} clips joined into one call, one stream, within ${JOINED.measured} + ${TOLERANCE}; a lossy stream fails that`,
      async () => {
        const choice = chooseLiveEngine("auto", ["en"], () => true).choice as LiveChoice;
        const call = joined(clips("en", JOINED.clips), JOINED.gapSeconds);
        const got = wer([{ ref: call.ref, hyp: await transcribe(rig(), choice, call) }]);
        // Positive control: the same call through a stream that loses a fifth of its tokens.
        const bad = rig();
        const real = bad.models.liveEngine.bind(bad.models);
        bad.models.liveEngine = (id: string) => lossy(real(id));
        const lost = wer([{ ref: call.ref, hyp: await transcribe(bad, choice, call) }]);
        console.log(
          `live ${choice.engine} en, ${JOINED.clips} clips as one call (${(call.samples.length / ASR_RATE / 60).toFixed(1)} min): WER ${got.toFixed(2)}, lossy control ${lost.toFixed(2)}, bound ${JOINED.measured + TOLERANCE}`,
        );
        expect(got).toBeLessThanOrEqual(JOINED.measured + TOLERANCE);
        expect(lost).toBeGreaterThan(JOINED.measured + TOLERANCE);
      },
      LONG,
    );

    test(
      "a word shows within 1 s at real time, and a feed held back 1.5 s fails that bound",
      async () => {
        const choice = chooseLiveEngine("auto", ["en"], () => true).choice as LiveChoice;
        const some = clips("en", 5);
        const p50 = await shownLatency(some, choice, 0);
        const late = await shownLatency(some.slice(0, 2), choice, 1500);
        console.log(
          `live ${choice.engine}: shown p50 ${p50.toFixed(2)} s; held back 1.5 s: ${late.toFixed(2)} s`,
        );
        expect(p50).toBeLessThan(1);
        expect(late).toBeGreaterThanOrEqual(1);
      },
      LONG,
    );
  });
}
