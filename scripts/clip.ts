/** Reading the recognizer's test clips, for the scripts that decode one (models-smoke, G2). */

import { readFileSync } from "node:fs";
import { ASR_RATE } from "../src/main/asr/engine.ts";

/** A 16-bit mono WAV as 32-bit floats at the recognizer's 16 kHz (linear resampling). */
export function readClip(path: string): Float32Array {
  const b = readFileSync(path);
  const rate = b.readUInt32LE(24);
  let at = 12;
  while (b.toString("ascii", at, at + 4) !== "data") at += 8 + b.readUInt32LE(at + 4);
  const n = b.readUInt32LE(at + 4) / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(at + 8 + 2 * i) / 32768;
  const out = new Float32Array(Math.floor((n * ASR_RATE) / rate));
  for (let i = 0; i < out.length; i++) {
    const x = (i * rate) / ASR_RATE;
    const j = Math.floor(x);
    out[i] = (pcm[j] ?? 0) + ((pcm[j + 1] ?? pcm[j] ?? 0) - (pcm[j] ?? 0)) * (x - j);
  }
  return out;
}
