/**
 * Nemotron 3 Diarization for real, on this machine only: the `akou-diarize` helper and the model
 * file. It runs when `AKOU_MODELS_DIR` holds the Nemotron file (checked against its pinned
 * SHA-256), the helper is found (`AKOU_DIARIZE_BIN`, else a release build in
 * `native/akou-diarize`, else PATH) and macOS `say` can generate speech; otherwise every test is
 * skipped and the reason is printed. CI never sets `AKOU_MODELS_DIR`, and nothing here downloads.
 *
 * `say` speaks four sentences in two voices, taking turns, into one 16 kHz channel. The final
 * diarizer (30.4 s latency) and the live stream (2.0 s latency, fed in 0.1 s pushes) must each
 * find two speakers, the same one for both sentences of a voice. The positive control is one voice
 * saying all four sentences: one speaker. Then the live pipeline itself (live-worker.ts) labels
 * the call lines through the real helper; its recognizer is a stand-in, since only the labels are
 * under test here (tests/integration/asr.local.test.ts runs the real recognizer).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiarizedSpan, ModelSet, SpeakerTurn } from "../../src/main/asr/engine.ts";
import { type LiveOut, LivePipeline } from "../../src/main/asr/live-worker.ts";
import { modelFile, NEMOTRON, NEMOTRON_FILE, verifyModels } from "../../src/main/asr/models.ts";
import {
  DIARIZE_HELPER_NAME,
  NemotronDiarizer,
  NemotronStream,
} from "../../src/main/asr/nemotron.ts";
import { FakeModels } from "../fixtures/asr-fake.ts";

const RATE = 16000;
const MODELS = process.env.AKOU_MODELS_DIR;
const BUILT = join(
  import.meta.dir,
  "..",
  "..",
  "native",
  "akou-diarize",
  "target",
  "release",
  DIARIZE_HELPER_NAME,
);
const HELPER =
  process.env.AKOU_DIARIZE_BIN ?? (existsSync(BUILT) ? BUILT : Bun.which(DIARIZE_HELPER_NAME));
const HAS_SAY = process.platform === "darwin" && spawnSync("which", ["say"]).status === 0;
const MODEL = MODELS ? modelFile(MODELS, NEMOTRON, NEMOTRON_FILE) : "";
const SKIP = !MODELS
  ? "AKOU_MODELS_DIR is not set"
  : !existsSync(MODEL)
    ? `${NEMOTRON}/${NEMOTRON_FILE} is not in AKOU_MODELS_DIR`
    : !HELPER
      ? "akou-diarize is not built (cargo build --release in native/akou-diarize) or set AKOU_DIARIZE_BIN"
      : !HAS_SAY
        ? "macOS `say` is not available to generate speech"
        : null;
if (SKIP) console.log(`diarize.local: skipped, ${SKIP}.`);

const work = mkdtempSync(join(tmpdir(), "akou-diarize-local-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function readMono(path: string): Float32Array {
  const b = new Uint8Array(readFileSync(path));
  const v = new DataView(b.buffer);
  let o = 12;
  while (o + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(o, o + 4));
    const size = v.getUint32(o + 4, true);
    if (id === "data") {
      const n = Math.floor(Math.min(size, b.length - o - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(o + 8 + i * 2, true) / 32768;
      return out;
    }
    o += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no data`);
}

/** `say` into a file, never the speakers. */
function say(text: string, voice: string): Float32Array {
  const out = join(work, `say-${Math.random().toString(36).slice(2)}.wav`);
  const r = spawnSync("say", ["-v", voice, "-o", out, "--data-format=LEI16@16000", text]);
  if (r.status !== 0) throw new Error(`say -v ${voice} failed: ${r.stderr}`);
  return readMono(out);
}

const SENTENCES = [
  "Good morning everyone, thanks for joining the weekly planning call today.",
  "Thanks. I finished the migration yesterday and the new cluster is already serving traffic.",
  "Great. Can you write down the steps so the rest of the team can repeat them next week?",
  "Sure, I will put the notes in the shared folder before lunch and send you the link.",
];

/** Sentences in turn, 0.8 s apart; returns the audio and where each sentence sits (seconds). */
function conversation(voices: string[]): { audio: Float32Array; at: [number, number][] } {
  const clips = SENTENCES.map((s, i) => say(s, voices[i % voices.length] as string));
  const gap = Math.round(0.8 * RATE);
  const total = clips.reduce((n, c) => n + c.length + gap, gap);
  const audio = new Float32Array(total);
  const at: [number, number][] = [];
  let o = gap;
  for (const c of clips) {
    audio.set(c, o);
    at.push([o / RATE, (o + c.length) / RATE]);
    o += c.length + gap;
  }
  return { audio, at };
}

