/**
 * What the window shows, decided without the DOM (docs/DESIGN.md section 7), so each rule has a
 * plain unit test: the state label, the banner, the final-pass note, speaker hues, durations and
 * citations. The DOM modules only draw what these return.
 *
 * Every time shown is local wall clock in the call's zone; a length of time always carries a unit
 * or a label ("12 min into the call"), never a bare `mm:ss` (TRAPS "Offsets shown as times of
 * day").
 */

import { formatWall } from "../core/log/clock.ts";
import type { CallView } from "../core/log/fold.ts";
import { hotkeyLabel } from "../main/window/hotkey.ts";
import type { AppStatus } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Speaker hues

/**
 * Everyone but you gets the next hue in order of first appearance, and none of them sits on the
 * accent's hue (WINDOW section 8). You keep a hue of your own for the log's sake, but the window
 * draws you in a neutral grey (`--you` in theme.css), so the accent stays for the one primary action.
 */
export const YOU_HUE = 214;
export const HUES = [36, 145, 285, 5, 178, 58, 325, 100] as const;

/**
 * Stable hues per speaker id. Keyed by the id, not the name, so a renamed speaker keeps its hue;
 * a merged id takes the hue of the speaker it merged into.
 */
export class HueBook {
  private readonly hues = new Map<string, number>([["you", YOU_HUE]]);
  private next = 0;

  hue(spk: string): number {
    const cur = this.hues.get(spk);
    if (cur !== undefined) return cur;
    const h = HUES[this.next % HUES.length] as number;
    this.next++;
    this.hues.set(spk, h);
    return h;
  }
}

/**
 * The player bar has something to play (WINDOW section 5): a saved call with at least one recorded
 * part. With no call, or while the call is live, there is no bar at all.
 */
export function hasRecording(v: CallView | null): boolean {
  return !!v?.call && !v.live && v.parts().length > 0;
}

// ---------------------------------------------------------------------------
// Time

/** A length of time with its units: `45 s`, `3 min 5 s`, `1 h 2 min`. Never `mm:ss`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  const r = s % 60;
  return r > 0 ? `${m} min ${r} s` : `${m} min`;
}

// ---------------------------------------------------------------------------
// The state label (hark-viewer's states, with "offline" split by what actually happened)

export type StateClass =
  | "ready"
  | "recording"
  | "paused"
  | "saved"
  | "offline"
  | "failed"
  | "other";

export interface StateLabel {
  cls: StateClass;
  label: string;
  meta: string;
}

export interface StateInput {
  view: CallView | null;
  status: AppStatus | null;
  /** The follower cannot reach the app. */
  disconnected: boolean;
  now: number;
  /** When the last committed line arrived, for "last line 5 s ago". */
  lastLineAt: number | null;
  /** When the last audio level arrived; a live call with none for 5 s is not capturing. */
  levelAt: number | null;
  /** When the page's follow of this call first opened (null: not yet), for a call joined late. */
  followedAt: number | null;
  /**
   * The window has been reconnecting for longer than a follow request may take: its RPC socket may
   * be gone for good (ElectroBun #518, #550), and only a new window gets a new one.
   */
  reopen?: boolean;
  lines: number;
  /**
   * The welcome is on screen (WINDOW section 10): the speech models are missing, so nothing can
   * record, and the state word must not say ready.
   */
  setup?: boolean;
}

/** Channel health states that mean nothing is being recorded on that side. */
const DEAD_STATES = new Set(["dead", "stalled", "no-buffers"]);

/**
 * Nothing is being recorded: both channels are proven dead, or no level for 5 s. With no level yet,
 * the 5 s count from the later of the part's start and the page's first follow, so a call opened
 * while it records is not declared dead before its first level can arrive.
 */
export function notCapturing(
  v: CallView,
  now: number,
  levelAt: number | null,
  followedAt: number | null,
): boolean {
  if (!v.live || v.state === "paused") return false;
  const mic = v.channelHealth("mic")?.state;
  const call = v.channelHealth("call")?.state;
  if (mic && call && DEAD_STATES.has(mic) && DEAD_STATES.has(call)) return true;
  if (levelAt !== null) return now - levelAt > 5000;
  if (followedAt === null) return false;
  const started = v.parts().at(-1)?.wallStart ?? now;
  return now - Math.max(started, followedAt) > 5000;
}

