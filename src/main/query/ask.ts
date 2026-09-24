/**
 * Asking akou's provider about a call (docs/DESIGN.md sections 5.3 and 5.4): the ask box, `akou
 * ask`, `POST /calls/{id}/ask` and `akou_ask` all run this.
 *
 * 1. The pack is built (no model call). A naming question ("c2 is Ben") writes `speaker.name` at
 *    once and needs no model.
 * 2. The excerpts that match the question are ready at once, before any model runs, so the asker
 *    always has something within the 300 ms target.
 * 3. The question is logged as an `ask` event; the provider answers over the pack, streaming.
 * 4. An answer is logged as an `answer` event with the segment ids it cites, the model and the
 *    pack's size. When the provider cannot answer (missing, a usage limit, not logged in, no
 *    answer within the deadline), the reply is the excerpts, labelled, with the reason; nothing is
 *    queued or retried, and no `answer` is logged, because no model answered.
 */

import { formatWall } from "../../core/log/clock.ts";
import type { EventDraft, LogEvent } from "../../core/log/events.ts";
import type { CallView, Line } from "../../core/log/fold.ts";
import { type ExcerptBlock, excerptsText } from "../llm/none.ts";
import {
  type Provider,
  ProviderError,
  type ProviderErrorKind,
  runProvider,
} from "../llm/provider.ts";
import type { CallQuery, ContextPack } from "./context.ts";
import { formatCitation, renderLine } from "./render.ts";

export const ASK_MAX_TOKENS = 1024;
const EXCERPT_K = 4;
const RECENT_LINES = 6;

export const ASK_SYSTEM = [
  "You answer a question about a call from the context pack you are given, and from nothing else.",
  "Follow the pack's rules: every time is local wall-clock time, cite what was said as [HH:MM Name], never present an offset as a time of day, and never quote a line marked DRAFT as fact.",
  "If the answer is not in the pack, say so and name the time range to look at.",
  "Answer briefly and plainly.",
].join("\n");

export interface AskResult {
  /** The `ask` event's id, when the question was logged. */
  ask?: string;
  /** A model answered. */
  answered: boolean;
  /** The answer, or the labelled excerpts. */
  text: string;
  kind: "answer" | "excerpts" | "naming";
  model?: string;
  cites: string[];
  /** Why no model answered. */
  reason?: string;
  errorKind?: ProviderErrorKind;
  resetsAt?: number;
  excerpts: ExcerptBlock[];
  /** The pack, for "Copy context for my agent". */
  context: string;
  pack: { mode: string; tokens: number };
  state: string;
  cursor: number;
}

export interface AskOptions {
  q: CallQuery;
  question: string;
  now: number;
  provider: Provider;
  by: string;
  write: (draft: EventDraft | ((view: CallView) => EventDraft)) => Promise<LogEvent>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onExcerpts?: (blocks: ExcerptBlock[]) => void;
  onToken?: (t: string) => void;
}

/** The parts of the call that match the question: BM25 hits, else the newest lines of the pack. */
export function excerptsFor(q: CallQuery, question: string, pack: ContextPack): ExcerptBlock[] {
  const hits = q.search(question, EXCERPT_K);
  if (hits.length > 0) return hits.map((h) => ({ citation: h.citation, lines: h.rendered }));
  const recent = pack.lines.slice(-RECENT_LINES);
  const first = recent[0];
  if (!first) return [];
  return [
    {
      citation: formatCitation(first.w0, first.speaker, q.tz),
      lines: recent.map((l) => renderLine(l, { tz: q.tz })),
    },
  ];
}

/**
 * The segment ids an answer cites: `#l000031` written out, and `[15:41 Ben]` matched to the pack's
 * lines of that minute and speaker. Only ids of this call are kept.
 */
export function answerCites(text: string, pack: ContextPack, view: CallView): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/#([lf]\d{6,})\b/g)) {
    const id = m[1] as string;
    if (view.resolve(id)) out.add(id);
  }
  const lines: Line[] = pack.lines;
  for (const m of text.matchAll(/\[(\d{1,2}:\d{2})(?::\d{2})?\s+([^\]]+?)\]/g)) {
    const hhmm = (m[1] as string).padStart(5, "0");
    const who = (m[2] as string).trim().toLowerCase();
    for (const l of lines) {
      if (formatWall(l.w0, pack.tz, { seconds: false }) !== hhmm) continue;
      if (l.speaker.toLowerCase() === who || l.speaker.toLowerCase().startsWith(who)) out.add(l.id);
    }
  }
  return [...out];
}

/** "Claude Code reported its usage limit is reached until 18:00". */
export function reasonText(err: ProviderError, tz: string): string {
  if (err.resetsAt === undefined) return err.message;
  const until = formatWall(err.resetsAt, tz, { seconds: false });
  return err.message.replace(/usage limit is reached/, `usage limit is reached until ${until}`);
}

export async function ask(o: AskOptions): Promise<AskResult> {
  const pack = o.q.context(o.question, { now: o.now, surface: "app" });
  const base = {
    context: pack.text,
    pack: { mode: pack.mode, tokens: pack.tokens },
    state: pack.state,
    cursor: pack.cursor,
  };
  const naming = pack.analysis.naming;
  if (naming) {
    await o.write({ type: "speaker.name", spk: naming.spk, name: naming.name, by: o.by });
    return {
      ...base,
      answered: true,
      kind: "naming",
      text: `${naming.spk} is now named ${naming.name}.`,
      cites: [],
      excerpts: [],
    };
  }
  const excerpts = excerptsFor(o.q, o.question, pack);
  o.onExcerpts?.(excerpts);
  const asked = await o.write((view) => ({
    type: "ask",
    id: `q${String(view.lastSeq + 1).padStart(4, "0")}`,
    q: o.question,
    by: o.by,
  }));
  const askId = (asked as { id: string }).id;
  const fallback = (err: ProviderError): AskResult => {
    const reason = reasonText(err, o.q.tz);
    return {
      ...base,
      ask: askId,
      answered: false,
      kind: "excerpts",
      text: excerptsText(reason, excerpts),
      cites: [],
      reason,
      errorKind: err.kind,
      resetsAt: err.resetsAt,
      excerpts,
    };
  };
  const avail = await o.provider.available();
  if (!avail.ok) return fallback(new ProviderError(avail.kind, avail.reason));
  try {
    const r = await runProvider(
      o.provider,
      {
        system: ASK_SYSTEM,
        prompt: `${pack.text}\n\nQuestion: ${o.question}`,
        maxTokens: ASK_MAX_TOKENS,
      },
      (t) => o.onToken?.(t),
      { signal: o.signal, timeoutMs: o.timeoutMs },
    );
    const cites = answerCites(r.text, pack, o.q.view);
    await o.write({
      type: "answer",
      ask: askId,
      text: r.text,
      cites,
      model: r.model,
      pack: { mode: pack.mode, tokens: pack.tokens },
    });
    return {
      ...base,
      ask: askId,
      answered: true,
      kind: "answer",
      text: r.text,
      model: r.model,
      cites,
      excerpts,
    };
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError("other", String(err));
    if (e.kind === "cancelled") throw e;
    return fallback(e);
  }
}
