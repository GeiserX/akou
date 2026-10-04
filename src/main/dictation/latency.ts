/**
 * How long a dictation's text takes after the key is let go (docs/ux/DICTATION.md DC-T3), for the
 * Dictation page: the p50 for 10 s of speech measured on this platform when
 * `docs/gates/dictation-latency.json` has one (the nightly's `dictation` stage writes that table),
 * else the estimate of DICTATION section 7.1, marked as one.
 */

import table from "../../../docs/gates/dictation-latency.json" with { type: "json" };

/** What a dictation inserts (`dictation.final`), and the remote. */
export type LatencyChoice = "live" | "parakeet" | "qwen" | "remote";

/** Release to text in ms, and whether it was measured on this platform or is an estimate. */
export interface Latency {
  ms: number;
  measured: boolean;
}

/** The length of speech the page's time is for. */
export const LATENCY_SECONDS = 10;

/**
 * DICTATION section 7.1's estimates for 10 s of speech, where nothing was measured: Parakeet at
 * real-time factor 0.02, Qwen at the top of its "0.5 to 1 s", the streaming model's flush of its
 * last chunk. The remote has none of its own: its time is the network's and the remote's.
 */
export const ESTIMATED_MS: Readonly<Record<LatencyChoice, number | null>> = {
  live: 300,
  parakeet: 200,
  qwen: 1000,
  remote: null,
};

/** The table's engine for each choice: `parakeet` is not measured, as no default runs it. */
const MEASURED_AS: Readonly<Record<LatencyChoice, string | null>> = {
  live: "live",
  parakeet: null,
  qwen: "qwen",
  remote: "remote",
};

interface Table {
  platforms: Record<
    string,
    { engines: Record<string, { seconds: Record<string, { p50: number }> } | undefined> }
  >;
}

/** Each choice's time on `platform` (`darwin-arm64`), measured when the table has it. */
export function dictationLatency(
  platform = `${process.platform}-${process.arch}`,
  t: Table = table as Table,
): Partial<Record<LatencyChoice, Latency>> {
  const engines = t.platforms[platform]?.engines ?? {};
  const out: Partial<Record<LatencyChoice, Latency>> = {};
  for (const choice of Object.keys(ESTIMATED_MS) as LatencyChoice[]) {
    const as = MEASURED_AS[choice];
    const p50 = as ? engines[as]?.seconds[String(LATENCY_SECONDS)]?.p50 : undefined;
    const estimate = ESTIMATED_MS[choice];
    if (p50 !== undefined) out[choice] = { ms: p50, measured: true };
    else if (estimate !== null) out[choice] = { ms: estimate, measured: false };
  }
  return out;
}
