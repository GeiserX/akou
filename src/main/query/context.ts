/**
 * The live query engine (docs/DESIGN.md sections 5.4 and 5.5).
 *
 * Any question, from the ask box or an agent, becomes a small, correct context pack with no model
 * call, no re-reading of the call, and no dependence on the asker's memory. Everything in the pack
 * comes from the log through the fold: names, remembered lines, the memo and earlier questions
 * survive the asker's own context being compacted.
 *
 * The pack, in order:
 * 1. Status line: `LIVE, recording now`, `ENDED at 15:52 (38 min ago)`, `INTERRUPTED since 15:44`.
 * 2. Header: title, workspace, start and zone, now, parts and pauses, the roster, health gaps,
 *    notes from the agent's earlier turns, and the rules.
 * 3. Question analysis, one line.
 * 4. Earlier questions: the last three ask/answer pairs, answers trimmed.
 * 5. Vocabulary hits: entries whose term or heard forms appear in the question or the lines.
 * 6. The rolling memo.
 * 7. Retrieved: BM25 top-k speaker-turn chunks outside the recency window, re-sorted by time,
 *    with one neighbouring line either side.
 * 8. Recent lines: verbatim from `min(memo coverage, now - 5 min)` to now.
 * 9. The provisional line, only for `now` questions, only if updated in the last 3 s.
 *
 * Whole-call mode: when the whole rendered transcript fits 12k tokens, the in-app pack (and an
 * MCP caller asking for a budget of 12k or more) is the header plus the whole transcript, capped
 * at 14k tokens. Speaker ids go in a stable prefix; the roster, vocabulary hits, memo and "now" go
 * in a dynamic tail, so naming a speaker does not invalidate a provider's prompt cache.
 *
 * Call text is data (PG-Z1): in both modes, everything taken from the call (earlier questions and
 * answers, vocabulary hits, the memo, the lines and the draft line) sits in one `<call-text>`
 * block under a fixed header, with any marker inside it escaped. The status, the header, the
 * agent's own remembered lines, the rules and akou's notes to the agent stay outside it.
 */

import { formatLocalDate, formatWall } from "../../core/log/clock.ts";
import type { CallState, CallView, Line, Provisional } from "../../core/log/fold.ts";
import { foldText, tokenize } from "../../core/vocab/correct.ts";
import type { QueryTerm } from "./bm25.ts";
import { type Chunk, ChunkIndex, type ChunkIndexOptions } from "./chunks.ts";
import { type Classification, classify, type Intent, type SpeakerRef } from "./classify.ts";
import {
  MEMO_MAX_TOKENS,
  type MemoStatus,
  memoCoveredUntil,
  memoStatus,
  renderMemo,
} from "./memo.ts";
import {
  CALL_TEXT_CLOSE,
  CALL_TEXT_START,
  escapeCallText,
  estimateTokens,
  formatAgo,
  formatCitation,
  nowLine,
  type PackState,
  packState,
  quoteCallText,
  renderLine,
  renderProvisional,
  statusLine,
  zoneLine,
} from "./render.ts";

// ---------------------------------------------------------------------------
// Budgets (DESIGN 5.4, step 3)

export const MCP_BUDGET = 6000;
export const APP_BUDGET = 8000;
/**
 * The smallest budget a pack is built for. The status line, the header and the rules are in every
 * pack; a smaller budget is raised to this, and the pack's `budget` says so.
 */
export const MIN_BUDGET = 500;
export const WHOLE_CALL_FITS = 12_000;
export const WHOLE_CALL_CAP = 14_000;
export const RECENCY_MS = 5 * 60_000;

export const BLOCK_CAPS = {
  header: 400,
  analysis: 60,
  qa: 400,
  vocab: 300,
  memo: MEMO_MAX_TOKENS,
  remember: 200,
  recency: 2000,
  retrieved: 1800,
  provisional: 100,
} as const;

/**
 * Under a small budget the optional blocks shrink with it: at most these shares of what the
 * header leaves, so the transcript is never starved by them. At the 6k default every cap above
 * is in force unchanged.
 */
const BLOCK_SHARE = { memo: 0.25, qa: 0.1, vocab: 0.06, remember: 0.1 } as const;

/** Share of the line budget given to the recency window; the rest goes to retrieval. */
const RECENCY_SHARE: Record<Intent, number> = {
  now: 0.8,
  summary: 0.7,
  recall: 0.4,
  "follow-up": 0.5,
  time: 0,
  naming: 0.5,
};

export const SEARCH_K = 6;
/** A hit scoring under this share of the best hit is noise. */
const MIN_RELATIVE_SCORE = 0.2;
/** Hits closer than this to an already chosen hit are the same moment. */
const DEDUP_MS = 30_000;
const SPEAKER_BOOST = 1.5;

const SUMMARY_TERMS = [
  "decide",
  "decided",
  "decision",
  "agreed",
  "agree",
  "action",
  "todo",
  "follow",
  "owner",
  "deadline",
  "next",
];

// ---------------------------------------------------------------------------
// Resolving `live` and `last` (step 0)

export interface CallSummary {
  id: string;
  title: string;
  state: CallState;
  startedAt: number;
  /** Wall time the call ended, when it has. */
  endedAt?: number;
}

export type ResolvedCall =
  | { ok: true; id: string }
  | {
      ok: false;
      status: 404;
      error: "no_live_call";
      last?: { id: string; title: string; endedAt?: number };
    }
  | { ok: false; status: 400; error: "last_refused" }
  | { ok: false; status: 404; error: "not_found" };

