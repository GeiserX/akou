/**
 * Rendering for packs and every text surface a model reads (docs/DESIGN.md sections 4.4 and 5.4).
 *
 * The rules this file enforces:
 * - Every time is local wall-clock time in the call's zone. A line carries seconds
 *   (`15:41:07`), a citation carries a speaker (`[15:41 Ben]`), and elapsed time is only ever
 *   shown with its label (`12:30 into the call`). An audio offset (`a0`, `a1`) is never rendered.
 * - A committed line carries its segment id (`#l000031`), so it can be cited and resolved later.
 * - The provisional line is the only line without an id. It is marked `DRAFT` and "(still being
 *   spoken, may change)", so it can never be cited as what was said.
 */

import { formatElapsed, formatWall, formatZone } from "../../core/log/clock.ts";
import type { CallState, Line, Provisional } from "../../core/log/fold.ts";

// ---------------------------------------------------------------------------
// Token estimate

/**
 * A conservative token estimate with no tokenizer: about four ASCII characters per token, two for
 * other alphabetic scripts, one per character elsewhere (CJK, Devanagari and the like). Budgets are
 * enforced with this number, so it errs on the high side.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 0.25 : c < 0x0530 ? 0.5 : 1;
  }
  return Math.ceil(n);
}

// ---------------------------------------------------------------------------
// Lines

export interface RenderOptions {
  tz: string;
  /** Speaker ids (`c2`) instead of labels, for the stable prefix of whole-call mode. */
  speakerIds?: boolean;
}

/** The speaker shown on a line: the label (`Ben`, `Speaker 2`) or the id for whole-call mode. */
export function lineSpeaker(line: Line, opts: RenderOptions): string {
  return opts.speakerIds ? line.spk : line.speaker;
}

/**
 * One committed line: `#l000031 15:41:07 Ben: we should move the build to Kubernetes (heard:
 * "kubernetis")`. The text is the annotated form, so a correction is visible to the model.
 */
export function renderLine(line: Line, opts: RenderOptions): string {
  return `#${line.id} ${formatWall(line.w0, opts.tz)} ${lineSpeaker(line, opts)}: ${line.annotated}`;
}

/** The marker every provisional line carries, and the only line that carries it. */
export const DRAFT_MARK = "DRAFT";
export const DRAFT_NOTE = "(still being spoken, may change)";

/** The provisional line: no id, marked as a draft. Never cite it; it is not in the log. */
export function renderProvisional(p: Provisional, speaker: string, tz: string): string {
  return `${DRAFT_MARK} ${formatWall(p.w0, tz)} ${speaker}: ${p.text} ${DRAFT_NOTE}`;
}

/** The citation form a model is told to use: `[15:41 Ben]`. */
export function formatCitation(w: number, speaker: string, tz: string): string {
  return `[${formatWall(w, tz, { seconds: false })} ${speaker}]`;
}

// ---------------------------------------------------------------------------
// Status line

export interface StatusInput {
  state: CallState;
  /** Wall time the call ended, or was interrupted: the end of its last part. */
  endedAt?: number;
  /** Wall time a pause began, when paused. */
  pausedAt?: number;
  now: number;
  tz: string;
  /** Leave out "(38 min ago)", which changes every minute: whole-call mode keeps it in the tail. */
  stable?: boolean;
}

export type PackState = "LIVE" | "ENDED" | "INTERRUPTED" | "FAILED" | "STARTING";

export function packState(state: CallState): PackState {
  switch (state) {
    case "recording":
    case "paused":
    case "restarting":
      return "LIVE";
    case "interrupted":
    case "crashed":
      return "INTERRUPTED";
    case "failed":
      return "FAILED";
    case "empty":
    case "starting":
      return "STARTING";
    default:
      return "ENDED";
  }
}

