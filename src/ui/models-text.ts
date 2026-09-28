/**
 * What the welcome says about the speech models (`models-card.ts`, docs/ux/WINDOW.md section 10):
 * the rows, the sentence on where they are kept, the line beside the one button, the progress, and
 * why Record waits. Pure, so the tests read it without a DOM.
 */

import { type ModelRow, sizeText } from "./models-rows.ts";
import type { ModelsInfo } from "./protocol.ts";

/** The welcome's models step for a state, or null when the models are there (no welcome). */
export interface ModelsCardView {
  /** The whole download, for the card's head. */
  size: string;
  /** One line beside the button or the bar: the size, the progress, or why it stopped. */
  text: string;
  /** Where the files live and that nothing leaves the computer: the dim sentence. */
  where: string;
  /** The one button's label, or null while it downloads (no Cancel: the API has none). */
  button: string | null;
  /** 0 to 1 while it downloads, else null. */
  progress: number | null;
  failed: boolean;
}

export function modelsCardText(m: ModelsInfo | undefined): ModelsCardView | null {
  if (!m || m.state === "ready") return null;
  const size = sizeText(m.total);
  const where = m.dir.includes("/Library/Application Support/")
    ? "Kept in Application Support on this Mac. Nothing leaves this computer."
    : `Kept in ${m.dir}. Nothing leaves this computer.`;
  const base = { size, where, failed: false };
  if (m.state === "downloading") {
    const pct = m.total > 0 ? Math.floor((100 * m.bytes) / m.total) : 0;
    return {
      ...base,
      text: `${sizeText(m.bytes)} of ${size} · ${pct} %${m.file ? ` · ${m.file}` : ""}`,
      button: null,
      progress: m.total > 0 ? m.bytes / m.total : 0,
    };
  }
  if (m.state === "failed") {
    return {
      ...base,
      text: `The download stopped: ${m.error ?? "unknown error"}. Files already verified are kept; the one that failed is fetched again.`,
      button: "Try again",
      progress: null,
      failed: true,
    };
  }
  return {
    ...base,
    text: `One download, ${size}`,
    button: "Download speech models",
    progress: null,
  };
}

/** Why Record waits, for its tooltip, or null when it may record. An older app sends no models. */
export function recordBlocked(m: ModelsInfo | undefined): string | null {
  if (!m || m.state === "ready") return null;
  if (m.state === "downloading") return "Record starts once the speech models finish downloading.";
  return "Record needs the speech models: download them first.";
}

const KIND_TITLE: Record<ModelRow["kind"], string> = {
  speech: "Speech recognizer",
  speakers: "Speaker labeller",
  helper: "Helper",
};
/** Models that share a kind with another default model get their own title, so no two rows read the same. */
const TITLE: Record<string, string> = {
  "titanet-small": "Speaker embeddings",
  "pyannote-segmentation-3.0": "Speaker segmentation",
};
const KIND_ORDER: ModelRow["kind"][] = ["speech", "speakers", "helper"];

/**
 * One row per model the download fetches (the app's own set, `default` on `GET /models`): what it
 * is, its job in one line, its size. The catalog's job loses its trailing note on the setting that
 * picks it, which is for the Models page.
 */
export function welcomeRows(
  rows: readonly ModelRow[],
): { id: string; kind: ModelRow["kind"]; title: string; role: string; size: string }[] {
  return rows
    .filter((r) => r.default)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map((r) => {
      const job = r.job.replace(/\s*\([^)]*\)\s*$/, "");
      return {
        id: r.id,
        kind: r.kind,
        title: TITLE[r.id] ?? KIND_TITLE[r.kind],
        role: job.charAt(0).toUpperCase() + job.slice(1),
        size: sizeText(r.size),
      };
    });
}
