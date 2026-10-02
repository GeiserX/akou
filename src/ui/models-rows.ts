/**
 * What the Models page says (`models-page.ts`, docs/ux/design-explorations/sd-a-models.html): each
 * model's name, its facts as plain sentences built from the numbers in `asr/model-scores.ts` and
 * `asr/live-setups.ts` (each accuracy figure naming its test set), sizes, and why a model is kept.
 * Pure, so the tests read it without a browser.
 */

import type { LiveSetupView, LiveView, ReviewChoiceView } from "../main/asr/live-setups.ts";
import { everyText } from "../main/asr/model-text.ts";
import type { ModelView, ScoreView } from "../main/server/model-store.ts";
import { when } from "./server-text.ts";

export type ModelRow = ModelView;
export type { LiveSetupView, LiveView, ReviewChoiceView };

/** Catalog ids the page places by hand (`tests/models-rows.test.ts` checks them against the catalog). */
export const RECOGNIZER_ID = "parakeet-tdt-0.6b-v3-fp32";
export const QWEN_ID = "qwen3-asr-1.7b";
/**
 * The model each speaker setting (`asr.diarizer`) adds: removing it frees what that choice alone
 * needs. TitaNet runs under both, so it is a model of its own, not part of either choice
 * (`modelsFor` in `asr/models.ts`; `tests/models-rows.test.ts` checks the two agree).
 */
export const DIARIZERS: Readonly<Record<string, readonly string[]>> = {
  nemotron: ["nemotron-3-diarization"],
  embeddings: ["pyannote-segmentation-3.0"],
};

/** The recognizer a job preset runs, so Jobs marks the row a preset in the setting stands for. */
export const PRESET_ENGINES: Readonly<Record<string, string>> = {
  fast: RECOGNIZER_ID,
  best: QWEN_ID,
};

/** The settings whose home is the Models page; the Settings page leaves them out and links here. */
export const MODELS_KEYS = [
  "asr.live",
  "asr.review.model",
  "asr.review.everySeconds",
  "asr.diarizer",
  "asr.accelerator",
  "server.models_unused_days",
  "server.models_max_gb",
] as const;

/** The defaults the page marks "(default)"; `tests/models-rows.test.ts` checks them against the registry. */
export const DEFAULTS: Readonly<Record<string, string>> = {
  "asr.live": "auto",
  "asr.review.model": "none",
  "asr.diarizer": "nemotron",
  "server.default_model": "auto",
};

const NAMES: Readonly<Record<string, string>> = {
  [RECOGNIZER_ID]: "Parakeet v3",
  [QWEN_ID]: "Qwen3-ASR 1.7B",
  "nemotron-3-diarization": "Nemotron diarization",
  "pyannote-segmentation-3.0": "Speech turns",
  "titanet-small": "Speaker voices",
  "silero-vad": "Voice detection",
  "nemotron-en-560": "Nemotron streaming, English",
  "nemotron-3.5-560": "Nemotron streaming, many languages",
  "nemotron-3.5-1120": "Nemotron streaming, many languages, 1 s",
  "nemotron-3.5-80": "Nemotron streaming, many languages, 80 ms",
  "nemotron-3.5-160": "Nemotron streaming, many languages, 160 ms",
  "nemotron-3.5-320": "Nemotron streaming, many languages, 320 ms",
  "nemotron-en-80": "Nemotron streaming, English, 80 ms",
  "nemotron-en-160": "Nemotron streaming, English, 160 ms",
  "nemotron-en-1120": "Nemotron streaming, English, 1 s",
};

/** What each build of Qwen3-ASR's program runs on, from the last part of its id. */
const BUILDS: Readonly<Record<string, string>> = {
  cpu: "the processor",
  metal: "the graphics chip",
  vulkan: "the graphics card, Vulkan",
  cuda: "an NVIDIA graphics card",
  rocm: "an AMD graphics card",
  sycl: "an Intel graphics card",
};

/**
 * A model's name in words: the page's own, else the catalog's (`name`), else, for a model nobody
 * named, its id.
 */
