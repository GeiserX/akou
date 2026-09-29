/**
 * ASR-7 against the real models: public FLEURS clips through the live pipeline on the `upgrade`
 * setup, each utterance decoded by Parakeet in the pipeline and then by the vote of Qwen and
 * Parakeet, and cut back into its lines, as the host does it. It reports the word error rate of
 * each stage and how long each rewrite takes. Model-gated, so it never runs in CI's test jobs and
 * never downloads anything.
 * It needs:
 *
 * - `AKOU_LIVE_MODELS`: a models folder with `nemotron-en-560`, `nemotron-3.5-1120`,
 *   `parakeet-tdt-0.6b-v3-fp32`, `silero-vad`, `titanet-small`, `qwen3-asr-1.7b` and the
 *   llama-server build for this machine (`akou models pull best` fetches Qwen and the build);
 * - `AKOU_FLEURS`: the FLEURS clips of the nightly evaluation, as for tests/live-nemotron.test.ts.
 *
 *   AKOU_LIVE_MODELS=<models> AKOU_FLEURS=<data> bun test tests/live-upgrade-qwen.test.ts
 *
 * `AKOU_LIVE_CLIPS` sets how many clips per language (20); `AKOU_LIVE_ACCEL` the llama-server
 * build (`metal`).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEURS, readWav } from "../scripts/eval/nightly.ts";
import { percentile, wer } from "../scripts/eval/score.ts";
import { ASR_RATE, type Hypothesis } from "../src/main/asr/engine.ts";
import { chooseLiveEngine, type LiveChoice } from "../src/main/asr/live-engines.ts";
import { type LiveOut, LivePipeline } from "../src/main/asr/live-worker.ts";
import { QWEN_ASR, QWEN_MMPROJ_FILE, QWEN_MODEL_FILE } from "../src/main/asr/llama-catalog.ts";
import { createLlamaServer, llamaBuild } from "../src/main/asr/llama-server.ts";
import { type Accelerator, hostPlatform, modelFile } from "../src/main/asr/models.ts";
import { QwenEngine } from "../src/main/asr/qwen.ts";
import { RoverFuser } from "../src/main/asr/rover.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";
import { splitToLines } from "../src/main/asr/upgrade.ts";

const MODELS = process.env.AKOU_LIVE_MODELS;
const DATA = process.env.AKOU_FLEURS;
const CLIPS = Number(process.env.AKOU_LIVE_CLIPS ?? 20);
const ACCEL = (process.env.AKOU_LIVE_ACCEL ?? "metal") as Accelerator;
const LONG = 60 * 60_000;
const READY = !!MODELS && !!DATA && existsSync(modelFile(MODELS, QWEN_ASR, QWEN_MODEL_FILE));

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
    return { id, ref: refs.get(id) ?? "", samples: readWav(new Uint8Array(readFileSync(wav))) };
  });
}

const noSpeakers = { centroids: [], merges: [], unmerged: [], ids: [] };

/** Qwen on the llama-server build this machine pulled. */
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

interface Stages {
  stream: string;
  parakeet: string;
  vote: string;
  /** The vote with Qwen's words in reverse order: the failing control. */
  control: string;
}

