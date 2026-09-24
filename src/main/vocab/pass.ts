/**
 * Vocabulary layer 3, the post-call pass (docs/DESIGN.md sections 3 and 5.4, REQUIREMENTS V6): the
 * configured provider reads the finished transcript with the vocabulary in force, corrects the
 * mishearings of known terms it finds, and proposes new entries. It runs only when asked (`akou
 * vocab pass`, `POST /calls/{id}/vocab/pass`), the same policy as Enhance: never on its own.
 *
 * What the model returns is never trusted as is. A deterministic check, the pass's citation check,
 * runs over every item before anything is written:
 *
 * - A correction names a line id and the span it replaces. The line must be one the model was
 *   shown, and the span must be in that line's raw text as whole words. Otherwise it is dropped.
 * - A correction to a term that is not in the vocabulary is a guess: it becomes a proposal, never a
 *   correction, so only the user's yes makes it one.
 * - A proposal cites lines; each heard form must be in one of them, and the term itself must be
 *   heard there or spelled there. A term the user rejected, one proposed before in this call, or
 *   one already known with nothing new to add is dropped.
 *
 * What passes is written through the call's one writer: a correction is a call-scoped `vocab.add`
 * restricted to the lines it names (the raw text stays as it was; the fold corrects when it
 * reads), and a proposal is a `vocab.propose` that does nothing until the user approves it.
 * Approving writes the entry into the workspace file with `source: call:<id>`.
 */

import type { EventDraft } from "../../core/log/events.ts";
import type { CallView, Line } from "../../core/log/fold.ts";
import { tokenize } from "../../core/vocab/correct.ts";
import { type CompleteResult, type Provider, runProvider } from "../llm/provider.ts";
import { estimateTokens, renderLine } from "../query/render.ts";
import { termKey, validateTerm } from "./files.ts";

/** One provider call reads at most this much transcript; a longer call is read in batches. */
export const PASS_BATCH_TOKENS = 12_000;
export const PASS_MAX_TOKENS = 2048;

export const PASS_SYSTEM = [
  "You check a call transcript for misheard names and terms.",
  "You are given the vocabulary in force (each term with the ways it has been misheard) and the transcript lines, each with its id like #f000031.",
  "Return one JSON object and nothing else:",
  '{"corrections": [{"line": "#f000031", "heard": "versal", "term": "Vercel"}],',
  ' "proposals": [{"term": "Anika", "heard": ["annika"], "lines": ["#f000012"], "why": "a name said three times"}]}',
  "Rules:",
  "- A correction replaces words that are in that line exactly as written (`heard`) with a term from the vocabulary.",
  "- A proposal is a new term the transcript shows is a name, product or project that the recognizer gets wrong, or a new way a known term was misheard. Cite the lines it rests on. `heard` lists the words exactly as they appear in those lines.",
  "- Use only line ids you were given. Never propose a term listed as rejected.",
  "- When unsure, leave it out. Empty lists are a fine answer.",
].join("\n");

export interface KnownTerm {
  term: string;
  heard: readonly string[];
}

export interface PassInput {
  /** The known terms: confirmed file entries, the call's own words, accepted proposals, names. */
  known: readonly KnownTerm[];
  /** Terms the user rejected: never proposed again. */
  rejected: readonly string[];
}

export interface PassCorrection {
  line: string;
  heard: string;
  term: string;
}

export interface PassProposal {
  term: string;
  heard: string[];
  lines: string[];
  why?: string;
}

export interface PassDropped {
  kind: "correction" | "proposal";
  item: unknown;
  reason: string;
}

export interface CheckedPass {
  /** Grouped by term and heard form: one call-scoped `vocab.add` each. */
  corrections: { term: string; heard: string; lines: string[] }[];
  proposals: PassProposal[];
  dropped: PassDropped[];
}

export interface PassResult extends CheckedPass {
  model: string;
  /** Provider calls made (one per batch). */
  calls: number;
  lines: number;
  /** The drafts to append, in order; the caller writes them. */
  drafts: EventDraft[];
}

/** The lines the pass reads: the `best` layer, echo left out. */
export function passLines(view: CallView): Line[] {
  return view.lines("best");
}