export function modelName(r: Pick<ModelRow, "id" | "job"> & { name?: string | null }): string {
  if (NAMES[r.id]) return NAMES[r.id] as string;
  if (r.name) return r.name;
  if (r.id.startsWith("llama-server")) {
    const on = BUILDS[r.id.slice(r.id.lastIndexOf("-") + 1)];
    return on ? `Qwen3-ASR's program for ${on}` : "Qwen3-ASR's program";
  }
  return r.id;
}

/** What `GET /server` lists that a job may name. */
export interface JobModels {
  presets?: readonly { name: string }[];
  engines?: readonly { id: string }[];
}

/**
 * The choices of a setting that names the model a job runs (`server.default_model`,
 * `server.dictation_engine`, SV-S1): Automatic for `auto`, each preset by its name, each engine by
 * its model's name, never a raw catalog id where the page has a name for it.
 */
export function jobModelChoices(s: JobModels): [value: string, label: string][] {
  const out = new Map<string, string>([["auto", "Automatic"]]);
  for (const p of s.presets ?? [])
    if (!out.has(p.name)) out.set(p.name, p.name.charAt(0).toUpperCase() + p.name.slice(1));
  for (const e of s.engines ?? [])
    if (!out.has(e.id)) out.set(e.id, modelName({ id: e.id, job: "" }));
  return [...out];
}

/** A live model's name on the page: Automatic, or the model's own name (`Nemotron 3.5`). */
export function liveName(id: string, title = id): string {
  return id === "auto" ? "Automatic" : title;
}

/** An interval's words in the page's list: `Every 2 min`. */
export function everyLabel(seconds: number): string {
  const t = everyText(seconds);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** `2.55 GB`, `40 MB`, `644 KB`, in powers of ten as the settings count them. */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** A model's size as the page gives it: `2.55 GB`, `0.40 GB`, and under 0.1 GB `47 MB`, `644 KB`. */
export function gbText(bytes: number): string {
  return bytes < 1e8 ? sizeText(bytes) : `${(bytes / 1e9).toFixed(2)} GB`;
}

/** How often a word is wrong: `1 word in 5` from 10 % up, `5 words in 100` below. */
function wordsWrong(pct: number): string {
  if (pct >= 10) return `1 word in ${Math.round(100 / pct)}`;
  const n = Math.max(1, Math.round(pct));
  return `${n} word${n === 1 ? "" : "s"} in 100`;
}

/** How often a second goes to the wrong speaker: `1 second in 10`, `6 seconds in 10`. */
function secondsWrong(pct: number): string {
  if (pct < 5) return `${Math.max(1, Math.round(pct))} second${pct < 1.5 ? "" : "s"} in 100`;
  const n = Math.round(pct / 10);
  return `${n} second${n === 1 ? "" : "s"} in 10`;
}

/**
 * The accuracy figure as a sentence naming its test set: "About 1 word in 5 wrong on meetings.",
 * "About 1 second in 10 given to the wrong speaker on real calls." Null when nobody measured it,
 * or the figure has no test set in words.
 */
export function accuracyText(s: ScoreView): string | null {
  if (s.score === null || !s.set) return null;
  if (s.metric === "wer" || s.metric === "call-wer")
    return `About ${wordsWrong(s.value)} wrong on ${s.set}.`;
  if (s.metric === "der")
    return `About ${secondsWrong(s.value)} given to the wrong speaker on ${s.set}.`;
  return null;
}

/** Minutes, one decimal under ten. */
function minutes(n: number): string {
  return n < 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n));
}

/**
 * How long an hour of audio takes: this machine's own runs when it has any, else the reference
 * machine's figure. Empty when neither is known.
 */
export function hourText(r: ModelRow, here: string): string {
  if (r.measured && r.measured.rtf > 0)
    return `An hour of audio in ${minutes(60 * r.measured.rtf)} minutes on ${here}.`;
  if (r.speed.score !== null && r.speed.metric === "rtfx" && r.speed.value > 0)
    return `An hour of audio in ${minutes(60 / r.speed.value)} minutes.`;
  return "";
}

