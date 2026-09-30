/**
 * DC-E7 against the real models: what `dictation.final` `live`, the default, gives up in accuracy
 * and saves in wait, next to `parakeet` and `qwen`. Each public FLEURS clip is one dictation, run
 * through the code the app runs for it: the live Worker's dictation stream (`openDictation`, its
 * audio in 0.1 s pieces, then the 250 ms post-roll of silence and the flush at the release), the
 * Worker's whole-buffer decode on Parakeet (`dictationSpans`, `decodeDictationSpan`), and Qwen3-ASR
 * on its llama-server as `best` asks it (`lang` auto, bounded by the dictation's languages). The
 * wait is the time from the release to the text: the flush for `live`, the decode for the others.
 * Two dictation setups: one language (the streaming model `auto` picks for it) and English with
 * Spanish (`nemotron-3.5-560`, which follows a switch). The failing control scores each clip's
 * `live` text against the next clip's reference: a harness that paired them wrong, or a scorer
 * that could not see errors, would not show it far worse. Model-gated, so it never runs in CI's
 * test jobs and never downloads anything. It needs what tests/live-upgrade-qwen.test.ts needs:
 *
 *   AKOU_LIVE_MODELS=<models> AKOU_FLEURS=<data> bun test tests/dictation-final-accuracy.test.ts
 *
 * `AKOU_LIVE_CLIPS` sets how many clips per language (20); `AKOU_LIVE_ACCEL` the llama-server
 * build (`metal`).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEURS, readWav } from "../scripts/eval/nightly.ts";
import { percentile, wer } from "../scripts/eval/score.ts";
import { ASR_RATE, type LiveToken } from "../src/main/asr/engine.ts";
import { chooseLiveEngine, type LiveChoice } from "../src/main/asr/live-engines.ts";
import { tokenText } from "../src/main/asr/live-stream.ts";
import { LivePipeline } from "../src/main/asr/live-worker.ts";
import { QWEN_ASR, QWEN_MMPROJ_FILE, QWEN_MODEL_FILE } from "../src/main/asr/llama-catalog.ts";
import { createLlamaServer, llamaBuild } from "../src/main/asr/llama-server.ts";
import { type Accelerator, hostPlatform, modelFile } from "../src/main/asr/models.ts";
import { QwenEngine } from "../src/main/asr/qwen.ts";
import { SherpaModels } from "../src/main/asr/sherpa.ts";

const MODELS = process.env.AKOU_LIVE_MODELS;
const DATA = process.env.AKOU_FLEURS;
const CLIPS = Number(process.env.AKOU_LIVE_CLIPS ?? 20);
const ACCEL = (process.env.AKOU_LIVE_ACCEL ?? "metal") as Accelerator;
const LONG = 60 * 60_000;
const READY = !!MODELS && !!DATA && existsSync(modelFile(MODELS, QWEN_ASR, QWEN_MODEL_FILE));
/** The helper's post-roll: the audio after the release that a session still records. */
const POST_ROLL = Math.round(0.25 * ASR_RATE);
/** The helper's audio packets, 0.1 s. */
const PIECE = ASR_RATE / 10;

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

/** One engine's texts for the clips, and its wait after each release, seconds. */
interface Run {
  hyps: string[];
  waits: number[];
}

const run = (): Run => ({ hyps: [], waits: [] });

let token = 0;

/** A dictation through the live Worker's stream, as a session feeds it: its text and the flush's wait. */
function liveDictation(
  p: LivePipeline,
  choice: LiveChoice,
  languages: readonly string[],
  samples: Float32Array,
): { text: string; wait: number } {
  const t = ++token;
  p.openDictation(t, choice, languages, false);
  const got: LiveToken[] = [];
  const audio = new Float32Array(samples.length + POST_ROLL);
  audio.set(samples);
  for (let at = 0; at < audio.length; at += PIECE)
    got.push(...p.dictationAudio(t, audio.subarray(at, at + PIECE)));
  const start = performance.now();
  got.push(...p.closeDictation(t, true));
  return { text: tokenText(got), wait: (performance.now() - start) / 1000 };
}

/**
 * A dictation's buffer on Parakeet: as the Worker's `decode` runs it, cut at the pauses its VAD
 * finds (`cut`), or the whole recording in one decode, the engine alone.
 */
function parakeetDictation(
  p: LivePipeline,
  samples: Float32Array,
  cut: boolean,
): { text: string; wait: number } {
  const audio = new Float32Array(samples.length + POST_ROLL);
  audio.set(samples);
  const start = performance.now();
  const texts: string[] = [];
  for (const span of cut ? p.dictationSpans(audio) : [{ from: 0, to: audio.length }]) {
    const r = p.decodeDictationSpan(audio, span);
    if (r.text !== "") texts.push(r.text);
  }
  return { text: texts.join(" "), wait: (performance.now() - start) / 1000 };
}