/** The lines split into batches that each fit `PASS_BATCH_TOKENS` once rendered. */
export function passBatches(lines: readonly Line[], tz: string, max = PASS_BATCH_TOKENS): Line[][] {
  const out: Line[][] = [];
  let cur: Line[] = [];
  let used = 0;
  for (const l of lines) {
    const t = estimateTokens(rawLine(l, tz)) + 1;
    if (cur.length > 0 && used + t > max) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(l);
    used += t;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** A line as the pass shows it: the raw text, so spans are what the recognizer wrote. */
export function rawLine(l: Line, tz: string): string {
  const raw = l.raw ?? l.text;
  return renderLine({ ...l, annotated: raw }, { tz });
}

export function passPrompt(input: PassInput, lines: readonly Line[], tz: string): string {
  const out: string[] = ["Vocabulary in force:"];
  if (input.known.length === 0) out.push("(none yet)");
  for (const k of input.known) {
    out.push(
      k.heard.length > 0 ? `- ${k.term} (misheard as: ${k.heard.join(", ")})` : `- ${k.term}`,
    );
  }
  if (input.rejected.length > 0)
    out.push("", `Rejected, never propose: ${input.rejected.join(", ")}`);
  out.push("", "Transcript:", ...lines.map((l) => rawLine(l, tz)));
  return out.join("\n");
}

/** The first JSON object in a model's answer, fenced or not. */
export function parsePassAnswer(text: string): { corrections: unknown[]; proposals: unknown[] } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? (fenced[1] as string) : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { corrections: [], proposals: [] };
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    return {
      corrections: Array.isArray(o.corrections) ? o.corrections : [],
      proposals: Array.isArray(o.proposals) ? o.proposals : [],
    };
  } catch {
    return { corrections: [], proposals: [] };
  }
}

/** Whether `span` occurs in `text` as whole words, compared folded (case and accents). */
export function spanIn(text: string, span: string): boolean {
  const want = tokenize(span).map((t) => t.folded);
  if (want.length === 0) return false;
  const have = tokenize(text).map((t) => t.folded);
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, j) => have[i + j] === w)) return true;
  }
  return false;
}

