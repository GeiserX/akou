/**
 * Event log schema, version 1 (docs/DESIGN.md section 4.3).
 *
 * Every event has the envelope `seq` (gap-free integer per call, starting at 1), `t` (epoch ms at
 * write) and `type`. The types below are the whole vocabulary of the log; anything else is refused
 * by `validateEvent`. Provisional lines are never events.
 */

export const SCHEMA_VERSION = 1;

export interface Envelope {
  seq: number;
  t: number;
}

/** What a writer is given: the envelope is assigned by the writer. */
export type Draft<E extends { seq: number; t: number }> = E extends unknown
  ? Omit<E, "seq" | "t">
  : never;

export type Channel = "mic" | "call";
export type Layer = "live" | "final";
/** `user`, `agent:<client>` for anything an agent wrote, or `app` for akou's own passes. */
export type Author = string;

export interface CallCreated extends Envelope {
  type: "call.created";
  id: string;
  schema: number;
  workspace: string;
  title: string;
  tz: string;
  user: string;
  akou: string;
  template?: string;
}

export interface CallEnded extends Envelope {
  type: "call.ended";
  reason: "stop" | "interrupted" | "abandoned";
}

export interface CallFailed extends Envelope {
  type: "call.failed";
  stage: string;
  error: string;
}

export interface PartStarted extends Envelope {
  type: "part.started";
  part: number;
  file: string;
  /** Epoch ms paired with `monoStart`: the anchor for every wall time in this part. */
  wallStart: number;
  /** Host monotonic clock in milliseconds (the helper's `capture_ns` / 1e6). */
  monoStart: number;
  /** Mic device name, or null when the part records no mic. */
  mic: string | null;
  call: { mode: string; exclude?: string[] };
  capture: string;
}

export type PartEndReason = "stop" | "restart" | "helper-exit" | "killed" | "crashed" | "cancelled";

export interface PartEnded extends Envelope {
  type: "part.ended";
  part: number;
  reason: PartEndReason;
  fileSeconds: number;
}

export interface Pause extends Envelope {
  type: "pause";
  part: number;
  /** Seconds into the part's audio file. */
  a: number;
  wall: number;
  mono: number;
}

export interface Resume extends Envelope {
  type: "resume";
  part: number;
  a: number;
  wall: number;
  mono: number;
}

export interface Mute extends Envelope {
  type: "mute";
  part: number;
  a: number;
}

export interface Unmute extends Envelope {
  type: "unmute";
  part: number;
  a: number;
}

export interface Gap extends Envelope {
  type: "gap";
  part: number;
  a: number;
  wallFrom: number;
  wallTo: number;
  reason: "sleep";
}

/**
 * A transcript segment. Revision 1 carries every field; a later revision (same `id`, higher
 * `rev`) may carry only the fields that changed. `text: null` retracts the segment.
 */
export interface Seg extends Envelope {
  type: "seg";
  id: string;
  rev: number;
  layer?: Layer;
  part?: number;
  ch?: Channel;
  spk?: string;
  a0?: number;
  a1?: number;
  w0?: number;
  w1?: number;
  text?: string | null;
  lang?: string;
  model?: string;
  echo?: boolean;
  by?: Author;
}

export interface SpeakerCentroid extends Envelope {
  type: "speaker.centroid";
  spk: string;
  /** base64 float32 */
  vec: string;
}

export interface SpeakerMerge extends Envelope {
  type: "speaker.merge";
  from: string;
  into: string;
}

export interface SpeakerUnmerge extends Envelope {
  type: "speaker.unmerge";
  from: string;
  into: string;
}

export interface SpeakerName extends Envelope {
  type: "speaker.name";
  spk: string;
  name: string;
  by: Author;
}

export interface SpeakerMap extends Envelope {
  type: "speaker.map";
  final: string;
  live: string;
  overlap: number;
}

export interface SpeakerSuggest extends Envelope {
  type: "speaker.suggest";
  final: string;
  live: string;
  overlap: number;
}

export interface Note extends Envelope {
  type: "note";
  id: string;
  rev: number;
  text: string;
  /** Wall time (epoch ms) of the first keystroke. */
  w: number;
  /** Last segment `seq` visible when the note was started. */
  afterSeq: number;
  by: Author;
}

export interface NoteDel extends Envelope {
  type: "note.del";
  id: string;
  by: Author;
}

export interface Remember extends Envelope {
  type: "remember";
  id: string;
  rev: number;
  /** `null` retracts the item. */
  text: string | null;
  by: Author;
}

export interface Memo extends Envelope {
  type: "memo";
  rev: number;
  body: string;
  coversSeq: number;
  by: Author;
  model: string;
}

export interface ChunkSummary extends Envelope {
  type: "chunk.summary";
  from: number;
  to: number;
  body: string;
  model: string;
}

