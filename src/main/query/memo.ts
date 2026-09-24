/**
 * The rolling memo slot (docs/DESIGN.md section 5.4, "Rolling memo", and 5.5).
 *
 * The memo is a short running summary of the call (topics, decisions, actions with owner, open
 * questions, people, each with `[HH:MM]`), stored as a `memo` event that covers `seq` 1 to
 * `coversSeq`. This file owns the slot: reading the latest memo, deciding when it is stale,
 * rendering it into a pack, and checking a new one before it is written, whoever wrote it.
 *
 * Who writes it is pluggable. In agent mode the agent writes it with `akou_memo_put` when a pack
 * says `memoStale`; with a provider configured, a `MemoUpdater` does (the provider-driven updater
 * itself is M2). Chunk summaries (`chunk.summary`) are never read as the memo.
 */

import type { EventDraft } from "../../core/log/events.ts";
import type { CallView, Line } from "../../core/log/fold.ts";
import { estimateTokens } from "./render.ts";

/** A memo is refreshed after at least this much new committed speech... */
export const MEMO_MIN_NEW_TOKENS = 1500;
/** ...and at least this long after the last one. */
export const MEMO_MIN_INTERVAL_MS = 3 * 60_000;
/** The memo's own cap, and its block's cap in the pack. */
export const MEMO_MAX_TOKENS = 1000;

export interface MemoStatus {
  /** The memo in force, if any. */
  body: string | null;
  rev: number;
  coversSeq: number;
  by?: string;
  model?: string;
  /** A refresh is due: enough new speech, and enough time, since the memo's coverage. */
  stale: boolean;
  /** The committed speech the memo does not cover yet. */
  uncovered: { fromSeq: number; toSeq: number; lines: number; tokens: number; w0?: number };
  /** Wall time the memo covers the call up to: the end of the last line it was written over. */
  coveredUntil?: number;
}

/**
 * Wall time a memo covering `seq` 1 to `coversSeq` covers the call up to: the latest end of a
 * line, in any layer, logged at or before `coversSeq`. Coverage is a span of the call, so the
 * final pass re-transcribing that span does not uncover it.
 */
export function memoCoveredUntil(view: CallView, coversSeq: number): number | undefined {
  if (coversSeq <= 0) return undefined;
  let w: number | undefined;
  for (const layer of ["live", "final"] as const) {
    for (const l of view.lines(layer, { includeEcho: true, includeRetracted: true })) {
      if (l.seq <= coversSeq && (w === undefined || l.w1 > w)) w = l.w1;
    }
  }
  return w;
}

/**
 * Whether the memo covers a line. A line logged at or before `coversSeq` is covered. A live line
 * logged after it is new speech. A final-layer line logged after it re-transcribes time the memo
 * may already cover, so it is covered when it starts inside that span.
 */
export function memoCovers(l: Line, coversSeq: number, coveredUntil: number | undefined): boolean {
  if (l.seq <= coversSeq) return true;
  return l.layer === "final" && coveredUntil !== undefined && l.w0 < coveredUntil;
}

/**
 * The memo slot for a call. `lines` is the `best` view in order; `now` is the reference time
 * (the current time while live, the end of the call once it ended). A caller that caches
 * `memoCoveredUntil` passes it in.
 */
export function memoStatus(
  view: CallView,
  lines: Iterable<Line>,
  now: number,
  coveredUntil: number | undefined = memoCoveredUntil(view, view.memo?.coversSeq ?? 0),
): MemoStatus {
  const memo = view.memo;
  const coversSeq = memo?.coversSeq ?? 0;
  let tokens = 0;
  let count = 0;
  let w0: number | undefined;
  // A length-based count is enough for a threshold.
  for (const l of lines) {
    if (memoCovers(l, coversSeq, coveredUntil)) continue;
    tokens += Math.ceil(l.text.length / 4);
    count++;
    if (w0 === undefined || l.w0 < w0) w0 = l.w0;
  }
  const since = memo ? memo.t : (view.parts()[0]?.wallStart ?? now);
  const stale = tokens >= MEMO_MIN_NEW_TOKENS && now - since >= MEMO_MIN_INTERVAL_MS;
  return {
    body: memo?.body ?? null,
    rev: memo?.rev ?? 0,
    coversSeq,
    by: memo?.by,
    model: memo?.model,
    stale,
    uncovered: { fromSeq: coversSeq + 1, toSeq: view.lastSeq, lines: count, tokens, w0 },
    coveredUntil,
  };
}

