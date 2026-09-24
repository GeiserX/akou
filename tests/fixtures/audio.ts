/**
 * Generated audio for capture tests. Nothing here is a recording: every signal is synthesised
 * from a seed, so fixtures are reproducible and nothing private is ever committed.
 *
 * `speechLike` is a voiced-syllable signal (a harmonic series on a gliding pitch, shaped by a
 * syllable envelope of about four syllables a second, with pauses between phrases). It is not
 * speech; it has the energy pattern of speech, which is what capture, alignment and health tests
 * need.
 */

import { writeFileSync } from "node:fs";

export const RATE = 16000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SpeechOptions {
  f0?: number;
  seed?: number;
  rate?: number;
  /** Peak amplitude, 0..1. */
  amp?: number;
}

export function speechLike(seconds: number, o: SpeechOptions = {}): Float32Array {
  const rate = o.rate ?? RATE;
  const f0 = o.f0 ?? 130;
  const amp = o.amp ?? 0.3;
  const rnd = mulberry32(o.seed ?? 1);
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  let i = 0;
  let phase = 0;
  while (i < n) {
    // A phrase of 3 to 8 syllables, then a pause of 0.3 to 1.2 s.
    const syllables = 3 + Math.floor(rnd() * 6);
    for (let s = 0; s < syllables && i < n; s++) {
      const len = Math.round((0.15 + rnd() * 0.15) * rate);
      const pitch = f0 * (0.85 + rnd() * 0.3);
      for (let k = 0; k < len && i < n; k++, i++) {
        const env = Math.sin((Math.PI * k) / len);
        const f = pitch * (1 + 0.05 * Math.sin((2 * Math.PI * k) / len));
        phase += (2 * Math.PI * f) / rate;
        let v = 0;
        for (let h = 1; h <= 6; h++) v += Math.sin(phase * h) / h;
        out[i] = amp * env * v * 0.5;
      }
      const gap = Math.round((0.02 + rnd() * 0.05) * rate);
      i += gap;
    }
    i += Math.round((0.3 + rnd() * 0.9) * rate);
  }
  return out;
}

export function tone(seconds: number, freq: number, amp = 0.25, rate = RATE): Float32Array {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** 16-bit PCM stereo WAV: left = mic, right = call. The shorter channel is padded with zeros. */
export function stereoWav(left: Float32Array, right: Float32Array, rate = RATE): Uint8Array {
  const frames = Math.max(left.length, right.length);
  const bytes = new Uint8Array(44 + frames * 4);
  const v = new DataView(bytes.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + frames * 4, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, frames * 4, true);
  const s16 = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  for (let i = 0; i < frames; i++) {
    v.setInt16(44 + i * 4, s16(left[i] ?? 0), true);
    v.setInt16(46 + i * 4, s16(right[i] ?? 0), true);
  }
  return bytes;
}

export interface Stereo {
  rate: number;
  left: Float32Array;
  right: Float32Array;
}

/** Reads a 16-bit PCM stereo WAV written by `stereoWav` (or any plain one with a `data` chunk). */
export function readStereoWav(bytes: Uint8Array): Stereo {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (str(0) !== "RIFF" || str(8) !== "WAVE") throw new Error("not a WAV file");
  let o = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (o + 8 <= bytes.length) {
    const id = str(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
    } else if (id === "data") {
      if (channels !== 2 || bits !== 16) throw new Error("need 16-bit stereo");
      const frames = Math.floor(Math.min(size, bytes.length - o - 8) / 4);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = v.getInt16(o + 8 + i * 4, true) / 32768;
        right[i] = v.getInt16(o + 10 + i * 4, true) / 32768;
      }
      return { rate, left, right };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Writes a two-channel test WAV (mic speech-like on the left, a different voice on the right). */
export function writeCallWav(
  path: string,
  seconds: number,
  o: { callSilentFor?: number } = {},
): void {
  const mic = speechLike(seconds, { f0: 120, seed: 7 });
  const call = speechLike(seconds, { f0: 210, seed: 11 });
  const silent = Math.round((o.callSilentFor ?? 0) * RATE);
  call.fill(0, 0, Math.min(silent, call.length));
  writeFileSync(path, stereoWav(mic, call));
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}
