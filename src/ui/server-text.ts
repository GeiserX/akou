/**
 * The words of server mode's pages that need no DOM (`server-page.ts`): times, durations and what
 * the Models page says of each state of the speech models. Pure, so the tests read them without a
 * browser.
 */

import type { ModelsInfo } from "./protocol.ts";

/** A local wall-clock time for an ISO time or epoch ms, or a dash. */
export function when(t: string | number | null | undefined): string {
  if (t === null || t === undefined) return "–";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString();
}

/** A length of time, `850 ms`, `12 s` or `3 min 4 s`. */
export function took(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const MB = 1e6;

/** What the Models page says of the speech models. Pure, for the tests. */
export function modelsStateText(m: ModelsInfo): string {
  const size = `${Math.round(m.total / MB)} MB`;
  if (m.state === "ready") return `The speech models are on disk in ${m.dir}.`;
  if (m.state === "downloading") {
    const pct = m.total > 0 ? Math.floor((100 * m.bytes) / m.total) : 0;
    return `Downloading the speech models: ${pct} % of ${size}${m.file ? ` (${m.file})` : ""}. Each file is checked against its published checksum.`;
  }
  if (m.state === "failed") {
    return `The download stopped: ${m.error ?? "unknown error"}. Files already verified are kept.`;
  }
  return `The speech models are not downloaded: ${size}, into ${m.dir}. Jobs are refused until they are.`;
}
