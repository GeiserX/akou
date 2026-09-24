/**
 * What the first-run download card says for each state of the speech models (`models-card.ts`).
 * Pure, so the tests read it without a DOM.
 */

import type { ModelsInfo } from "./protocol.ts";

const MB = 1e6;

/** What the card says for a state, or null when it is hidden. Pure, for the tests. */
/** What the card says for a state, or null when it is hidden. */
export function modelsCardText(m: ModelsInfo | undefined): {
  text: string;
  button: string | null;
  progress: number | null;
} | null {
  if (!m || m.state === "ready") return null;
  const size = `${Math.round(m.total / MB)} MB`;
  if (m.state === "downloading") {
    const pct = m.total > 0 ? Math.floor((100 * m.bytes) / m.total) : 0;
    return {
      text: `Downloading the speech models: ${pct} % of ${size}${m.file ? ` (${m.file})` : ""}. Each file is checked against its published checksum.`,
      button: null,
      progress: m.total > 0 ? m.bytes / m.total : 0,
    };
  }
  if (m.state === "failed") {
    return {
      text: `The speech model download stopped: ${m.error ?? "unknown error"}. What arrived is kept.`,
      button: "Try again",
      progress: null,
    };
  }
  return {
    text: `akou needs its speech models before it can record: one download of ${size}, kept in ${m.dir}. Nothing else leaves this computer.`,
    button: "Download speech models",
    progress: null,
  };
}