/** The speaker active longest inside each sentence. */
function whoSpoke(turns: readonly DiarizedSpan[], at: readonly [number, number][]): number[] {
  return at.map(([a, b]) => {
    const cover = new Map<number, number>();
    for (const t of turns) {
      const o = Math.min(b, t.end) - Math.max(a, t.start);
      if (o > 0) cover.set(t.speaker, (cover.get(t.speaker) ?? 0) + o);
    }
    return [...cover.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? -1;
  });
}

const spec = () => ({ command: [HELPER as string], model: MODEL, threads: 2 });

describe.skipIf(!!SKIP)("Nemotron 3 Diarization, for real (needs the model, helper, `say`)", () => {
  test("the model on disk matches its pinned checksum", async () => {
    const bad = (await verifyModels(MODELS as string, [NEMOTRON])).filter((s) => s.state !== "ok");
    expect(bad).toEqual([]);
  }, 120_000);

  test("final: two voices taking turns are two speakers, each the same across its sentences", async () => {
    const { audio, at } = conversation(["Samantha", "Daniel"]);
    const t0 = performance.now();
    const turns = await new NemotronDiarizer(spec()).process(audio);
    const took = (performance.now() - t0) / 1000;
    const who = whoSpoke(turns, at);
    console.log(
      `diarize.local: final, ${(audio.length / RATE).toFixed(1)} s in ${took.toFixed(1)} s, speakers per sentence ${JSON.stringify(who)}, ${turns.length} turns`,
    );
    for (const t of turns)
      console.log(`  s${t.speaker} ${t.start.toFixed(2)}-${t.end.toFixed(2)} s`);
    expect(new Set(turns.map((t) => t.speaker)).size).toBe(2);
    expect(who[0]).toBe(who[2] as number);
    expect(who[1]).toBe(who[3] as number);
    expect(who[0]).not.toBe(who[1] as number);
  }, 120_000);

  test("positive control: one voice saying all four sentences is one speaker", async () => {
    const { audio } = conversation(["Samantha"]);
    const turns = await new NemotronDiarizer(spec()).process(audio);
    console.log(
      `diarize.local: one voice, speakers ${JSON.stringify([...new Set(turns.map((t) => t.speaker))])}`,
    );
    expect(new Set(turns.map((t) => t.speaker)).size).toBe(1);
  }, 120_000);

  test("live: the stream at 2.0 s finds the same two speakers, pushed 0.1 s at a time", async () => {
    const { audio, at } = conversation(["Samantha", "Daniel"]);
    const got: SpeakerTurn[] = [];
    const decided: number[] = [];
    const dead: string[] = [];
    const s = new NemotronStream(spec(), {
      turns: (t, d) => {
        got.push(...t);
        decided.push(d);
      },
      dead: (e) => dead.push(e),
    });
    try {
      for (let o = 0; o < audio.length; o += RATE / 10) s.push(audio.subarray(o, o + RATE / 10));
      await s.flush();
    } finally {
      s.close();
    }
    const turns = got.map((t) => ({
      speaker: t.speaker,
      start: t.start / RATE,
      end: t.end / RATE,
    }));
    const who = whoSpoke(turns, at);
    console.log(
      `diarize.local: live, ${decided.length} reports, last at ${((decided.at(-1) ?? 0) / RATE).toFixed(2)} s, speakers per sentence ${JSON.stringify(who)}`,
    );
    expect(dead).toEqual([]);
    expect(decided.at(-1)).toBe(audio.length);
    expect(new Set(turns.map((t) => t.speaker)).size).toBe(2);
    expect(who[0]).toBe(who[2] as number);
    expect(who[1]).toBe(who[3] as number);
    expect(who[0]).not.toBe(who[1] as number);
  }, 120_000);

  test("the live pipeline labels each call line through the real helper, across two parts", async () => {
    const { audio, at } = conversation(["Samantha", "Daniel"]);
    // The fakes' VAD and embedder, a recognizer that hears a word in anything, the real Nemotron.
    const models = new FakeModels({ diarizer: "nemotron" }) as FakeModels & ModelSet;
    const prepare = models.prepare.bind(models);
    models.prepare = (list) => {
      const p = prepare(list);
      return {
        ...p,
        recognizer: { model: "stand-in", kind: "transducer", decode: () => ({ text: "words" }) },
      };
    };
    models.streamDiarizer = (listener) => new NemotronStream(spec(), listener);
    const out: LiveOut[] = [];
    const p = new LivePipeline(models, {}, (o) => out.push(o));
    // Part 1 is the first two sentences, part 2 the rest: the stream must carry across.
    const cut = Math.round((at[1] as [number, number])[1] * RATE + 0.4 * RATE);
    const parts: [number, Float32Array][] = [
      [1, audio.subarray(0, cut)],
      [2, audio.subarray(cut)],
    ];
    try {
      for (const [part, x] of parts) {
        for (let o = 0; o < x.length; o += 1600) p.audio(part, "call", o, x.subarray(o, o + 1600));
        await p.endPart(part);
      }
    } finally {
      p.stop();
    }
    const segs = out.filter((o): o is Extract<LiveOut, { type: "seg" }> => o.type === "seg");
    console.log(
      `diarize.local: pipeline, ${segs.length} call lines: ${segs.map((x) => `p${x.part} ${x.a0.toFixed(1)}-${x.a1.toFixed(1)} ${x.spk}`).join(", ")}`,
    );
    const errors = out.filter((o) => o.type === "log" && o.level === "error");
    expect(errors).toEqual([]);
    expect(segs.length).toBeGreaterThanOrEqual(4);
    const labels = [...new Set(segs.map((x) => x.spk))].sort();
    expect(labels).toEqual(["c1", "c2"]);
    // The voice of part 1's first sentence is the voice of part 2's first (sentence 3).
    const inPart2 = segs.filter((x) => x.part === 2);
    expect(inPart2[0]?.spk).toBe(segs[0]?.spk as string);
  }, 120_000);
});
