/**
 * Clocks (docs/DESIGN.md section 4.4).
 *
 * Each segment stores two times: `a0`/`a1`, seconds into its part's audio file (for seeking only),
 * and `w0`/`w1`, UTC epoch milliseconds. Wall times are computed when a segment is written, from
 * the helper's host-clock timestamp (`capture_ns`) through the part's anchors: `part.started`
 * pairs `wallStart` with `monoStart`, and every `resume` re-anchors. The host clock keeps running
 * during sleep and pauses, so paused time and sleep land correctly, and a system-clock change
 * mid-call cannot bend earlier timestamps.
 *
 * The audio file stops advancing while paused or asleep, so mapping a file position to wall time
 * uses a different anchor chain: the part start (a = 0), every `resume`, and every `gap`. A
 * `pause` is not an anchor; the `resume` that ends it is.
 *
 * Every time a person or a model reads is local wall-clock time. Elapsed time is only ever shown
 * with a label, never as a bare `mm:ss`.
 */

import type { Gap, LogEvent, PartStarted, Resume } from "./events.ts";

/** Host clock nanoseconds (the helper's u64 `capture_ns`) to the milliseconds stored in the log. */
export function nsToMs(ns: bigint | number): number {
  if (typeof ns === "bigint") {
    const whole = ns / 1_000_000n;
    const rest = ns % 1_000_000n;
    return Number(whole) + Number(rest) / 1e6;
  }
  return ns / 1e6;
}

interface MonoAnchor {
  mono: number;
  wall: number;
}

interface AudioAnchor {
  a: number;
  wall: number;
}

export class PartClock {
  readonly part: number;
  private readonly mono: MonoAnchor[];
  private readonly audio: AudioAnchor[];

  constructor(started: Pick<PartStarted, "part" | "wallStart" | "monoStart">) {
    this.part = started.part;
    this.mono = [{ mono: started.monoStart, wall: started.wallStart }];
    this.audio = [{ a: 0, wall: started.wallStart }];
  }

  /** Builds the clock of one part from a call's events. */
  static fromEvents(events: readonly LogEvent[], part: number): PartClock | null {
    let clock: PartClock | null = null;
    for (const e of events) {
      if (e.type === "part.started" && e.part === part) clock = new PartClock(e);
      else if (clock) clock.apply(e);
    }
    return clock;
  }

  /** Feeds one event; anything that is not an anchor of this part is ignored. */
  apply(e: LogEvent): void {
    if (e.type === "resume" && e.part === this.part) this.resume(e);
    else if (e.type === "gap" && e.part === this.part) this.gap(e);
  }

  resume(r: Pick<Resume, "a" | "wall" | "mono">): void {
    insertSorted(this.mono, { mono: r.mono, wall: r.wall }, (x) => x.mono);
    insertSorted(this.audio, { a: r.a, wall: r.wall }, (x) => x.a);
  }

  /** Sleep: the file stopped at `a`; audio after it is at `wallTo`. */
  gap(g: Pick<Gap, "a" | "wallTo">): void {
    insertSorted(this.audio, { a: g.a, wall: g.wallTo }, (x) => x.a);
  }

  /** Wall time (epoch ms) of a host-clock instant in milliseconds. */
  wallFromMono(monoMs: number): number {
    const anchor = lastAtOrBefore(this.mono, monoMs, (x) => x.mono) ?? (this.mono[0] as MonoAnchor);
    return anchor.wall + (monoMs - anchor.mono);
  }

  /** Wall time (epoch ms) of a host-clock timestamp in nanoseconds, as the helper reports it. */
  wallFromCapture(captureNs: bigint | number): number {
    return this.wallFromMono(nsToMs(captureNs));
  }

  /** Wall time (epoch ms) of a position in this part's audio file. */
  wallFromAudio(a: number): number {
    const anchor = lastAtOrBefore(this.audio, a, (x) => x.a) ?? (this.audio[0] as AudioAnchor);
    return anchor.wall + (a - anchor.a) * 1000;
  }

  /**
   * Position in the audio file for a wall time, for seeking. A time inside a pause or a sleep
   * seeks to where the audio resumed.
   */
  audioFromWall(w: number): number {
    let a = 0;
    for (let i = 0; i < this.audio.length; i++) {
      const anchor = this.audio[i] as AudioAnchor;
      if (w < anchor.wall) break;
      const next = this.audio[i + 1];
      a = anchor.a + (w - anchor.wall) / 1000;
      if (next && a > next.a) a = next.a;
    }
    return Math.max(0, a);
  }
}

function insertSorted<T>(list: T[], item: T, key: (x: T) => number): void {
  let i = list.length;
  while (i > 0 && key(list[i - 1] as T) > key(item)) i--;
  list.splice(i, 0, item);
}

function lastAtOrBefore<T>(list: readonly T[], v: number, key: (x: T) => number): T | undefined {
  let found: T | undefined;
  for (const x of list) {
    if (key(x) <= v) found = x;
    else break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Rendering

const timeFormats = new Map<string, Intl.DateTimeFormat>();

function timeFormat(tz: string, seconds: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${seconds}`;
  let f = timeFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      second: seconds ? "2-digit" : undefined,
      hourCycle: "h23",
    });
    timeFormats.set(key, f);
  }
  return f;
}

/** Local wall-clock time in the call's zone: `15:41:07`, or `15:41` for citations. */
export function formatWall(w: number, tz: string, opts: { seconds?: boolean } = {}): string {
  return timeFormat(tz, opts.seconds ?? true).format(new Date(w));
}

/** The zone, stated once per surface: `America/Chicago (GMT-5)`. */
export function formatZone(tz: string, at: number): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(new Date(at))
    .find((p) => p.type === "timeZoneName");
  return part ? `${tz} (${part.value})` : tz;
}

/** Local calendar date in the call's zone, `2026-09-23`, for filing a call under the right day. */
export function formatLocalDate(w: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(w));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Elapsed time, always labelled: `12:30 into the call`. Never use this as the only time on a
 * line; it is a secondary field beside the wall time.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return `${clock} into the call`;
}

/** A bare `mm:ss` or `m:ss` with nothing else: the shape an offset must never be rendered in. */
export function isBareOffset(text: string): boolean {
  return /^\s*\d{1,2}:\d{2}\s*$/.test(text);
}
