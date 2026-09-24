/**
 * Enhanced notes (docs/DESIGN.md section 5.2): the user's notepad plus the call, turned into notes
 * under a template's sections by the configured provider (or by an agent, through
 * `GET /enhance/context` and `PUT /enhanced`). "Enhance so far" is the same thing on a live call.
 *
 * The input: the template, every user note verbatim with the transcript from 90 s before to 30 s
 * after it, the memo, the agent's remembered lines, and the whole transcript if it fits 20k
 * tokens. Past that, a map step summarises each 15-minute stretch (cached as `chunk.summary`
 * events, so a re-run does not pay twice; the pack and the memo never read them) and one reduce
 * step writes the notes from the summaries.
 *
 * The output rules, enforced here and not left to the model:
 * - The user's own lines are kept word for word and marked as theirs. The model places one by
 *   writing a bullet that holds only its id (`- {n0004}`); akou puts the text back itself. A line
 *   the model did not place is added under "Your notes", so none is ever lost.
 * - Every added bullet cites segment ids, and `cite-check.ts` drops any that fails.
 * - The result is an `enhanced {rev}` event and a file per revision under `enhanced/`, plus
 *   `notes.enhanced.md` as the latest; enhancing again with another template keeps both.
 *
 * Re-enhance after the final layer (`reEnhanceState`): notes written before the final pass read the
 * live transcript. When the final layer lands, akou writes them again from it with the same
 * template, on its own, unless a person or an agent wrote those notes (then re-enhancing would
 * replace their work) or the provider is the harness (it runs only when asked); in both cases the
 * window offers a button instead.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatLocalDate, formatWall } from "../../core/log/clock.ts";
import type { EventDraft, LogEvent } from "../../core/log/events.ts";
import type { CallView, Line, NoteView } from "../../core/log/fold.ts";
import { type CompleteResult, type Provider, runProvider } from "../llm/provider.ts";
import type { CallQuery } from "../query/context.ts";
import { estimateTokens, renderLine, zoneLine } from "../query/render.ts";
import { type CiteCheckResult, citeCheck, type DroppedLine, stripMarker } from "./cite-check.ts";
import { linesAround, renderNote } from "./notepad.ts";
import { renderTemplate, type Template } from "./templates.ts";

/** The whole transcript goes in when it fits this many tokens. */
export const WHOLE_TRANSCRIPT_TOKENS = 20_000;
/** Past it, each stretch this long is summarised once (the map step). */
export const CHUNK_MS = 15 * 60_000;
export const MAP_MAX_TOKENS = 1500;
export const REDUCE_MAX_TOKENS = 4096;
export const NOTE_BEFORE_MS = 90_000;
export const NOTE_AFTER_MS = 30_000;

export const ENHANCED_LATEST = "notes.enhanced.md";
export const ENHANCED_DIR = "enhanced";

const PLACEHOLDER = /^\s*(?:[-*+]\s+)?\{(n\d+)\}\s*$/;

export const ENHANCE_SYSTEM = [
  "You write notes of a call from its transcript and the user's own notepad.",
  "Rules:",
  '- Write Markdown under exactly the "## " section headings of the template, in its order, following each section\'s instruction.',
  "- Every bullet ends with the ids of the transcript lines it rests on, like [#l000031] or [#l000031 #l000045]. Use only ids that appear in the lines you were given. Leave out anything you cannot tie to a line.",
  "- The user's own notes carry ids like {n0004}. Never reword them. To place one, write a bullet that holds only its id, for example `- {n0004}`, under the section it belongs to. Place each user note once.",
  "- Times are local wall-clock times as shown. Never write an offset such as 00:20 as a time of day.",
  "- No preamble and no closing remarks: only the sections.",
].join("\n");

export const MAP_SYSTEM = [
  "You summarise one stretch of a call transcript so that notes can be written from it later.",
  "Write short bullets: topics, facts, decisions, action items with their owner, open questions, and who said what.",
  "Every bullet ends with the ids of the lines it rests on, like [#l000031]. Use only ids from the lines given.",
  "No preamble and no closing remarks.",
].join("\n");

export interface EnhanceInput {
  mode: "whole" | "chunked";
  /** The prompt for the reduce step (or the only step). */
  prompt: string;
  tokens: number;
  coversSeq: number;
  /** Stretches still to summarise, in chunked mode; empty when all are cached. */
  pending: ChunkSpan[];
  userNotes: NoteView[];
}