const fmt = (n: number) => n.toFixed(2);

if (!READY) {
  test.skipIf(!READY)(
    "[DC-E7] the accuracy and wait of each dictation.final on FLEURS (skipped: needs AKOU_LIVE_MODELS with Qwen, and AKOU_FLEURS)",
    () => {},
  );
} else {
  describe("[DC-E7] what each dictation.final costs, with the real models", () => {
    for (const lang of ["en", "es"] as const) {
      test(
        `${lang}: ${CLIPS} FLEURS clips as dictations; the shuffled control scores far worse`,
        async () => {
          const setups = [
            { name: "one language", languages: [lang] },
            { name: "English and Spanish", languages: ["en", "es"] },
          ].map((s) => ({
            ...s,
            choice: chooseLiveEngine("auto", s.languages, () => true).choice as LiveChoice,
          }));
          const models = new SherpaModels({
            dir: MODELS as string,
            cacheDir: join(MODELS as string, ".cache"),
            threads: 4,
            diarizer: "embeddings",
          });
          const p = new LivePipeline(models, {}, () => {});
          const all = clips(lang, CLIPS);
          const live = setups.map(() => run());
          const qwen = setups.map(() => run());
          const parakeet = run();
          const whole = run();
          /** Clips DC-E6's speech check hears nothing in: the app inserts nothing for them. */
          let unheard = 0;
          try {
            // One streaming model at a time over every clip, loaded first as the app's warm-up
            // loads it, so no row pays a model load in its wait.
            for (const [i, s] of setups.entries()) {
              p.warmDictation(s.choice, false);
              for (const clip of all) {
                const l = liveDictation(p, s.choice, s.languages, clip.samples);
                live[i]?.hyps.push(l.text);
                live[i]?.waits.push(l.wait);
              }
            }
            for (const clip of all) {
              const k = parakeetDictation(p, clip.samples, true);
              parakeet.hyps.push(k.text);
              parakeet.waits.push(k.wait);
              const w = parakeetDictation(p, clip.samples, false);
              whole.hyps.push(w.text);
              whole.waits.push(w.wait);
              if (!p.dictationSpeech(clip.samples).speech.includes(true)) unheard++;
            }
          } finally {
            p.stop();
            // Parakeet and Nemotron go before Qwen loads: the three together do not fit beside
            // what else this machine runs.
            await models.release();
          }
          const server = qwenServer();
          try {
            // Kept warm while dictation is on, as `best` keeps it: its load is no dictation's wait.
            const first = all[0] as Clip;
            await new QwenEngine({ id: QWEN_ASR, server, allowed: [lang] }).decode({
              samples: first.samples,
              lang: "auto",
              glossary: [],
            });
            for (const [i, s] of setups.entries()) {
              const engine = new QwenEngine({ id: QWEN_ASR, server, allowed: s.languages });
              for (const clip of all) {
                const audio = new Float32Array(clip.samples.length + POST_ROLL);
                audio.set(clip.samples);
                const start = performance.now();
                const h = await engine.decode({ samples: audio, lang: "auto", glossary: [] });
                qwen[i]?.hyps.push(h.text);
                qwen[i]?.waits.push((performance.now() - start) / 1000);
              }
            }
          } finally {
            await server.stop();
          }
          const score = (r: Run) => wer(all.map((c, i) => ({ ref: c.ref, hyp: r.hyps[i] ?? "" })));
          const line = (label: string, r: Run) =>
            `| ${lang} | ${label} | ${fmt(score(r))} | ${fmt(percentile(r.waits, 50))} / ${fmt(percentile(r.waits, 95))} |`;
          const rows = [
            ...setups.map((s, i) => line(`live, ${s.name} (${s.choice.engine})`, live[i] as Run)),
            line("parakeet, as the app cuts it at pauses", parakeet),
            line("parakeet, the whole recording in one decode", whole),
            ...setups.map((s, i) => line(`qwen, ${s.name}`, qwen[i] as Run)),
          ];
          // Each clip's live text against the next clip's reference.
          const control = wer(
            all.map((_, i) => ({
              ref: (all[(i + 1) % all.length] as Clip).ref,
              hyp: live[0]?.hyps[i] ?? "",
            })),
          );
          console.log(
            `${rows.join("\n")}\n| ${lang} | control: live text against the next clip's reference | ${fmt(control)} | |\n${lang}: the speech check hears nothing in ${unheard} of ${all.length} clips`,
          );
          const liveWer = score(live[0] as Run);
          expect(control).toBeGreaterThan(Math.max(80, 3 * liveWer));
          // Every engine heard the clips: none is near the control.
          for (const r of [...live, ...qwen, parakeet, whole])
            expect(score(r)).toBeLessThan(control / 2);
        },
        LONG,
      );
    }
  });
}
