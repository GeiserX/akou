/**
 * What the Models page says of each model (`models-page.ts`): the sort orders, sizes, languages,
 * the two bars, the measured speed and why a model is kept. Pure, so the tests read it without a
 * browser.
 */

import type { LiveSetupView, LiveView } from "../main/asr/live-setups.ts";
import type { ModelView, ScoreView } from "../main/server/model-store.ts";
import { when } from "./server-text.ts";

export type ModelRow = ModelView;
export type { LiveSetupView, LiveView };

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
  return [r.job, langs, r.kind === "speech" ? reachText(r) : ""]
    .filter((x) => x !== "")
    .join(" · ");
}

/** When a speech model transcribes: live, after the call, or both. An older app sends no `after_call`. */
function reachText(r: ModelRow): string {
  if (!r.streaming) return "after the call only";
  return r.after_call === false ? "live only" : "live and after the call";
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
  "call-wer": (v) => `WER ${v} % on meetings`,
  seconds: (v) => `${v} s`,
  cores: (v) => `${v} cores`,
  gb: (v) => `${v} GB`,
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

// ---------------------------------------------------------------------------
// The Live section: the live setups (`asr.live`)

/** The four bars of a live setup, in the order the page draws them. */
export const LIVE_BARS = [
  { side: "accuracy", label: "Accuracy" },
  { side: "latency", label: "Latency" },
  { side: "cores", label: "Cores" },
  { side: "memory", label: "Memory" },
] as const;

/** The line under the section's title: the setting, what the next call runs, and when a change applies. */
export function liveHint(v: LiveView): string {
  const next = v.setups.find((s) => s.id === v.next)?.title ?? v.next;
  const setting =
    v.setting === "auto" ? "Auto" : (v.setups.find((s) => s.id === v.setting)?.title ?? v.setting);
  const why = v.note ? ` (${v.note})` : "";
  return `What writes the transcript while a call runs. Chosen: ${setting}; the next call runs ${next}${why}. A change applies from the next call; a running call keeps its setup.`;
}

/** The models a setup needs that are not on disk yet. */
export function liveMissing(s: LiveSetupView): string[] {
  return s.models.filter((m) => m.state === "missing").map((m) => m.id);
}

/** What the setup loads here, and which of those are missing. */
export function liveModelsText(s: LiveSetupView): string {
  if (s.models.length === 0) return "";
  const names = s.models.map((m) =>
    m.state === "ready"
      ? m.id
      : `${m.id} (${m.state === "downloading" ? "downloading" : "not downloaded"})`,
  );
  return `Runs on ${names.join(", ")}`;
}