export interface ChunkSpan {
  from: number;
  to: number;
  lines: Line[];
  /** The newest log `seq` among these lines: a cached summary written after it still holds. */
  newestSeq: number;
  summary?: string;
}

function header(q: CallQuery, now: number): string[] {
  const call = q.view.call;
  const start = q.start;
  const out: string[] = [q.status(now)];
  if (call) {
    const when =
      start !== undefined
        ? `, started ${formatWall(start, q.tz)} on ${formatLocalDate(start, q.tz)}`
        : "";
    out.push(`Call: "${call.title}", workspace ${call.workspace}${when}.`);
  }
  out.push(zoneLine(q.tz, start ?? now));
  const roster = q.view.roster().filter((r) => !r.mergedInto);
  if (roster.length > 0) out.push(`Speakers: ${roster.map((r) => r.label).join(", ")}.`);
  return out;
}

/** The user's own notepad lines (agents' lines are context, not kept verbatim). */
export function userNotes(view: CallView): NoteView[] {
  return view.notes().filter((n) => n.author === "human");
}

/** Splits the transcript into 15-minute stretches from its first line. */
export function chunkSpans(lines: readonly Line[], chunkMs = CHUNK_MS): ChunkSpan[] {
  const first = lines[0];
  if (!first) return [];
  const out: ChunkSpan[] = [];
  for (const l of lines) {
    const k = Math.floor((l.w0 - first.w0) / chunkMs);
    const from = first.w0 + k * chunkMs;
    let span = out.at(-1);
    if (!span || span.from !== from) {
      span = { from, to: from + chunkMs, lines: [], newestSeq: 0 };
      out.push(span);
    }
    span.lines.push(l);
    span.newestSeq = Math.max(span.newestSeq, l.seq);
  }
  return out;
}

/** A cached summary for a stretch, if one was written after its newest line changed. */
function cachedSummary(view: CallView, span: ChunkSpan): string | undefined {
  const newest = Math.max(
    span.newestSeq,
    ...span.lines.map((l) => view.segment(l.id)?.lastSeq ?? l.seq),
  );
  const hit = view
    .chunkSummaries()
    .filter((c) => c.from === span.from && c.to === span.to && c.seq > newest)
    .at(-1);
  return hit?.body;
}

/**
 * Builds the input. `summaries` fills chunked mode's stretches (cached ones are read from the
 * log); a stretch with no summary is listed in `pending`.
 */
export function buildEnhanceInput(
  q: CallQuery,
  template: Template,
  o: { now: number; wholeLimit?: number; chunkMs?: number },
): EnhanceInput {
  const view = q.view;
  const tz = q.tz;
  const lines = view.lines("best");
  const rendered = lines.map((l) => renderLine(l, { tz }));
  const transcriptTokens = estimateTokens(rendered.join("\n"));
  const whole = transcriptTokens <= (o.wholeLimit ?? WHOLE_TRANSCRIPT_TOKENS);
  const mine = userNotes(view);
  const agents = view.notes().filter((n) => n.author === "agent");

  const parts: string[] = [...header(q, o.now), "", "Template:", renderTemplate(template), ""];
  if (mine.length > 0) {
    parts.push("The user's own notes (place each by its id; never reword):");
    for (const n of mine) {
      parts.push(`{${n.id}} ${renderNote(n, tz)}`);
      if (!whole) {
        const around = linesAround(lines, n.w, NOTE_BEFORE_MS, NOTE_AFTER_MS);
        for (const l of around) parts.push(`    ${renderLine(l, { tz })}`);
      }
    }
    parts.push("");
  }
  if (agents.length > 0) {
    parts.push("Notes an agent added during the call (context only):");
    for (const n of agents) parts.push(`- ${renderNote(n, tz)}`);
    parts.push("");
  }
  const memo = view.memo;
  if (memo) parts.push("Rolling memo of the call:", memo.body, "");
  const remembered = view.remembered();
  if (remembered.length > 0) {
    parts.push("Remembered by the agent:");
    for (const r of remembered) parts.push(`- ${r.text}`);
    parts.push("");
  }

  let pending: ChunkSpan[] = [];
  if (whole) {
    parts.push("Transcript:", ...(rendered.length > 0 ? rendered : ["(no lines yet)"]));
  } else {
    const spans = chunkSpans(lines, o.chunkMs);
    for (const s of spans) s.summary = cachedSummary(view, s);
    pending = spans.filter((s) => s.summary === undefined);
    parts.push("Summaries of the call, stretch by stretch:");
    for (const s of spans) {
      parts.push(`Stretch ${formatWall(s.from, tz)} to ${formatWall(s.to, tz)}:`);
      parts.push(s.summary ?? "(not summarised yet)");
    }
  }
  const prompt = parts.join("\n");
  return {
    mode: whole ? "whole" : "chunked",
    prompt,
    tokens: estimateTokens(prompt),
    coversSeq: view.lastSeq,
    pending,
    userNotes: mine,
  };
}