export interface Ask extends Envelope {
  type: "ask";
  id: string;
  q: string;
  by: Author;
}

export interface Answer extends Envelope {
  type: "answer";
  ask: string;
  text: string;
  cites: string[];
  model: string;
  pack: { mode: string; tokens: number };
}

export interface Enhanced extends Envelope {
  type: "enhanced";
  rev: number;
  template: string;
  file: string;
  coversSeq: number;
  by: Author;
  model: string;
  cites: string[];
}

export interface VocabUsed extends Envelope {
  type: "vocab.used";
  entries: string[];
  files: string[];
  sha256: string[];
  model: string;
}

export interface VocabAdd extends Envelope {
  type: "vocab.add";
  id: string;
  rev: number;
  /** `null` on a revision retracts the entry. */
  term: string | null;
  heard?: string[];
  by: Author;
  /** Restrict the read-time pair to these segment ids. */
  segs?: string[];
  /** Also a decode entry unless false. */
  decode?: boolean;
}

export type ProposalStatus = "proposed" | "accepted" | "rejected";

export interface VocabPropose extends Envelope {
  type: "vocab.propose";
  id: string;
  rev: number;
  term: string;
  heard: string[];
  by: Author;
  evidence: unknown;
  status: ProposalStatus;
}

export interface Health extends Envelope {
  type: "health";
  part: number;
  ch: Channel;
  state: string;
  silentFor: number;
  rebuilds: number;
  detail: string;
}

export interface AsrLag extends Envelope {
  type: "asr.lag";
  part: number;
  seconds: number;
}

export interface FinalStarted extends Envelope {
  type: "final.started";
  pid: number;
}

export interface FinalPartDone extends Envelope {
  type: "final.part.done";
  part: number;
}

export interface FinalDone extends Envelope {
  type: "final.done";
  parts: number[];
  languages?: string[];
  skipped: unknown[];
  warning?: string;
}

export interface FinalFailed extends Envelope {
  type: "final.failed";
  step: string;
  error: string;
}

export interface ShareStarted extends Envelope {
  type: "share.started";
  bind: string;
  expires: unknown;
  include: Record<string, unknown>;
}

export interface ShareStopped extends Envelope {
  type: "share.stopped";
  bind?: string;
  expires?: unknown;
  include?: Record<string, unknown>;
}

export interface ExportDone extends Envelope {
  type: "export.done";
  path: string;
  sha256: string;
}

export interface HookDone extends Envelope {
  type: "hook.done";
  name: string;
  exit: number;
  ms: number;
}

export interface WebhookDone extends Envelope {
  type: "webhook.done";
  url: string;
  status: number;
  attempts: number;
}

export type LogEvent =
  | CallCreated
  | CallEnded
  | CallFailed
  | PartStarted
  | PartEnded
  | Pause
  | Resume
  | Mute
  | Unmute
  | Gap
  | Seg
  | SpeakerCentroid
  | SpeakerMerge
  | SpeakerUnmerge
  | SpeakerName
  | SpeakerMap
  | SpeakerSuggest
  | Note
  | NoteDel
  | Remember
  | Memo
  | ChunkSummary
  | Ask
  | Answer
  | Enhanced
  | VocabUsed
  | VocabAdd
  | VocabPropose
  | Health
  | AsrLag
  | FinalStarted
  | FinalPartDone
  | FinalDone
  | FinalFailed
  | ShareStarted
  | ShareStopped
  | ExportDone
  | HookDone
  | WebhookDone;

export type EventType = LogEvent["type"];
export type EventOf<T extends EventType> = Extract<LogEvent, { type: T }>;
export type EventDraft = Draft<LogEvent>;

/** Lifecycle events are fsynced as soon as they are written (DESIGN 4.2). */
export const LIFECYCLE_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "call.created",
  "call.ended",
  "call.failed",
  "part.started",
  "part.ended",
  "pause",
  "resume",
  "mute",
  "unmute",
  "gap",
  "final.started",
  "final.part.done",
  "final.done",
  "final.failed",
]);

// ---------------------------------------------------------------------------
// Runtime validation

export type Kind =
  | "string"
  | "number"
  | "int"
  | "boolean"
  | "string|null"
  | "string[]"
  | "number[]"
  | "array"
  | "object"
  | "any"
  | "author"
  | "noteAuthor"
  | "channel"
  | "layer"
  | readonly string[];

export interface FieldSpec {
  kind: Kind;
  optional?: boolean;
}

const req = (kind: Kind): FieldSpec => ({ kind });
const opt = (kind: Kind): FieldSpec => ({ kind, optional: true });

type Spec = Record<string, FieldSpec>;

