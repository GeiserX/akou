/**
 * What the Models page says of each model (`models-page.ts`): the sort orders, sizes, languages,
 * the two bars, the measured speed and why a model is kept. Pure, so the tests read it without a
 * browser.
 */

import type { ModelView, ScoreView } from "../main/server/model-store.ts";
import { when } from "./server-text.ts";

export type ModelRow = ModelView;

export const SORTS = [
  { by: "accuracy", label: "Accuracy" },
  { by: "speed", label: "Speed" },
  { by: "size", label: "Size" },
  { by: "name", label: "Name" },
  { by: "last_used", label: "Last used" },
] as const;
export type SortBy = (typeof SORTS)[number]["by"];

/** The page's sections, in order; helpers start folded. */
export const SECTIONS: readonly { kind: ModelRow["kind"]; title: string; hint: string }[] = [
  {
    kind: "speech",
    title: "Speech recognition",
    hint: "The models that turn speech into words.",
  },
  {
    kind: "speakers",
    title: "Speaker labels",
    hint: "Diarization: who spoke when. Used when a job or a call asks for speaker labels.",
  },
  {
    kind: "helper",
    title: "Helpers",
    hint: "Voice activity detection and the programs a model runs on. They are fetched with the model that needs them.",
  },
];

/** A score to sort by: the bar, else nothing (last). */
function scoreOf(s: ScoreView): number {
  return s.score ?? -1;
}

/**
 * The rows in the order asked for. Best first for accuracy and speed, largest first for size, A to
 * Z for name, most recent first for last used; a model with no number goes last, then by name.
 */
export function sortRows(rows: readonly ModelRow[], by: SortBy): ModelRow[] {
  const name = (a: ModelRow, b: ModelRow) => a.id.localeCompare(b.id);
  const key: Record<SortBy, (r: ModelRow) => number> = {
    accuracy: (r) => scoreOf(r.accuracy),
    speed: (r) => scoreOf(r.speed),
    size: (r) => r.size,
    name: () => 0,
    last_used: (r) => (r.last_used_at === null ? -1 : Date.parse(r.last_used_at)),
  };
  return [...rows].sort((a, b) => key[by](b) - key[by](a) || name(a, b));
}

/** `2.55 GB`, `40 MB`, `644 KB`, in powers of ten as the settings count them. */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** `25 languages`, `en, es`, `any language`, or nothing when the catalog does not say. */
export function languagesText(r: ModelRow): string {
  if (r.languages === null) return "";
  if (r.languages === "any") return "any language";
  if (r.languages.length <= 3) return r.languages.join(", ");
  return `${r.languages.length} languages`;
}

/** What the model is for, in one line: its job, languages, and whether it streams. */
export function purposeText(r: ModelRow): string {
  const langs = r.kind === "speech" ? languagesText(r) : "";
  return [
    r.job,
    langs,
    r.kind === "speech" ? (r.streaming ? "live and after the call" : "after the call only") : "",
  ]
    .filter((x) => x !== "")
    .join(" · ");
}

/** One bar: the 0 to 100 value or null, the short label beside it, and the full source text. */
export interface Bar {
  value: number | null;
  label: string;
  title: string;
}

const METRIC: Record<string, (v: number) => string> = {
  wer: (v) => `WER ${v} %`,
  der: (v) => `DER ${v} %`,
  rtfx: (v) => `${v}x real time`,
};

export function bar(s: ScoreView): Bar {
  if (s.score === null) return { value: null, label: "not measured", title: s.not_measured };
  const raw = (METRIC[s.metric] ?? String)(s.value);
  return {
    value: s.score,
    label: `${s.score} · ${raw}`,
    title: `${raw}: ${s.what}. Score: ${s.formula}. Source: ${s.source}`,
  };
}

/** This machine's measured speed, or null when it has not run the model. */
export function measuredText(r: ModelRow): string | null {
  if (!r.measured) return null;
  const { rtf, runs } = r.measured;
  const x = rtf > 0 ? Math.round(10 / rtf) / 10 : 0;
  return `Measured here: ${x}x real time (real-time factor ${rtf}), median of ${runs} run${runs === 1 ? "" : "s"}`;
}

/** Last use and what the sweep does with it: kept, deleted on a date, or never deleted. */
export function keptText(r: ModelRow, unusedDays: number | null): string {
  if (r.state !== "ready") return r.state === "downloading" ? "Downloading" : "Not downloaded";
  const used = r.last_used_at ? `Last used ${when(r.last_used_at)}` : "Not used yet";
  if (r.default) return `${used} · Kept: default`;
  if (r.in_use) return `${used} · Kept: in use`;
  if (r.evicts_at) return `${used} · Deleted on ${when(r.evicts_at)} if still unused`;
  return unusedDays === 0 ? `${used} · Kept: automatic deletion is off` : used;
}

/** Why Delete is not offered on a model, or null when it is. */
export function deleteRefusal(r: ModelRow): string | null {
  if (r.state !== "ready") return r.state === "downloading" ? "downloading" : null;
  if (r.default) return "the default model's set is never deleted; choose another default first";
  if (r.in_use) return "in use by a job, a worker or the recognizer";
  return null;
}

/** Percent of a download, rounded down. */
export function percent(r: ModelRow): number {
  return r.size > 0 ? Math.floor((100 * r.bytes) / r.size) : 0;
}
