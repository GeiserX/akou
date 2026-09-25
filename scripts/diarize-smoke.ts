/**
 * Runs the real `akou-diarize` on the real Nemotron model over a generated conversation, in both
 * modes, the way the app does (src/main/asr/nemotron.ts). Two synthetic voices say four sentences
 * in turn (tests/fixtures/two-voices.wav, made by scripts/two-voices.sh); each mode must find
 * turns, give the two sentences of a voice the same speaker and the two voices different ones,
 * and live mode must answer for every sample. So a helper whose ONNX Runtime loads but infers
 * nothing, or nonsense, exits 1. The local integration test (tests/integration/diarize.local.test.ts)
 * does the same with `say` on a Mac.
 *
 *   bun scripts/diarize-smoke.ts <akou-diarize> <nemotron3_diar_v3.onnx> [speech.wav]
 *
 * `speech.wav` (with its `.json` beside it) replaces the fixture: one voice saying all four
 * sentences is the positive control, which must fail.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpeakerTurn } from "../src/main/asr/engine.ts";
import { NemotronDiarizer, NemotronStream } from "../src/main/asr/nemotron.ts";

const RATE = 16000;
const [helper, model, speech] = process.argv.slice(2);
if (!helper || !model) {
  console.error("usage: bun scripts/diarize-smoke.ts <akou-diarize> <model.onnx> [speech.wav]");
  process.exit(64);
}
const wav = speech ?? join(import.meta.dir, "..", "tests", "fixtures", "two-voices.wav");
const sentences = (
  JSON.parse(readFileSync(wav.replace(/\.wav$/, ".json"), "utf8")) as {
    sentences: [number, number][];
  }
).sentences;

/** The samples of a 16-bit PCM WAV, as floats. */
function readMono(path: string): Float32Array {
  const b = new Uint8Array(readFileSync(path));
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
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

/** Why `turns` (seconds) fail the conversation, or null: speaker per sentence alternates A B A B. */
function judge(turns: readonly SpeakerTurn[]): { who: number[]; why: string | null } {
  const who = sentences.map(([a, b]) => {
    const cover = new Map<number, number>();
    for (const t of turns) {
      const o = Math.min(b, t.end) - Math.max(a, t.start);
      if (o > 0) cover.set(t.speaker, (cover.get(t.speaker) ?? 0) + o);
    }
    return [...cover.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? -1;
  });
  const why =
    turns.length === 0
      ? "no turns"
      : who.includes(-1)
        ? "a sentence has no speaker"
        : who[0] !== who[2] || who[1] !== who[3]
          ? "a voice changed speaker"
          : who[0] === who[1]
            ? "the two voices are one speaker"
            : null;
  return { who, why };
}

const x = readMono(wav);
const len = (x.length / RATE).toFixed(1);
const spec = { command: [helper], model, threads: 2 };
let failed = false;

const t0 = performance.now();
try {
  const turns = await new NemotronDiarizer(spec).process(x);
  const s = (performance.now() - t0) / 1000;
  const { who, why } = judge(turns);
  const line = `final: ${turns.length} turns, speaker per sentence ${JSON.stringify(who)}, ${s.toFixed(1)} s for ${len} s`;
  if (why) throw new Error(`${why}; ${line}`);
  console.log(line);
} catch (err) {
  console.error(`final: FAILED ${(err as Error).message}`);
  failed = true;
}

const t1 = performance.now();
let decided = 0;
const got: SpeakerTurn[] = [];
let dead = "";
const stream = new NemotronStream(spec, {
  turns: (t, at) => {
    got.push(...t);
    decided = at;
  },
  dead: (e) => {
    dead = e;
  },
});
try {
  for (let o = 0; o < x.length; o += RATE / 5) stream.push(x.subarray(o, o + RATE / 5));
  await stream.flush();
  const s = (performance.now() - t1) / 1000;
  if (decided !== x.length) throw new Error(`decided ${decided} of ${x.length} samples`);
  const turns = got.map((t) => ({ ...t, start: t.start / RATE, end: t.end / RATE }));
  const { who, why } = judge(turns);
  const line = `live: ${turns.length} turns, every sample decided, speaker per sentence ${JSON.stringify(who)}, ${s.toFixed(1)} s for ${len} s`;
  if (why) throw new Error(`${why}; ${line}`);
  console.log(line);
} catch (err) {
  console.error(`live: FAILED ${(err as Error).message}${dead ? ` (${dead})` : ""}`);
  failed = true;
} finally {
  stream.close();
}
process.exit(failed ? 1 : 0);