/** Longer than a follow request may wait for its answer (the window's RPC timeout, 30 s). */
export const REOPEN_AFTER_MS = 40_000;

/**
 * Whether to tell the user to close and reopen the window: only the window, and only once it has
 * been reconnecting past a follow request's timeout. A browser page reconnects over HTTP by itself.
 */
export function suggestReopen(
  surface: "window" | "browser",
  disconnectedSince: number | null,
  now: number,
): boolean {
  return (
    surface === "window" && disconnectedSince !== null && now - disconnectedSince > REOPEN_AFTER_MS
  );
}

export function stateLabel(i: StateInput): StateLabel {
  const v = i.view;
  const liveId = i.status?.live?.call ?? null;
  if (i.disconnected) {
    return {
      cls: "offline",
      label: "reconnecting",
      meta: i.reopen
        ? "akou is not answering; retrying. If this stays, close this window and open it again"
        : "akou is not answering; retrying",
    };
  }
  // The welcome covers the page even when the last saved call sits open behind it, so the word
  // follows the welcome, not that call. A call recording elsewhere still says so.
  if (i.setup && !liveId) {
    return { cls: "ready", label: "setup", meta: "the speech models are not here yet" };
  }
  if (!v?.call) {
    if (liveId) return { cls: "other", label: "another call is recording", meta: "" };
    return { cls: "ready", label: "ready", meta: "" };
  }
  if (v.live) {
    const first = v.parts()[0]?.wallStart ?? i.now;
    const bits = [`recording for ${formatDuration((i.now - first) / 1000)}`];
    if (v.muted) bits.push("mic muted");
    if (i.lastLineAt !== null) {
      bits.push(`last line ${formatDuration((i.now - i.lastLineAt) / 1000)} ago`);
    }
    if (v.state === "paused") return { cls: "paused", label: "paused", meta: bits.join("  ·  ") };
    if (notCapturing(v, i.now, i.levelAt, i.followedAt)) {
      return {
        cls: "offline",
        label: "not capturing",
        meta: "the call is open and nothing is being recorded",
      };
    }
    return { cls: "recording", label: "rec", meta: bits.join("  ·  ") };
  }
  const lines = `${i.lines} ${i.lines === 1 ? "line" : "lines"}`;
  if (liveId && liveId !== v.call.id) {
    return { cls: "other", label: "another call is recording", meta: lines };
  }
  switch (v.state) {
    case "failed":
      return {
        cls: "failed",
        label: "recording failed",
        meta: v.failure ? `${v.failure.stage}: ${v.failure.error}` : "",
      };
    case "crashed":
      return {
        cls: "offline",
        label: "ended unexpectedly",
        meta: `${lines}  ·  press Restart to carry on`,
      };
    case "interrupted":
      return { cls: "offline", label: "interrupted", meta: lines };
    case "starting":
    case "stopping":
    case "restarting":
      return { cls: "recording", label: v.state, meta: "" };
    default:
      return { cls: "saved", label: "saved", meta: lines };
  }
}

// ---------------------------------------------------------------------------
// The banner under the header: red proven, amber a guess or a lag, grey quiet, green recovered

export type BannerKind = "dead" | "permission" | "guess" | "lag" | "quiet" | "recovered";

export interface Banner {
  kind: BannerKind;
  text: string;
  /** The action the banner offers. */
  action?: "restart" | "open-settings";
}

export interface BannerInput {
  view: CallView | null;
  now: number;
  lastLineAt: number | null;
  /** When the call channel's level last rose above -60 dBFS (null: never while shown). */
  callHeardAt: number | null;
  levelAt: number | null;
  /** The platform, for naming the right settings pane. */
  platform: "mac" | "windows" | "linux";
}

export const QUIET_AFTER_MS = 90_000;
export const LAG_AMBER_S = 10;
export const RECOVERED_FOR_MS = 30_000;

