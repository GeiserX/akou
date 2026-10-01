/**
 * The final pass in words, as the window's note and `akou status` say it: `waiting for the pass on
 * <id> (Qwen)`, `starting Qwen`, `labelling speakers (Qwen)`, `running, 37 of 152 min (Qwen)`,
 * `ready (Parakeet), 1 span skipped`, `failed (Qwen is unavailable: …)`. No imports but the model
 * names, so the window's bundle can take it.
 */

import { shortModelName } from "./model-text.ts";

/**
 * What a running pass is doing before its figures move: starting its model (Qwen's llama-server),
 * labelling speakers over the whole call, or decoding, the only step the minutes count.
 */
export type FinalStep = "starting" | "speakers" | "decoding";

export interface FinalFacts {
  state: "none" | "running" | "done" | "failed";
  /** The recognizer's id; absent or null when the log names none (an older pass). */
  model?: string | null;
  /** Seconds of the call the running pass has covered. */
  done_s?: number | null;
  /** The call's length, seconds; 0 or absent until the pass has read it. */
  total_s?: number | null;
  skipped?: number;
  error?: string | null;
  /** The running pass's step; absent: decoding, or not known (an older app). */
  step?: FinalStep | null;
  /** The call whose Qwen pass this one waits for (one at a time); absent or null: not waiting. */
  waiting?: string | null;
}

/** `37 of 152 min`, or `20 of 45 s` for a call under two minutes. */
export function amountText(done: number, total: number): string {
  if (total < 120)
    return `${Math.min(Math.floor(done), Math.round(total))} of ${Math.round(total)} s`;
  const all = Math.round(total / 60);
  return `${Math.min(Math.floor(done / 60), all)} of ${all} min`;
}

/** The pass's state in a few words, with its model by name. */
export function finalText(f: FinalFacts): string {
  const name = f.model ? shortModelName(f.model) : null;
  if (f.state === "running") {
    if (f.waiting) return `waiting for the pass on ${f.waiting}${name ? ` (${name})` : ""}`;
    if (f.step === "starting") return `starting ${name ?? "the model"}`;
    if (f.step === "speakers") return `labelling speakers${name ? ` (${name})` : ""}`;
    const total = f.total_s ?? 0;
    const amount = total > 0 ? `, ${amountText(f.done_s ?? 0, total)}` : "";
    return `running${amount}${name ? ` (${name})` : ""}`;
  }
  if (f.state === "failed") {
    // An engine's own error starts with its id ("qwen3-asr-1.7b is unavailable: …"): the name
    // takes its place instead of saying the model twice.
    if (name && f.model && f.error?.startsWith(`${f.model} `))
      return `failed (${name}${f.error.slice(f.model.length)})`;
    const why = [name, f.error].filter((x) => x).join(": ");
    return `failed${why ? ` (${why})` : ""}`;
  }
  if (f.state === "done") {
    const n = f.skipped ?? 0;
    const skipped = n > 0 ? `, ${n} ${n === 1 ? "span" : "spans"} skipped` : "";
    return `ready${name ? ` (${name})` : ""}${skipped}`;
  }
  return "not run";
}
