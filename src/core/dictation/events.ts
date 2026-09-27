/**
 * The dictation log's events (docs/ux/DICTATION.md section 10): `dictation/events.jsonl` under the
 * config folder, append-only, one JSON object per line with the `v: 1` envelope. Dictations are
 * not calls and never enter a call's log; this is their own log, with its own event types.
 *
 * Never the field's full text, never anything of a password field: an event carries only what akou
 * decoded and inserted, and later the hunks of an edit (DC-L2).
 */

/** What the helper found about the field that had the keyboard when the session began. */
export type FieldKind = "editable" | "not-editable" | "unknown" | "secure";

/** The app and field a dictation goes to, captured at key-down (DC-N9). */
export interface Target {
  /** Bundle id (macOS), executable name (Windows) or window class (Linux). */
  app: string;
  pid: number;
  /** An opaque window id, compared at insert time. */
  window: string;
  field: FieldKind;
}

/** One decoded word: seconds into the dictation's audio, and a confidence from 0 to 1. */
export interface DictationWord {
  w: string;
  s: number;
  e: number;
  c: number;
}

export type DictationDraft =
  | {
      type: "dictation.started";
      id: string;
      /** Null for a clip sent to `POST /v1/dictations`, which goes to no app. */
      target: Target | null;
      /** The engine asked for: `fast`, `best`, `remote` or `auto`. */
      engine: string;
      /** `user` for the key, `agent:<client>` for a door. */
      by: string;
    }
  | { type: "dictation.ended"; id: string; reason: string; seconds: number }
  | {
      type: "dictation.text";
      id: string;
      /** What the engine returned. */
      raw: string;
      /** What akou inserts: `raw` after the dictation vocabulary and the text rules. */
      text: string;
      language: string | null;
      words: DictationWord[];
      /** The engine that decoded it (`fast`, `best`, `remote`) and its model. */
      engine: string;
      model: string;
      /** Decode time, milliseconds. */
      ms: number;
      fallback_from?: string;
    }
  | { type: "dictation.empty"; id: string }
  | { type: "dictation.inserted"; id: string; method: string; receipt_ms: number }
  | { type: "dictation.cancelled"; id: string }
  | { type: "dictation.failed"; id: string; error: string };

export type DictationEvent = DictationDraft & { v: 1; seq: number; t: number };

export const DICTATION_TYPES: readonly DictationDraft["type"][] = [
  "dictation.started",
  "dictation.ended",
  "dictation.text",
  "dictation.empty",
  "dictation.inserted",
  "dictation.cancelled",
  "dictation.failed",
];

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isId = (v: unknown): v is string => isStr(v) && /^[A-Za-z0-9_-]{1,64}$/.test(v);

function isTarget(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    isStr(t.app) &&
    isNum(t.pid) &&
    isStr(t.window) &&
    ["editable", "not-editable", "unknown", "secure"].includes(t.field as string)
  );
}

function isWord(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const w = v as Record<string, unknown>;
  return isStr(w.w) && isNum(w.s) && isNum(w.e) && isNum(w.c);
}

/** Null when a draft is well formed, else what is wrong with it. */
export function checkDictationDraft(o: Record<string, unknown>): string | null {
  if (!isId(o.id)) return "id";
  switch (o.type) {
    case "dictation.started":
      return isTarget(o.target) && isStr(o.engine) && isStr(o.by) ? null : "dictation.started";
    case "dictation.ended":
      return isStr(o.reason) && isNum(o.seconds) ? null : "dictation.ended";
    case "dictation.text":
      return isStr(o.raw) &&
        isStr(o.text) &&
        (o.language === null || isStr(o.language)) &&
        Array.isArray(o.words) &&
        o.words.every(isWord) &&
        isStr(o.engine) &&
        isStr(o.model) &&
        isNum(o.ms) &&
        (o.fallback_from === undefined || isStr(o.fallback_from))
        ? null
        : "dictation.text";
    case "dictation.inserted":
      return isStr(o.method) && isNum(o.receipt_ms) ? null : "dictation.inserted";
    case "dictation.failed":
      return isStr(o.error) ? null : "dictation.failed";
    case "dictation.empty":
    case "dictation.cancelled":
      return null;
    default:
      return `unknown type ${String(o.type)}`;
  }
}

/** Null when a line of the log is a well-formed event, else what is wrong with it. */
export function checkDictationEvent(o: unknown): string | null {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return "not an object";
  const e = o as Record<string, unknown>;
  if (e.v !== 1) return "v";
  if (!isNum(e.seq) || !Number.isInteger(e.seq) || e.seq < 1) return "seq";
  if (!isNum(e.t)) return "t";
  return checkDictationDraft(e);
}

/** What the log says about one dictation, folded from its events in order. */
export interface DictationItem {
  id: string;
  /** Epoch ms of `dictation.started`. */
  at: number;
  by: string;
  target: Target | null;
  state:
    | "listening"
    | "transcribing"
    | "inserting"
    | "done"
    | "inserted"
    | "cancelled"
    | "empty"
    | "failed";
  seconds: number | null;
  raw: string | null;
  text: string | null;
  language: string | null;
  words: DictationWord[];
  engine: string;
  model: string | null;
  ms: number | null;
  fallback_from: string | null;
  error: string | null;
}

/** Every dictation in the log, oldest first. Events of an unknown dictation are skipped. */
export function foldDictations(events: readonly DictationEvent[]): DictationItem[] {
  const items = new Map<string, DictationItem>();
  for (const e of events) {
    if (e.type === "dictation.started") {
      items.set(e.id, {
        id: e.id,
        at: e.t,
        by: e.by,
        target: e.target,
        state: "listening",
        seconds: null,
        raw: null,
        text: null,
        language: null,
        words: [],
        engine: e.engine,
        model: null,
        ms: null,
        fallback_from: null,
        error: null,
      });
      continue;
    }
    const it = items.get(e.id);
    if (!it) continue;
    switch (e.type) {
      case "dictation.ended":
        it.state = "transcribing";
        it.seconds = e.seconds;
        break;
      case "dictation.text":
        Object.assign(it, {
          state: it.target ? "inserting" : "done",
          raw: e.raw,
          text: e.text,
          language: e.language,
          words: e.words,
          engine: e.engine,
          model: e.model,
          ms: e.ms,
          fallback_from: e.fallback_from ?? null,
        });
        break;
      case "dictation.empty":
        it.state = "empty";
        break;
      case "dictation.inserted":
        it.state = "inserted";
        break;
      case "dictation.cancelled":
        it.state = "cancelled";
        break;
      case "dictation.failed":
        it.state = "failed";
        it.error = e.error;
        break;
    }
  }
  return [...items.values()];
}
