/**
 * Finding calls on disk and closing what a crash left open (docs/DESIGN.md sections 4.1 and 4.5).
 *
 * At the next start, for every call folder whose log no process holds:
 *
 * - a part with no `part.ended` gets `part.ended {reason: crashed}`, with the duration read from
 *   the last granule of its Opus file (or, when the file has none, the furthest audio position the
 *   log mentions);
 * - a call that never captured (`call.created`, no part, no failure) gets `call.failed`, so
 *   nothing ever points at it as live;
 * - a call left between two parts of a restart gets `call.ended {reason: interrupted}`, and one
 *   left stopping gets `call.ended {reason: stop}`;
 * - an `interrupted` call with no resume for 24 h gets `call.ended {reason: abandoned}`.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EventDraft, LogEvent } from "../../core/log/events.ts";
import { type CallState, fold } from "../../core/log/fold.ts";
import { readLog } from "../../core/log/reader.ts";
import { EVENTS_FILE, LockError, LogWriter } from "../../core/log/writer.ts";

const OPUS_RATE = 48000;

/**
 * Duration of an Ogg Opus file from its last page's granule position, minus the pre-skip in its
 * `OpusHead`. `null` when the file is missing or has no page with a granule.
 */
export function opusDurationSeconds(path: string): number | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size < 27) return null;
  const fd = openSync(path, "r");
  try {
    const head = new Uint8Array(Math.min(size, 512));
    readSync(fd, head, 0, head.length, 0);
    const preSkip = findPreSkip(head);
    // Pages are at most ~64 KB; scan back from the end in windows until a granule is found.
    const win = 70_000;
    for (let end = size; end > 0; end -= win - 27) {
      const start = Math.max(0, end - win);
      const buf = new Uint8Array(end - start);
      readSync(fd, buf, 0, buf.length, start);
      for (let i = buf.length - 27; i >= 0; i--) {
        if (buf[i] !== 0x4f || buf[i + 1] !== 0x67 || buf[i + 2] !== 0x67 || buf[i + 3] !== 0x53) {
          continue;
        }
        const v = new DataView(buf.buffer, buf.byteOffset + i, 27);
        const granule = v.getBigInt64(6, true);
        if (granule > 0n) return Math.max(0, Number(granule - BigInt(preSkip)) / OPUS_RATE);
      }
      if (start === 0) break;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function findPreSkip(head: Uint8Array): number {
  const tag = new TextEncoder().encode("OpusHead");
  outer: for (let i = 0; i + 12 <= head.length; i++) {
    for (let j = 0; j < tag.length; j++) if (head[i + j] !== tag[j]) continue outer;
    return (head[i + 10] as number) | ((head[i + 11] as number) << 8);
  }
  return 0;
}

/** The furthest audio position a log mentions for a part: segments, pauses, mutes, gaps. */
export function lastKnownAudio(events: readonly LogEvent[], part: number): number {
  let a = 0;
  for (const e of events) {
    if (e.type === "seg" && e.part === part && typeof e.a1 === "number") a = Math.max(a, e.a1);
    else if (
      (e.type === "pause" ||
        e.type === "resume" ||
        e.type === "mute" ||
        e.type === "unmute" ||
        e.type === "gap") &&
      e.part === part
    ) {
      a = Math.max(a, e.a);
    }
  }
  return a;
}

export interface CallSummary {
  id: string;
  dir: string;
  workspace: string;
  title: string;
  /** `t` of `call.created`. */
  createdAt: number;
  state: CallState;
  /** `t` of the last event that ended the call or its newest part; null while live. */
  endedAt: number | null;
  parts: number;
}

export function summarize(
  dir: string,
  workspace: string,
  events: readonly LogEvent[],
): CallSummary | null {
  const first = events[0];
  if (first?.type !== "call.created") return null;
  const view = fold(events);
  let endedAt: number | null = null;
  if (!view.live) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i] as LogEvent;
      if (e.type === "call.ended" || e.type === "call.failed" || e.type === "part.ended") {
        endedAt = e.t;
        break;
      }
    }
    endedAt ??= (events[events.length - 1] as LogEvent).t;
  }
  return {
    id: first.id,
    dir,
    workspace,
    title: first.title,
    createdAt: first.t,
    state: view.state,
    endedAt,
    parts: view.parts().length,
  };
}

/** Every call folder under the root: `<root>/<workspace>/<call>/events.jsonl`. */
export function listCallDirs(root: string): { dir: string; workspace: string }[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: { dir: string; workspace: string }[] = [];
  for (const ws of readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(root, ws.name);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const c of entries) {
      if (!c.isDirectory()) continue;
      const dir = join(wsDir, c.name);
      if (existsSync(join(dir, EVENTS_FILE))) out.push({ dir, workspace: ws.name });
    }
  }
  return out;
}

export interface RecoveryAction {
  dir: string;
  appended: EventDraft[];
}

export interface RecoveryOptions {
  now: () => number;
  abandonAfterMs: number;
  writerOptions?: Parameters<typeof LogWriter.open>[1];
}

/** Closes what a crash left open in one call folder. Skips a folder another writer holds. */
export async function recoverCall(dir: string, o: RecoveryOptions): Promise<RecoveryAction | null> {
  const { events } = await readLog(join(dir, EVENTS_FILE));
  if (events.length === 0) return null;
  const view = fold(events);
  const drafts: EventDraft[] = [];
  for (const p of view.openParts()) {
    const fromFile = opusDurationSeconds(join(dir, p.file));
    drafts.push({
      type: "part.ended",
      part: p.part,
      reason: "crashed",
      fileSeconds: fromFile ?? lastKnownAudio(events, p.part),
    });
  }
  const stateAfter = drafts.length > 0 ? "crashed" : view.state;
  const last = events[events.length - 1] as LogEvent;
  if (stateAfter === "starting") {
    drafts.push({
      type: "call.failed",
      stage: "crashed",
      error: "akou exited before capture started",
    });
  } else if (stateAfter === "restarting" || stateAfter === "recording" || stateAfter === "paused") {
    drafts.push({ type: "call.ended", reason: "interrupted" });
  } else if (stateAfter === "stopping") {
    drafts.push({ type: "call.ended", reason: "stop" });
  } else if (stateAfter === "interrupted" && o.now() - last.t > o.abandonAfterMs) {
    drafts.push({ type: "call.ended", reason: "abandoned" });
  }
  if (drafts.length === 0) return null;
  let w: LogWriter;
  try {
    w = LogWriter.open(dir, o.writerOptions);
  } catch (err) {
    if (err instanceof LockError) return null;
    throw err;
  }
  try {
    for (const d of drafts) w.append(d);
  } finally {
    w.close();
  }
  return { dir, appended: drafts };
}
