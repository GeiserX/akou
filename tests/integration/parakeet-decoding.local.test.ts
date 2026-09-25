/**
 * Why Parakeet decodes greedy by default (`asr.parakeet.decoding`), on this machine only. sherpa-onnx
 * 1.13.8's `modified_beam_search` returns some meeting chunks empty that greedy decodes in full: in
 * the benchmark, 14 of 200 AMI chunks lost their decoded tail (651 words), and greedy lost none.
 *
 * It runs when `AKOU_MODELS_DIR` points at a models folder in the registry layout and
 * `AKOU_AMI_IS1009B` at a 16 kHz mono 16-bit WAV of the public AMI meeting IS1009b (Mix-Headset,
 * CC BY 4.0); otherwise it is skipped and the reason is printed. CI sets neither, and nothing here
 * downloads anything. To make the WAV:
 *
 *   curl -LO https://groups.inf.ed.ac.uk/ami/AMICorpusMirror//amicorpus/IS1009b/audio/IS1009b.Mix-Headset.wav
 *   ffmpeg -i IS1009b.Mix-Headset.wav -ac 1 -ar 16000 -sample_fmt s16 IS1009b.wav
 *
 * The chunk is the 12 s from 1206.624 s, the benchmark's unit `IS1009b__0055`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASR_RATE } from "../../src/main/asr/engine.ts";
import { prepareSpan } from "../../src/main/asr/pad.ts";
import { SherpaModels } from "../../src/main/asr/sherpa.ts";

const MODELS = process.env.AKOU_MODELS_DIR;
const AMI = process.env.AKOU_AMI_IS1009B;
const SKIP = !MODELS
  ? "AKOU_MODELS_DIR is not set"
  : !AMI
    ? "AKOU_AMI_IS1009B is not set (the file header says how to make it)"
    : null;
if (SKIP) {
  console.log(`parakeet-decoding.local: skipped, ${SKIP}. It needs the real model and AMI audio.`);
}

const work = mkdtempSync(join(tmpdir(), "akou-parakeet-decoding-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The samples of a mono 16-bit WAV, extra chunks skipped. */
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

const words = (text: string) => text.split(/\s+/).filter((w) => w !== "").length;

describe.skipIf(!!SKIP)("Parakeet decoding (needs AKOU_MODELS_DIR and AKOU_AMI_IS1009B)", () => {
  test("an AMI chunk beam search returns empty decodes to text under greedy; beam still loses it", () => {
    const from = Math.round(1206.624 * ASR_RATE);
    const chunk = prepareSpan(readMono(AMI as string).slice(from, from + 12 * ASR_RATE));
    const decode = (decoding: "greedy" | "beam") =>
      new SherpaModels({ dir: MODELS as string, cacheDir: join(work, decoding), decoding })
        .prepare(null)
        .recognizer.decode(chunk).text;
    const greedy = decode("greedy");
    const beam = decode("beam");
    console.log(`parakeet-decoding.local: greedy "${greedy}" | beam "${beam}"`);
    expect(words(greedy)).toBeGreaterThanOrEqual(10);
    // Positive control: the same chunk through beam search is still (nearly) empty, so this test
    // fails if greedy stops being what decodes it.
    expect(words(beam)).toBeLessThan(3);
  }, 120_000);
});
