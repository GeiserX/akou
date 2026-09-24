/**
 * What every path does to a span before the recognizer sees it (docs/DESIGN.md section 3.1 steps 3
 * and 4; TRAPS "Short spans lose their words" [T1.9, T4.19]). The live path, the final pass and a
 * single file all call `prepareSpan`, so the rule cannot drift between them.
 *
 * - **Gain** the copy toward -3 dBFS peak, at most +20 dB, never attenuate. The recording is never
 *   touched; this is a copy.
 * - **Pad** a span shorter than 0.5 s to 0.5 s with zeros **after** the speech. Short words
 *   vanished under a 0.3 s engine floor in hark's engines. The floor is unmeasured on sherpa-onnx
 *   with Parakeet, and the streaming-zipformer evidence about leading audio does not transfer, so
 *   the zeros go after the speech and the 0.2 s "Yes." fixture measures the three conditions
 *   (none, leading, trailing) against the real model in the local integration test.
 */

import { ASR_RATE } from "./engine.ts";

/** Every span reaches the recognizer at least this long. */
export const MIN_SPAN_SECONDS = 0.5;
/** The engine floor seen in hark: a span shorter than this lost its words. */
export const ENGINE_FLOOR_SECONDS = 0.3;
/** -3 dBFS as a linear peak. */
export const TARGET_PEAK = 10 ** (-3 / 20);
/** +20 dB. */
export const MAX_GAIN = 10;

/** The span padded to `MIN_SPAN_SECONDS` with trailing zeros; the same array if long enough. */
export function padSpan(samples: Float32Array, rate = ASR_RATE): Float32Array {
  const min = Math.round(MIN_SPAN_SECONDS * rate);
  if (samples.length >= min) return samples;
  const out = new Float32Array(min);
  out.set(samples, 0);
  return out;
}

export function peak(samples: Float32Array): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number);
    if (v > p) p = v;
  }
  return p;
}

/** Linear gain toward the target peak: at least 1, at most `MAX_GAIN`. */
export function gainFor(samples: Float32Array): number {
  const p = peak(samples);
  if (p === 0) return 1;
  return Math.max(1, Math.min(MAX_GAIN, TARGET_PEAK / p));
}

/** Gain then pad, on a copy. The input is never modified. */
export function prepareSpan(samples: Float32Array, rate = ASR_RATE): Float32Array {
  const g = gainFor(samples);
  const copy = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) copy[i] = (samples[i] as number) * g;
  return padSpan(copy, rate);
}