/** Minutes and hours since a time, for "ENDED at 15:52 (38 min ago)". */
export function formatAgo(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h ago` : `${h} h ${m} min ago`;
}

/**
 * The first line of every pack: `LIVE, recording now`, `ENDED at 15:52 (38 min ago)` or
 * `INTERRUPTED since 15:44`. A call that is not recording never reads as live.
 */
export function statusLine(s: StatusInput): string {
  const at = (w: number) => formatWall(w, s.tz, { seconds: false });
  switch (packState(s.state)) {
    case "LIVE":
      if (s.state === "paused" && s.pausedAt !== undefined) {
        return `LIVE, paused since ${at(s.pausedAt)}`;
      }
      return s.state === "restarting" ? "LIVE, restarting capture" : "LIVE, recording now";
    case "INTERRUPTED":
      return s.endedAt !== undefined ? `INTERRUPTED since ${at(s.endedAt)}` : "INTERRUPTED";
    case "FAILED":
      return "FAILED to start, nothing was recorded";
    case "STARTING":
      return "STARTING, nothing recorded yet";
    default: {
      if (s.endedAt === undefined) return "ENDED";
      const ago = s.stable ? "" : ` (${formatAgo(s.now - s.endedAt)})`;
      return `ENDED at ${at(s.endedAt)}${ago}`;
    }
  }
}

/** `Now: 16:02:40, 26:28 into the call`. The elapsed time always carries its label. */
export function nowLine(now: number, start: number | undefined, tz: string): string {
  const wall = formatWall(now, tz);
  return start === undefined ? `Now: ${wall}` : `Now: ${wall}, ${formatElapsed(now - start)}`;
}

export function zoneLine(tz: string, at: number): string {
  return `Times are local wall clock, ${formatZone(tz, at)}.`;
}

// ---------------------------------------------------------------------------
// Checks that keep the rules honest

const TIME_LIKE = /(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/g;

export interface TimeAuditOptions {
  tz: string;
  /** Wall times a time on this surface may name: the call's span, with a margin. */
  from: number;
  to: number;
}

/**
 * Finds every clock-like time in a rendered text that is neither a labelled elapsed time (`12:30
 * into the call`) nor a local wall time inside the call's span. An audio offset rendered as
 * `2:11` fails this check unless it happens to equal a wall time of the call. Returns the
 * offenders; empty means the text passes.
 */
export function auditTimes(text: string, opts: TimeAuditOptions): string[] {
  const allowed = wallMinutes(opts);
  const bad: string[] = [];
  for (const m of text.matchAll(TIME_LIKE)) {
    const after = text.slice((m.index ?? 0) + m[0].length);
    if (/^ into the call/.test(after)) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!allowed.has(hh * 60 + mm) || hh > 23 || mm > 59) bad.push(m[0]);
  }
  return bad;
}

function wallMinutes(opts: TimeAuditOptions): Set<number> {
  const out = new Set<number>();
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: opts.tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const start = Math.floor(opts.from / 60_000) * 60_000;
  // Walking minute by minute is cheap for a call and exact across zone changes.
  for (let w = start; w <= opts.to + 60_000; w += 60_000) {
    const [h, m] = f.format(new Date(w)).split(":");
    out.add(Number(h) * 60 + Number(m));
    if (out.size >= 1440) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Citations

export interface Citation {
  /** The citation as written, `[15:41 Ben]`. */
  raw: string;
  hhmm: string;
  speaker: string;
}

const CITATION = /\[(\d{1,2}:\d{2})(?::\d{2})? ([^\]\n]+)\]/g;

export function parseCitations(answer: string): Citation[] {
  return [...answer.matchAll(CITATION)].map((m) => ({
    raw: m[0],
    hhmm: (m[1] as string).padStart(5, "0"),
    speaker: (m[2] as string).trim(),
  }));
}

export interface CitationCheck {
  citation: Citation;
  /** Committed lines the citation can refer to: same minute, same speaker. */
  lines: string[];
  /** True when the only thing it can refer to is the provisional line. */
  draftOnly: boolean;
  ok: boolean;
}

/**
 * Checks each `[HH:MM Name]` citation in an answer against the committed lines of the pack it was
 * built from. A citation that matches no committed line fails, and one that matches only the
 * provisional line is flagged `draftOnly`: a draft is never cited as what was said.
 */
export function checkCitations(
  answer: string,
  pack: {
    tz: string;
    lines: readonly Line[];
    provisional?: { w0: number; speaker: string } | null;
  },
): CitationCheck[] {
  const key = (w: number, speaker: string) =>
    `${formatWall(w, pack.tz, { seconds: false })}|${speaker.toLowerCase()}`;
  const byKey = new Map<string, string[]>();
  for (const l of pack.lines) {
    for (const label of [l.speaker, l.spk]) {
      const k = key(l.w0, label);
      const list = byKey.get(k) ?? [];
      if (!list.includes(l.id)) list.push(l.id);
      byKey.set(k, list);
    }
  }
  const draftKey = pack.provisional ? key(pack.provisional.w0, pack.provisional.speaker) : null;
  return parseCitations(answer).map((c) => {
    const k = `${c.hhmm}|${c.speaker.toLowerCase()}`;
    const lines = byKey.get(k) ?? [];
    const draftOnly = lines.length === 0 && k === draftKey;
    return { citation: c, lines, draftOnly, ok: lines.length > 0 };
  });
}
