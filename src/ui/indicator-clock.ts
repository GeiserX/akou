/**
 * The floating indicator's clock (docs/ux/DESKTOP.md DK-F1), apart from the page so the unit tests
 * read it without a DOM. The elapsed time is the call's recorded time: from its first part, carried
 * across a new part (a capture rebuild, a wake), and standing still while paused.
 */

import type { IndicatorEvent } from "./indicator-protocol.ts";

/**
 * The call's recorded time at `now` from its events: the running spans (a part's start or a resume,
 * to a pause or the part's end) added up. `since` is the first part's start, or null before one.
 */
export function recordedMs(
  events: readonly IndicatorEvent[],
  now: number,
): { ms: number; since: number | null } {
  let ms = 0;
  let running: number | null = null;
  let since: number | null = null;
  const halt = (at: number) => {
    if (running !== null) ms += Math.max(0, at - running);
    running = null;
  };
  for (const e of events) {
    if (e.type === "part.started") {
      since ??= e.wallStart;
      running ??= e.wallStart;
    } else if (e.type === "resume") running ??= e.wall;
    else if (e.type === "pause") halt(e.wall);
    else if (e.type === "part.ended") halt(e.at);
  }
  if (running !== null) ms += Math.max(0, now - running);
  return { ms, since };
}

/** `h:mm:ss`, or `m:ss` under an hour: a duration, never a time of day. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}