const lineId = (v: unknown): string | null =>
  typeof v === "string" ? (/^#?([lf]\d{6,})$/.exec(v.trim())?.[1] ?? null) : null;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/**
 * The pass's citation check: every item the model returned, kept or dropped with a reason. Pure:
 * `shown` is the lines the model was given, `existing` the call's proposals so far.
 */
export function checkPass(
  answer: { corrections: unknown[]; proposals: unknown[] },
  o: {
    shown: ReadonlyMap<string, Line>;
    input: PassInput;
    existing: readonly { term: string }[];
  },
): CheckedPass {
  const dropped: PassDropped[] = [];
  const known = new Map(o.input.known.map((k) => [termKey(k.term), k]));
  const rejected = new Set(o.input.rejected.map(termKey));
  const raw = (id: string) => {
    const l = o.shown.get(id);
    return l ? (l.raw ?? l.text) : null;
  };
  const groups = new Map<string, { term: string; heard: string; lines: string[] }>();
  const guesses: PassProposal[] = [];

  for (const item of answer.corrections) {
    const c = (item ?? {}) as Record<string, unknown>;
    const id = lineId(c.line);
    const heard = str(c.heard);
    const term = str(c.term);
    const drop = (reason: string) => dropped.push({ kind: "correction", item, reason });
    if (!id || !heard || !term) {
      drop("needs line, heard and term");
      continue;
    }
    const text = raw(id);
    if (text === null) {
      drop(`#${id} is not a line the pass was shown`);
      continue;
    }
    if (!spanIn(text, heard)) {
      drop(`"${heard}" is not in #${id}`);
      continue;
    }
    if (validateTerm(term) || validateTerm(heard)) {
      drop(validateTerm(term) ?? (validateTerm(heard) as string));
      continue;
    }
    if (termKey(term) === termKey(heard)) {
      drop("the span already reads as the term");
      continue;
    }
    const k = known.get(termKey(term));
    if (!k) {
      // An unknown term is a guess: the user decides.
      guesses.push({
        term,
        heard: [heard],
        lines: [id],
        why: "a correction to a term not in the vocabulary",
      });
      continue;
    }
    const key = `${termKey(k.term)}\u0000${termKey(heard)}`;
    const g = groups.get(key) ?? { term: k.term, heard, lines: [] };
    if (!g.lines.includes(id)) g.lines.push(id);
    groups.set(key, g);
  }

  // A correction whose heard form is new to a known term also proposes that heard form, so the
  // next call gets it right without a pass.
  for (const g of groups.values()) {
    const k = known.get(termKey(g.term)) as KnownTerm;
    if (!k.heard.some((h) => termKey(h) === termKey(g.heard))) {
      guesses.push({
        term: k.term,
        heard: [g.heard],
        lines: [...g.lines],
        why: "heard this way in this call",
      });
    }
  }

  const proposals = new Map<string, PassProposal>();
  const seen = new Set(o.existing.map((p) => termKey(p.term)));
  for (const item of [...answer.proposals, ...guesses]) {
    const p = (item ?? {}) as Record<string, unknown>;
    const drop = (reason: string) => dropped.push({ kind: "proposal", item, reason });
    const term = str(p.term);
    if (!term || validateTerm(term)) {
      drop(term ? (validateTerm(term) as string) : "needs a term");
      continue;
    }
    const key = termKey(term);
    if (rejected.has(key)) {
      drop(`"${term}" was rejected before`);
      continue;
    }
    if (seen.has(key)) {
      drop(`"${term}" is already proposed in this call`);
      continue;
    }
    const ids = (Array.isArray(p.lines) ? p.lines : []).map(lineId);
    const cited = ids.filter((id): id is string => id !== null && raw(id) !== null);
    if (cited.length === 0 || cited.length !== ids.length) {
      drop("cites no line the pass was shown");
      continue;
    }
    const texts = cited.map((id) => raw(id) as string);
    const heardIn = (h: string) => texts.some((t) => spanIn(t, h));
    const heardAll = (Array.isArray(p.heard) ? p.heard : [])
      .map(str)
      .filter((h): h is string => h !== null && validateTerm(h) === null && termKey(h) !== key);
    const heard = [...new Map(heardAll.filter(heardIn).map((h) => [termKey(h), h])).values()];
    if (heardAll.length > 0 && heard.length === 0) {
      drop("no heard form is in the lines it cites");
      continue;
    }
    if (heard.length === 0 && !heardIn(term)) {
      drop(`"${term}" is not in the lines it cites`);
      continue;
    }
    const k = known.get(key);
    const fresh = k ? heard.filter((h) => !k.heard.some((x) => termKey(x) === termKey(h))) : heard;
    if (k && fresh.length === 0) {
      drop(`"${term}" is already in the vocabulary`);
      continue;
    }
    const cur = proposals.get(key);
    if (cur) {
      for (const h of fresh)
        if (!cur.heard.some((x) => termKey(x) === termKey(h))) cur.heard.push(h);
      for (const id of cited) if (!cur.lines.includes(id)) cur.lines.push(id);
      continue;
    }
    proposals.set(key, {
      term: k ? k.term : term,
      heard: fresh,
      lines: cited,
      ...(str(p.why) ? { why: str(p.why) as string } : {}),
    });
  }
  return { corrections: [...groups.values()], proposals: [...proposals.values()], dropped };
}

/** The events a checked pass writes: call-scoped corrections, then proposals. */
export function passDrafts(
  checked: CheckedPass,
  o: {
    lastSeq: number;
    model: string;
    existingAdds: readonly { term: string; heard: readonly string[]; segs?: readonly string[] }[];
  },
): EventDraft[] {
  const out: EventDraft[] = [];
  let seq = o.lastSeq;
  const id = (prefix: string) => `${prefix}${String(++seq).padStart(4, "0")}`;
  for (const c of checked.corrections) {
    // A re-run that finds the same correction writes nothing new.
    const same = o.existingAdds.some(
      (a) =>
        termKey(a.term) === termKey(c.term) &&
        a.heard.some((h) => termKey(h) === termKey(c.heard)) &&
        c.lines.every((l) => a.segs?.includes(l)),
    );
    if (same) continue;
    out.push({
      type: "vocab.add",
      id: id("v"),
      rev: 1,
      term: c.term,
      heard: [c.heard],
      by: "app",
      segs: c.lines,
      decode: false,
    });
  }
  for (const p of checked.proposals) {
    out.push({
      type: "vocab.propose",
      id: id("p"),
      rev: 1,
      term: p.term,
      heard: p.heard,
      by: "app",
      evidence: { pass: true, model: o.model, lines: p.lines, ...(p.why ? { why: p.why } : {}) },
      status: "proposed",
    });
  }
  return out;
}

/**
 * Runs the pass over a call: one provider call per batch, every answer checked. Writes nothing;
 * the caller appends `drafts` (each id is the seq it will get, when appended in order right after
 * `view.lastSeq`). Provider failures are thrown as `ProviderError`s.
 */
export async function runPass(o: {
  view: CallView;
  tz: string;
  input: PassInput;
  provider: Provider;
  signal?: AbortSignal;
  timeoutMs?: number;
  batchTokens?: number;
}): Promise<PassResult> {
  const lines = passLines(o.view);
  const batches = passBatches(lines, o.tz, o.batchTokens);
  const corrections: unknown[] = [];
  const proposals: unknown[] = [];
  const models = new Set<string>();
  for (const batch of batches) {
    const r: CompleteResult = await runProvider(
      o.provider,
      { system: PASS_SYSTEM, prompt: passPrompt(o.input, batch, o.tz), maxTokens: PASS_MAX_TOKENS },
      () => {},
      { signal: o.signal, timeoutMs: o.timeoutMs },
    );
    models.add(r.model);
    const a = parsePassAnswer(r.text);
    corrections.push(...a.corrections);
    proposals.push(...a.proposals);
  }
  const shown = new Map(lines.map((l) => [l.id, l]));
  const checked = checkPass(
    { corrections, proposals },
    { shown, input: o.input, existing: o.view.proposals() },
  );
  const model = [...models].join(", ") || "none";
  const drafts = passDrafts(checked, {
    lastSeq: o.view.lastSeq,
    model,
    existingAdds: o.view.callVocabulary(),
  });
  return { ...checked, model, calls: batches.length, lines: lines.length, drafts };
}
