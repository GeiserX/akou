/**
 * The lines of the Record row's live model menu (WINDOW W3.19), without the DOM so the rules can
 * be tested on their own: the live models by name, each with one plain line, a model that is not
 * downloaded listed dim with Get, a model this machine cannot run left out; then the second pass,
 * its model and how often it reviews. The menu itself is `live-picker.ts`.
 */

import { everyText, liveModelName } from "../main/asr/live-names.ts";
import type { LiveView, ReviewModel, RunnableSetup } from "../main/asr/live-setups.ts";

/** One live model of the menu: a value of `asr.live`, its name and its plain line. */
export interface LiveOption {
  id: RunnableSetup;
  title: string;
  line: string;
  /** Every model it loads is on disk: it can be picked. */
  ready: boolean;
}

/** The live models in the menu's order. */
const MODELS: readonly RunnableSetup[] = ["nemotron", "parakeet"];

/**
 * The menu's models: each one this machine can run, by name, with its line and whether it is
 * downloaded. None at all when not one is downloaded: the menu then says so and offers Get models.
 */
export function liveOptions(v: LiveView): LiveOption[] {
  const out: LiveOption[] = [];
  for (const id of MODELS) {
    const s = v.setups.find((x) => x.id === id);
    if (!s || s.unavailable || s.models.length === 0) continue;
    out.push({
      id,
      title: s.title,
      line: s.line,
      ready: s.models.every((m) => m.state === "ready"),
    });
  }
  return out.some((o) => o.ready) ? out : [];
}

/**
 * The checked model: the one the next call runs when it is the one chosen, `auto` included (the
 * app's own rule); none when `asr.live` names a model that is not here.
 */
export function liveChecked(v: LiveView, options: readonly LiveOption[]): RunnableSetup | null {
  const want = v.setting === "auto" ? v.next : v.setting;
  return options.some((o) => o.id === want && o.ready) ? want : null;
}

/**
 * Why the saved model is not the one a call runs, in plain words, when `asr.live` names one whose
 * models are not all here; null otherwise. The app then runs `next` instead, the same fallback the
 * CLI and the hotkey get.
 */
export function liveNote(v: LiveView, options: readonly LiveOption[]): string | null {
  if (options.length === 0 || liveChecked(v, options) !== null) return null;
  return `${liveTitle(v, v.setting)} is not downloaded, so calls run ${liveTitle(v, v.next)} until it is.`;
}

/** A live model's name here: the Nemotron that would run, by its model. */
export function liveTitle(v: LiveView | null, id: string): string {
  return v?.setups.find((s) => s.id === id)?.title ?? liveModelName(id);
}

/** One choice of the second pass: Off, or a model with its line and what stops it here. */
export interface ReviewOption {
  id: ReviewModel;
  title: string;
  line: string;
  /** `ready`: it can be picked; `missing`: its models are not downloaded (Get); `blocked`: `why`. */
  state: "ready" | "missing" | "blocked";
  why?: string;
}

/** The intervals the menu offers, seconds. */
export const REVIEW_EVERY_CHOICES = [60, 120, 300] as const;

/**
 * The intervals to draw: the three offered, and the saved one when it is another (90 or 600 s set
 * from the CLI), so the saved value always shows as itself.
 */
export function everyChoices(saved: number): number[] {
  const all: number[] = [...REVIEW_EVERY_CHOICES];
  return all.includes(saved) ? all : [...all, saved].sort((a, b) => a - b);
}

/** An interval as the menu's switch says it: `2 min`, `90 s`. */
export function everyShort(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

export function reviewOptions(v: LiveView): ReviewOption[] {
  const r = v.review;
  return [
    { id: "none", title: "Off", line: "The live lines stay as they were written.", state: "ready" },
    ...r.choices.map((c): ReviewOption => {
      const missing = c.models.some((m) => m.state !== "ready");
      return {
        id: c.id,
        title: c.title,
        line: c.blocked ?? c.line,
        // Blocked first: a model that could not run anyway offers no Get.
        state: c.blocked ? "blocked" : missing ? "missing" : "ready",
        ...(c.blocked ? { why: c.blocked } : {}),
      };
    }),
  ];
}

/**
 * The checked second pass: the one the next call runs, Off when none is chosen, and none when the
 * chosen one cannot run. A Qwen chosen elsewhere on a Mac the menu does not offer it on runs, and
 * keeps its check.
 */
export function reviewChecked(v: LiveView, _options?: readonly ReviewOption[]): ReviewModel | null {
  if (v.review.next) return v.review.next.model;
  return v.review.setting === "none" ? "none" : null;
}

/** Why the saved second pass does not run, in plain words; null when it runs or is Off. */
export function reviewNote(v: LiveView, options: readonly ReviewOption[]): string | null {
  if (reviewChecked(v) !== null) return null;
  const o = options.find((x) => x.id === v.review.setting);
  if (!o) return null;
  return o.state === "missing"
    ? `${o.title} is not downloaded, so calls run with no second pass until it is.`
    : `${o.title} is chosen, but calls run with no second pass: ${lower(o.why ?? "")}`;
}

/** The second pass the next call runs, as the menu's line says it: `Off`, `Qwen, every 2 min`. */
export function reviewLabel(v: LiveView): string {
  const n = v.review.next;
  return n ? `${liveModelName(n.model)}, ${everyText(n.everySeconds)}` : "Off";
}

/** The call header's chip: `Live: Nemotron 3.5`, and `, Qwen every 2 min` with a second pass. */
export function liveChip(live: {
  setup?: string | null;
  engine?: string | null;
  review?: { model: string; everySeconds: number } | null;
}): string | null {
  if (!live.setup) return null;
  const model = liveModelName(live.engine ?? live.setup);
  const r = live.review;
  return `Live: ${model}${r ? `, ${liveModelName(r.model)} ${everyText(r.everySeconds)}` : ""}`;
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
