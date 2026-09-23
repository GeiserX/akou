/**
 * The fold (docs/DESIGN.md section 4.6): the only reader of raw events. Every surface (window,
 * packs, export, share viewer, API) reads a call through a `CallView`.
 *
 * It is incremental: `apply(event)` updates the view in constant time. Rendering a segment with
 * names and vocabulary applied happens when a surface asks, and is cached; a `vocab.add` with
 * heard forms re-renders only the segments those forms occur in.
 *
 * What it holds: segments per layer with revisions (latest `rev` wins, every revision kept), the
 * `best` view (final for every part that has `final.part.done`, else live), parts with their
 * clocks, pauses, mutes and gaps, speakers (clusters, merges, names, the final-to-live map), notes
 * with their author, remembered items, memo, Q&A, enhanced notes, the call's vocabulary and the
 * corrected text it yields beside the raw text, proposals, health, the final pass, sharing and
 * hand-off. Provisional lines are not events; they have their own small board below.
 */

import {
  type Correction,
  type CorrectResult,
  correctText,
  tokenize,
  type VocabRule,
} from "../vocab/correct.ts";
import { PartClock } from "./clock.ts";
import {
  type Answer,
  type Ask,
  type AsrLag,
  type CallCreated,
  type CallFailed,
  type Channel,
  type ChunkSummary,
  type Enhanced,
  type ExportDone,
  type FinalDone,
  type FinalFailed,
  type Gap,
  type Health,
  type HookDone,
  isAgentAuthor,
  type Layer,
  type LogEvent,
  type Memo,
  type PartEndReason,
  type PartStarted,
  type ProposalStatus,
  type Seg,
  type ShareStarted,
  type SpeakerMap,
  type SpeakerSuggest,
  type VocabUsed,
  type WebhookDone,
} from "./events.ts";
import { compareLines } from "./reader.ts";

// ---------------------------------------------------------------------------
// Public shapes

export interface FileVocabEntry {
  term: string;
  heard: readonly string[];
  /** An unconfirmed entry does nothing: no correction, no decode entry. */
  confirmed?: boolean;
}

export interface FoldOptions {
  /** Entries from the vocabulary files (global, workspace, extra paths). */
  vocabFiles?: readonly FileVocabEntry[];
  /**
   * Is this lowercase, accent-folded word a dictionary word? Without it, file pairs and fuzzy
   * matching cannot be applied safely, so only call-scoped pairs correct text.
   */
  isDictionaryWord?: (word: string) => boolean;
}

export type CallState =
  | "empty"
  | "starting"
  | "recording"
  | "paused"
  | "restarting"
  | "stopping"
  | "crashed"
  | "ended"
  | "interrupted"
  | "failed";

export type View = "best" | "live" | "final";

export interface SegState {
  id: string;
  layer: Layer;
  part: number;
  ch: Channel;
  spk: string;
  a0: number;
  a1: number;
  w0: number;
  w1: number;
  /** Current text; null when retracted. */
  text: string | null;
  /** The recognizer's text, from revision 1. Never changed by edits or corrections. */
  recognized: string | null;
  lang?: string;
  model: string;
  echo: boolean;
  by?: string;
  rev: number;
  /** `seq` of revision 1: the line's stable position in the log. */
  seq: number;
  /** `seq` of the latest revision. */
  lastSeq: number;
  revisions: Seg[];
}

export interface Line {
  id: string;
  layer: Layer;
  part: number;
  ch: Channel;
  /** Speaker id after the final-to-live map and merges. */
  spk: string;
  /** The raw speaker id as written. */
  spkRaw: string;
  /** Display label: the name, `Speaker N`, or the user's name for `you`. */
  speaker: string;
  a0: number;
  a1: number;
  w0: number;
  w1: number;
  /** Text with vocabulary corrections applied. Empty when retracted. */
  text: string;
  /** Pack and export form: `Anika (heard: "annika")`. */
  annotated: string;
  /** The raw text, present only when a correction changed it. */
  heard?: string;
  /** The current raw text (latest revision), never corrected. */
  raw: string | null;
  corrections: Correction[];
  retracted: boolean;
  echo: boolean;
  edited: boolean;
  rev: number;
  seq: number;
  lang?: string;
  model: string;
  by?: string;
}

