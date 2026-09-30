/**
 * What the Record row's live panel shows (WINDOW W3.19), without the DOM so the rules can be
 * tested on their own: the two slots, Live and Second pass, each a list of the catalog models that
 * can fill it (`GET /models`, its `live.slots`) with their names and lines (the catalog's, through
 * `models`), which of them are downloaded, which one the next call runs, and what the button says.
 * The panel itself is `live-picker.ts`.
 */

import type { LiveView } from "../main/asr/live-setups.ts";
import { everyText } from "../main/asr/model-text.ts";
import type { ModelView } from "../main/server/model-store.ts";

export type Slot = "live" | "review";

/** One model of a slot, as the panel draws it. */
export interface SlotRow {
  /** The catalog id a pick saves. */
  id: string;
  name: string;
  /** Its line for this slot, from the catalog. */
  line: string;
  /** `ready`: every model it needs is here; `downloading`: one is on its way; else `missing`. */
  state: "ready" | "downloading" | "missing";
  /** Bytes on disk and in all, over every model it needs. */
  bytes: number;
  size: number;
  /** The models it needs here, in the order a download fetches them. */
  models: string[];
  /** The next call runs it. */
  checked: boolean;
  /** Why it cannot be picked here, in plain words, or null. */
  blocked: string | null;
}

/** A slot's models with their names, lines, state and size, in the panel's order. */
export function slotRows(v: LiveView, rows: readonly ModelView[], slot: Slot): SlotRow[] {
  const by = new Map(rows.map((r) => [r.id, r]));
  return v.slots[slot].map((e) => {
    const own = by.get(e.id);
    const parts = e.models.map((id) => by.get(id));
    const state = parts.every((p) => p?.state === "ready")
      ? "ready"
      : parts.some((p) => p?.state === "downloading")
        ? "downloading"
        : "missing";
    return {
      id: e.id,
      name: own?.name ?? e.id,
      line: own?.lines[slot] ?? "",
      state,
      bytes: parts.reduce((n, p) => n + (p?.bytes ?? 0), 0),
      size: parts.reduce((n, p) => n + (p?.size ?? 0), 0),
      models: e.models,
      checked: e.checked,
      blocked: e.blocked,
    };
  });
}

/** The intervals the Second pass heading offers, seconds. */
export const REVIEW_EVERY_CHOICES = [60, 120, 300] as const;

/** An interval as the switch and the button say it: `2 min`, `90 s`. */
export function everyShort(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/** The short name of a model, for the button: `Qwen` for Qwen3-ASR. */
function shortName(rows: readonly ModelView[], id: string): string {
  const r = rows.find((x) => x.id === id);
  return r?.short ?? r?.name ?? id;
}

/**
 * What the button says of the next call: the live model it runs, and with a second pass on, that
 * pass and how often (`+ Qwen 2 min`, drawn dim). `none` when no live model is downloaded.
 */
export function buttonLabel(
  v: LiveView,
  rows: readonly ModelView[],
): { name: string; extra: string | null; none: boolean } {
  const live = slotRows(v, rows, "live");
  const checked = live.find((r) => r.checked && r.state === "ready");
  if (!checked) return { name: "no model", extra: null, none: true };
  const review = slotRows(v, rows, "review").find((r) => r.checked);
  const every = v.review.next?.everySeconds ?? v.review.everySeconds;
  return {
    name: shortName(rows, checked.id),
    extra: review ? `+ ${shortName(rows, review.id)} ${everyShort(every)}` : null,
    none: false,
  };
}

/** The live call as the status names it: its model, and its second pass when one runs. */
export interface RunningLive {
  setup?: string | null;
  engine?: string | null;
  review?: { model: string; everySeconds: number } | null;
  name?: string;
  reviewName?: string;
}

/** What the button says while a call records: what that call runs. */
export function runningLabel(live: RunningLive): { name: string; extra: string | null } {
  const r = live.review;
  return {
    name: live.name ?? live.engine ?? live.setup ?? "",
    extra: r ? `+ ${live.reviewName ?? r.model} ${everyShort(r.everySeconds)}` : null,
  };
}

/** The call header's chip: `Live: Nemotron 3.5`, and `+ Qwen 2 min` with a second pass. */
export function liveChip(live: RunningLive): string | null {
  if (!live.setup) return null;
  const l = runningLabel(live);
  return `Live: ${l.name}${l.extra ? ` ${l.extra}` : ""}`;
}

/**
 * Why the saved live model is not the one a call runs, in plain words, when `asr.live` names one
 * that is not downloaded; null otherwise. The app then runs the checked one instead.
 */
export function liveNote(v: LiveView, rows: readonly ModelView[]): string | null {
  const live = slotRows(v, rows, "live");
  const checked = live.find((r) => r.checked && r.state === "ready");
  const saved = live.find((r) => r.id === v.setting);
  if (!checked || !saved || saved.id === checked.id || saved.state === "ready") return null;
  return `${saved.name} is not downloaded, so calls run ${checked.name} until it is.`;
}

/** Why the saved second pass does not run, in plain words; null when it runs or is Off. */
export function reviewNote(v: LiveView, rows: readonly ModelView[]): string | null {
  if (v.review.next || v.review.setting === "none") return null;
  const saved = slotRows(v, rows, "review").find(
    (r) => r.id === v.review.setting || shortKind(r.id) === v.review.setting,
  );
  if (!saved) return null;
  return saved.state !== "ready"
    ? `${saved.name} is not downloaded, so calls run with no second pass until it is.`
    : saved.blocked
      ? `${saved.name} is chosen, but calls run with no second pass: ${lower(saved.blocked)}`
      : null;
}

/** `qwen` or `parakeet` for a second-pass model id, the older values of `asr.review.model`. */
function shortKind(id: string): string {
  return id.startsWith("qwen") ? "qwen" : id.startsWith("parakeet") ? "parakeet" : id;
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export { everyText };

/** A download's size as the Add a model list says it: `0.7 GB`, `40 MB`. */
export function sizeShort(bytes: number): string {
  if (bytes >= 1e8) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