/** The first letter lower case, to follow a colon. */
function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** A live setup's facts: its accuracy on meetings, then how its lines behave. */
export function liveHelp(s: LiveSetupView): string {
  return [accuracyText(s.accuracy), s.plain].filter((x) => x).join(" ");
}

/** What Automatic runs: Nemotron once a streaming model is here, else Parakeet. */
export function autoHelp(v: LiveView, here: string): string {
  const nemotron = v.setups.find((s) => s.id === "nemotron");
  const name = nemotron?.title ?? "Nemotron";
  const streams =
    v.setting === "auto"
      ? v.next === "nemotron"
      : (nemotron?.models.every((m) => m.state === "ready") ?? false);
  return streams
    ? `Uses ${name}, since it is on ${here}.`
    : `Uses Parakeet until ${name} is on ${here}.`;
}

/** The After the call row's facts: what it does, its accuracy, and how fast. */
export function afterCallHelp(r: ModelRow, here: string): string {
  return [
    "Writes the accurate transcript when a call ends.",
    accuracyText(r.accuracy),
    hourText(r, here),
  ]
    .filter((x) => x)
    .join(" ");
}

/** Dictation's Best row: the most accurate, what else it does, and what dictation does without it. */
export function bestHelp(r: ModelRow): string {
  const acc = accuracyText(r.accuracy);
  return [
    acc ? `The most accurate: ${lower(acc)}` : "The most accurate.",
    "It also writes the final transcript after a call, rewrites live lines and checks the words akou learns.",
    "Without it, dictation uses Fast.",
  ].join(" ");
}

/** A speaker setting's facts. */
export function speakersHelp(setting: string, rows: readonly ModelRow[]): string {
  const acc = rows.map((r) => accuracyText(r.accuracy)).find((x) => x) ?? null;
  if (setting === "nemotron")
    return ["Who spoke when, live and after the call.", acc].filter((x) => x).join(" ");
  return acc ? `The older way: ${lower(acc)}` : "The older way.";
}