export interface PauseSpan {
  a: number;
  wall: number;
  mono: number;
  resumed?: { a: number; wall: number; mono: number };
}

export interface MuteSpan {
  a: number;
  unmutedAt?: number;
}

export interface PartView {
  part: number;
  file: string;
  wallStart: number;
  monoStart: number;
  mic: string | null;
  call: PartStarted["call"];
  capture: string;
  startSeq: number;
  ended?: { reason: PartEndReason; fileSeconds: number; seq: number };
  pauses: PauseSpan[];
  mutes: MuteSpan[];
  gaps: Gap[];
  clock: PartClock;
  /** The final layer is shown for this part in the `best` view. */
  finalDone: boolean;
}

export interface SpeakerView {
  spk: string;
  label: string;
  name?: string;
  namedBy?: string;
  /** Set when this id is merged into another. */
  mergedInto?: string;
}

export interface NoteView {
  id: string;
  rev: number;
  text: string;
  w: number;
  afterSeq: number;
  by: string;
  author: "human" | "agent";
  /** For agent notes, the client after `agent:`. */
  client?: string;
  seq: number;
}

export interface RememberView {
  id: string;
  rev: number;
  text: string;
  by: string;
  seq: number;
}

export interface CallVocabEntry {
  id: string;
  rev: number;
  term: string;
  heard: string[];
  by: string;
  segs?: string[];
  decode: boolean;
  seq: number;
}

export interface ProposalView {
  id: string;
  rev: number;
  term: string;
  heard: string[];
  by: string;
  evidence: unknown;
  status: ProposalStatus;
}

export interface QaView {
  ask: Ask;
  answer?: Answer;
}

export interface FinalState {
  state: "none" | "running" | "done" | "failed";
  partsDone: number[];
  done?: FinalDone;
  failed?: FinalFailed;
}

// ---------------------------------------------------------------------------
// Provisional lines: never in the log, newest wins, cleared on close, 3 s expiry.

export const PROVISIONAL_TTL_MS = 3000;

export interface Provisional {
  ch: Channel;
  part: number;
  /** Increases with every update of the open segment; an older update never replaces a newer. */
  pseq: number;
  text: string;
  /** Wall time the open segment began. */
  w0: number;
  /** When this update was published (epoch ms); it expires PROVISIONAL_TTL_MS later. */
  at: number;
  spk?: string;
}

export class ProvisionalBoard {
  private readonly lines = new Map<Channel, Provisional>();

  /** Publishes an update. Returns false if a newer update for the channel is already shown. */
  update(p: Provisional): boolean {
    const cur = this.lines.get(p.ch);
    if (cur && cur.part === p.part && cur.pseq >= p.pseq) return false;
    this.lines.set(p.ch, p);
    return true;
  }

  /** A committed line on the channel closes the open segment it covers. */
  commit(ch: Channel, w1: number): void {
    const cur = this.lines.get(ch);
    if (cur && cur.w0 <= w1) this.lines.delete(ch);
  }

  clear(ch: Channel): void {
    this.lines.delete(ch);
  }

