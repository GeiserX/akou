/**
 * The stimulus and the analysis of the live capture test (tests/capture-live.e2e.test.ts): tone
 * bursts that start on the same sample on both channels, and the measurements a recording of
 * them must pass, "left = mic tone, right = call tone, skew under 20 ms" (ROADMAP M4).
 *
 * Kept apart from the live test so the analysis itself is tested on every run against signals
 * with a known answer, including the ones it must reject.
 */

import type { Packet } from "../src/main/capture/protocol.ts";
import { CAPTURE_RATE } from "../src/main/capture/protocol.ts";

export const MIC_HZ = 440;
export const CALL_HZ = 1000;
/** Burst layout, seconds: the first starts at LEAD, then one every PERIOD, each BURST long. */
export const LEAD = 0.5;
export const PERIOD = 0.8;
export const BURST = 0.25;
export const BURSTS = 5;

/** One channel of the stimulus: bursts of `hz` at the shared positions, `rate` samples a second. */
export function bursts(hz: number, rate: number, amp = 0.4): Float32Array {
  const total = Math.round((LEAD + PERIOD * BURSTS + 0.5) * rate);
  const out = new Float32Array(total);
  const ramp = Math.round(0.002 * rate);
  const len = Math.round(BURST * rate);
  for (let b = 0; b < BURSTS; b++) {
    const start = Math.round((LEAD + b * PERIOD) * rate);
    for (let i = 0; i < len && start + i < total; i++) {
      const edge = Math.min(1, i / ramp, (len - 1 - i) / ramp);
      out[start + i] = amp * edge * Math.sin((2 * Math.PI * hz * i) / rate);
    }
  }
  return out;
}

/** The packets of one channel laid out by file position, at the packet rate. */
export function channel(packets: readonly Packet[], ch: "mic" | "call"): Float32Array {
  let end = 0;
  for (const p of packets) {
    if (p.ch !== ch) continue;
    end = Math.max(end, Math.round(p.fileSeconds * CAPTURE_RATE) + p.samples.length);
  }
  const out = new Float32Array(end);
  for (const p of packets) {
    if (p.ch === ch) out.set(p.samples, Math.round(p.fileSeconds * CAPTURE_RATE));
  }
  return out;
}

/** Signal power at `hz` over the whole signal (Goertzel). */
export function power(x: Float32Array, hz: number, rate = CAPTURE_RATE): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s = v + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / Math.max(1, x.length);
}

/** Decibels by which `want` dominates `other` in `x`. */
export function dominance(x: Float32Array, want: number, other: number): number {
  return 10 * Math.log10((power(x, want) + 1e-20) / (power(x, other) + 1e-20));
}

/**
 * Burst onsets, seconds: the first 2 ms block whose RMS rises above a quarter of the channel's
 * loudest block after at least 100 ms below it.
 */
export function onsets(x: Float32Array, rate = CAPTURE_RATE): number[] {
  const block = Math.round(0.002 * rate);
  const env: number[] = [];
  for (let i = 0; i + block <= x.length; i += block) {
    let s = 0;
    for (let j = i; j < i + block; j++) s += (x[j] as number) ** 2;
    env.push(Math.sqrt(s / block));
  }
  const top = Math.max(0, ...env);
  if (top === 0) return [];
  const thr = top / 4;
  const quiet = Math.round(0.1 / 0.002);
  const out: number[] = [];
  let below = quiet;
  env.forEach((e, i) => {
    if (e >= thr) {
      if (below >= quiet) out.push((i * block) / rate);
      below = 0;
    } else {
      below++;
    }
  });
  return out;
}

export interface Verdict {
  /** dB by which the mic tone dominates the call tone on the left, and the reverse on the right. */
  leftDb: number;
  rightDb: number;
  /** Left onset minus right onset for each burst, milliseconds. */
  skewsMs: number[];
  maxSkewMs: number;
}

/** Measures a two-channel recording of the stimulus. */
export function measure(left: Float32Array, right: Float32Array): Verdict {
  const l = onsets(left);
  const r = onsets(right);
  const n = Math.min(l.length, r.length);
  const skewsMs = Array.from({ length: n }, (_, i) => ((l[i] as number) - (r[i] as number)) * 1000);
  return {
    leftDb: dominance(left, MIC_HZ, CALL_HZ),
    rightDb: dominance(right, CALL_HZ, MIC_HZ),
    skewsMs,
    maxSkewMs: n ? Math.max(...skewsMs.map(Math.abs)) : Number.POSITIVE_INFINITY,
  };
}

/** Block length of `toneRuns`, seconds: 20 ms resolves 440 Hz from 1000 Hz with room to spare. */
export const TONE_BLOCK = 0.02;

/**
 * The runs of `want` in `x`, each as its length in seconds, read from tone content alone: a 20 ms
 * Hann-windowed block belongs to `want` when its power there is at least a tenth of the loudest
 * block's power at either tone and at least `db` above its power at `other`. It never looks at
 * when a burst starts, so two players that start a few milliseconds apart (PulseAudio's two
 * `paplay`s) measure exactly as one player does, and it pairs nothing across channels.
 */
export function toneRuns(
  x: Float32Array,
  want: number,
  other: number,
  db = 20,
  rate = CAPTURE_RATE,
): number[] {
  const n = Math.round(TONE_BLOCK * rate);
  const hann = Float32Array.from(
    { length: n },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)),
  );
  const blocks: { w: number; o: number }[] = [];
  const buf = new Float32Array(n);
  for (let i = 0; i + n <= x.length; i += n) {
    for (let j = 0; j < n; j++) buf[j] = (x[i + j] as number) * (hann[j] as number);
    blocks.push({ w: power(buf, want, rate), o: power(buf, other, rate) });
  }
  const loud = blocks.reduce((m, b) => Math.max(m, b.w, b.o), 0);
  if (loud === 0) return [];
  const ratio = 10 ** (db / 10);
  const runs: number[] = [];
  let run = 0;
  for (const b of blocks) {
    if (b.w >= loud / 10 && b.w >= b.o * ratio) {
      run++;
    } else if (run > 0) {
      runs.push(run * TONE_BLOCK);
      run = 0;
    }
  }
  if (run > 0) runs.push(run * TONE_BLOCK);
  return runs;
}