const SPECS: { [T in EventType]: Spec } = {
  "call.created": {
    id: req("string"),
    schema: req("int"),
    workspace: req("string"),
    title: req("string"),
    tz: req("string"),
    user: req("string"),
    akou: req("string"),
    template: opt("string"),
  },
  "call.ended": { reason: req(["stop", "interrupted", "abandoned"]) },
  "call.failed": { stage: req("string"), error: req("string") },
  "part.started": {
    part: req("int"),
    file: req("string"),
    wallStart: req("number"),
    monoStart: req("number"),
    mic: req("string|null"),
    call: req("object"),
    capture: req("string"),
  },
  "part.ended": {
    part: req("int"),
    reason: req(["stop", "restart", "helper-exit", "killed", "crashed", "cancelled"]),
    fileSeconds: req("number"),
  },
  pause: { part: req("int"), a: req("number"), wall: req("number"), mono: req("number") },
  resume: { part: req("int"), a: req("number"), wall: req("number"), mono: req("number") },
  mute: { part: req("int"), a: req("number") },
  unmute: { part: req("int"), a: req("number") },
  gap: {
    part: req("int"),
    a: req("number"),
    wallFrom: req("number"),
    wallTo: req("number"),
    reason: req(["sleep"]),
  },
  // Revision 1 requirements for `seg` are enforced separately in validateSeg.
  seg: {
    id: req("string"),
    rev: req("int"),
    layer: opt("layer"),
    part: opt("int"),
    ch: opt("channel"),
    spk: opt("string"),
    a0: opt("number"),
    a1: opt("number"),
    w0: opt("number"),
    w1: opt("number"),
    text: opt("string|null"),
    lang: opt("string"),
    model: opt("string"),
    echo: opt("boolean"),
    by: opt("author"),
  },
  "speaker.centroid": { spk: req("string"), vec: req("string") },
  "speaker.merge": { from: req("string"), into: req("string") },
  "speaker.unmerge": { from: req("string"), into: req("string") },
  "speaker.name": { spk: req("string"), name: req("string"), by: req("author") },
  "speaker.map": { final: req("string"), live: req("string"), overlap: req("number") },
  "speaker.suggest": { final: req("string"), live: req("string"), overlap: req("number") },
  note: {
    id: req("string"),
    rev: req("int"),
    text: req("string"),
    w: req("number"),
    afterSeq: req("int"),
    by: req("noteAuthor"),
  },
  "note.del": { id: req("string"), by: req("noteAuthor") },
  remember: { id: req("string"), rev: req("int"), text: req("string|null"), by: req("author") },
  memo: {
    rev: req("int"),
    body: req("string"),
    coversSeq: req("int"),
    by: req("author"),
    model: req("string"),
  },
  "chunk.summary": { from: req("int"), to: req("int"), body: req("string"), model: req("string") },
  ask: { id: req("string"), q: req("string"), by: req("author") },
  answer: {
    ask: req("string"),
    text: req("string"),
    cites: req("string[]"),
    model: req("string"),
    pack: req("object"),
  },
  enhanced: {
    rev: req("int"),
    template: req("string"),
    file: req("string"),
    coversSeq: req("int"),
    by: req("author"),
    model: req("string"),
    cites: req("string[]"),
  },
  "vocab.used": {
    entries: req("string[]"),
    files: req("string[]"),
    sha256: req("string[]"),
    model: req("string"),
  },
  "vocab.add": {
    id: req("string"),
    rev: req("int"),
    term: req("string|null"),
    heard: opt("string[]"),
    by: req("author"),
    segs: opt("string[]"),
    decode: opt("boolean"),
  },
  "vocab.propose": {
    id: req("string"),
    rev: req("int"),
    term: req("string"),
    heard: req("string[]"),
    by: req("author"),
    evidence: req("any"),
    status: req(["proposed", "accepted", "rejected"]),
  },
  health: {
    part: req("int"),
    ch: req("channel"),
    state: req("string"),
    silentFor: req("number"),
    rebuilds: req("int"),
    detail: req("string"),
  },
  "asr.lag": { part: req("int"), seconds: req("number") },
  "final.started": { pid: req("int") },
  "final.part.done": { part: req("int") },
  "final.done": {
    parts: req("number[]"),
    languages: opt("string[]"),
    skipped: req("array"),
    warning: opt("string"),
  },
  "final.failed": { step: req("string"), error: req("string") },
  "share.started": { bind: req("string"), expires: req("any"), include: req("object") },
  "share.stopped": { bind: opt("string"), expires: opt("any"), include: opt("object") },
  "export.done": { path: req("string"), sha256: req("string") },
  "hook.done": { name: req("string"), exit: req("int"), ms: req("number") },
  "webhook.done": { url: req("string"), status: req("int"), attempts: req("int") },
};