const LIVE: ReadonlySet<CallState> = new Set(["recording", "paused", "restarting"]);

/**
 * Resolves a call reference: a call id, `live`, or `last`. `live` is only ever a call that is
 * recording now; with none, it answers `no_live_call` with the last call so the caller can name
 * it. `last` is refused on live controls (stop, pause, resume, mute, unmute), so a control can
 * never land on a finished call. A failed start is never `live` or `last`.
 */
export function resolveCall(
  ref: string,
  calls: readonly CallSummary[],
  opts: { control?: boolean } = {},
): ResolvedCall {
  const usable = calls.filter((c) => c.state !== "failed" && c.state !== "empty");
  const newest = [...usable].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (ref === "live") {
    const live = usable.filter((c) => LIVE.has(c.state)).sort((a, b) => b.startedAt - a.startedAt);
    if (live[0]) return { ok: true, id: live[0].id };
    return {
      ok: false,
      status: 404,
      error: "no_live_call",
      last: newest ? { id: newest.id, title: newest.title, endedAt: newest.endedAt } : undefined,
    };
  }
  if (ref === "last") {
    if (opts.control) return { ok: false, status: 400, error: "last_refused" };
    return newest ? { ok: true, id: newest.id } : { ok: false, status: 404, error: "not_found" };
  }
  return calls.some((c) => c.id === ref)
    ? { ok: true, id: ref }
    : { ok: false, status: 404, error: "not_found" };
}

// ---------------------------------------------------------------------------
// The engine

export interface EngineOptions extends ChunkIndexOptions {}

export interface ContextOptions {
  /** Current wall time, epoch ms. */
  now: number;
  /**
   * Token budget; defaults to 6k for MCP and 8k in the app. A budget below `MIN_BUDGET` is raised
   * to it. In the app, whole-call mode may use up to 14k unless a budget is given here.
   */
  budget?: number;
  /** Who asks: an agent over MCP (the default) or the in-app ask box. */
  surface?: "mcp" | "app";
}

export interface PackBlock {
  name: string;
  tokens: number;
}

export interface ContextPack {
  text: string;
  tokens: number;
  budget: number;
  mode: "retrieval" | "whole";
  state: PackState;
  status: string;
  /** Highest `seq` the pack covers: pass it to `read` to get only what is new. */
  cursor: number;
  memoStale: boolean;
  memo: { coversSeq: number; uncovered: MemoStatus["uncovered"] };
  /** The draft line shown, if any. It is never a committed line and is never cited. */
  provisional: { text: string; w0: number; speaker: string } | null;
  analysis: Classification & { line: string };
  /** Committed lines in the pack, in time order: what a citation may refer to. */
  lines: Line[];
  blocks: PackBlock[];
  tz: string;
  /**
   * Whole-call mode only: the pack in its three parts, so a provider that keeps a session can be
   * sent only the transcript lines it has not seen plus the tail (`followUpPrompt` in `ask.ts`).
   */
  whole?: { head: string; transcript: string[]; tail: string };
}

export interface ReadResult {
  /** New or revised committed lines since the cursor, in time order. */
  lines: Line[];
  rendered: string[];
  /** Segment ids retracted since the cursor. */
  retracted: string[];
  /**
   * Live segment ids the final layer replaced since the cursor: a part switched to the final
   * layer (`final.part.done`), so its final lines are in `lines` and the live copies a reader
   * holds for that part should be dropped. They still resolve by id.
   */
  superseded: string[];
  provisional: { text: string; w0: number; speaker: string; rendered: string } | null;
  cursor: number;
  state: PackState;
  status: string;
}

export interface SearchHit {
  score: number;
  w0: number;
  w1: number;
  citation: string;
  lines: Line[];
  rendered: string[];
}

export class CallQuery {
  readonly view: CallView;
  readonly index: ChunkIndex;

  constructor(view: CallView, opts: EngineOptions = {}) {
    this.view = view;
    this.index = new ChunkIndex(view, opts);
  }

  get tz(): string {
    return this.view.call?.tz ?? "UTC";
  }

  /** Wall time of the first part, or of the call's creation. */
  get start(): number | undefined {
    return this.view.parts()[0]?.wallStart ?? this.view.call?.t;
  }

  /** When the call stopped recording: the end of its last part, or its last line. */
  endedAt(): number | undefined {
    if (this.view.live) return undefined;
    let end: number | undefined;
    for (const p of this.view.parts()) {
      if (!p.ended) continue;
      const w = p.clock.wallFromAudio(p.ended.fileSeconds);
      if (end === undefined || w > end) end = w;
    }
    const lines = this.index.allLines();
    const last = lines[lines.length - 1]?.line.w1;
    if (last !== undefined && (end === undefined || last > end)) end = last;
    return end;
  }

  /** "Now" for this call: the current time while live, the end of the call once it ended. */
  reference(now: number): number {
    if (this.view.live) return now;
    return this.endedAt() ?? now;
  }

  status(now: number, stable = false): string {
    const parts = this.view.parts();
    const lastPart = parts[parts.length - 1];
    const pause = lastPart?.pauses.findLast((p) => !p.resumed);
    return statusLine({
      state: this.view.state,
      endedAt: this.endedAt(),
      pausedAt: pause?.wall,
      now,
      tz: this.tz,
      stable,
    });
  }

  roster(): SpeakerRef[] {
    return this.view.roster().map((r) => ({
      spk: r.mergedInto ?? r.spk,
      label: r.label,
      name: r.name,
    }));
  }