  /** Lines still inside their expiry, mic first. */
  current(now: number): Provisional[] {
    const out: Provisional[] = [];
    for (const ch of ["mic", "call"] as const) {
      const p = this.lines.get(ch);
      if (p && now - p.at < PROVISIONAL_TTL_MS) out.push(p);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// The view

const LIVE_STATES: ReadonlySet<CallState> = new Set(["recording", "paused", "restarting"]);

/** Change-feed marker: every line may render differently. Never a segment id. */
const ALL_LINES = "*";

interface NameEntry {
  name: string;
  by: string;
  seq: number;
}

interface RenderCacheEntry {
  rev: number;
  result: CorrectResult;
}

export class CallView {
  readonly options: FoldOptions;
  /** Problems found while folding (a revision for an unknown segment, for example). */
  readonly issues: string[] = [];
  /** Counts `correctText` runs, to prove rendering stays incremental. */
  readonly stats = { renders: 0 };
  readonly provisional = new ProvisionalBoard();

  private _lastSeq = 0;
  private _call: CallCreated | null = null;
  private _state: CallState = "empty";
  private _muted = false;
  private _failed: CallFailed | null = null;
  private _endedReason: "stop" | "interrupted" | "abandoned" | null = null;

  private readonly segs = new Map<string, SegState>();
  private readonly _parts = new Map<number, PartView>();

  private readonly names = new Map<string, NameEntry>();
  private readonly merges = new Map<string, string>();
  private readonly finalMap = new Map<string, SpeakerMap>();
  private readonly suggestions = new Map<string, SpeakerSuggest>();
  private readonly centroids = new Map<string, string>();

  private readonly _notes = new Map<string, NoteView>();
  private readonly _remember = new Map<string, RememberView & { retracted: boolean }>();
  private _memo: Memo | null = null;
  private readonly _chunks: ChunkSummary[] = [];
  private readonly _asks = new Map<string, QaView>();
  private readonly _enhanced: Enhanced[] = [];

  private readonly callVocab = new Map<string, CallVocabEntry & { retracted: boolean }>();
  private readonly _proposals = new Map<string, ProposalView>();
  private _vocabUsed: VocabUsed | null = null;

  private readonly _health = new Map<string, Health>();
  private readonly _healthLog: Health[] = [];
  private _lag: AsrLag | null = null;

  private readonly _final: FinalState = { state: "none", partsDone: [] };
  private _share: { active: boolean; started?: ShareStarted } = { active: false };
  private readonly _exports: ExportDone[] = [];
  private readonly _hooks: HookDone[] = [];
  private readonly _webhooks: WebhookDone[] = [];

  // Rendering cache and the index that keeps vocabulary changes local.
  private readonly renderCache = new Map<string, RenderCacheEntry>();
  private readonly tokenIndex = new Map<string, Set<string>>();
  private rulesCache: VocabRule[] | null = null;

  // Change feed for incremental readers (the query index): segment ids whose rendering may have
  // changed, in order, with ALL_LINES when every line may have (names, merges, a layer switch).
  private readonly changeLog: string[] = [];

  constructor(options: FoldOptions = {}) {
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Applying events

  apply(e: LogEvent): void {
    if (e.seq <= this._lastSeq) {
      this.issues.push(`seq ${e.seq} applied after ${this._lastSeq}; ignored`);
      return;
    }
    this._lastSeq = e.seq;
    switch (e.type) {
      case "call.created":
        this._call = e;
        this._state = "starting";
        this.invalidateNames();
        break;
      case "call.ended":
        this._endedReason = e.reason;
        this._state = e.reason === "interrupted" ? "interrupted" : "ended";
        break;
      case "call.failed":
        this._failed = e;
        this._state = "failed";
        break;
      case "part.started":
        this._parts.set(e.part, {
          part: e.part,
          file: e.file,
          wallStart: e.wallStart,
          monoStart: e.monoStart,
          mic: e.mic,
          call: e.call,
          capture: e.capture,
          startSeq: e.seq,
          pauses: [],
          mutes: [],
          gaps: [],
          clock: new PartClock(e),
          finalDone: this._final.partsDone.includes(e.part),
        });
        this._state = "recording";
        this._muted = false;
        this._endedReason = null;
        break;
      case "part.ended": {
        const p = this._parts.get(e.part);
        if (p) p.ended = { reason: e.reason, fileSeconds: e.fileSeconds, seq: e.seq };
        // A restart is make before break: part n+1 may start before part n ends. Only the newest
        // part ending moves the call's state.
        const newest = Math.max(e.part, ...this._parts.keys());
        if (this._state !== "failed" && e.part >= newest) {
          this._state =
            e.reason === "restart" || e.reason === "helper-exit"
              ? "restarting"
              : e.reason === "crashed"
                ? "crashed"
                : "stopping";
        }
        break;
      }
      case "pause": {
        this._parts.get(e.part)?.pauses.push({ a: e.a, wall: e.wall, mono: e.mono });
        this._state = "paused";
        break;
      }
      case "resume": {
        const p = this._parts.get(e.part);
        if (p) {
          const open = p.pauses.findLast((x) => !x.resumed);
          if (open) open.resumed = { a: e.a, wall: e.wall, mono: e.mono };
          p.clock.resume(e);
        }
        this._state = "recording";
        break;
      }
      case "mute":
        this._parts.get(e.part)?.mutes.push({ a: e.a });
        this._muted = true;
        break;
      case "unmute": {
        const open = this._parts.get(e.part)?.mutes.findLast((m) => m.unmutedAt === undefined);
        if (open) open.unmutedAt = e.a;
        this._muted = false;
        break;
      }
      case "gap": {
        const p = this._parts.get(e.part);
        if (p) {
          p.gaps.push(e);
          p.clock.gap(e);
        }
        break;
      }
      case "seg":
        this.applySeg(e);
        break;
      case "speaker.centroid":
        this.centroids.set(e.spk, e.vec);
        break;
      case "speaker.merge":
        if (e.from !== e.into) this.merges.set(e.from, e.into);
        this.changeLog.push(ALL_LINES);
        break;
      case "speaker.unmerge":
        if (this.merges.get(e.from) === e.into) this.merges.delete(e.from);
        this.changeLog.push(ALL_LINES);
        break;
      case "speaker.name":
        this.names.set(e.spk, { name: e.name, by: e.by, seq: e.seq });
        this.invalidateNames();
        break;
      case "speaker.map":
        this.finalMap.set(e.final, e);
        this.suggestions.delete(e.final);
        this.changeLog.push(ALL_LINES);
        break;
      case "speaker.suggest":
        if (!this.finalMap.has(e.final)) this.suggestions.set(e.final, e);
        break;
      case "note": {
        const cur = this._notes.get(e.id);
        if (cur && cur.rev >= e.rev) break;
        this._notes.set(e.id, {
          id: e.id,
          rev: e.rev,
          text: e.text,
          w: e.w,
          afterSeq: e.afterSeq,
          by: e.by,
          author: isAgentAuthor(e.by) ? "agent" : "human",
          client: isAgentAuthor(e.by) ? e.by.slice("agent:".length) : undefined,
          seq: cur?.seq ?? e.seq,
        });
        break;
      }
      case "note.del":
        this._notes.delete(e.id);
        break;
      case "remember": {
        const cur = this._remember.get(e.id);
        if (cur && cur.rev >= e.rev) break;
        this._remember.set(e.id, {
          id: e.id,
          rev: e.rev,
          text: e.text ?? "",
          by: e.by,
          seq: cur?.seq ?? e.seq,
          retracted: e.text === null,
        });
        break;
      }
      case "memo":
        if (!this._memo || e.rev >= this._memo.rev) this._memo = e;
        break;
      case "chunk.summary":
        this._chunks.push(e);
        break;
      case "ask":
        this._asks.set(e.id, { ask: e, answer: this._asks.get(e.id)?.answer });
        break;
      case "answer": {
        const qa = this._asks.get(e.ask);
        if (qa) qa.answer = e;
        else this.issues.push(`answer at seq ${e.seq} for unknown ask "${e.ask}"`);
        break;
      }
      case "enhanced":
        this._enhanced.push(e);
        break;
      case "vocab.used":
        this._vocabUsed = e;
        break;
      case "vocab.add":
        this.applyVocabAdd(e);
        break;
      case "vocab.propose": {
        const cur = this._proposals.get(e.id);
        if (cur && cur.rev >= e.rev) break;
        const wasAccepted = cur?.status === "accepted";
        this._proposals.set(e.id, {
          id: e.id,
          rev: e.rev,
          term: e.term,
          heard: [...e.heard],
          by: e.by,
          evidence: e.evidence,
          status: e.status,
        });
        // As with vocab.add: a term with no heard forms is fuzzy and can touch any segment.
        if (
          (wasAccepted && cur?.heard.length === 0) ||
          (e.status === "accepted" && e.heard.length === 0)
        ) {
          this.invalidateAll();
        } else if (wasAccepted || e.status === "accepted") {
          this.invalidateRuleForms([...(cur?.heard ?? []), ...e.heard]);
        }
        break;
      }
      case "health":
        this._health.set(`${e.part}:${e.ch}`, e);
        this._healthLog.push(e);
        break;
      case "asr.lag":
        this._lag = e;
        break;
      case "final.started":
        this._final.state = "running";
        this._final.failed = undefined;
        break;
      case "final.part.done": {
        if (!this._final.partsDone.includes(e.part)) this._final.partsDone.push(e.part);
        const p = this._parts.get(e.part);
        if (p) p.finalDone = true;
        this.changeLog.push(ALL_LINES);
        break;
      }
      case "final.done":
        this._final.state = "done";
        this._final.done = e;
        break;
      case "final.failed":
        this._final.state = "failed";
        this._final.failed = e;
        break;
      case "share.started":
        this._share = { active: true, started: e };
        break;
      case "share.stopped":
        this._share = { active: false, started: this._share.started };
        break;
      case "export.done":
        this._exports.push(e);
        break;
      case "hook.done":
        this._hooks.push(e);
        break;
      case "webhook.done":
        this._webhooks.push(e);
        break;
    }
  }

  private applySeg(e: Seg): void {
    const cur = this.segs.get(e.id);
    if (!cur) {
      if (e.rev !== 1) {
        this.issues.push(`seg ${e.id} rev ${e.rev} has no revision 1; ignored`);
        return;
      }
      const s: SegState = {
        id: e.id,
        layer: e.layer ?? (e.id.startsWith("f") ? "final" : "live"),
        part: e.part as number,
        ch: e.ch as Channel,
        spk: e.spk as string,
        a0: e.a0 as number,
        a1: e.a1 as number,
        w0: e.w0 as number,
        w1: e.w1 as number,
        text: e.text ?? null,
        recognized: e.text ?? null,
        lang: e.lang,
        model: e.model as string,
        echo: e.echo ?? false,
        by: e.by,
        rev: 1,
        seq: e.seq,
        lastSeq: e.seq,
        revisions: [e],
      };
      this.segs.set(e.id, s);
      this.changeLog.push(s.id);
      this.indexTokens(s.id, s.text);
      if (s.layer === "live") this.provisional.commit(s.ch, s.w1);
      return;
    }
    cur.revisions.push(e);
    // Highest rev wins; a stale revision stays in the history only.
    if (e.rev <= cur.rev) return;
    cur.rev = e.rev;
    cur.lastSeq = e.seq;
    if (e.part !== undefined) cur.part = e.part;
    if (e.ch !== undefined) cur.ch = e.ch;
    if (e.spk !== undefined) cur.spk = e.spk;
    if (e.a0 !== undefined) cur.a0 = e.a0;
    if (e.a1 !== undefined) cur.a1 = e.a1;
    if (e.w0 !== undefined) cur.w0 = e.w0;
    if (e.w1 !== undefined) cur.w1 = e.w1;
    if (e.text !== undefined) cur.text = e.text;
    if (e.lang !== undefined) cur.lang = e.lang;
    if (e.model !== undefined) cur.model = e.model;
    if (e.echo !== undefined) cur.echo = e.echo;
    if (e.by !== undefined) cur.by = e.by;
    this.changeLog.push(cur.id);
    this.indexTokens(cur.id, cur.text);
  }

  private applyVocabAdd(e: LogEvent & { type: "vocab.add" }): void {
    const cur = this.callVocab.get(e.id);
    if (cur && cur.rev >= e.rev) return;
    const heard = e.term === null ? (cur?.heard ?? []) : (e.heard ?? []);
    const entry = {
      id: e.id,
      rev: e.rev,
      term: e.term ?? cur?.term ?? "",
      heard: [...heard],
      by: e.by,
      segs: e.segs ?? (e.term === null ? cur?.segs : undefined),
      decode: e.decode ?? (e.term === null ? (cur?.decode ?? true) : true),
      seq: cur?.seq ?? e.seq,
      retracted: e.term === null,
    };
    this.callVocab.set(e.id, entry);
    const before = cur && !cur.retracted ? cur : null;
    // A term matched by heard forms only touches segments containing those forms; a fuzzy term
    // (no heard forms) can touch any segment.
    if ((before && before.heard.length === 0) || (!entry.retracted && entry.heard.length === 0)) {
      this.invalidateAll();
    } else {
      this.invalidateRuleForms([...(before?.heard ?? []), ...entry.heard]);
    }
  }

  private indexTokens(id: string, text: string | null): void {
    if (!text) return;
    for (const t of tokenize(text)) {
      let set = this.tokenIndex.get(t.folded);
      if (!set) {
        set = new Set();
        this.tokenIndex.set(t.folded, set);
      }
      set.add(id);
    }
  }

  private invalidateRuleForms(forms: readonly string[]): void {
    this.rulesCache = null;
    for (const form of forms) {
      const first = tokenize(form)[0];
      if (!first) continue;
      for (const id of this.tokenIndex.get(first.folded) ?? []) {
        this.renderCache.delete(id);
        this.changeLog.push(id);
      }
    }
  }

  private invalidateNames(): void {
    // Names are fuzzy terms, so any segment may change.
    this.invalidateAll();
  }

  private invalidateAll(): void {
    this.rulesCache = null;
    this.renderCache.clear();
    this.changeLog.push(ALL_LINES);
  }

  /**
   * What changed since a cursor from an earlier call (0 at first): the segment ids whose line may
   * render differently, or `all: true` when every line may (a name, a merge, a layer switch, a
   * fuzzy vocabulary term). Lets a reader such as the query index stay incremental without reading
   * raw events itself.
   */
  changesSince(cursor: number): { cursor: number; all: boolean; ids: string[] } {
    const next = this.changeLog.length;
    const ids = new Set<string>();
    for (let i = Math.max(0, cursor); i < next; i++) {
      const id = this.changeLog[i] as string;
      if (id === ALL_LINES) return { cursor: next, all: true, ids: [] };
      ids.add(id);
    }
    return { cursor: next, all: false, ids: [...ids] };
  }

  // -------------------------------------------------------------------------
  // Call, state, parts

  get lastSeq(): number {
    return this._lastSeq;
  }

  get call(): CallCreated | null {
    return this._call;
  }

  get state(): CallState {
    return this._state;
  }

  /** True while the call is recording, paused, or between two parts of a restart. */
  get live(): boolean {
    return LIVE_STATES.has(this._state);
  }

  get muted(): boolean {
    return this._muted;
  }

  get failure(): CallFailed | null {
    return this._failed;
  }

  get endedReason(): "stop" | "interrupted" | "abandoned" | null {
    return this._endedReason;
  }

  parts(): PartView[] {
    return [...this._parts.values()].sort((a, b) => a.part - b.part);
  }

  part(n: number): PartView | undefined {
    return this._parts.get(n);
  }

  /** Parts with no `part.ended`: after a crash, the app closes them with `reason: crashed`. */
  openParts(): PartView[] {
    return this.parts().filter((p) => !p.ended);
  }

  // -------------------------------------------------------------------------
  // Speakers

  /** Follows merges from a live id to the id it currently renders as. */
  resolveSpeaker(spk: string): string {
    const seen = new Set<string>();
    let cur = spk;
    while (this.merges.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.merges.get(cur) as string;
    }
    return cur;
  }

  /** A segment's speaker: final clusters go through `speaker.map` first, then merges. */
  private segSpeaker(s: SegState): string {
    if (s.ch === "mic") return "you";
    const mapped = s.layer === "final" ? (this.finalMap.get(s.spk)?.live ?? s.spk) : s.spk;
    return this.resolveSpeaker(mapped);
  }

  private nameOf(root: string): NameEntry | undefined {
    const own = this.names.get(root);
    if (own) return own;
    // A merged group with an unnamed root carries the latest name given to any member.
    let best: NameEntry | undefined;
    for (const [spk, entry] of this.names) {
      if (spk !== root && this.resolveSpeaker(spk) === root && (!best || entry.seq > best.seq)) {
        best = entry;
      }
    }
    return best;
  }

  /** Display label for a speaker id (already resolved or not). */
  speakerLabel(spk: string): string {
    const root = this.resolveSpeaker(spk);
    const named = this.nameOf(root);
    if (named) return named.name;
    if (root === "you") return this._call?.user || "You";
    const n = /^c(\d+)$/.exec(root);
    if (n) return `Speaker ${n[1]}`;
    if (root === "c?") return "Unknown speaker";
    return root;
  }

  /** Every speaker id seen in segments, names or merges, with its label. */
  roster(): SpeakerView[] {
    const ids = new Set<string>();
    for (const s of this.segs.values()) {
      ids.add(s.ch === "mic" ? "you" : s.layer === "final" ? this.segSpeaker(s) : s.spk);
    }
    for (const k of this.names.keys()) ids.add(k);
    for (const [from, into] of this.merges) {
      ids.add(from);
      ids.add(into);
    }
    return [...ids].sort(speakerOrder).map((spk) => {
      const root = this.resolveSpeaker(spk);
      const named = this.nameOf(root);
      return {
        spk,
        label: this.speakerLabel(spk),
        name: named?.name,
        namedBy: named?.by,
        mergedInto: root !== spk ? root : undefined,
      };
    });
  }

  /** Final clusters mapped to a live cluster with less than 60 % overlap, awaiting the user. */
  speakerSuggestions(): SpeakerSuggest[] {
    return [...this.suggestions.values()];
  }

  centroid(spk: string): string | undefined {
    return this.centroids.get(spk);
  }

  // -------------------------------------------------------------------------
  // Segments

  private rules(): VocabRule[] {
    if (this.rulesCache) return this.rulesCache;
    const rules: VocabRule[] = [];
    for (const v of this.callVocab.values()) {
      if (v.retracted || v.term === "") continue;
      rules.push({ term: v.term, heard: v.heard, scope: "call", segs: v.segs });
    }
    for (const f of this.options.vocabFiles ?? []) {
      if (f.confirmed === false) continue;
      rules.push({ term: f.term, heard: f.heard, scope: "file" });
    }
    for (const p of this._proposals.values()) {
      // A proposal is inert until the user accepts it; then it behaves like a file entry.
      if (p.status === "accepted") rules.push({ term: p.term, heard: p.heard, scope: "file" });
    }
    const names = new Set<string>();
    for (const n of this.names.values()) names.add(n.name);
    if (this._call?.user) names.add(this._call.user);
    for (const name of names) rules.push({ term: name, heard: [], scope: "name" });
    this.rulesCache = rules;
    return rules;
  }

  private corrected(s: SegState): CorrectResult {
    const hit = this.renderCache.get(s.id);
    if (hit && hit.rev === s.rev) return hit.result;
    this.stats.renders++;
    const result =
      s.text === null
        ? { text: "", annotated: "", corrections: [] }
        : correctText(s.text, this.rules(), {
            segId: s.id,
            isDictionaryWord: this.options.isDictionaryWord,
          });
    this.renderCache.set(s.id, { rev: s.rev, result });
    return result;
  }

  private toLine(s: SegState): Line {
    const c = this.corrected(s);
    const spk = this.segSpeaker(s);
    const changed = s.text !== null && c.text !== s.text;
    return {
      id: s.id,
      layer: s.layer,
      part: s.part,
      ch: s.ch,
      spk,
      spkRaw: s.spk,
      speaker: this.speakerLabel(spk),
      a0: s.a0,
      a1: s.a1,
      w0: s.w0,
      w1: s.w1,
      text: c.text,
      annotated: c.annotated,
      heard: changed ? (s.text as string) : undefined,
      raw: s.text,
      corrections: c.corrections,
      retracted: s.text === null,
      echo: s.echo,
      edited: s.text !== s.recognized,
      rev: s.rev,
      seq: s.seq,
      lang: s.lang,
      model: s.model,
      by: s.by,
    };
  }

  /** Whether a segment belongs to a view, before echo and retraction filtering. */
  private inView(s: SegState, view: View): boolean {
    if (view === "live" || view === "final") return s.layer === view;
    const finalShown = this._final.partsDone.includes(s.part);
    return s.layer === (finalShown ? "final" : "live");
  }

  /**
   * The rendered transcript of one view, in the one sort order: wall time, mic before call,
   * `seq`. Echo and retracted lines are left out unless asked for.
   */
  lines(
    view: View = "best",
    opts: { includeEcho?: boolean; includeRetracted?: boolean } = {},
  ): Line[] {
    const out: Line[] = [];
    for (const s of this.segs.values()) {
      if (!this.inView(s, view)) continue;
      if (s.echo && !opts.includeEcho) continue;
      if (s.text === null && !opts.includeRetracted) continue;
      out.push(this.toLine(s));
    }
    return out.sort(compareLines);
  }

  /** Whether a segment is a line of a view: in it, not echo, not retracted. */
  visibleIn(id: string, view: View = "best"): boolean {
    const s = this.segs.get(id);
    return s !== undefined && this.inView(s, view) && !s.echo && s.text !== null;
  }

  /** Any segment id, live or final, resolves for as long as the log exists. */
  resolve(id: string): Line | null {
    const s = this.segs.get(id);
    return s ? this.toLine(s) : null;
  }

  /** The raw state of a segment, every revision included. */
  segment(id: string): SegState | undefined {
    return this.segs.get(id);
  }

  // -------------------------------------------------------------------------
  // Notes, memory, memo, Q&A, enhanced

  notes(): NoteView[] {
    return [...this._notes.values()].sort((a, b) => a.w - b.w || a.seq - b.seq);
  }

  remembered(): RememberView[] {
    return [...this._remember.values()]
      .filter((r) => !r.retracted)
      .map(({ retracted: _r, ...r }) => r)
      .sort((a, b) => a.seq - b.seq);
  }

  /** The latest rolling memo. Chunk summaries are never read as the memo. */
  get memo(): Memo | null {
    return this._memo;
  }

  chunkSummaries(): ChunkSummary[] {
    return [...this._chunks];
  }

  qa(): QaView[] {
    return [...this._asks.values()].sort((a, b) => a.ask.seq - b.ask.seq);
  }

  /** Every enhanced-notes revision, oldest first. */
  enhanced(): Enhanced[] {
    return [...this._enhanced];
  }

  latestEnhanced(): Enhanced | null {
    let best: Enhanced | null = null;
    for (const e of this._enhanced) if (!best || e.rev >= best.rev) best = e;
    return best;
  }

  // -------------------------------------------------------------------------
  // Vocabulary

  /** Call-scoped entries in force (retracted ones left out). */
  callVocabulary(): CallVocabEntry[] {
    return [...this.callVocab.values()]
      .filter((v) => !v.retracted)
      .map(({ retracted: _r, ...v }) => v)
      .sort((a, b) => a.seq - b.seq);
  }

  proposals(status?: ProposalStatus): ProposalView[] {
    const all = [...this._proposals.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  get vocabUsed(): VocabUsed | null {
    return this._vocabUsed;
  }

  // -------------------------------------------------------------------------
  // Health, final pass, sharing, hand-off

  /** The latest health state per part and channel. */
  health(): Health[] {
    return [...this._health.values()];
  }

  /** Current state of a channel: the latest health event for it in the newest part. */
  channelHealth(ch: Channel): Health | undefined {
    let best: Health | undefined;
    for (const h of this._health.values()) {
      if (
        h.ch === ch &&
        (!best || h.part > best.part || (h.part === best.part && h.seq > best.seq))
      )
        best = h;
    }
    return best;
  }

  healthHistory(): Health[] {
    return [...this._healthLog];
  }

  get asrLag(): AsrLag | null {
    return this._lag;
  }

  get final(): FinalState {
    return { ...this._final, partsDone: [...this._final.partsDone].sort((a, b) => a - b) };
  }

  get share(): { active: boolean; started?: ShareStarted } {
    return { ...this._share };
  }

  handoff(): { exports: ExportDone[]; hooks: HookDone[]; webhooks: WebhookDone[] } {
    return { exports: [...this._exports], hooks: [...this._hooks], webhooks: [...this._webhooks] };
  }
}

function speakerOrder(a: string, b: string): number {
  const rank = (s: string) => (s === "you" ? 0 : /^c\d+$/.test(s) ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) return Number(a.slice(1)) - Number(b.slice(1));
  return a.localeCompare(b);
}

/** Folds a whole log into a view. Feed later events with `view.apply(event)`. */
export function fold(events: Iterable<LogEvent>, options: FoldOptions = {}): CallView {
  const view = new CallView(options);
  for (const e of events) view.apply(e);
  return view;
}