/** A helper's line: what it is for. */
export function helperHelp(r: ModelRow): string {
  if (r.id === "silero-vad") return "Finds where someone speaks, for every model.";
  if (r.id === "titanet-small")
    return "Tells voices apart, live and after the call, whichever way speakers are found.";
  if (r.id.startsWith("llama-server")) return "The program Qwen3-ASR runs in.";
  if (r.kind === "speech" && r.streaming && !r.after_call)
    return [accuracyText(r.accuracy), "Writes the live transcript as words are said."]
      .filter((x) => x)
      .join(" ");
  const acc = accuracyText(r.accuracy);
  return acc ?? capital(r.job);
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What a model does in a call, the four groups of the All models page. */
export type Role = "live" | "final" | "speakers" | "helpers";
export const ROLES: readonly Role[] = ["live", "final", "speakers", "helpers"];

/**
 * A model's group: a recognizer that writes the transcript after the call is `final` even when it
 * can also stream (Parakeet); one that only streams is `live`.
 */
export function roleOf(r: Pick<ModelRow, "kind" | "after_call">): Role {
  if (r.kind === "speech") return r.after_call ? "final" : "live";
  return r.kind === "speakers" ? "speakers" : "helpers";
}

/** Each group's title; server mode has jobs, not calls. */
export function roleTitle(role: Role, server: boolean): string {
  if (role === "live") return "Live transcript";
  if (role === "final") return server ? "Jobs" : "After the call";
  return role === "speakers" ? "Speakers" : "Helpers";
}

const ON_DISK_FIRST: Readonly<Record<ModelRow["state"], number>> = {
  ready: 0,
  downloading: 1,
  missing: 2,
};

/**
 * The whole catalog in its four groups, empty groups left out, each with the models on disk first,
 * then the ones downloading, then the rest, in the catalog's order within each.
 */
export function catalogGroups(rows: readonly ModelRow[]): { role: Role; rows: ModelRow[] }[] {
  return ROLES.map((role) => ({
    role,
    rows: rows
      .filter((r) => roleOf(r) === role)
      .map((r, i) => ({ r, i }))
      .sort((a, b) => ON_DISK_FIRST[a.r.state] - ON_DISK_FIRST[b.r.state] || a.i - b.i)
      .map((x) => x.r),
  })).filter((g) => g.rows.length > 0);
}

/** A model's line on the All models page: its live line for a streaming model, else what it does. */
export function catalogLine(r: ModelRow): string {
  if (roleOf(r) === "live" && r.lines.live) return r.lines.live;
  return helperHelp(r);
}

/** The All models row's line on the main page: how many are here and how many more there are. */
export function allModelsText(rows: readonly ModelRow[], here: string): string {
  const on = rows.filter((r) => r.state === "ready").length;
  const more = rows.length - on;
  return more === 0 ? `Every model is on ${here}.` : `${on} on ${here}, ${more} more to download.`;
}

/** The page's line under its title: how much is on this computer, and that none of it leaves. */
export function totalText(rows: readonly ModelRow[], here: string, server: boolean): string {
  const bytes = rows.filter((r) => r.state === "ready").reduce((n, r) => n + r.size, 0);
  if (bytes === 0) return "Nothing downloaded yet.";
  const gb = (bytes / 1e9).toFixed(1);
  return `${gb} GB on ${here}. Nothing leaves ${server ? "this server" : "this computer"}.`;
}

/**
 * Last use and what the sweep does with it: kept, deleted on a date, or never deleted. A default no
 * setting chooses (the app's after-call recognizer, the voice detection) is one akou needs.
 */
export function keptText(r: ModelRow, unusedDays: number | null): string {
  if (r.state !== "ready") return r.state === "downloading" ? "Downloading" : "Not downloaded";
  const used = r.last_used_at ? `Last used ${when(r.last_used_at)}` : "Not used yet";
  if (r.default) return `${used}. Kept: ${r.set_default ? "the default" : "akou needs it"}.`;
  if (r.in_use) return `${used}. Kept: in use.`;
  if (r.evicts_at) return `${used}. Deleted on ${when(r.evicts_at)} if still unused.`;
  return unusedDays === 0 ? `${used}. Kept: nothing is deleted for being unused.` : `${used}.`;
}

/** Why Remove is not offered on a model (the size's tooltip says it), or null when it is. */
export function removeRefusal(r: ModelRow): string | null {
  if (r.state !== "ready") return r.state === "downloading" ? "It is downloading." : null;
  if (r.default) return "Kept: akou uses it by default. Choose another first.";
  if (r.in_use) return "Kept: in use right now.";
  return null;
}

/** Percent of a download, rounded down. */
export function percent(bytes: number, size: number): number {
  return size > 0 ? Math.floor((100 * bytes) / size) : 0;
}

/** "Needs Qwen3-ASR." for a setup or engine whose models are not all here. */
export function needsText(missing: readonly ModelRow[]): string {
  return missing.length === 0 ? "" : `Needs ${missing.map((r) => modelName(r)).join(" and ")}.`;
}

/**
 * A refused download, cancel or removal, or a stopped download, in plain words: the reason the
 * server gave, without the ids, keys and byte counts it carries. Empty when there is no plain one.
 */
export function reasonText(error: string | null | undefined): string {
  const e = (error ?? "").toLowerCase();
  if (/enospc|no space|free space|bytes free|volume has/.test(e))
    return "there is not enough free disk space";
  if (/models_max_gb|size cap/.test(e)) return "it would pass the size you keep models under";
  if (/still starting/.test(e)) return "akou is still starting";
  if (/auto_download/.test(e)) return "downloading a missing model is turned off";
  if (/is downloading/.test(e)) return "it is downloading";
  if (/default/.test(e)) return "akou uses it by default";
  if (/in use/.test(e)) return "it is in use";
  if (/enotfound|econn|etimedout|network|fetch failed|timed out|http \d/.test(e))
    return "the network failed";
  return "";
}

/** "A, B and C". */
export function joinAnd(parts: readonly string[]): string {
  return parts.length < 2
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