export function banner(i: BannerInput): Banner | null {
  const v = i.view;
  if (!v?.call) return null;
  if (v.state === "interrupted") {
    return {
      kind: "dead",
      text: "RECORDING INTERRUPTED. The capture failed five times in ten minutes and akou stopped trying. Press Restart to carry on in the same call.",
      action: "restart",
    };
  }
  if (!v.live) return null;
  const call = v.channelHealth("call");
  const mic = v.channelHealth("mic");
  if (call?.state === "stalled" || mic?.state === "stalled") {
    return {
      kind: "dead",
      text: "NOTHING IS BEING RECORDED. The capture stopped sending audio; akou is restarting it. If this stays, press Restart.",
      action: "restart",
    };
  }
  if (call?.state === "dead") {
    const n = call.rebuilds;
    return {
      kind: "dead",
      text: `CALL AUDIO LOST for ${formatDuration(call.silentFor + (i.now - call.t) / 1000)}. Audio is playing and akou hears none of it. akou is rebuilding the capture${n > 0 ? ` (${n} ${n === 1 ? "rebuild" : "rebuilds"} so far)` : ""} and restarts it after a minute. If this stays, press Restart.`,
      action: "restart",
    };
  }
  if (call?.state === "permission-suspect" || mic?.state === "permission-suspect") {
    const what = call?.state === "permission-suspect" ? "System Audio Recording" : "Microphone";
    const where =
      i.platform === "mac"
        ? `System Settings > Privacy & Security > ${what}`
        : i.platform === "windows"
          ? "Settings > Privacy > Microphone"
          : "your system's sound settings";
    return {
      kind: "permission",
      text: `akou hears only silence while audio is playing: check that akou is allowed in ${where}.`,
      action: "open-settings",
    };
  }
  if (v.state === "paused") return null;
  const lag = v.asrLag?.seconds ?? 0;
  if (lag > LAG_AMBER_S) {
    return {
      kind: "lag",
      text: `transcript ${Math.round(lag)} s behind. The recording is fine; lines will catch up.`,
    };
  }
  if (call?.state === "no-buffers" || mic?.state === "no-buffers") {
    return {
      kind: "guess",
      text: "no audio has arrived from the capture yet; akou is rebuilding it. If this stays, press Restart.",
      action: "restart",
    };
  }
  const since = i.lastLineAt ?? v.parts().at(-1)?.wallStart ?? i.now;
  if (i.now - since > QUIET_AFTER_MS) {
    return {
      kind: "guess",
      text: `no new lines for ${formatDuration((i.now - since) / 1000)}. If people are talking, the capture may have died: press Restart.`,
      action: "restart",
    };
  }
  if (call?.state === "ok") {
    const history = v.healthHistory().filter((h) => h.ch === "call" && h.part === call.part);
    const wasDead = history.some((h) => h.state === "dead" && h.seq < call.seq);
    if (wasDead && i.now - call.t < RECOVERED_FOR_MS) {
      const n = call.rebuilds;
      return {
        kind: "recovered",
        text: `call audio is back${n > 0 ? ` after ${n} ${n === 1 ? "rebuild" : "rebuilds"}` : ""}`,
      };
    }
  }
  const heard = i.callHeardAt ?? v.parts().at(-1)?.wallStart ?? i.now;
  if (i.levelAt !== null && i.now - heard > QUIET_AFTER_MS) {
    return { kind: "quiet", text: `call side quiet for ${formatDuration((i.now - heard) / 1000)}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The final pass note and the languages chip

export interface FinalNote {
  text: string;
  state: "running" | "failed" | "done";
  /** 0 to 1 while running. */
  progress?: number;
}

export function finalNote(v: CallView): FinalNote | null {
  const f = v.final;
  if (f.state === "none") return null;
  if (f.state === "failed") {
    return {
      state: "failed",
      text: `final transcript: failed${f.failed ? ` (${f.failed.error})` : ""}`,
    };
  }
  if (f.state === "running") {
    const total = Math.max(1, v.parts().length);
    return {
      state: "running",
      text: `final transcript: running (${f.partsDone.length} of ${total} ${total === 1 ? "part" : "parts"})`,
      progress: f.partsDone.length / total,
    };
  }
  const skipped = f.done?.skipped.length ?? 0;
  const bits = ["final transcript: ready"];
  if (skipped > 0) bits[0] += ` (${skipped} ${skipped === 1 ? "span" : "spans"} skipped)`;
  if (f.done?.warning) bits.push(f.done.warning);
  return { state: "done", text: bits.join("  ·  ") };
}

/** The languages a model reported in the final pass; empty when none did (Parakeet). */
export function languages(v: CallView): string[] {
  return v.final.state === "done" ? [...(v.final.done?.languages ?? [])] : [];
}

// ---------------------------------------------------------------------------
// Citations in answers and enhanced notes

export type Piece =
  | { kind: "text"; text: string }
  | { kind: "time"; text: string; time: string; speaker: string }
  | { kind: "seg"; text: string; id: string };

const CITE = /\[(\d{1,2}:\d{2}(?::\d{2})?) ([^\]\n]{1,60})\]|\[#([lf]\d{6,})\]|#([lf]\d{6,})\b/g;

/** Splits text into plain runs and citations: `[15:41 Ben]` and `[#l000031]`. */
export function splitCitations(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of text.matchAll(CITE)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ kind: "text", text: text.slice(at, i) });
    if (m[1] && m[2]) out.push({ kind: "time", text: m[0], time: m[1], speaker: m[2] });
    else out.push({ kind: "seg", text: m[0], id: (m[3] ?? m[4]) as string });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/**
 * The line a `[15:41 Ben]` citation points at: among the answer's cited ids first, then the whole
 * call, the first line of that speaker starting in that minute.
 */
export function resolveTimeCitation(
  v: CallView,
  time: string,
  speaker: string,
  cites: readonly string[],
): string | null {
  const tz = v.call?.tz ?? "UTC";
  const seconds = time.split(":").length === 3;
  const match = (id: string) => {
    const l = v.resolve(id);
    if (!l || l.retracted) return false;
    const t = formatWall(l.w0, tz, { seconds });
    return t === time && l.speaker.toLowerCase() === speaker.trim().toLowerCase();
  };
  for (const id of cites) if (match(id)) return id;
  for (const l of v.lines("best")) if (match(l.id)) return l.id;
  // A citation whose speaker was renamed since still points at its minute.
  for (const id of cites) {
    const l = v.resolve(id);
    if (l && formatWall(l.w0, tz, { seconds }) === time) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The ask box presets (DESIGN 7)

export function presets(speakers: readonly string[]): { label: string; question: string }[] {
  const out = [
    { label: "Catch me up", question: "Catch me up: what has been said so far?" },
    { label: "Was my name mentioned?", question: "Was my name mentioned? By whom and when?" },
    { label: "Decisions so far", question: "What decisions have been made so far?" },
    { label: "Action items", question: "What are the action items so far, with owners?" },
  ];
  for (const s of speakers) {
    out.push({ label: `What did ${s} say?`, question: `What did ${s} say so far?` });
  }
  return out;
}

/** The markers the notepad knows: `- `, `[] ` (action), `? ` (open question), `# ` (section). */
export function noteKind(text: string): "text" | "bullet" | "action" | "question" | "section" {
  if (text.startsWith("[] ") || text.startsWith("[ ] ")) return "action";
  if (text.startsWith("? ")) return "question";
  if (text.startsWith("# ")) return "section";
  if (text.startsWith("- ")) return "bullet";
  return "text";
}

// ---------------------------------------------------------------------------
// Speaker chips (WINDOW W4.2)

/**
 * A live cluster is a guess until someone names it or the final pass lands (DESIGN 3.2), so its
 * chip reads `c3?` and is drawn provisional. A name, the final layer, or a `final.done` written
 * after the line (`finalDoneSeq`, the fold's `final.done.seq`) makes it solid; you, on the mic,
 * are never a guess. Going by `seq` keeps a call reopened after its pass honest (its new lines
 * are guesses again) and keeps a re-run from turning finished lines back into guesses. A line
 * with no `seq` (the grey line still being spoken) is newer than any finished pass.
 */
export function speakerChip(
  line: { layer: "live" | "final"; ch: "mic" | "call"; spk: string; speaker: string; seq?: number },
  o: { named: boolean; finalDoneSeq?: number },
): { label: string; provisional: boolean } {
  const passed =
    o.finalDoneSeq !== undefined && line.seq !== undefined && line.seq < o.finalDoneSeq;
  const provisional = line.ch === "call" && line.layer === "live" && !o.named && !passed;
  if (!provisional) return { label: line.speaker, provisional };
  return { label: line.spk.endsWith("?") ? line.spk : `${line.spk}?`, provisional };
}

// ---------------------------------------------------------------------------
// Playback (WINDOW section 5)

/** Playback speeds, 0.75x to 2x in 0.25 steps; `[` and `]` move one step. */
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const SEEK_STEP_S = 5;

/** One step slower (-1) or faster (1), held at both ends. */
export function stepRate(rate: number, dir: -1 | 1): number {
  const i = RATES.indexOf(rate as (typeof RATES)[number]);
  const at = i < 0 ? RATES.indexOf(1) : i;
  return RATES[Math.max(0, Math.min(RATES.length - 1, at + dir))] as number;
}

/** The speed kept from an earlier visit, or 1x when what was kept is not one of the steps. */
export function restoreRate(saved: string | null): number {
  const r = Number(saved);
  return saved && RATES.includes(r as (typeof RATES)[number]) ? r : 1;
}

/** `1.0x`, `1.25x`, `2.0x`. */
export function rateLabel(rate: number): string {
  return `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}x`;
}

/** A position moved by `delta` seconds, held inside the part: 0 to its length once known. */
export function seekBy(t: number, delta: number, duration: number): number {
  const to = Math.max(0, t + delta);
  return Number.isFinite(duration) ? Math.min(duration, to) : to;
}

/**
 * The line being played at `t` seconds into a part's audio: `a0 <= t < a1`. When two lines overlap
 * (the mic and the call at once), the one that started last; between lines, none.
 */
export function playingLine(
  lines: readonly { id: string; part: number; a0: number; a1: number }[],
  part: number,
  t: number,
): string | null {
  let best: { id: string; a0: number } | null = null;
  for (const l of lines) {
    if (l.part !== part || t < l.a0 || t >= l.a1) continue;
    if (!best || l.a0 >= best.a0) best = l;
  }
  return best?.id ?? null;
}

/**
 * A position in a part's audio as the wall time of that instant, through the part's clock, so a
 * pause or a sleep in the part moves it (TRAPS "Clock drifts by paused time"). Never an offset.
 */
export function positionText(v: CallView, part: number, a: number): string {
  const p = v.part(part);
  if (!p) return "";
  return formatWall(p.clock.wallFromAudio(a), v.call?.tz ?? "UTC");
}

// ---------------------------------------------------------------------------
// The calls list (WINDOW section 13)

/** One call as `GET /calls` lists it: metadata only, never its content. */
export interface CallSummary {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  /** Null while the call is live. */
  endedAt?: number | null;
  state: string;
}

export interface CallGroup {
  workspace: string;
  calls: CallSummary[];
}

/**
 * The calls by workspace, each workspace newest first with the live call on top, the workspaces
 * ordered by their newest call. A query keeps the calls whose title or workspace contains it, in
 * any case; it never reads what was said.
 */
export function groupCalls(
  calls: readonly CallSummary[],
  query = "",
  live: string | null = null,
): CallGroup[] {
  const q = query.trim().toLowerCase();
  const rank = (c: CallSummary) => (c.id === live ? Number.POSITIVE_INFINITY : c.createdAt);
  const groups = new Map<string, CallSummary[]>();
  for (const c of calls) {
    if (q && !`${c.title}\n${c.workspace}`.toLowerCase().includes(q)) continue;
    const list = groups.get(c.workspace) ?? [];
    list.push(c);
    groups.set(c.workspace, list);
  }
  const out = [...groups].map(([workspace, list]) => ({
    workspace,
    calls: list.sort((a, b) => rank(b) - rank(a)),
  }));
  const top = (g: CallGroup) => rank(g.calls[0] as CallSummary);
  return out.sort((a, b) => top(b) - top(a) || a.workspace.localeCompare(b.workspace));
}

/** The calendar date of `t` in `tz`. */
function dateIn(t: number, tz: string): { year: number; month: number; day: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(t);
  const n = (type: string) => Number(p.find((x) => x.type === type)?.value);
  return { year: n("year"), month: n("month"), day: n("day") };
}

/** Spelled out here: engines disagree on the short name of September ("Sep" or "Sept"). */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The day of a call, local: Today, Yesterday, the weekday within a week, then the date. */
export function dayLabel(t: number, now: number, tz: string): string {
  const d = dateIn(t, tz);
  const today = dateIn(now, tz);
  // Days since the epoch of each calendar date, so two dates subtract.
  const utc = (x: typeof d) => Date.UTC(x.year, x.month - 1, x.day);
  const ago = Math.round((utc(today) - utc(d)) / 86_400_000);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago > 1 && ago < 7) return WEEKDAYS[new Date(utc(d)).getUTCDay()] as string;
  const date = `${d.day} ${MONTHS[d.month - 1]}`;
  return d.year === today.year ? date : `${date} ${d.year}`;
}

/**
 * The line under a call's title: its day, its local start time and how long it ran, from the start
 * to the end of its last part. `Today, 14:02 · 38 min`; a live call says live, a failed start
 * failed.
 */
export function callMeta(c: CallSummary, now: number, tz: string, live: boolean): string {
  const time = hourMinute(c.createdAt, tz);
  let span: string;
  if (live) span = "live";
  else if (c.state === "failed") span = "failed";
  else {
    const min = Math.round(Math.max(0, (c.endedAt ?? c.createdAt) - c.createdAt) / 60_000);
    span =
      min < 1
        ? "under 1 min"
        : min < 60
          ? `${min} min`
          : formatDuration(min * 60).replace(/ 0 min$/, "");
  }
  return `${dayLabel(c.createdAt, now, tz)}, ${time} · ${span}`;
}

/** `14:02`: a wall-clock time to the minute, local to `tz`. */
function hourMinute(t: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(t);
}

// ---------------------------------------------------------------------------
// The transcript header and the composer row (WINDOW section 3.1)

export interface CallHeadInput {
  /** When the call was created, and its zone. */
  createdAt: number;
  tz: string;
  now: number;
  /** The audio recorded, in seconds; null while the call is live (the state says how long). */
  seconds: number | null;
  workspace: string;
  /** What the state adds (`stateLabel`'s meta): lines, a failure, how long it has recorded. */
  note: string;
}

/**
 * The line under the open call's title: `Today, 14:02 · 38 min 12 s · work`, then what the state
 * adds, such as `4 lines` or `open: permission denied`. No template: the window has no Enhance.
 */
export function callHeadMeta(i: CallHeadInput): string {
  const bits = [`${dayLabel(i.createdAt, i.now, i.tz)}, ${hourMinute(i.createdAt, i.tz)}`];
  if (i.seconds !== null && i.seconds > 0) bits.push(formatDuration(i.seconds));
  bits.push(i.workspace);
  if (i.note) bits.push(...i.note.split(/\s+·\s+/));
  return bits.filter(Boolean).join(" · ");
}

export interface SpeakerTotal {
  spk: string;
  label: string;
  seconds: number;
}

/**
 * Who spoke and for how long, from the lines on screen: the most first, ties in order of speech.
 * With `chips` (the named speakers and the fold's `final.done.seq`), a voice is called what its
 * lines are called (`speakerChip`), so a guessed cluster reads `c1?` on its chip too.
 */
export function speakerTotals(
  lines: readonly {
    spk: string;
    speaker: string;
    w0: number;
    w1: number;
    layer?: "live" | "final";
    ch?: "mic" | "call";
    seq?: number;
  }[],
  chips?: { named: ReadonlySet<string>; finalDoneSeq?: number },
): SpeakerTotal[] {
  const by = new Map<string, SpeakerTotal>();
  for (const l of lines) {
    const label =
      chips && l.layer && l.ch
        ? speakerChip(
            { ...l, layer: l.layer, ch: l.ch },
            { named: chips.named.has(l.spk), finalDoneSeq: chips.finalDoneSeq },
          ).label
        : l.speaker;
    const t = by.get(l.spk) ?? { spk: l.spk, label, seconds: 0 };
    t.seconds += Math.max(0, l.w1 - l.w0) / 1000;
    by.set(l.spk, t);
  }
  // A stable sort: equal totals keep the order in which the speakers first spoke.
  return [...by.values()].sort((a, b) => b.seconds - a.seconds);
}

/** A speaker's time on a chip: `40 s` under a minute, then whole minutes, `1 h 2 min` past an hour. */
export function talkTime(seconds: number): string {
  if (seconds < 59.5) return `${Math.max(1, Math.round(seconds))} s`;
  return formatDuration(Math.round(seconds / 60) * 60).replace(/ 0 min$/, "");
}

/**
 * The shortcut beside Record: the global hotkey that starts and stops a call, as keycaps
 * (`⌥⌘R`), or empty when the app registers none (a headless app has no shell to register it).
 */
export function recordKey(app: { hotkey?: string | null; platform?: string } | undefined): string {
  return app?.hotkey ? hotkeyLabel(app.hotkey, app.platform ?? "") : "";
}