/** A note's text on one Markdown line: a line break inside it becomes a space. */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ");
}

/** The user's line as it appears in the notes: the text untouched, marked as theirs. */
export function userLine(n: NoteView, tz: string): string {
  return `- ${oneLine(n.text)} _(your note, ${formatWall(n.w, tz, { seconds: false })})_`;
}

export interface Composed {
  markdown: string;
  check: CiteCheckResult;
  /** User notes the model did not place, added under "Your notes". */
  appended: string[];
}

/**
 * Turns a model's (or an agent's) Markdown into the stored notes: placeholders become the user's
 * lines verbatim, the citation check runs, and any user line not placed is added at the end.
 */
export function composeNotes(
  raw: string,
  o: { view: CallView; tz: string; maxSeq: number; notes: readonly NoteView[] },
): Composed {
  const byId = new Map(o.notes.map((n) => [n.id, n]));
  const placed = new Set<string>();
  const lines: string[] = [];
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const m = PLACEHOLDER.exec(line);
    if (m) {
      const n = byId.get(m[1] as string);
      // An unknown id, or a note placed twice, is dropped: it is not the user's line.
      if (n && !placed.has(n.id)) {
        placed.add(n.id);
        lines.push(userLine(n, o.tz));
      }
      continue;
    }
    lines.push(line);
  }
  const body = lines.join("\n");
  const userLines = o.notes.flatMap((n) => [oneLine(n.text), userLine(n, o.tz)]);
  const check = citeCheck(body, { view: o.view, maxSeq: o.maxSeq, userLines });
  // A note counts as placed only when a whole kept line is it (by its id, or written out verbatim
  // by an agent). A substring, or the user's words inside a longer bullet, is not their line.
  const kept = new Set(check.markdown.split("\n").map((l) => stripMarker(l)));
  const isKept = (n: NoteView) =>
    kept.has(stripMarker(userLine(n, o.tz))) || kept.has(stripMarker(oneLine(n.text)));
  const missing = o.notes.filter((n) => !isKept(n));
  const appended = missing.map((n) => userLine(n, o.tz));
  const markdown =
    appended.length > 0
      ? `${check.markdown}${check.markdown ? "\n\n" : ""}## Your notes\n${appended.join("\n")}`
      : check.markdown;
  return { markdown, check, appended };
}

export interface EnhanceOptions {
  q: CallQuery;
  template: Template;
  provider: Provider;
  now: number;
  /** Appends an event through the call's one writer. */
  write: (draft: EventDraft) => Promise<LogEvent>;
  signal?: AbortSignal;
  /** Per provider call. */
  timeoutMs?: number;
  wholeLimit?: number;
  chunkMs?: number;
}

export interface EnhanceResult {
  markdown: string;
  model: string;
  coversSeq: number;
  mode: "whole" | "chunked";
  cites: string[];
  dropped: DroppedLine[];
  appended: string[];
  /** Provider calls made for the map step (cached stretches cost none). */
  mapCalls: number;
  tokens: number;
}

/**
 * Runs the enhancement: the map step for each stretch not cached (each summary checked and written
 * as a `chunk.summary`), then the reduce step, then the checks. Storing the result is the
 * caller's (`storeEnhanced`). Provider failures are thrown as `ProviderError`s.
 */