  // -------------------------------------------------------------------------
  // akou_read: what is new since a cursor

  read(since: number, now: number): ReadResult {
    this.index.sync();
    const lines: Line[] = [];
    const retracted: string[] = [];
    const switched = new Set(
      this.view
        .parts()
        .filter((p) => p.finalDoneSeq !== undefined && p.finalDoneSeq > since)
        .map((p) => p.part),
    );
    const superseded =
      switched.size === 0
        ? []
        : this.view
            .lines("live", { includeEcho: true, includeRetracted: true })
            .filter((l) => switched.has(l.part))
            .map((l) => l.id);
    for (const l of this.view.lines("best", { includeRetracted: true })) {
      const seg = this.view.segment(l.id);
      // A part that switched layers since the cursor is new to the reader in full.
      if (!seg || (seg.lastSeq <= since && !switched.has(l.part))) continue;
      if (l.retracted) retracted.push(l.id);
      else lines.push(l);
    }
    const p = this.provisionalLine(now);
    return {
      lines,
      rendered: lines.map((l) => renderLine(l, { tz: this.tz })),
      retracted,
      superseded,
      provisional: p,
      cursor: this.view.lastSeq,
      state: packState(this.view.state),
      status: this.status(now),
    };
  }

  // -------------------------------------------------------------------------
  // akou_search: BM25 hits with wall-time citations

