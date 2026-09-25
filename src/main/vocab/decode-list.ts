/**
 * The per-call decode list (docs/DESIGN.md section 3, "Custom vocabulary", and 3.1 step 5): the
 * short list of words the recognizer is told to prefer while decoding, through sherpa-onnx
 * hotwords.
 *
 * Every listed word is pushed at every frame, so the list must be short and the boost gentle:
 * - The global boost is a constant, 3. A per-entry boost (up to 5, the entry's `decode` value in
 *   its vocabulary file) exists for a word the engine keeps missing.
 * - The list is capped at 24 entries, filled in priority order, with a warning when it truncates:
 *   1. words added to this call while it runs (`vocab.add`, "Fix this word");
 *   2. the people and title of this call: the words `akou start --vocab` wrote before capture
 *      began (attendees, title terms) and every speaker name given so far;
 *   3. workspace and extra-file entries, the high-miss ones first (a per-entry boost above the
 *      default), then the newest;
 *   4. global entries only when they set `decode` explicitly, because the global list is where
 *      the vocabulary grows large.
 * - Unconfirmed entries and entries with `decode: false` are never in it.
 * - Only transducer models (Parakeet) take hotwords. sherpa-onnx exits the process when Moonshine
 *   or Whisper are given any, so for those the list is empty and the words are read-time only.
 *
 * The list in force is written to the log as `vocab.used`.
 */

import type { EventDraft } from "../../core/log/events.ts";
import type { CallVocabEntry } from "../../core/log/fold.ts";
import { MAX_ENTRY_BOOST, type MergedEntry, termKey } from "./files.ts";

export const DECODE_CAP = 24;
/** The global boost. A constant, never a setting. */
export const DEFAULT_BOOST = 3;

export type ModelKind = "transducer" | "other";

/**
 * Parakeet TDT (and any zipformer or transducer) takes hotwords; Moonshine, Whisper and CTC models
 * (NeMo's parakeet-ctc and the tdt_ctc hybrids exported as CTC) do not. A CTC name wins, because a
 * list given to a model that takes none ends the process.
 */
export function modelKind(model: string): ModelKind {
  if (/(^|[^a-z])ctc([^a-z]|$)/i.test(model)) return "other";
  return /parakeet|zipformer|transducer|\btdt\b/i.test(model) ? "transducer" : "other";
}

export type Tier = 1 | 2 | 3 | 4;

export interface DecodeEntry {
  term: string;
  boost: number;
  tier: Tier;
  /** `call`, `attendee`, `speaker`, or the vocabulary file's path. */
  source: string;
}

export interface DecodeList {
  model: string;
  entries: DecodeEntry[];
  /** Words left out, and why. */
  dropped: { term: string; reason: string }[];
  warnings: string[];
}

export interface DecodeInput {
  model: string;
  /** Call-scoped entries in force (`CallView.callVocabulary()`). */
  callVocab: readonly CallVocabEntry[];
  /**
   * `seq` of the call's first `part.started`: call-scoped words written before it came from
   * `akou start --vocab` (attendees, title terms). Undefined while capture has not started.
   */
  captureStartSeq?: number;
  /** Speaker names given so far. */
  names: readonly string[];
  /** The merged vocabulary files, in priority order (`mergeVocab`). */
  files: readonly MergedEntry[];
  cap?: number;
}

function boostOf(decode: boolean | number | undefined): number {
  if (typeof decode !== "number") return DEFAULT_BOOST;
  return Math.max(1, Math.min(MAX_ENTRY_BOOST, Math.round(decode)));
}