/** The memo block of a pack, trimmed to its cap on a line boundary. */
export function renderMemo(status: MemoStatus, maxTokens = MEMO_MAX_TOKENS): string {
  if (!status.body) return "";
  const out: string[] = [];
  let used = 0;
  for (const line of status.body.split("\n")) {
    const t = estimateTokens(line) + 1;
    if (used + t > maxTokens) {
      out.push("(memo trimmed)");
      break;
    }
    out.push(line);
    used += t;
  }
  return out.join("\n").trimEnd();
}

export type MemoCheck = { ok: true; draft: EventDraft } | { ok: false; error: string };

/**
 * Checks a memo before it is written, from the agent (`PUT /memo`, `akou_memo_put`) or from an
 * updater, and returns the event draft for the log's single writer. The memo must cover seqs the
 * log has, move coverage forward, and fit its cap.
 */
export function memoDraft(
  view: CallView,
  input: { text: string; coversSeq: number; by: string; model?: string },
): MemoCheck {
  const body = input.text.trim();
  if (body === "") return { ok: false, error: "memo text is empty" };
  if (!Number.isInteger(input.coversSeq) || input.coversSeq < 1) {
    return { ok: false, error: "coversSeq must be a positive integer" };
  }
  if (input.coversSeq > view.lastSeq) {
    return { ok: false, error: `coversSeq ${input.coversSeq} is past the log (${view.lastSeq})` };
  }
  const cur = view.memo;
  if (cur && input.coversSeq < cur.coversSeq) {
    return {
      ok: false,
      error: `coversSeq ${input.coversSeq} is behind the memo in force (${cur.coversSeq})`,
    };
  }
  const tokens = estimateTokens(body);
  if (tokens > MEMO_MAX_TOKENS) {
    return { ok: false, error: `memo is ${tokens} tokens; the cap is ${MEMO_MAX_TOKENS}` };
  }
  return {
    ok: true,
    draft: {
      type: "memo",
      rev: (cur?.rev ?? 0) + 1,
      body,
      coversSeq: input.coversSeq,
      by: input.by,
      model: input.model ?? "none",
    },
  };
}

// ---------------------------------------------------------------------------
// The pluggable updater

export interface MemoUpdateInput {
  /** The memo in force, or null for the first one. */
  previous: string | null;
  /** New committed lines since the memo's coverage, rendered for a model. */
  newLines: string[];
  /** The seq the new memo will cover. */
  coversSeq: number;
  /** Local zone of the call, for `[HH:MM]` anchors. */
  tz: string;
  maxTokens: number;
}

/** Writes the next memo from the previous one plus the new lines. The M2 provider implements it. */
export interface MemoUpdater {
  readonly id: string;
  update(input: MemoUpdateInput, signal: AbortSignal): Promise<{ text: string; model: string }>;
}

/**
 * Runs an updater once if the memo is stale, and returns the checked draft to write, or null when
 * nothing is due. The caller appends the draft; this function writes nothing.
 */
export async function refreshMemo(
  view: CallView,
  lines: readonly Line[],
  now: number,
  updater: MemoUpdater,
  render: (l: Line) => string,
  signal: AbortSignal,
): Promise<MemoCheck | null> {
  const status = memoStatus(view, lines, now);
  if (!status.stale) return null;
  const coversSeq = view.lastSeq;
  const fresh = lines
    .filter((l) => !memoCovers(l, status.coversSeq, status.coveredUntil))
    .map(render);
  const out = await updater.update(
    {
      previous: status.body,
      newLines: fresh,
      coversSeq,
      tz: view.call?.tz ?? "UTC",
      maxTokens: MEMO_MAX_TOKENS,
    },
    signal,
  );
  return memoDraft(view, { text: out.text, coversSeq, by: "app", model: out.model || updater.id });
}