  search(query: string, k = SEARCH_K): SearchHit[] {
    this.index.sync();
    const terms = this.index.terms(query).map((term) => ({ term, weight: 1 }));
    return this.pickHits(this.expand(terms, query), [], k, () => true).map(({ chunk, score }) => {
      const lines = chunk.ids
        .map((id) => this.lineById(id))
        .filter((l): l is Line => l !== undefined);
      const first = lines[0];
      return {
        score,
        w0: chunk.w0,
        w1: chunk.w1,
        citation: first ? formatCitation(first.w0, first.speaker, this.tz) : "",
        lines,
        rendered: lines.map((l) => renderLine(l, { tz: this.tz })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // akou_context: the pack

  context(question: string, opts: ContextOptions): ContextPack {
    this.index.sync();
    const surface = opts.surface ?? "mcp";
    const budget = Math.max(
      MIN_BUDGET,
      opts.budget ?? (surface === "app" ? APP_BUDGET : MCP_BUDGET),
    );
    const now = opts.now;
    const ref = this.reference(now);
    const tz = this.tz;
    const roster = this.roster();
    const cls = classify(question, {
      tz,
      start: this.start,
      now: ref,
      roster,
      stopwords: this.index.stopwords,
      user: this.view.call?.user,
    });
    const memo = memoStatus(this.view, this.linesIter(), ref, this.memoCoverage());

    const whole = this.wholeCall(question, cls, memo, {
      now,
      ref,
      budget,
      surface,
      explicit: opts.budget !== undefined,
    });
    if (whole) return whole;
    return this.retrieval(cls, memo, { now, ref, budget });
  }

  // -------------------------------------------------------------------------

  private coverage: { key: string; until: number | undefined } | null = null;

  /** `memoCoveredUntil`, cached per memo revision: it walks both layers once. */
  private memoCoverage(): number | undefined {
    const memo = this.view.memo;
    const key = memo ? `${memo.rev}:${memo.coversSeq}` : "";
    if (this.coverage?.key !== key) {
      this.coverage = { key, until: memoCoveredUntil(this.view, memo?.coversSeq ?? 0) };
    }
    return this.coverage.until;
  }

  private *linesIter(): Iterable<Line> {
    for (const c of this.index.allLines()) yield c.line;
  }

  private lineById(id: string): Line | undefined {
    const i = this.index.lineIndex(id);
    return i < 0 ? undefined : this.index.allLines()[i]?.line;
  }

  private provisionalLine(now: number): (ContextPack["provisional"] & { rendered: string }) | null {
    let best: Provisional | undefined;
    for (const p of this.view.provisional.current(now)) if (!best || p.at > best.at) best = p;
    if (!best) return null;
    const speaker =
      best.ch === "mic"
        ? this.view.speakerLabel("you")
        : best.spk
          ? this.view.speakerLabel(best.spk)
          : "Unknown speaker";
    return {
      text: best.text,
      w0: best.w0,
      speaker,
      rendered: renderProvisional(best, speaker, this.tz),
    };
  }

  private headerLines(now: number, ref: number, stable: boolean): string[] {
    const call = this.view.call;
    const tz = this.tz;
    const start = this.start;
    const out: string[] = [];
    if (call) {
      const started =
        start !== undefined
          ? `, started ${formatWall(start, tz)} on ${formatLocalDate(start, tz)}`
          : "";
      out.push(`Call: "${call.title}", workspace ${call.workspace}${started}.`);
    }
    out.push(zoneLine(tz, start ?? now));
    if (!stable) out.push(...this.dynamicHeader(now, ref));
    return out;
  }

  /** The part of the header that changes as the call goes on. */
  private dynamicHeader(now: number, ref: number): string[] {
    const tz = this.tz;
    const out: string[] = [nowLine(now, this.start, tz)];
    const ended = this.endedAt();
    if (ended !== undefined && !this.view.live) {
      out.push(`The call ended ${formatAgo(now - ended)}; answer about it in the past tense.`);
    }
    const parts = this.view.parts();
    const facts: string[] = [];
    if (parts.length > 1) {
      const restarts = parts.slice(1).map((p) => formatWall(p.wallStart, tz));
      facts.push(`${parts.length} parts, restarted at ${restarts.join(", ")}; read as one call`);
    }
    for (const p of parts) {
      for (const pause of p.pauses) {
        const until = pause.resumed ? formatWall(pause.resumed.wall, tz) : "now";
        facts.push(`paused ${formatWall(pause.wall, tz)} to ${until}, nothing recorded`);
      }
      for (const g of p.gaps) {
        facts.push(
          `computer asleep ${formatWall(g.wallFrom, tz)} to ${formatWall(g.wallTo, tz)}, nothing recorded`,
        );
      }
    }
    if (facts.length > 0) out.push(`Recording: ${facts.join("; ")}.`);
    out.push(`Speakers: ${this.rosterText()}.`);
    const gaps = this.healthGaps(ref);
    if (gaps.length > 0) out.push(`Health: ${gaps.join("; ")}.`);
    const lag = this.view.asrLag;
    if (lag && this.view.live && lag.seconds >= 10) {
      out.push(
        `The recognizer is ${Math.round(lag.seconds)} s behind; the newest speech is not here yet.`,
      );
    }
    return out;
  }

  private rosterText(): string {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const r of this.view.roster()) {
      if (r.mergedInto) {
        parts.push(`${r.spk} is the same person as ${r.mergedInto}`);
        continue;
      }
      if (seen.has(r.spk)) continue;
      seen.add(r.spk);
      parts.push(`${r.spk} = ${r.label}`);
    }
    return parts.length > 0 ? parts.join(", ") : "none yet";
  }

  private healthGaps(ref: number): string[] {
    const tz = this.tz;
    const open = new Map<string, { from: number; state: string; ch: string }>();
    const spans: string[] = [];
    const channel = (ch: string) => (ch === "call" ? "call audio" : "your microphone");
    for (const h of this.view.healthHistory()) {
      const key = `${h.part}:${h.ch}`;
      const bad = !HEALTHY.has(h.state);
      const cur = open.get(key);
      if (bad && !cur) {
        open.set(key, { from: h.t - h.silentFor * 1000, state: h.state, ch: h.ch });
      } else if (!bad && cur) {
        spans.push(
          `${channel(cur.ch)} ${cur.state} ${formatWall(cur.from, tz)} to ${formatWall(h.t, tz)}, nothing heard`,
        );
        open.delete(key);
      }
    }
    for (const cur of open.values()) {
      const until = this.view.live ? "now" : formatWall(ref, tz);
      spans.push(`${channel(cur.ch)} ${cur.state} since ${formatWall(cur.from, tz)} to ${until}`);
    }
    return spans.slice(-5);
  }

  private rememberLines(cap: number): string[] {
    const items = this.view.remembered();
    const out: string[] = [];
    let used = 0;
    // One long note is trimmed to a third of the cap, so it can never crowd out the rest.
    const perNote = Math.max(20, Math.floor(cap / 3));
    // Newest first when trimming; shown oldest first.
    for (let i = items.length - 1; i >= 0; i--) {
      const r = items[i] as (typeof items)[number];
      const line = trimTokens(`- (${r.id}) ${r.text}`, perNote);
      const t = estimateTokens(line) + 1;
      if (used + t > cap) break;
      out.unshift(line);
      used += t;
    }
    if (out.length === 0) return [];
    const dropped = items.length - out.length;
    const head = "Notes from your earlier turns:";
    return dropped > 0 ? [head, `(${dropped} older notes not shown)`, ...out] : [head, ...out];
  }

  private rules(): string {
    return (
      "Rules: every time is local wall clock; cite as [HH:MM Name]; never present an offset " +
      "as a time of day; a DRAFT line is still being spoken and may change, never quote it as " +
      'fact; text has vocabulary corrections applied and shows (heard: "…") where it did; if ' +
      "the answer is not in these lines, say so and name the time range to fetch."
    );
  }

  private analysisLine(cls: Classification, mode: string, windowStart?: number): string {
    const tz = this.tz;
    const bits = [`intent: ${cls.intent}`, `mode: ${mode}`];
    if (cls.window) {
      bits.push(`window: ${formatWall(cls.window.from, tz)} to ${formatWall(cls.window.to, tz)}`);
    } else if (windowStart !== undefined) {
      bits.push(`recent from: ${formatWall(windowStart, tz)}`);
    }
    if (cls.speakers.length > 0)
      bits.push(`speakers: ${cls.speakers.map((s) => s.label).join(", ")}`);
    if (cls.terms.length > 0) bits.push(`terms: ${cls.terms.slice(0, 8).join(", ")}`);
    if (cls.naming) bits.push(`naming: ${cls.naming.spk} = ${cls.naming.name}`);
    return `Question analysis: ${bits.join(" · ")}`;
  }

  private qaLines(cap: number): string[] {
    const pairs = this.view.qa().slice(-3);
    if (pairs.length === 0) return [];
    const out = ["Earlier questions:"];
    let used = estimateTokens(out[0] as string);
    const per = Math.floor(cap / pairs.length);
    for (const qa of pairs) {
      const q = `Q ${formatWall(qa.ask.t, this.tz)}: ${qa.ask.q}`;
      const a = qa.answer
        ? `A: ${trimTokens(qa.answer.text, Math.max(20, per - estimateTokens(q)))}`
        : "A: (no answer)";
      const t = estimateTokens(q) + estimateTokens(a) + 2;
      if (used + t > cap) break;
      out.push(q, a);
      used += t;
    }
    return out.length > 1 ? out : [];
  }

  /** Vocabulary entries in force for this call: call-scoped adds, confirmed file entries, accepted proposals. */
  private vocabEntries(): { term: string; heard: string[]; scope: string }[] {
    const out: { term: string; heard: string[]; scope: string }[] = [];
    for (const v of this.view.callVocabulary())
      out.push({ term: v.term, heard: v.heard, scope: "call" });
    for (const f of this.view.options.vocabFiles ?? []) {
      if (f.confirmed !== false) out.push({ term: f.term, heard: [...f.heard], scope: "file" });
    }
    for (const p of this.view.proposals("accepted"))
      out.push({ term: p.term, heard: p.heard, scope: "file" });
    return out;
  }

  private vocabHits(question: string, lines: readonly Line[], cap: number): string[] {
    const q = ` ${tokenize(question)
      .map((t) => t.folded)
      .join(" ")} `;
    const used = new Set<string>();
    for (const l of lines) for (const c of l.corrections) used.add(foldText(c.term));
    const out: string[] = [];
    let tokens = 0;
    for (const e of this.vocabEntries()) {
      const forms = [e.term, ...e.heard].map((f) =>
        tokenize(f)
          .map((t) => t.folded)
          .join(" "),
      );
      if (!used.has(foldText(e.term)) && !forms.some((f) => f && q.includes(` ${f} `))) continue;
      const heard =
        e.heard.length > 0 ? ` (heard as ${e.heard.map((h) => JSON.stringify(h)).join(", ")})` : "";
      const line = `- ${e.term}${heard}`;
      const t = estimateTokens(line) + 1;
      if (tokens + t > cap) break;
      out.push(line);
      tokens += t;
    }
    return out.length > 0 ? ["Vocabulary in these lines:", ...out] : [];
  }

  /** Question terms plus expansions: vocabulary spellings, named speakers, summary words. */
  private expand(terms: QueryTerm[], question: string, cls?: Classification): QueryTerm[] {
    const out = [...terms];
    const q = ` ${tokenize(question)
      .map((t) => t.folded)
      .join(" ")} `;
    for (const e of this.vocabEntries()) {
      const forms = [e.term, ...e.heard];
      const hit = forms.some((f) => {
        const k = tokenize(f)
          .map((t) => t.folded)
          .join(" ");
        return k !== "" && q.includes(` ${k} `);
      });
      if (!hit) continue;
      for (const f of forms) for (const term of this.index.terms(f)) out.push({ term, weight: 1 });
    }
    if (cls) {
      for (const s of cls.speakers) {
        for (const term of this.index.terms(s.name ?? "")) out.push({ term, weight: 0.5 });
      }
      if (cls.intent === "summary")
        for (const term of SUMMARY_TERMS) out.push({ term, weight: 0.5 });
      if (cls.intent === "follow-up") {
        const last = this.view.qa().at(-1);
        if (last) for (const term of this.index.terms(last.ask.q)) out.push({ term, weight: 0.7 });
      }
    }
    return out;
  }

  private pickHits(
    query: readonly QueryTerm[],
    boostSpeakers: readonly string[],
    k: number,
    accept: (c: Chunk) => boolean,
  ): { chunk: Chunk; score: number }[] {
    if (query.length === 0) return [];
    const boost = new Set(boostSpeakers);
    const hits = this.index.search(query, {
      accept,
      boost: (c) => (boost.size > 0 && c.speakers.some((s) => boost.has(s)) ? SPEAKER_BOOST : 1),
    });
    const top = hits[0]?.score ?? 0;
    const chosen: { chunk: Chunk; score: number }[] = [];
    for (const h of hits) {
      if (chosen.length >= k) break;
      if (h.score <= 0 || h.score < top * MIN_RELATIVE_SCORE) break;
      const near = chosen.some(
        (c) => h.chunk.w0 <= c.chunk.w1 + DEDUP_MS && c.chunk.w0 <= h.chunk.w1 + DEDUP_MS,
      );
      if (!near) chosen.push(h);
    }
    return chosen;
  }

  // -------------------------------------------------------------------------
  // Retrieval mode

  private retrieval(
    cls: Classification,
    memo: MemoStatus,
    o: { now: number; ref: number; budget: number },
  ): ContextPack {
    const tz = this.tz;
    const lines = this.index.allLines();
    const status = this.status(o.now);
    const header = [status, ...this.headerLines(o.now, o.ref, false)];
    // What the header, the rules and the call-text markers leave: the optional blocks shrink with
    // a small budget.
    const avail = Math.max(
      0,
      o.budget - cost([...header, this.rules()]) - BLOCK_CAPS.analysis - QUOTE_COST,
    );
    const capOf = (name: keyof typeof BLOCK_SHARE) =>
      Math.min(BLOCK_CAPS[name], Math.floor(avail * BLOCK_SHARE[name]));
    const remember = this.rememberLines(
      // Remembered lines are in every pack; they keep at least 150 tokens of the header.
      Math.min(
        capOf("remember"),
        Math.max(150, BLOCK_CAPS.header - estimateTokens(header.join("\n")) - 90),
      ),
    );
    header.push(...remember, this.rules());

    const qa = this.qaLines(capOf("qa"));
    const memoText = renderMemo(memo, capOf("memo"));
    const memoBlock: string[] = [];
    if (memoText) {
      const covered = memo.coveredUntil;
      memoBlock.push(
        `Memo${covered ? ` (covers the call up to ${formatWall(covered, tz)})` : ""}:`,
        memoText,
      );
    } else {
      memoBlock.push("Memo: none yet.");
    }
    // akou's notes to the agent: outside the call-text block, so they read as akou's.
    const notes: string[] = [];
    if (memo.stale) {
      notes.push(
        `The memo is stale: ${memo.uncovered.lines} lines are not covered. Write one with akou_memo_put.`,
      );
    }
    const prov = cls.intent === "now" ? this.provisionalLine(o.now) : null;
    const provBlock = prov ? ["Being said now:", prov.rendered] : [];

    // The recency window starts at the earlier of "5 minutes ago" and the first line the memo
    // does not cover, so memo and window never leave a gap.
    const fiveMin = o.ref - RECENCY_MS;
    const windowStart =
      memo.uncovered.w0 !== undefined ? Math.min(fiveMin, memo.uncovered.w0) : fiveMin;
    let analysis = this.analysisLine(
      cls,
      "retrieval",
      cls.intent === "time" ? undefined : windowStart,
    );

    const fixed =
      cost(header) +
      cost([analysis]) +
      cost(notes) +
      QUOTE_COST +
      cost(qa) +
      cost(memoBlock) +
      cost(provBlock) +
      capOf("vocab") +
      20;
    const lineBudget = Math.max(0, o.budget - fixed);
    let recencyBudget = Math.floor(lineBudget * RECENCY_SHARE[cls.intent]);

    const chosen = new Set<string>();
    const recency: Line[] = [];
    const retrieved: Line[] = [];
    let recencyOmitted = false;
    let recencyUsed = 0;
    let retrievedUsed = 0;

    const take = (l: Line, into: Line[], cap: number, used: number): number => {
      const t = estimateTokens(renderLine(l, { tz })) + 1;
      if (used + t > cap) return -1;
      into.push(l);
      chosen.add(l.id);
      return used + t;
    };

    if (cls.intent === "time" && cls.window?.empty) {
      // Nothing of the call is in the window asked for.
      recencyBudget = 0;
    } else if (cls.intent === "time" && cls.window) {
      // Hard time filter, then recall inside it.
      const win = cls.window;
      const from = this.index.firstAtOrAfter(win.from);
      const to = this.index.firstAtOrAfter(win.to + 1);
      const inWindow = (c: Chunk) => c.w0 <= win.to && c.w1 >= win.from;
      const terms = cls.terms.map((term) => ({ term, weight: 1 }));
      const cap = lineBudget;
      for (const h of this.pickHits(
        this.expand(terms, "", cls),
        speakerIds(cls),
        SEARCH_K,
        inWindow,
      )) {
        for (let i = h.chunk.start; i < h.chunk.end; i++) {
          const l = (lines[i] as { line: Line }).line;
          if (chosen.has(l.id) || l.w0 < win.from || l.w0 > win.to) continue;
          const next = take(l, retrieved, cap, retrievedUsed);
          if (next < 0) break;
          retrievedUsed = next;
        }
      }
      // Fill the rest of the window: outward from the moment asked about ("around 15:40"), from
      // its end when it reaches now ("last 5 minutes"), else from its start ("first 10 minutes").
      const order: number[] = [];
      for (let i = from; i < to; i++) order.push(i);
      const lineAt = (i: number) => (lines[i] as { line: Line }).line;
      const anchor = win.anchor;
      if (anchor !== undefined) {
        order.sort((a, b) => Math.abs(lineAt(a).w0 - anchor) - Math.abs(lineAt(b).w0 - anchor));
      } else if (win.to >= o.ref - 60_000) {
        order.reverse();
      }
      for (const i of order) {
        const l = lineAt(i);
        if (chosen.has(l.id)) continue;
        const next = take(l, retrieved, cap, retrievedUsed);
        if (next < 0) {
          recencyOmitted = true;
          break;
        }
        retrievedUsed = next;
      }
      recencyBudget = 0;
    } else {
      // 1. The recency window, newest first, within its share.
      let shownFrom = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = (lines[i] as { line: Line }).line;
        if (l.w0 < windowStart) break;
        const next = take(l, recency, recencyBudget, recencyUsed);
        if (next < 0) {
          recencyOmitted = true;
          break;
        }
        recencyUsed = next;
        shownFrom = i;
      }
      // 2. Retrieval over what the window did not show, with what the window left unused.
      let retrievedBudget = lineBudget - recencyUsed;
      const outside = (c: Chunk) => c.start < shownFrom;
      const terms = cls.terms.map((term) => ({ term, weight: 1 }));
      const hits = this.pickHits(
        this.expand(terms, joinTerms(cls), cls),
        speakerIds(cls),
        SEARCH_K,
        outside,
      );
      for (const h of hits) {
        const group: Line[] = [];
        for (let i = Math.max(0, h.chunk.start - 1); i <= h.chunk.end && i < shownFrom; i++) {
          const l = (lines[i] as { line: Line }).line;
          if (!chosen.has(l.id)) group.push(l);
        }
        const groupCost = group.reduce((n, l) => n + estimateTokens(renderLine(l, { tz })) + 1, 0);
        const list =
          retrievedUsed + groupCost <= retrievedBudget ? group : matching(group, cls.terms);
        for (const l of list) {
          const next = take(l, retrieved, retrievedBudget, retrievedUsed);
          if (next >= 0) retrievedUsed = next;
        }
      }
      // 3. What retrieval left unused flows back to the window, older lines, until a line
      //    retrieval already shows.
      recencyBudget = lineBudget - retrievedUsed;
      for (let i = shownFrom - 1; i >= 0 && recencyOmitted; i--) {
        const l = (lines[i] as { line: Line }).line;
        if (chosen.has(l.id)) break;
        const next = take(l, recency, recencyBudget, recencyUsed);
        if (next < 0) break;
        recencyUsed = next;
        shownFrom = i;
      }
      recencyOmitted =
        recencyOmitted && shownFrom > 0 && (lines[shownFrom - 1]?.line.w0 ?? 0) >= windowStart;
      recency.reverse();
      retrievedBudget = 0;
    }

    retrieved.sort(byTime);
    // The analysis names where the recent lines actually start.
    analysis = this.analysisLine(cls, "retrieval", recency[0]?.w0);
    const all = [...retrieved, ...recency].sort(byTime);
    const vocab = this.vocabHits(joinTerms(cls), all, capOf("vocab"));

    const sections: { name: string; rows: string[] }[] = [
      { name: "header", rows: header },
      { name: "analysis", rows: [analysis] },
      { name: "notes", rows: notes },
    ];
    const push = (name: string, block: string[]) => {
      if (block.length > 0) sections.push({ name, rows: [...block] });
    };
    push("qa", qa);
    push("vocab", vocab);
    push("memo", memoBlock);
    const win = cls.intent === "time" ? cls.window : undefined;
    if (retrieved.length > 0) {
      const title = win
        ? `Lines from ${formatWall(win.from, tz)} to ${formatWall(win.to, tz)}${recencyOmitted ? " (not all fit; ask a narrower window for the rest)" : ""}:`
        : "Retrieved earlier lines:";
      push("retrieved", [title, ...renderRuns(retrieved, this.index, tz)]);
    } else if (win?.empty) {
      const start = this.start;
      const span =
        start !== undefined
          ? `, which ran ${formatWall(start, tz)} to ${formatWall(o.ref, tz)}`
          : "";
      push("retrieved", [
        `Lines in the window asked for: nothing recorded; it falls outside the call${span}.`,
      ]);
    } else if (win) {
      push("retrieved", [
        `Lines from ${formatWall(win.from, tz)} to ${formatWall(win.to, tz)}: nothing recorded in this window.`,
      ]);
    }
    if (recency.length > 0) {
      const first = recency[0] as Line;
      const note = recencyOmitted
        ? ` (lines from ${formatWall(windowStart, tz)} to ${formatWall(first.w0, tz)} did not fit; fetch that range if needed)`
        : "";
      push("recency", [
        `Recent lines, ${formatWall(first.w0, tz)} to now${note}:`,
        ...recency.map((l) => renderLine(l, { tz })),
      ]);
    } else if (cls.intent !== "time") {
      push("recency", ["Recent lines: nothing said in the last 5 minutes."]);
    }
    push("provisional", provBlock);

    const join = () => {
      const text = (xs: typeof sections) =>
        xs
          .filter((x) => x.rows.length > 0)
          .map((x) => x.rows.join("\n"))
          .join("\n\n");
      const outside = text(sections.filter((x) => !QUOTED.has(x.name)));
      const quoted = text(sections.filter((x) => QUOTED.has(x.name)));
      // A pack squeezed down to its header has no call text left to quote.
      return quoted === "" ? outside : `${outside}\n\n${quoteCallText(quoted)}`;
    };
    let text = join();
    let tokens = estimateTokens(text);
    // The estimate of the parts can differ from the whole; trim until the pack fits: the oldest
    // retrieved line, then the oldest recent line, then the Q&A, the vocabulary and the memo.
    while (tokens > o.budget) {
      const victim = retrieved.shift() ?? recency.shift();
      if (victim) {
        const r = renderLine(victim, { tz });
        for (const x of sections) {
          const i = x.rows.indexOf(r);
          if (i >= 0) x.rows.splice(i, 1);
        }
      } else {
        // Then the Q&A, the vocabulary and the memo, which leaves a pointer among akou's notes;
        // then that pointer; then the titles left of the line blocks, and with them the block.
        const notes = sections.find((x) => x.name === "notes");
        const at = ["qa", "vocab", "memo"]
          .map((n) => sections.findIndex((x) => x.name === n))
          .find((i) => i >= 0);
        const pointer = notes?.rows.indexOf(MEMO_OMITTED) ?? -1;
        const rest = sections.findIndex((x) => QUOTED.has(x.name));
        if (at !== undefined) {
          const x = sections.splice(at, 1)[0];
          if (x?.name === "memo") notes?.rows.push(MEMO_OMITTED);
        } else if (pointer >= 0) notes?.rows.splice(pointer, 1);
        else if (rest >= 0) sections.splice(rest, 1);
        else break;
      }
      text = join();
      tokens = estimateTokens(text);
    }
    const blocks: PackBlock[] = sections
      .filter((x) => x.rows.length > 0)
      .map((x) => ({ name: x.name, tokens: cost(x.rows) }));

    return {
      text,
      tokens,
      budget: o.budget,
      mode: "retrieval",
      state: packState(this.view.state),
      status,
      cursor: this.view.lastSeq,
      memoStale: memo.stale,
      memo: { coversSeq: memo.coversSeq, uncovered: memo.uncovered },
      provisional: prov ? { text: prov.text, w0: prov.w0, speaker: prov.speaker } : null,
      analysis: { ...cls, line: analysis },
      lines: [...retrieved, ...recency].sort(byTime),
      blocks,
      tz,
    };
  }

  // -------------------------------------------------------------------------
  // Whole-call mode

  private wholeCall(
    question: string,
    cls: Classification,
    memo: MemoStatus,
    o: { now: number; ref: number; budget: number; surface: "mcp" | "app"; explicit: boolean },
  ): ContextPack | null {
    if (o.surface === "mcp" && o.budget < WHOLE_CALL_FITS) return null;
    const tz = this.tz;
    const lines = this.index.allLines();
    const transcript: string[] = [];
    let used = 0;
    for (const c of lines) {
      const r = escapeCallText(renderLine(c.line, { tz, speakerIds: true }));
      used += estimateTokens(r) + 1;
      if (used > WHOLE_CALL_FITS) return null;
      transcript.push(r);
    }
    // The app overrides its 8k default with the whole-call cap, never a budget it was given.
    const cap =
      o.surface === "app" && !o.explicit ? WHOLE_CALL_CAP : Math.min(o.budget, WHOLE_CALL_CAP);

    // Stable prefix: nothing here changes when a speaker is named or time passes.
    const status = this.status(o.now, true);
    const head = [
      status,
      ...this.headerLines(o.now, o.ref, true),
      this.rules(),
      "Speaker ids are used below; the roster after the transcript gives their names.",
      "",
      ...CALL_TEXT_START,
      "Transcript:",
    ];
    const prefix = [...head, ...transcript];

    // Dynamic tail.
    const prov = cls.intent === "now" ? this.provisionalLine(o.now) : null;
    const analysis = this.analysisLine(cls, "whole");
    const memoText = renderMemo(memo, BLOCK_CAPS.memo);
    const all = lines.map((c) => c.line);
    // The rest of the call text closes the block the head opened; akou's own lines follow it.
    const tail = [
      ...[
        ...this.vocabHits(question, all, BLOCK_CAPS.vocab),
        ...(memoText ? ["Memo:", memoText] : []),
        ...this.qaLines(BLOCK_CAPS.qa),
        ...(prov ? ["Being said now:", prov.rendered] : []),
      ].map(escapeCallText),
      CALL_TEXT_CLOSE,
      "",
      ...(this.status(o.now) !== status ? [`Status now: ${this.status(o.now)}.`] : []),
      ...this.dynamicHeader(o.now, o.ref),
      ...this.rememberLines(BLOCK_CAPS.remember),
      ...(memo.stale ? ["The memo is stale. Write one with akou_memo_put."] : []),
      analysis,
    ];
    const text = [...prefix, ...tail].join("\n");
    const tokens = estimateTokens(text);
    if (tokens > cap) return null;
    return {
      text,
      tokens,
      budget: cap,
      mode: "whole",
      state: packState(this.view.state),
      status,
      cursor: this.view.lastSeq,
      memoStale: memo.stale,
      memo: { coversSeq: memo.coversSeq, uncovered: memo.uncovered },
      provisional: prov ? { text: prov.text, w0: prov.w0, speaker: prov.speaker } : null,
      analysis: { ...cls, line: analysis },
      lines: all,
      blocks: [
        { name: "prefix", tokens: estimateTokens(prefix.join("\n")) },
        { name: "tail", tokens: estimateTokens(tail.join("\n")) },
      ],
      tz,
      whole: { head: head.join("\n"), transcript, tail: tail.join("\n") },
    };
  }
}

const MEMO_OMITTED = "Memo: not shown, over the budget; read it with akou_memo_get.";

/** The sections of a retrieval pack that come from the call, quoted in one block (PG-Z1). */
const QUOTED: ReadonlySet<string> = new Set([
  "qa",
  "vocab",
  "memo",
  "retrieved",
  "recency",
  "provisional",
]);

/** What the call-text header and markers cost. */
const QUOTE_COST = estimateTokens(quoteCallText("")) + 2;

const HEALTHY = new Set(["ok", "alive", "healthy", "recovered", "running"]);

function cost(block: readonly string[]): number {
  return block.length === 0 ? 0 : estimateTokens(block.join("\n")) + 2;
}

function byTime(a: Line, b: Line): number {
  return a.w0 - b.w0 || (a.ch === b.ch ? a.seq - b.seq : a.ch === "mic" ? -1 : 1);
}

function speakerIds(cls: Classification): string[] {
  return cls.speakers.map((s) => s.spk);
}

function joinTerms(cls: Classification): string {
  return cls.terms.join(" ");
}

function matching(group: readonly Line[], terms: readonly string[]): Line[] {
  const set = new Set(terms);
  return group.filter((l) => tokenize(`${l.text} ${l.raw ?? ""}`).some((t) => set.has(t.folded)));
}

function trimTokens(text: string, max: number): string {
  if (estimateTokens(text) <= max) return text;
  let out = "";
  for (const word of text.split(/\s+/)) {
    if (estimateTokens(`${out} ${word} …`) > max) break;
    out = out ? `${out} ${word}` : word;
  }
  return `${out} …`;
}

/** Retrieved lines grouped into runs of neighbours, with "…" between runs. */
function renderRuns(lines: readonly Line[], index: ChunkIndex, tz: string): string[] {
  const out: string[] = [];
  let prev = -2;
  for (const l of lines) {
    const i = index.lineIndex(l.id);
    if (out.length > 0 && i !== prev + 1) out.push("…");
    out.push(renderLine(l, { tz }));
    prev = i;
  }
  return out;
}