export const EVENT_TYPES: readonly EventType[] = Object.keys(SPECS) as EventType[];

/** The field table of schema v1: every field of every event type, with its kind. */
export const EVENT_FIELDS: { readonly [T in EventType]: Readonly<Record<string, FieldSpec>> } =
  SPECS;

/** `user`, `agent:<client>`, or `app` for what akou itself decided (the post-call pass). */
const AUTHOR = /^(user|app|agent:\S+)$/;
/** Notes have exactly two kinds of author, so the window can tell them apart. */
const NOTE_AUTHOR = /^(user|agent:\S+)$/;

export function isAgentAuthor(by: string): boolean {
  return by.startsWith("agent:");
}

function checkKind(value: unknown, kind: Kind): boolean {
  if (Array.isArray(kind)) return typeof value === "string" && kind.includes(value);
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string|null":
      return value === null || typeof value === "string";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "number[]":
      return Array.isArray(value) && value.every((v) => checkKind(v, "number"));
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "any":
      return value !== undefined;
    case "author":
      return typeof value === "string" && AUTHOR.test(value);
    case "noteAuthor":
      return typeof value === "string" && NOTE_AUTHOR.test(value);
    case "channel":
      return value === "mic" || value === "call";
    case "layer":
      return value === "live" || value === "final";
  }
  return false;
}

function kindName(kind: Kind): string {
  return Array.isArray(kind) ? kind.join(" | ") : (kind as string);
}

const SEG_REV1_REQUIRED = [
  "layer",
  "part",
  "ch",
  "spk",
  "a0",
  "a1",
  "w0",
  "w1",
  "text",
  "model",
] as const;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates the fields of one event body (no envelope). */
function validateBody(o: Record<string, unknown>, type: EventType): string | null {
  const spec = SPECS[type];
  for (const [name, field] of Object.entries(spec)) {
    const v = o[name];
    if (v === undefined) {
      if (field.optional) continue;
      return `${type}: missing field "${name}"`;
    }
    if (!checkKind(v, field.kind)) {
      return `${type}: field "${name}" must be ${kindName(field.kind)}`;
    }
  }
  if (type === "seg") {
    if ((o.rev as number) < 1) return "seg: rev must be >= 1";
    if (o.rev === 1) {
      for (const name of SEG_REV1_REQUIRED) {
        if (o[name] === undefined) return `seg: revision 1 is missing field "${name}"`;
      }
    }
    const id = o.id as string;
    if (o.layer !== undefined && !id.startsWith(o.layer === "live" ? "l" : "f")) {
      return `seg: id "${id}" does not match layer "${String(o.layer)}"`;
    }
  }
  if (type === "part.started") {
    const call = o.call as Record<string, unknown>;
    if (typeof call.mode !== "string") return 'part.started: field "call.mode" must be string';
    if (call.exclude !== undefined && !checkKind(call.exclude, "string[]")) {
      return 'part.started: field "call.exclude" must be string[]';
    }
  }
  if (type === "call.created" && o.schema !== SCHEMA_VERSION) {
    return `call.created: unsupported schema ${String(o.schema)}`;
  }
  if (type === "vocab.add" && typeof o.term === "string") {
    if (o.term.trim() === "") return "vocab.add: term must not be empty";
    if (o.heard === undefined) return 'vocab.add: missing field "heard"';
  }
  if ((type === "note" || type === "remember" || type === "vocab.add") && (o.rev as number) < 1) {
    return `${type}: rev must be >= 1`;
  }
  if (type === "answer") {
    const pack = o.pack as Record<string, unknown>;
    if (typeof pack.mode !== "string" || !checkKind(pack.tokens, "number")) {
      return "answer: pack must be {mode: string, tokens: number}";
    }
  }
  return null;
}

/** Validates an event that a writer is about to append (no envelope yet). */
export function validateDraft(input: unknown): ValidationResult<EventDraft> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "event must be an object" };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.type !== "string") return { ok: false, error: 'missing field "type"' };
  if (!Object.hasOwn(SPECS, o.type)) return { ok: false, error: `unknown event type "${o.type}"` };
  const error = validateBody(o, o.type as EventType);
  return error ? { ok: false, error } : { ok: true, value: o as unknown as EventDraft };
}

/** Validates a full event as read from the log, envelope included. */
export function validateEvent(input: unknown): ValidationResult<LogEvent> {
  const draft = validateDraft(input);
  if (!draft.ok) return draft;
  const o = input as Record<string, unknown>;
  if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 1) {
    return { ok: false, error: 'field "seq" must be a positive integer' };
  }
  if (typeof o.t !== "number" || !Number.isFinite(o.t)) {
    return { ok: false, error: 'field "t" must be a number (epoch ms)' };
  }
  return { ok: true, value: o as unknown as LogEvent };
}