export async function enhance(o: EnhanceOptions): Promise<EnhanceResult> {
  const tz = o.q.tz;
  let input = buildEnhanceInput(o.q, o.template, o);
  let mapCalls = 0;
  const models = new Set<string>();
  for (const span of input.pending) {
    const prompt = [
      ...header(o.q, o.now),
      "",
      `Stretch ${formatWall(span.from, tz)} to ${formatWall(span.to, tz)}:`,
      ...span.lines.map((l) => renderLine(l, { tz })),
    ].join("\n");
    const r: CompleteResult = await runProvider(
      o.provider,
      { system: MAP_SYSTEM, prompt, maxTokens: MAP_MAX_TOKENS },
      () => {},
      { signal: o.signal, timeoutMs: o.timeoutMs },
    );
    mapCalls++;
    models.add(r.model);
    const checked = citeCheck(r.text, { view: o.q.view });
    await o.write({
      type: "chunk.summary",
      from: span.from,
      to: span.to,
      body: checked.markdown,
      model: r.model,
    });
  }
  if (mapCalls > 0) input = buildEnhanceInput(o.q, o.template, o);
  const r = await runProvider(
    o.provider,
    { system: ENHANCE_SYSTEM, prompt: input.prompt, maxTokens: REDUCE_MAX_TOKENS },
    () => {},
    { signal: o.signal, timeoutMs: o.timeoutMs },
  );
  models.add(r.model);
  const composed = composeNotes(r.text, {
    view: o.q.view,
    tz,
    maxSeq: input.coversSeq,
    notes: input.userNotes,
  });
  return {
    markdown: composed.markdown,
    model: r.model,
    coversSeq: input.coversSeq,
    mode: input.mode,
    cites: composed.check.cites,
    dropped: composed.check.dropped,
    appended: composed.appended,
    mapCalls,
    tokens: input.tokens,
  };
}

/** The per-revision file name, relative to the call folder. */
export function enhancedFile(rev: number, template: string): string {
  return `${ENHANCED_DIR}/${String(rev).padStart(3, "0")}-${template}.md`;
}

/** The next enhanced revision of a call. */
export function nextEnhancedRev(view: CallView): number {
  return (view.latestEnhanced()?.rev ?? 0) + 1;
}

/** The `enhanced` event for a stored revision. */
export function enhancedDraft(o: {
  rev: number;
  template: string;
  coversSeq: number;
  by: string;
  model: string;
  cites: string[];
}): EventDraft {
  return {
    type: "enhanced",
    rev: o.rev,
    template: o.template,
    file: enhancedFile(o.rev, o.template),
    coversSeq: o.coversSeq,
    by: o.by,
    model: o.model,
    cites: o.cites,
  };
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text, { flag: "wx" });
  renameSync(tmp, path);
}

/**
 * Writes a revision's notes into the call folder: `enhanced/NNN-template.md`, and the same body as
 * `notes.enhanced.md`, the latest. Both writes are atomic. Called before the `enhanced` event is
 * appended, so the event never names a file that is not there.
 */
export function storeEnhanced(
  dir: string,
  rev: number,
  template: string,
  markdown: string,
): string {
  const file = enhancedFile(rev, template);
  const body = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  writeAtomic(join(dir, file), body);
  writeAtomic(join(dir, ENHANCED_LATEST), body);
  return file;
}

/** Calls with an enhancement being written: one at a time per call, so revisions never race. */
const enhancing = new Set<string>();

/** Runs `fn` as the call's one enhancement, or returns null when one is already running. */
export async function enhanceExclusive<T>(id: string, fn: () => Promise<T>): Promise<T | null> {
  if (enhancing.has(id)) return null;
  enhancing.add(id);
  try {
    return await fn();
  } finally {
    enhancing.delete(id);
  }
}

export interface ReEnhanceState {
  /** The notes predate the final layer that has since landed. */
  due: boolean;
  /** akou re-enhances on its own; otherwise the window offers a button. */
  auto: boolean;
  template?: string;
  reason: string;
}

/**
 * Whether the latest notes should be written again from the final transcript. `provider` is the
 * configured provider's id: the harness is never run on its own.
 */
export function reEnhanceState(view: CallView, provider: string): ReEnhanceState {
  const latest = view.latestEnhanced();
  const done = view.final.state === "done" ? view.final.done : undefined;
  if (!latest) return { due: false, auto: false, reason: "no enhanced notes yet" };
  if (!done) return { due: false, auto: false, reason: "the final transcript is not ready" };
  if (latest.seq > done.seq) {
    return { due: false, auto: false, reason: "the notes were written from the final transcript" };
  }
  const base = { due: true, template: latest.template };
  // A provider's notes carry its model; notes put by a person or an agent carry their author.
  if (latest.model === latest.by) {
    return {
      ...base,
      auto: false,
      reason: "these notes were written by hand; re-enhancing would replace them",
    };
  }
  if (provider === "harness") {
    return { ...base, auto: false, reason: "the harness runs only when you ask" };
  }
  if (provider === "none") {
    return { ...base, auto: false, reason: "no provider is set up" };
  }
  return { ...base, auto: true, reason: "the final transcript landed after these notes" };
}