if (!READY) {
  test.skipIf(!READY)(
    "[ASR-7] the in-call upgrade on FLEURS with the real models (skipped: needs AKOU_LIVE_MODELS with Qwen, and AKOU_FLEURS)",
    () => {},
  );
} else {
  describe("[ASR-7] the in-call upgrade with the real models", () => {
    for (const lang of ["en", "es"] as const) {
      test(
        `${lang}: ${CLIPS} FLEURS clips; the vote of Qwen and Parakeet beats the stream, and a scrambled Qwen fails that`,
        async () => {
          const choice = chooseLiveEngine("auto", [lang], () => true).choice as LiveChoice;
          const models = new SherpaModels({
            dir: MODELS as string,
            cacheDir: join(MODELS as string, ".cache"),
            threads: 4,
            diarizer: "embeddings",
          });
          const out: { o: LiveOut; at: number }[] = [];
          const p = new LivePipeline(models, {}, (o) => out.push({ o, at: performance.now() }));
          // Parakeet loads now, as the app loads it with the call's decode list, not on the first line.
          p.setDecodeList(null, 0);
          const server = qwenServer();
          const qwen = new QwenEngine({ id: QWEN_ASR, server, allowed: [lang] });
          const fuser = new RoverFuser("rover-conf");
          const rows: (Stages & { ref: string })[] = [];
          const parakeetS: number[] = [];
          const qwenS: number[] = [];
          try {
            for (const clip of clips(lang, CLIPS)) {
              await p.beginCall({ ...noSpeakers, live: choice, upgrade: true });
              const from = out.length;
              const audio = new Float32Array(clip.samples.length + ASR_RATE);
              audio.set(clip.samples);
              for (let at = 0; at < audio.length; at += 1600) {
                p.audio(1, "mic", at, audio.subarray(at, at + 1600), false);
              }
              await p.flush();
              const mine = out.slice(from);
              // Each line's text after each stage, as the host writes it: a line that gets no
              // words from a stage keeps the text it had.
              const texts = new Map<number, Stages>();
              let segAt = 0;
              for (const { o, at } of mine) {
                if (o.type === "log" && o.level === "error") throw new Error(o.msg);
                if (o.type === "seg" && o.key !== undefined) {
                  texts.set(o.key, { stream: o.text, parakeet: o.text, vote: "", control: "" });
                  segAt = at;
                }
                if (o.type !== "upgrade") continue;
                parakeetS.push((at - segAt) / 1000);
                const apply = (k: keyof Stages, h: Hypothesis) => {
                  const parts = splitToLines(
                    o.lines,
                    h.words.map((x) => x.w),
                  );
                  o.keys.forEach((key, j) => {
                    const cur = texts.get(key);
                    if (cur && parts[j]) cur[k] = parts[j] as string;
                  });
                };
                const pk: Hypothesis = { engine: o.model, text: o.text, words: o.words, ms: 0 };
                apply("parakeet", pk);
                for (const key of o.keys) {
                  const cur = texts.get(key);
                  if (cur) cur.vote = cur.control = cur.parakeet;
                }
                const t = performance.now();
                const q = await qwen.decode({ samples: o.samples, lang, glossary: [] });
                qwenS.push((performance.now() - t) / 1000);
                apply("vote", fuser.fuseSync([q, pk]));
                apply("control", fuser.fuseSync([{ ...q, words: [...q.words].reverse() }, pk]));
              }
              const stages: Stages = { stream: "", parakeet: "", vote: "", control: "" };
              for (const k of Object.keys(stages) as (keyof Stages)[]) {
                stages[k] = [...texts.values()].map((x) => x[k] || x.parakeet).join(" ");
              }
              rows.push({ ref: clip.ref, ...stages });
            }
          } finally {
            await server.stop();
            p.stop();
          }
          const w = (k: keyof Stages) => wer(rows.map((r) => ({ ref: r.ref, hyp: r[k] })));
          console.log(
            `upgrade ${choice.engine} ${lang}, ${rows.length} clips: WER stream ${w("stream").toFixed(2)}, Parakeet ${w("parakeet").toFixed(2)}, vote ${w("vote").toFixed(2)}; scrambled-Qwen control ${w("control").toFixed(2)}; Parakeet rewrite p50 ${percentile(parakeetS, 50).toFixed(2)} s (p95 ${percentile(parakeetS, 95).toFixed(2)}), Qwen p50 ${percentile(qwenS, 50).toFixed(2)} s (p95 ${percentile(qwenS, 95).toFixed(2)})`,
          );
          expect(w("vote")).toBeLessThan(w("stream"));
          expect(w("control")).toBeGreaterThan(w("stream"));
        },
        LONG,
      );
    }
  });
}
