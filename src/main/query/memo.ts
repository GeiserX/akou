/**
 * The rolling memo slot (docs/DESIGN.md section 5.4, "Rolling memo", and 5.5).
 *
 * The memo is a short running summary of the call (topics, decisions, actions with owner, open
 * questions, people, each with `[HH:MM]`), stored as a `memo` event that covers `seq` 1 to
 * `coversSeq`. This file owns the slot: reading the latest memo, deciding when it is stale,
 * rendering it into a pack, and checking a new one before it is written, whoever wrote it.
 *
 * Who writes it is pluggable. In agent mode the agent writes it with `akou_memo_put` when a pack
 * says `memoStale`; with a provider configured, `ProviderMemoUpdater` does, incrementally (the
 * previous memo plus the new lines). With the harness it is opt-in (`memo.provider`), because it
 * would run the user's subscription unattended every few minutes. Chunk summaries
 * (`chunk.summary`) are never read as the memo.
 *
 * A memo a provider wrote is checked before it is stored: every item must carry `[HH:MM]` anchors
 * that are minutes of the call with a line in them, or it is dropped, and the memo is trimmed to its
 * cap on a line boundary, so a model that writes too much or invents a time cannot put either in
 * the pack.
 */

import { formatWall } from "../../core/log/clock.ts";
import type { EventDraft } from "../../core/log/events.ts";
import type { CallView, Line } from "../../core/log/fold.ts";
import { type Provider, runProvider } from "../llm/provider.ts";
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

/** Writes the next memo from the previous one plus the new lines. */
export interface MemoUpdater {
  readonly id: string;
  update(input: MemoUpdateInput, signal: AbortSignal): Promise<{ text: string; model: string }>;
}

/**
 * Whether the configured provider writes the memo on its own (`memo.provider`). `auto` leaves the
 * harness out (TRAPS "Unattended harness use"): the memo runs every few minutes without a request,
 * and would spend the user's subscription unattended.
 */
export function memoByProvider(kind: string, setting: string): boolean {
  if (kind === "none" || setting === "off") return false;
  if (setting === "on") return true;
  return kind !== "harness";
}

export const MEMO_SYSTEM = [
  "You keep a short running memo of a call that is still going on.",
  "You get the memo so far and the lines said since. Return the whole new memo, and nothing else.",
  "Sections, in this order, each only if it has items: Topics, Decisions, Action items (owner: task), Open questions, People.",
  "Every item is one bullet that ends with the local time it rests on, like [15:41] or [15:41 Ben], taken from the lines. An item with no such time is left out.",
  "Merge and shorten old items rather than adding new ones for the same thing. Stay under the token limit you are given.",
].join("\n");

export function memoPrompt(input: MemoUpdateInput): string {
  return [
    `Token limit: ${input.maxTokens}.`,
    "",
    "Memo so far:",
    input.previous ?? "(none yet)",
    "",
    "New lines:",
    ...(input.newLines.length > 0 ? input.newLines : ["(none)"]),
  ].join("\n");
}

/** The memo written by the configured provider (openai-compatible, anthropic, or the harness). */
export class ProviderMemoUpdater implements MemoUpdater {
  readonly id: string;
  constructor(
    private readonly provider: Provider,
    private readonly timeoutMs?: number,
  ) {
    this.id = provider.id;
  }

  async update(input: MemoUpdateInput, signal: AbortSignal) {
    const r = await runProvider(
      this.provider,
      { system: MEMO_SYSTEM, prompt: memoPrompt(input), maxTokens: input.maxTokens },
      () => {},
      { signal, timeoutMs: this.timeoutMs },
    );
    return { text: r.text, model: r.model };
  }
}

/** `[15:41]`, `[15:41:07]`, `[15:41 Ben]`: the minute is group 1. */
export const MEMO_ANCHOR = /\[(\d{1,2}:\d{2})(?::\d{2})?(?:\s[^\]]*)?\]/g;

const MEMO_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** The local minutes (`15:41`) that have a line in them: where a memo anchor may point. */
export function anchorMinutes(lines: Iterable<Line>, tz: string): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    out.add(formatWall(l.w0, tz, { seconds: false }));
    out.add(formatWall(l.w1, tz, { seconds: false }));
  }
  return out;
}

export interface MemoAnchorCheck {
  body: string;
  dropped: { text: string; reason: string }[];
}

/**
 * Keeps the memo's items whose anchors all point at a minute of the call with a line in it, and
 * drops the rest: an item with no anchor, or with one the call does not have. Headings stay.
 */
export function checkMemoAnchors(body: string, minutes: ReadonlySet<string>): MemoAnchorCheck {
  const kept: string[] = [];
  const dropped: MemoAnchorCheck["dropped"] = [];
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!MEMO_ITEM.test(line)) {
      kept.push(line);
      continue;
    }
    const anchors = [...line.matchAll(MEMO_ANCHOR)].map((m) => (m[1] as string).padStart(5, "0"));
    if (anchors.length === 0) {
      dropped.push({ text: line, reason: "no [HH:MM] anchor" });
      continue;
    }
    const bad = anchors.find((a) => !minutes.has(a));
    if (bad) {
      dropped.push({
        text: line,
        reason: `[${bad}] is not a minute of the call with a line in it`,
      });
      continue;
    }
    kept.push(line);
  }
  return {
    body: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    dropped,
  };
}

/** The memo cut to its cap on a line boundary; a heading left with nothing under it goes too. */
export function capMemo(body: string, maxTokens = MEMO_MAX_TOKENS): string {
  if (estimateTokens(body) <= maxTokens) return body;
  const lines = body.split("\n");
  while (lines.length > 0 && estimateTokens(lines.join("\n")) > maxTokens) lines.pop();
  while (lines.length > 0 && !MEMO_ITEM.test(lines.at(-1) as string)) lines.pop();
  return lines.join("\n").trim();
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
  const tz = view.call?.tz ?? "UTC";
  const out = await updater.update(
    { previous: status.body, newLines: fresh, coversSeq, tz, maxTokens: MEMO_MAX_TOKENS },
    signal,
  );
  const checked = checkMemoAnchors(out.text, anchorMinutes(lines, tz));
  const body = capMemo(checked.body);
  if (!MEMO_ITEM_IN.test(body)) {
    return { ok: false, error: "the provider's memo had no item with a valid anchor" };
  }
  return memoDraft(view, { text: body, coversSeq, by: "app", model: out.model || updater.id });
}

const MEMO_ITEM_IN = /^\s*(?:[-*+]|\d+[.)])\s+/m;