export function buildDecodeList(input: DecodeInput): DecodeList {
  const cap = input.cap ?? DECODE_CAP;
  const candidates: DecodeEntry[] = [];
  const dropped: DecodeList["dropped"] = [];
  const warnings: string[] = [];

  const start = input.captureStartSeq;
  const callAdds = input.callVocab.filter((v) => v.term !== "");
  const mid = callAdds.filter((v) => start !== undefined && v.seq > start);
  const atStart = callAdds.filter((v) => start === undefined || v.seq < start);
  for (const v of mid.sort((a, b) => b.seq - a.seq)) {
    if (!v.decode) dropped.push({ term: v.term, reason: "decode: false" });
    else candidates.push({ term: v.term, boost: DEFAULT_BOOST, tier: 1, source: "call" });
  }
  for (const v of atStart) {
    if (!v.decode) dropped.push({ term: v.term, reason: "decode: false" });
    else candidates.push({ term: v.term, boost: DEFAULT_BOOST, tier: 2, source: "attendee" });
  }
  for (const name of input.names) {
    candidates.push({ term: name, boost: DEFAULT_BOOST, tier: 2, source: "speaker" });
  }

  const fromFiles = input.files.filter((e) => {
    if (!e.confirmed) {
      dropped.push({ term: e.term, reason: "unconfirmed" });
      return false;
    }
    if (e.decode === false) {
      dropped.push({ term: e.term, reason: "decode: false" });
      return false;
    }
    if (e.scope === "global" && e.decode === undefined) {
      dropped.push({ term: e.term, reason: "global entry without decode set" });
      return false;
    }
    return true;
  });
  const local = fromFiles
    .filter((e) => e.scope !== "global")
    .sort((a, b) => boostOf(b.decode) - boostOf(a.decode) || b.added_at.localeCompare(a.added_at));
  const global = fromFiles
    .filter((e) => e.scope === "global")
    .sort((a, b) => boostOf(b.decode) - boostOf(a.decode) || b.added_at.localeCompare(a.added_at));
  for (const e of local)
    candidates.push({ term: e.term, boost: boostOf(e.decode), tier: 3, source: e.file });
  for (const e of global)
    candidates.push({ term: e.term, boost: boostOf(e.decode), tier: 4, source: e.file });

  // One entry per term, the highest tier wins.
  const seen = new Set<string>();
  const unique: DecodeEntry[] = [];
  for (const c of candidates) {
    const key = termKey(c.term);
    if (key === "" || seen.has(key)) continue;
    if (/[/:]/.test(c.term)) {
      // `/` separates hotwords and `:` starts a boost, so such a term cannot be passed safely.
      dropped.push({ term: c.term, reason: "contains / or :, which the hotwords format reserves" });
      continue;
    }
    seen.add(key);
    unique.push(c);
  }

  if (modelKind(input.model) !== "transducer") {
    for (const c of unique)
      dropped.push({ term: c.term, reason: `${input.model} takes no hotwords` });
    if (unique.length > 0) {
      warnings.push(`${input.model} takes no hotwords; the vocabulary applies at read time only`);
    }
    return { model: input.model, entries: [], dropped, warnings };
  }

  const entries = unique.slice(0, cap);
  if (unique.length > cap) {
    for (const c of unique.slice(cap))
      dropped.push({ term: c.term, reason: `over the cap of ${cap}` });
    warnings.push(`decode list has ${unique.length} words; kept the first ${cap} by priority`);
  }
  return { model: input.model, entries, dropped, warnings };
}

/**
 * The per-stream hotwords argument (`createStream(list)`): one word per `/`, a boost other than the
 * default written after it as ` :N`. Empty for a model that takes no hotwords, so the Worker never
 * passes a list to Moonshine or Whisper.
 */
export function hotwordsArg(list: DecodeList): string {
  if (modelKind(list.model) !== "transducer") return "";
  return list.entries
    .map((e) => (e.boost === DEFAULT_BOOST ? e.term : `${e.term} :${e.boost}`))
    .join("/");
}

/** The `vocab.used` event that records the list and the files in force. */
export function vocabUsedDraft(
  list: DecodeList,
  files: readonly { path: string; sha256: string }[],
): EventDraft {
  return {
    type: "vocab.used",
    entries: list.entries.map((e) =>
      e.boost === DEFAULT_BOOST ? e.term : `${e.term} :${e.boost}`,
    ),
    files: files.map((f) => f.path),
    sha256: files.map((f) => f.sha256),
    model: list.model,
  };
}
