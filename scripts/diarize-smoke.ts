/**
 * Runs the real `akou-diarize` on the real Nemotron model over 60 s of generated audio, in both
 * modes, the way the app does (src/main/asr/nemotron.ts), and exits 1 unless each mode answers
 * for every sample. It proves the helper loads ONNX Runtime and the model and runs on this OS; it
 * does not judge who spoke (the local integration test does, with `say`).
 *
 *   bun scripts/diarize-smoke.ts <akou-diarize> <nemotron3_diar_v3.onnx>
 */

import { NemotronDiarizer, NemotronStream } from "../src/main/asr/nemotron.ts";

const RATE = 16000;
const [helper, model] = process.argv.slice(2);
if (!helper || !model) {
  console.error("usage: bun scripts/diarize-smoke.ts <akou-diarize> <model.onnx>");
  process.exit(64);
}

/** 60 s: two "talkers" (noise shaped at two pitches) taking 4 s turns, with pauses. */
function audio(): Float32Array {
  const out = new Float32Array(60 * RATE);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const turn = Math.floor(t / 5);
    if (t % 5 > 4) continue;
    const f0 = turn % 2 ? 210 : 115;
    const syll = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[i] = 0.08 * syll * (v + 0.3 * rnd());
  }
  return out;
}

const x = audio();
const spec = { command: [helper], model, threads: 2 };
let failed = false;

const t0 = performance.now();
try {
  const turns = await new NemotronDiarizer(spec).process(x);
  const s = (performance.now() - t0) / 1000;
  console.log(
    `final: ${turns.length} turns, speakers ${JSON.stringify([...new Set(turns.map((t) => t.speaker))])}, ${s.toFixed(1)} s for 60 s`,
  );
} catch (err) {
  console.error(`final: FAILED ${(err as Error).message}`);
  failed = true;
}

const t1 = performance.now();
let decided = 0;
let turns = 0;
let dead = "";
const stream = new NemotronStream(spec, {
  turns: (t, at) => {
    turns += t.length;
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
  console.log(`live: ${turns} turns, every sample decided, ${s.toFixed(1)} s for 60 s`);
} catch (err) {
  console.error(`live: FAILED ${(err as Error).message}${dead ? ` (${dead})` : ""}`);
  failed = true;
} finally {
  stream.close();
}
process.exit(failed ? 1 : 0);
