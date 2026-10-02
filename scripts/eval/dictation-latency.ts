/**
 * Dictation's release-to-text time per engine (docs/ux/DICTATION.md DC-T3): how long after the key
 * is let go the text is ready, p50 and p95, for 3 s, 10 s and 30 s of speech, through the app's own
 * engine code. Run as the `dictation` stage of `scripts/eval/nightly.ts`, which writes the table
 * this file defines; `docs/gates/dictation-latency.json` holds the one measured on real hardware,
 * which the Dictation page shows (`src/main/dictation/latency.ts`).
 *
 * - `live`: the streaming model a dictation's words come from (`dictation.final` `live`, the
 *   default), fed the speech at real-time pace as a held key feeds it; the time is its flush at
 *   the release (`LiveWords.finish`).
 * - `qwen`: Qwen3-ASR on its warm llama-server (`dictation.final` `qwen`, the `best` engine),
 *   which decodes the whole buffer after the release.
 * - `remote`: another akou on this machine's loopback (`akou serve`, its own default engine),
 *   reached by the app's own client with the audio streamed during the hold (DC-R6); the time is
 *   the tail, the remote's decode and the answer.
 *
 * Each engine is warmed with one dictation first, which is not counted.
 */

import { percentile } from "./score.ts";

/** The utterance lengths of DC-T3, in seconds. */
export const DICTATION_LENGTHS = [3, 10, 30] as const;
/** Dictations measured per engine and length. */
export const DICTATIONS_PER_LENGTH = 10;
export const DICTATION_RATE = 16_000;
/** The peak every clip is brought to, as a microphone's gain would. */
export const DICTATION_PEAK = 0.5;

/** `x` scaled so its peak is `peak`; null for a clip with no sound at all. */
export function atPeak(x: Float32Array, peak: number): Float32Array | null {
  const top = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return top === 0 ? null : x.map((v) => (v * peak) / top);
}

export type LatencyEngine = "live" | "qwen" | "remote";

/** One engine's times: the model that ran, and per length in seconds its p50 and p95 in ms. */
export interface EngineLatency {
  model: string;
  seconds: Record<string, { p50: number; p95: number; n: number }>;
}

/** One platform's entry in `docs/gates/dictation-latency.json`. */
export interface PlatformLatency {
  /** When, on what, and by what command. */
  measured: string;
  engines: Partial<Record<LatencyEngine, EngineLatency>>;
}

export interface LatencyTable {
  _about: string;
  platforms: Record<string, PlatformLatency>;
}

/**
 * `count` utterances of exactly `seconds` each, made by joining the clips end to end in order and
 * cutting: the speech of a dictation, never padded with silence. Throws when the clips are too short.
 */
export function utterances(
  clips: readonly Float32Array[],
  seconds: number,
  count: number,
): Float32Array[] {
  const n = Math.round(seconds * DICTATION_RATE);
  const out: Float32Array[] = [];
  let cur = new Float32Array(n);
  let at = 0;
  for (const c of clips) {
    let from = 0;
    while (from < c.length && out.length < count) {
      const take = Math.min(n - at, c.length - from);
      cur.set(c.subarray(from, from + take), at);
      at += take;
      from += take;
      if (at === n) {
        out.push(cur);
        cur = new Float32Array(n);
        at = 0;
      }
    }
    if (out.length === count) return out;
  }
  throw new Error(`the clips hold ${out.length} utterances of ${seconds} s, not ${count}`);
}

/** Times in ms by length in seconds, as the table writes them, rounded to the ms. */
export function engineLatency(model: string, times: ReadonlyMap<number, number[]>): EngineLatency {
  const seconds: EngineLatency["seconds"] = {};
  for (const [s, ms] of times) {
    seconds[String(s)] = {
      p50: Math.round(percentile(ms, 50)),
      p95: Math.round(percentile(ms, 95)),
      n: ms.length,
    };
  }
  return { model, seconds };
}

/** `table` with `platform`'s entry replaced; the others are kept as they were. */
export function withPlatform(
  table: LatencyTable | null,
  platform: string,
  entry: PlatformLatency,
): LatencyTable {
  return {
    _about: table?._about ?? ABOUT,
    platforms: { ...(table?.platforms ?? {}), [platform]: entry },
  };
}

export const ABOUT =
  "Dictation's release-to-text time per engine (docs/ux/DICTATION.md DC-T3), p50 and p95 in ms over 10 dictations each of 3, 10 and 30 s of FLEURS speech, by `bun scripts/eval/nightly.ts --only dictation`, per platform as process.platform-process.arch. The Dictation page shows the 10 s p50 of this machine's platform as measured, and an estimate otherwise. The nightly runs the same stage on GitHub's runners and prints their numbers; those runners have no GPU worth the name, so a platform's entry here comes from a real machine, named in `measured`.";

/** Sleeps until `at` on the `performance.now()` clock. */
async function until(at: number): Promise<void> {
  const wait = at - performance.now();
  if (wait > 0) await Bun.sleep(wait);
}

/** The packet a held key's audio arrives in, in samples: 20 ms, as the helper sends it. */
const PACKET = DICTATION_RATE / 50;

/**
 * Feeds `samples` to `push` at real-time pace, a packet at a time, as a held key does, and returns
 * the moment the last packet went: the release.
 */
export async function hold(samples: Float32Array, push: (p: Float32Array) => void): Promise<void> {
  const t0 = performance.now();
  for (let at = 0; at < samples.length; at += PACKET) {
    await until(t0 + (at / DICTATION_RATE) * 1000);
    push(samples.subarray(at, at + PACKET));
  }
  await until(t0 + (samples.length / DICTATION_RATE) * 1000);
}

/** One dictation: `run` gets the speech and answers the release-to-text time in ms. */
export type Dictate = (samples: Float32Array) => Promise<number>;

/**
 * Every length's utterances through `dictate`, after one warm-up dictation that is not counted.
 * `log` gets one line per length.
 */
export async function measure(
  dictate: Dictate,
  byLength: ReadonlyMap<number, Float32Array[]>,
  log: (line: string) => void = () => {},
): Promise<Map<number, number[]>> {
  const first = [...byLength.values()][0]?.[0];
  if (first) await dictate(first);
  const out = new Map<number, number[]>();
  for (const [s, utts] of byLength) {
    const ms: number[] = [];
    for (const u of utts) ms.push(await dictate(u));
    out.set(s, ms);
    log(`${s} s: ${ms.map((m) => Math.round(m)).join(", ")} ms`);
  }
  return out;
}
