/**
 * The lines of the Record row's live model menu (WINDOW W3.19), without the DOM so the rule can be
 * tested on its own: only the live setups whose every model is on disk, Automatic first when at
 * least one is, each with its name and one plain line. The menu itself is `live-picker.ts`.
 */

import type { LiveSetting, LiveView } from "../main/asr/live-setups.ts";

/** One line of the menu: a value of `asr.live`, its name, and what it does in plain words. */
export interface LiveOption {
  id: LiveSetting;
  title: string;
  line: string;
}

/** The setups a call can run, in the menu's order after Automatic. */
const SETUPS: readonly Exclude<LiveSetting, "auto">[] = ["nemotron", "upgrade", "parakeet"];

const TITLE: Record<LiveSetting, string> = {
  auto: "Automatic",
  nemotron: "Streaming (Nemotron)",
  upgrade: "Streaming + Qwen rewrite",
  parakeet: "Parakeet between pauses",
};

const LINE: Record<Exclude<LiveSetting, "auto">, string> = {
  nemotron: "Words appear as they are said and never change.",
  upgrade: "Streams the words, then Qwen rewrites the last minute's sentences once a minute.",
  parakeet: "Writes each stretch between pauses; words can change for a moment.",
};

export function liveTitle(id: string): string {
  return TITLE[id as LiveSetting] ?? id;
}

/**
 * The menu's lines: only the setups whose every model is on disk, Automatic first when at least
 * one is. Automatic's line names what it runs here (streaming when its model is on disk, else
 * Parakeet, or the Qwen review when the Mac allows it), the rule the app follows when the call
 * starts.
 */
export function liveOptions(v: LiveView): LiveOption[] {
  const ready = new Set(
    v.setups
      .filter(
        (s) => !s.unavailable && s.models.length > 0 && s.models.every((m) => m.state === "ready"),
      )
      .map((s) => s.id as string),
  );
  const setups = SETUPS.filter((id) => ready.has(id));
  if (setups.length === 0) return [];
  const auto =
    v.auto && ready.has(v.auto) ? v.auto : ready.has("nemotron") ? "nemotron" : "parakeet";
  return [
    { id: "auto", title: TITLE.auto, line: `Picks the best one here: ${TITLE[auto]} now.` },
    ...setups.map((id) => ({ id, title: TITLE[id], line: LINE[id] })),
  ];
}

/** The checked line: `asr.live` when it is listed, else none; the check never moves to a setup nobody chose. */
export function liveChecked(v: LiveView, options: readonly LiveOption[]): LiveSetting | null {
  return options.some((o) => o.id === v.setting) ? v.setting : null;
}

/**
 * Why the saved setup is not the one a call runs, in plain words, when `asr.live` names a setup
 * whose models are not all here; null when it is listed. The app then runs `next` instead, the
 * same fallback the CLI and the hotkey get.
 */
export function liveNote(v: LiveView, options: readonly LiveOption[]): string | null {
  if (options.length === 0 || liveChecked(v, options) !== null) return null;
  return `${liveTitle(v.setting)} is not downloaded, so calls run ${liveTitle(v.next)} until it is.`;
}
