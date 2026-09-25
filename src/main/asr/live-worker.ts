/**
 * The live transcript (docs/DESIGN.md sections 1.1, 1.5, 3.1 and 3.2): one `live-asr` Worker that
 * turns each channel's 16 kHz audio into segments, provisional lines and speaker labels, and the
 * host on the main thread that feeds it and writes what it finds to the log.
 *
 * Per channel, in the Worker (`LivePipeline`):
 * 1. **Segment** with Silero VAD. A segment closes after `segmentPause` (0.7 s) of no speech or at
 *    `segmentWindow` (12 s) of unbroken speech. VAD only cuts the live transcript; it never decides
 *    what is recorded or what the final pass transcribes.
 * 2. **Gain and pad** the copy through `prepareSpan` (pad.ts), the one function every path uses.
 * 3. **Decode** with the offline recognizer and the call's decode list as the per-stream hotwords.
 *    A word added mid-call is in the list from the next segment. Hotwords reach only a transducer.
 * 4. **Provisional line.** While a segment is open it is re-decoded every second (bounded by the
 *    window) and published with a 3 s expiry. It is never written to the log.
 * 5. **Speakers.** The mic is `you`. On the call channel, with a stream diarizer (`asr.diarizer`
 *    nemotron), the channel's audio also goes to Nemotron as one stream for the whole call, and a
 *    call segment is held until the model has decided all of it, then labelled with the speaker
 *    active longest inside it (`StreamSpeakers`). Without one, call segments of 1 s or more are
 *    embedded and clustered (`LiveSpeakers`).
 *
 * On the main thread (`LiveAsr`):
 * - It pulls audio from the part's bounded ingest queues (10 minutes) and keeps only a few seconds
 *   in flight to the Worker, so a slow model makes the transcript lag, never memory grow. Audio is
 *   never affected by the recognizer.
 * - It assigns `seq` (through the call's one writer), the segment id and the wall times (from the
 *   part's anchors), and writes `seg`, `vocab.used`, `speaker.centroid`, `speaker.merge` and
 *   `asr.lag` (when the backlog crosses 10 s or 30 s, and when it recovers).
 * - Before `call.ended` it asks the Worker to close what is open (`flush`), within the call's
 *   flush budget. A result that arrives after `call.ended` is dropped, never written after it.
 * - The Worker transcribes one call at a time. A call started while the last one is still
 *   stopping takes the Worker over only after the last one's queued audio is sent and its open
 *   lines are closed, so they land in the last call's log before its `call.ended`.
 * - A Worker that dies is replaced (at most three times in ten minutes) and takes over the current
 *   call from its log; a dead Worker never throws into the call's packet or event path.
 *
 * The Worker never writes the log and never prints: engine and pipeline messages come back as
 * `log` messages for the app log (TRAPS T1.45).
 */

import { workerData } from "node:worker_threads";
import type { Channel, EventDraft, LogEvent } from "../../core/log/events.ts";
import type { CallView } from "../../core/log/fold.ts";
import { CHANNELS, type Clock, realClock, withDeadline } from "../capture/engine.ts";
import type { PartIngest } from "../capture/ingest.ts";
import type { Packet } from "../capture/protocol.ts";
import { buildDecodeList, type DecodeList } from "../vocab/decode-list.ts";
import type { MergedEntry } from "../vocab/files.ts";
import {
  ASR_RATE,
  type Embedder,
  loadModelSet,
  type ModelSet,
  type ModelSpec,
  type PreparedHotwords,
  type StreamDiarizer,
  type Vad,
} from "./engine.ts";
import { RECOGNIZER } from "./models.ts";
import { prepareSpan } from "./pad.ts";
import { siblingModule } from "./sibling.ts";
import {
  highestLabel,
  LiveSpeakers,
  MIN_EMBED_SECONDS,
  type SpeakerEvent,
  StreamSpeakers,
} from "./speakers.ts";

/** A stream diarizer that dies is started again at most this many times per call. */
export const STREAM_RESTART_LIMIT = 3;
/** A call segment the stream diarizer has not decided this far behind the stream is `c?`. */
export const STREAM_WAIT_SECONDS = 30;
/** How long a part end, a flush or a new call waits for the stream diarizer's last decisions. */
export const STREAM_FLUSH_MS = 3000;

export interface LiveOptions {
  /** Silence that closes a segment, seconds (0.2 to 5). */
  segmentPause: number;
  /** Longest segment, seconds (2 to 30, above the pause). */
  segmentWindow: number;
  /** Re-decode of the open segment for the provisional line, seconds. */
  provisionalEvery: number;
  /** Audio kept before the VAD's first speech window. */
  preRoll: number;
  /** Audio kept after the last speech window. */
  postRoll: number;
}

export const DEFAULT_LIVE: LiveOptions = {
  segmentPause: 0.7,
  segmentWindow: 12,
  provisionalEvery: 1,
  preRoll: 0.5,
  postRoll: 0.2,
};

/** What the pipeline reports. The host turns these into events and provisional lines. */
export type LiveOut =
  | {
      type: "seg";
      part: number;
      ch: Channel;
      a0: number;
      a1: number;
      text: string;
      spk: string;
      model: string;
      lang?: string;
    }
  | { type: "provisional"; part: number; ch: Channel; pseq: number; a0: number; text: string }
  | { type: "progress"; part: number; ch: Channel; pos: number }
  | {
      type: "vocab";
      version: number;
      model: string;
      entries: string[];
      dropped: { term: string; reason: string }[];
      warnings: string[];
    }
  | SpeakerEvent
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };

// ---------------------------------------------------------------------------
// Audio kept per channel: from a start position to the newest sample

class Span {
  private chunks: Float32Array[] = [];
  start = 0;
  length = 0;

  get end(): number {
    return this.start + this.length;
  }

  reset(at: number): void {
    this.chunks = [];
    this.start = at;
    this.length = 0;
  }

  push(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.chunks.push(samples);
    this.length += samples.length;
  }

  /** Drops audio before `pos`. */
  trimTo(pos: number): void {
    let drop = Math.min(this.length, Math.max(0, pos - this.start));
    while (drop > 0 && this.chunks.length > 0) {
      const first = this.chunks[0] as Float32Array;
      if (first.length <= drop) {
        this.chunks.shift();
        this.start += first.length;
        this.length -= first.length;
        drop -= first.length;
      } else {
        this.chunks[0] = first.subarray(drop);
        this.start += drop;
        this.length -= drop;
        drop = 0;
      }
    }
  }

  /** A copy of `[from, to)`, clamped to what is held. */
  slice(from: number, to: number): Float32Array {
    const a = Math.max(from, this.start);
    const b = Math.min(to, this.end);
    const out = new Float32Array(Math.max(0, b - a));
    let pos = this.start;
    let o = 0;
    for (const c of this.chunks) {
      const cEnd = pos + c.length;
      if (cEnd > a && pos < b) {
        const s = Math.max(a, pos) - pos;
        const e = Math.min(b, cEnd) - pos;
        out.set(c.subarray(s, e), o);
        o += e - s;
      }
      pos = cEnd;
      if (pos >= b) break;
    }
    return out;
  }
}

/** The call channel's stream to the diarizer: one per call, parts included (DESIGN 3.2). */
interface StreamState {
  d: StreamDiarizer;
  speakers: StreamSpeakers;
  /** The label each of this stream's speakers was given. */
  labels: Map<number, string>;
  /** Samples pushed so far: the stream's own timeline. */
  pos: number;
  /** Where each run of contiguous call audio sits on the stream. */
  runs: { part: number; from: number; to: number; at: number }[];
  dead: boolean;
}

type SegOut = Extract<LiveOut, { type: "seg" }>;

/** A call segment waiting for the diarizer to decide `[s0, s1)` of `stream`. */
interface Pending {
  seg: Omit<SegOut, "spk">;
  stream: StreamState | null;
  s0: number;
  s1: number;
  /** For segments of `MIN_EMBED_SECONDS` or more. */
  emb: Float32Array | null;
}

interface ChannelState {
  ch: Channel;
  part: number | null;
  vad: Vad;
  /** Next sample expected on the part's file timeline. */
  pos: number;
  /** Samples of an unfinished VAD window. */
  pending: Float32Array;
  pendingStart: number;
  audio: Span;
  inSpeech: boolean;
  segStart: number;
  lastSpeech: number;
  lastProvisional: number;
  pseq: number;
}

// ---------------------------------------------------------------------------
// The pipeline, one per Worker (or per test)

export class LivePipeline {
  private readonly o: LiveOptions;
  /**
   * A Map, not an object keyed by channel: a channel name that arrives in a Worker message is
   * looked up here, and on an object `__proto__` would find Object.prototype and write into it.
   */
  private readonly chans: ReadonlyMap<Channel, ChannelState>;
  private list: DecodeList | null = null;
  private listVersion = 0;
  private prepared: PreparedHotwords | null = null;
  private speakers = new LiveSpeakers();
  private embedder: Embedder | null = null;
  /** The newest audio message came in close to real time, so provisional lines are worth it. */
  private live = true;
  /** `stream` once the model set gave a stream diarizer, `embeddings` once it gave none. */
  private labels: "unknown" | "stream" | "embeddings" = "unknown";
  private stream: StreamState | null = null;
  private pending: Pending[] = [];
  /** The highest `c<N>` the call has: a new stream numbers its speakers after it. */
  private labelsUsed = 0;
  private streamStarts = 0;

  constructor(
    private readonly models: ModelSet,
    opts: Partial<LiveOptions>,
    private readonly emit: (o: LiveOut) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.o = { ...DEFAULT_LIVE, ...opts };
    if (!(this.o.segmentWindow > this.o.segmentPause)) {
      throw new Error("segmentWindow must exceed segmentPause");
    }
    const state = (ch: Channel): ChannelState => ({
      ch,
      part: null,
      vad: models.vad(),
      pos: 0,
      pending: new Float32Array(0),
      pendingStart: 0,
      audio: new Span(),
      inSpeech: false,
      segStart: 0,
      lastSpeech: 0,
      lastProvisional: 0,
      pseq: 0,
    });
    this.chans = new Map(CHANNELS.map((ch) => [ch, state(ch)]));
  }

  private sec(n: number): number {
    return Math.round(n * ASR_RATE);
  }

  /**
   * A new call: clusters restored from its log. What the previous call still had open is closed
   * and emitted first, so a call started while the last one is stopping (TRAPS T0.9) never costs
   * the last one its final words.
   */
  async beginCall(
    state: Parameters<LiveSpeakers["restore"]>[0] & { ids?: string[] },
  ): Promise<void> {
    let open = false;
    for (const st of this.chans.values()) {
      if (st.part === null) continue;
      open = true;
      this.flushPending(st);
      this.closeOpen(st);
    }
    if (this.stream || this.pending.length > 0) await this.settleStream();
    if (open) for (const c of this.speakers.centroids(this.now(), true)) this.emit(c);
    this.speakers = new LiveSpeakers();
    this.speakers.restore(state);
    for (const id of state.ids ?? []) this.speakers.noteId(id);
    for (const st of this.chans.values()) this.resetChannel(st, null, 0);
    // The new call's stream starts afresh: its speakers take the call's labels by centroid, or
    // the numbers after every label the call already has (a Worker that took over a call mid-way
    // has lost the old stream's speaker state).
    this.labelsUsed = highestLabel([...(state.ids ?? []), ...state.centroids.map((c) => c.spk)]);
    this.streamStarts = 0;
    const s = this.stream;
    if (s && !s.dead) {
      s.d.reset();
      this.stream = { ...s, speakers: new StreamSpeakers(), labels: new Map(), pos: 0, runs: [] };
    } else {
      s?.d.close();
      this.stream = null;
    }
  }

  /** The call's decode list. Takes effect for the next stream; loads the recognizer now. */
  setDecodeList(list: DecodeList | null, version: number): void {
    this.list = list;
    this.listVersion = version;
    this.prepared = null;
    this.hot();
  }

  unmerge(from: string, into: string): void {
    this.speakers.unmerge(from, into);
  }

  private hot(): PreparedHotwords {
    if (this.prepared) return this.prepared;
    const p = this.models.prepare(this.list);
    this.prepared = p;
    for (const d of p.dropped) {
      this.emit({ type: "log", level: "error", msg: `hotword "${d.term}" dropped: ${d.reason}` });
    }
    this.emit({
      type: "vocab",
      version: this.listVersion,
      model: p.recognizer.model,
      entries: p.entries,
      dropped: p.dropped,
      warnings: p.warnings,
    });
    return p;
  }

  private resetChannel(st: ChannelState, part: number | null, pos: number): void {
    st.part = part;
    st.vad.reset();
    st.pos = pos;
    st.pending = new Float32Array(0);
    st.pendingStart = pos;
    st.audio.reset(pos);
    st.inSpeech = false;
    st.pseq = 0;
  }

  /** Audio for one channel at `start` (samples on the part's file timeline). */
  audio(part: number, ch: Channel, start: number, samples: Float32Array, live = true): void {
    const st = this.chans.get(ch);
    if (!st) {
      this.emit({ type: "log", level: "error", msg: "live: audio for an unknown channel ignored" });
      return;
    }
    this.live = live;
    if (st.part !== part) {
      if (st.part !== null) this.closeOpen(st);
      this.resetChannel(st, part, start);
    }
    if (start > st.pos) {
      // Audio the host could not keep (its queue was full): close what is open and continue.
      this.closeOpen(st);
      this.emit({
        type: "log",
        level: "warn",
        msg: `live ${ch}: ${((start - st.pos) / ASR_RATE).toFixed(1)} s skipped (a pause, or the recognizer queue was full); the final pass covers it`,
      });
      this.resetChannel(st, part, start);
    } else if (start < st.pos) {
      const overlap = st.pos - start;
      if (overlap >= samples.length) return;
      samples = samples.subarray(overlap);
    }
    st.audio.push(samples);
    if (ch === "call") this.toStream(part, st.pos, samples);
    st.pos += samples.length;

    const w = st.vad.windowSize;
    let buf = samples;
    if (st.pending.length > 0) {
      const joined = new Float32Array(st.pending.length + samples.length);
      joined.set(st.pending, 0);
      joined.set(samples, st.pending.length);
      buf = joined;
    }
    let off = 0;
    let at = st.pendingStart;
    while (buf.length - off >= w) {
      const speech = st.vad.accept(buf.subarray(off, off + w));
      this.window(st, at, at + w, speech);
      off += w;
      at += w;
    }
    st.pending = buf.slice(off);
    st.pendingStart = at;
    this.emit({ type: "progress", part, ch, pos: st.pos });
  }

  private window(st: ChannelState, ws: number, we: number, speech: boolean): void {
    const o = this.o;
    if (speech) {
      if (!st.inSpeech) {
        st.inSpeech = true;
        st.segStart = Math.max(st.audio.start, ws - this.sec(o.preRoll));
        st.lastProvisional = we;
      }
      st.lastSpeech = we;
    }
    if (st.inSpeech) {
      if (!speech && we - st.lastSpeech >= this.sec(o.segmentPause)) {
        this.close(st, st.segStart, Math.min(we, st.lastSpeech + this.sec(o.postRoll)));
        st.inSpeech = false;
      } else if (we - st.segStart >= this.sec(o.segmentWindow)) {
        this.close(st, st.segStart, we);
        st.segStart = we;
        st.lastProvisional = we;
      } else if (this.live && we - st.lastProvisional >= this.sec(o.provisionalEvery)) {
        st.lastProvisional = we;
        this.provisional(st, st.segStart, we);
      }
    }
    // Keep only the open segment, or the pre-roll while nothing is open.
    st.audio.trimTo(st.inSpeech ? st.segStart : we - this.sec(o.preRoll));
  }

  /** Closes an open segment at the newest audio (part end, flush, skipped audio). */
  private closeOpen(st: ChannelState): void {
    if (!st.inSpeech) return;
    this.close(st, st.segStart, Math.min(st.pos, st.lastSpeech + this.sec(this.o.postRoll)));
    st.inSpeech = false;
  }

  private decode(samples: Float32Array): { text: string; lang?: string; model: string } {
    const h = this.hot();
    const r = h.recognizer.decode(prepareSpan(samples), streamHotwords(h));
    return { text: r.text.trim(), lang: r.lang, model: h.recognizer.model };
  }

  private provisional(st: ChannelState, from: number, to: number): void {
    if (st.part === null) return;
    const r = this.decode(st.audio.slice(from, to));
    if (r.text === "") return;
    st.pseq++;
    this.emit({
      type: "provisional",
      part: st.part,
      ch: st.ch,
      pseq: st.pseq,
      a0: from / ASR_RATE,
      text: r.text,
    });
  }

  private close(st: ChannelState, from: number, to: number): void {
    if (st.part === null || to <= from) return;
    const samples = st.audio.slice(from, to);
    const r = this.decode(samples);
    if (r.text === "") return;
    const a0 = from / ASR_RATE;
    const a1 = to / ASR_RATE;
    if (st.ch === "call" && this.labels === "stream") {
      const seg = {
        type: "seg" as const,
        part: st.part,
        ch: st.ch,
        a0,
        a1,
        text: r.text,
        model: r.model,
        ...(r.lang ? { lang: r.lang } : {}),
      };
      const s = this.stream && !this.stream.dead ? this.stream : null;
      const range = s ? streamRange(s, st.part, from, to) : null;
      let emb: Float32Array | null = null;
      if (a1 - a0 >= MIN_EMBED_SECONDS) {
        this.embedder ??= this.models.embedder();
        emb = this.embedder.embed(samples);
      }
      this.pending.push({
        seg,
        stream: range ? s : null,
        s0: range?.[0] ?? 0,
        s1: range?.[1] ?? 0,
        emb,
      });
      this.drain(false);
      return;
    }
    let spk = "you";
    if (st.ch === "call") {
      let emb: Float32Array | null = null;
      if (a1 - a0 >= MIN_EMBED_SECONDS) {
        this.embedder ??= this.models.embedder();
        emb = this.embedder.embed(samples);
      }
      spk = this.speakers.assign(st.part, a0, a1, emb);
    }
    this.emit({
      type: "seg",
      part: st.part,
      ch: st.ch,
      a0,
      a1,
      text: r.text,
      spk,
      model: r.model,
      ...(r.lang ? { lang: r.lang } : {}),
    });
    if (st.ch === "call") {
      for (const m of this.speakers.merges()) this.emit(m);
      for (const c of this.speakers.centroids(this.now())) this.emit(c);
    }
  }

  /**
   * The part ended: close its open segments, write every changed centroid, and label every call
   * segment still waiting. The diarizer's stream is not reset: the next part continues it, so its
   * speakers keep their labels (TRAPS T2.48).
   */
  async endPart(part: number): Promise<void> {
    for (const st of this.chans.values()) {
      if (st.part !== part) continue;
      this.flushPending(st);
      this.closeOpen(st);
      this.resetChannel(st, null, 0);
    }
    if (this.pending.length > 0) await this.settleStream();
    for (const c of this.speakers.centroids(this.now(), true)) this.emit(c);
  }

  /** Closes what is open on every channel (the call is ending) and labels what is waiting. */
  async flush(): Promise<void> {
    for (const st of this.chans.values()) {
      this.flushPending(st);
      this.closeOpen(st);
      this.resetChannel(st, null, 0);
    }
    if (this.pending.length > 0) await this.settleStream();
    for (const c of this.speakers.centroids(this.now(), true)) this.emit(c);
  }

  // --- the stream diarizer ------------------------------------------------------------------

  /** The call channel's stream, started on its first audio; null when there is none. */
  private ensureStream(): StreamState | null {
    if (this.labels === "embeddings") return null;
    if (this.stream && !this.stream.dead) return this.stream;
    if (this.streamStarts >= (this.labels === "unknown" ? 1 : STREAM_RESTART_LIMIT)) return null;
    this.streamStarts++;
    const ref: { d: StreamDiarizer | null } = { d: null };
    const current = () => (this.stream && this.stream.d === ref.d ? this.stream : null);
    let d: StreamDiarizer | null;
    try {
      d = this.models.streamDiarizer({
        turns: (turns, decided) => {
          const s = current();
          if (!s) return;
          s.speakers.add(turns, decided);
          this.drain(false);
        },
        dead: (error) => {
          const s = current();
          if (!s || s.dead) return;
          s.dead = true;
          this.emit({
            type: "log",
            level: "error",
            msg: `live speaker labels: the diarizer stopped (${error}); call lines it had not decided are c?`,
          });
          this.drain(false);
        },
      });
    } catch (err) {
      this.labels = "stream";
      this.emit({
        type: "log",
        level: "error",
        msg: `live speaker labels: the diarizer did not start (${(err as Error).message}); call lines are c?`,
      });
      return null;
    }
    if (!d) {
      this.labels = "embeddings";
      return null;
    }
    ref.d = d;
    this.labels = "stream";
    this.stream?.d.close();
    this.stream = {
      d,
      speakers: new StreamSpeakers(),
      labels: new Map(),
      pos: 0,
      runs: [],
      dead: false,
    };
    return this.stream;
  }

  /** Appends call audio at `pos` of `part` to the stream. */
  private toStream(part: number, pos: number, samples: Float32Array): void {
    if (samples.length === 0) return;
    const s = this.ensureStream();
    if (!s) return;
    const last = s.runs[s.runs.length - 1];
    if (last && last.part === part && last.to === pos) last.to += samples.length;
    else s.runs.push({ part, from: pos, to: pos + samples.length, at: s.pos });
    s.pos += samples.length;
    s.d.push(samples);
  }

  /**
   * Emits waiting call segments, oldest first, as their audio is decided. `force` labels the rest
   * with what is decided, else `c?`. A segment the stream has left `STREAM_WAIT_SECONDS` behind
   * undecided is `c?` too.
   */
  private drain(force: boolean): void {
    while (this.pending.length > 0) {
      const p = this.pending[0] as Pending;
      const k = p.stream ? p.stream.speakers.speakerAt(p.s0, p.s1) : -1;
      let spk: string | null =
        k === null ? null : k < 0 || !p.stream ? "c?" : this.labelFor(p.stream, k, p.emb);
      if (spk === null && p.stream) {
        const stalled = p.stream.pos - p.s1 > STREAM_WAIT_SECONDS * ASR_RATE;
        if (force || p.stream.dead || p.stream !== this.stream || stalled) {
          if (stalled && !force && !p.stream.dead)
            this.emit({
              type: "log",
              level: "warn",
              msg: `live speaker labels: the diarizer is over ${STREAM_WAIT_SECONDS} s behind; a call line is c?`,
            });
          spk = "c?";
        }
      }
      if (spk === null) break;
      this.pending.shift();
      if (p.emb && spk !== "c?") this.speakers.addTo(spk, p.emb);
      this.emit({ ...p.seg, spk });
      for (const c of this.speakers.centroids(this.now())) this.emit(c);
    }
    const s = this.stream;
    const head = this.pending[0];
    if (s && (!head || head.stream === s)) {
      // Keep the turns of the call segment still open too: it is labelled by all of it.
      let keep = head ? head.s0 : s.speakers.decided;
      const call = this.chans.get("call") as ChannelState;
      const open =
        call.inSpeech && call.part !== null
          ? streamRange(s, call.part, call.segStart, call.segStart + 1)
          : null;
      if (open) keep = Math.min(keep, open[0]);
      s.speakers.prune(keep);
    }
  }

  /**
   * The label of speaker `k` of stream `s`: the one it already has, else the nearest centroid this
   * stream has not given out (a speaker the call had before the stream started over), else the
   * next free number. A line too short to embed while such centroids remain is `c?` and binds
   * nothing, so a known voice is never renumbered for want of an embedding.
   */
  private labelFor(s: StreamState, k: number, emb: Float32Array | null): string {
    const known = s.labels.get(k);
    if (known) return known;
    const given = new Set(s.labels.values());
    if (!emb && this.speakers.hasOther(given)) return "c?";
    const label = (emb ? this.speakers.nearest(emb, given) : null) ?? `c${++this.labelsUsed}`;
    this.labelsUsed = Math.max(this.labelsUsed, highestLabel([label]));
    s.labels.set(k, label);
    return label;
  }

  /** Waits (bounded) for the stream's decisions on everything pushed, then labels every waiting line. */
  private async settleStream(): Promise<void> {
    const s = this.stream;
    if (s && !s.dead && this.pending.some((p) => p.stream === s)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          s.d.flush(),
          new Promise<void>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`no answer in ${STREAM_FLUSH_MS} ms`)),
              STREAM_FLUSH_MS,
            );
          }),
        ]);
      } catch (err) {
        this.emit({
          type: "log",
          level: "warn",
          msg: `live speaker labels: the diarizer's last decisions did not come (${(err as Error).message})`,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    this.drain(true);
  }

  /** Stops the stream diarizer (the transcriber is closing). */
  stop(): void {
    this.stream?.d.close();
    this.stream = null;
  }

  /** The tail shorter than one VAD window counts as speech if a segment is open. */
  private flushPending(st: ChannelState): void {
    if (st.pending.length === 0) return;
    if (st.inSpeech) st.lastSpeech = st.pendingStart + st.pending.length;
    st.pending = new Float32Array(0);
  }
}

/** `[from, to)` of `part` on the stream's timeline, or null when that audio never reached it. */
function streamRange(
  s: StreamState,
  part: number,
  from: number,
  to: number,
): [number, number] | null {
  for (let i = s.runs.length - 1; i >= 0; i--) {
    const r = s.runs[i] as StreamState["runs"][number];
    if (r.part !== part || from < r.from || from >= r.to) continue;
    return [r.at + (from - r.from), r.at + (Math.min(to, r.to) - r.from)];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Messages between the host and the Worker

export type ToWorker =
  | { type: "init"; models: ModelSpec; live: Partial<LiveOptions> }
  | {
      type: "call";
      id: string;
      centroids: { spk: string; vec: string }[];
      merges: { from: string; into: string }[];
      unmerged: { from: string; into: string }[];
      ids: string[];
    }
  | { type: "decode-list"; list: DecodeList | null; version: number }
  | {
      type: "audio";
      part: number;
      ch: Channel;
      start: number;
      samples: Float32Array;
      live: boolean;
    }
  | { type: "end-part"; part: number }
  | { type: "unmerge"; from: string; into: string }
  /** Closes the named call's open segments if it is still the Worker's call; always answers. */
  | { type: "flush"; token: number; call: string };

export type FromWorker =
  | { type: "ready"; loads: Record<string, number> }
  | { type: "flushed"; token: number }
  | { type: "failed"; error: string }
  | { type: "loads"; loads: Record<string, number> }
  /** Tagged with the call it belongs to, so a late result never lands in the next call. */
  | (LiveOut & { call: string });

/** The Worker's side, shared by the real Worker and the in-thread transport used in tests. */
export class WorkerSide {
  private pipeline: LivePipeline | null = null;
  private models: ModelSet | null = null;
  private queue: Promise<void> = Promise.resolve();
  private callId = "";

  constructor(private readonly reply: (m: FromWorker) => void) {}

  private out(o: LiveOut): void {
    this.reply({ ...o, call: this.callId });
  }

  /** Stops what the pipeline started (the in-thread transport's close; a Worker just ends). */
  close(): void {
    this.pipeline?.stop();
  }

  /** Messages are handled one at a time, in order. */
  handle(m: ToWorker): void {
    this.queue = this.queue.then(() => this.run(m));
  }

  private async run(m: ToWorker): Promise<void> {
    try {
      if (m.type === "init") {
        this.models = await loadModelSet(m.models);
        this.pipeline = new LivePipeline(this.models, m.live, (o) => this.out(o));
        this.reply({ type: "ready", loads: { ...this.models.loads } });
        return;
      }
      const p = this.pipeline;
      if (!p) throw new Error(`${m.type} before init`);
      switch (m.type) {
        case "call":
          // The previous call's closing lines are tagged with its own id.
          await p.beginCall(m);
          this.callId = m.id;
          break;
        case "decode-list":
          p.setDecodeList(m.list, m.version);
          break;
        case "audio":
          p.audio(m.part, m.ch, m.start, m.samples, m.live);
          break;
        case "end-part":
          await p.endPart(m.part);
          break;
        case "unmerge":
          p.unmerge(m.from, m.into);
          break;
        case "flush":
          if (m.call === this.callId) await p.flush();
          this.reply({ type: "loads", loads: { ...(this.models?.loads ?? {}) } });
          this.reply({ type: "flushed", token: m.token });
          break;
      }
    } catch (err) {
      this.out({ type: "log", level: "error", msg: `live ASR: ${(err as Error).message}` });
      if (m.type === "init") this.reply({ type: "failed", error: (err as Error).message });
      if (m.type === "flush") this.reply({ type: "flushed", token: m.token });
    }
  }
}

export const LIVE_WORKER_NAME = "akou-live-asr";

// The Worker entry: runs only inside the Worker the host starts (marked by `workerData`), so
// importing this module from the main thread or from another Worker never installs it.
declare const self: Worker;
if (!Bun.isMainThread && workerData === LIVE_WORKER_NAME) {
  const post = (m: FromWorker) => self.postMessage(m);
  // Nothing in the Worker prints: every line goes to the app log (TRAPS T1.45).
  const toLog =
    (level: "info" | "warn" | "error") =>
    (...args: unknown[]) =>
      post({ type: "log", level, msg: args.map(String).join(" "), call: "" });
  console.log = toLog("info");
  console.info = toLog("info");
  console.warn = toLog("warn");
  console.error = toLog("error");
  const side = new WorkerSide(post);
  self.onmessage = (e: MessageEvent<ToWorker>) => side.handle(e.data);
}

// ---------------------------------------------------------------------------
// The host, on the main thread

/** What the host needs of a call: its view and its one writer. `CallController` provides both. */
export interface CallAccess {
  readonly id: string;
  readonly view: CallView;
  record(draft: EventDraft): LogEvent | null;
}

export interface VocabSource {
  /** The merged vocabulary files of the call's workspace. */
  entries: readonly MergedEntry[];
  files: readonly { path: string; sha256: string }[];
}

export interface LiveAsrOptions {
  models: ModelSpec;
  live?: Partial<LiveOptions>;
  /** The vocabulary files for a call, read when the call starts. */
  vocab?(callId: string): VocabSource;
  /** Backlog levels that write `asr.lag`, seconds. */
  lagLevels?: readonly number[];
  /** Audio in flight to the Worker per channel, seconds; the rest waits in the ingest queue. */
  inflightSeconds?: number;
  clock?: Clock;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
  /** Runs the pipeline on this thread. Tests only: the app always uses the Worker. */
  inThread?: boolean;
}

interface Transport {
  post(m: ToWorker, transfer?: ArrayBuffer[]): void;
  close(): void;
}

interface HostCall {
  id: string;
  access: CallAccess;
  nextLive: number;
  version: number;
  listKey: string;
  parts: Map<
    number,
    {
      ingest: PartIngest;
      posted: Record<Channel, number>;
      acked: Record<Channel, number>;
      ended: boolean;
    }
  >;
  lagLevel: number;
  /** A newer call took the recognizer; this one's late audio is left to the final pass. */
  superseded: boolean;
}

/** A Worker that dies is replaced at most this many times in `RESPAWN_WINDOW_MS`. */
const RESPAWN_LIMIT = 3;
const RESPAWN_WINDOW_MS = 10 * 60_000;

export class LiveAsr {
  readonly ready: Promise<{ loads: Record<string, number> }>;
  /** Model loads the Worker reported, by model. */
  loads: Record<string, number> = {};
  private transport: Transport;
  private readonly clock: Clock;
  private readonly inflight: number;
  private readonly lagLevels: readonly number[];
  /** Calls the host writes results for, until their `call.ended`. */
  private readonly calls = new Map<string, HostCall>();
  /** The call the Worker is transcribing. The Worker transcribes one call at a time. */
  private current: HostCall | null = null;
  private readonly flushes = new Map<number, () => void>();
  private flushToken = 0;
  private failed: string | null = null;
  private closed = false;
  private readonly respawns: number[] = [];
  private resolveReady!: (v: { loads: Record<string, number> }) => void;
  private rejectReady!: (e: Error) => void;

  constructor(
    private readonly o: LiveAsrOptions,
    private readonly access: (callId: string) => CallAccess | undefined,
  ) {
    this.clock = o.clock ?? realClock;
    this.inflight = Math.round((o.inflightSeconds ?? 4) * ASR_RATE);
    this.lagLevels = o.lagLevels ?? [10, 30];
    this.ready = new Promise((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.ready.catch(() => {});
    this.transport = this.spawn();
  }

  /** Starts a Worker (or the in-thread side) and sends it `init`. */
  private spawn(): Transport {
    const onMessage = (m: FromWorker) => this.onWorker(m);
    let t: Transport;
    if (this.o.inThread) {
      const side = new WorkerSide((m) => queueMicrotask(() => onMessage(m)));
      t = { post: (m) => side.handle(m), close: () => side.close() };
    } else {
      const w = new Worker(siblingModule(import.meta.url, "live-worker"), {
        workerData: LIVE_WORKER_NAME,
      } as WorkerOptions);
      let dead = false;
      const died = (error: string) => {
        if (dead) return;
        dead = true;
        this.crashed(t, error);
      };
      w.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
      w.onerror = (e) => died(e.message);
      t = {
        // A dead Worker must never throw into the call's packet or event path.
        post: (m, tr) => {
          if (dead) return;
          try {
            w.postMessage(m, tr ?? []);
          } catch (err) {
            died((err as Error).message);
          }
        },
        close: () => {
          dead = true;
          w.terminate();
        },
      };
    }
    t.post({ type: "init", models: this.o.models, live: this.o.live ?? {} });
    return t;
  }

  /**
   * The Worker died (an uncaught error, a native crash). Audio it held is lost to the live layer
   * (the final pass covers it); a new Worker takes over the current call from its log, so this
   * call and every later one keep a live transcript. Too many deaths in a row give up for the run.
   */
  private crashed(t: Transport, error: string): void {
    if (t !== this.transport || this.closed || this.failed) return;
    for (const done of this.flushes.values()) done();
    this.flushes.clear();
    const now = this.clock.now();
    while (this.respawns.length > 0 && now - (this.respawns[0] as number) > RESPAWN_WINDOW_MS)
      this.respawns.shift();
    if (this.respawns.length >= RESPAWN_LIMIT) {
      this.log("error", `live ASR worker died again (${error}); no live transcript for this run`);
      this.fail(error);
      return;
    }
    this.respawns.push(now);
    this.log("error", `live ASR worker died (${error}); starting a new one`);
    // Replace it after the current call stack: the death may be noticed inside a post.
    queueMicrotask(() => {
      if (this.closed || this.failed || t !== this.transport) return;
      this.transport = this.spawn();
      const c = this.current;
      if (!c) return;
      for (const pr of c.parts.values()) pr.acked = { ...pr.posted };
      this.beginCall(c);
      for (const [part, pr] of c.parts) {
        if (pr.ended) this.transport.post({ type: "end-part", part });
        else this.pump(c, part, false);
      }
    });
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.o.onLog?.(level, msg);
  }

  private fail(error: string): void {
    this.failed = error;
    this.rejectReady(new Error(error));
    for (const done of this.flushes.values()) done();
    this.flushes.clear();
  }

  // --- from the call ------------------------------------------------------------------------

  /** `CallManagerOptions.onPacket`. */
  onPacket(callId: string, part: number, _p: Packet, ingest: PartIngest): void {
    const c = this.ensureCall(callId);
    if (!c) return;
    let pr = c.parts.get(part);
    if (!pr) {
      pr = { ingest, posted: { mic: 0, call: 0 }, acked: { mic: 0, call: 0 }, ended: false };
      c.parts.set(part, pr);
    }
    this.pump(c, part, false);
  }

  /** `CallManagerOptions.onEvent`. */
  onEvent(callId: string, e: LogEvent): void {
    const c = this.calls.get(callId);
    if (!c) return;
    const isCurrent = c === this.current;
    switch (e.type) {
      case "part.ended": {
        const pr = c.parts.get(e.part);
        if (pr && !pr.ended) {
          pr.ended = true;
          if (isCurrent) {
            this.pump(c, e.part, true);
            this.transport.post({ type: "end-part", part: e.part });
          }
        }
        break;
      }
      case "vocab.add":
      case "speaker.name":
        if (isCurrent) this.sendDecodeList(c);
        break;
      case "speaker.unmerge":
        if (isCurrent) this.transport.post({ type: "unmerge", from: e.from, into: e.into });
        break;
      case "call.ended":
        // Its open lines were flushed before this event; anything later is dropped.
        this.calls.delete(callId);
        if (isCurrent) this.current = null;
        break;
      default:
        break;
    }
  }

  /** `CallManagerOptions.beforeEnd`: closes what is open and waits for the segments. */
  flush(callId: string): Promise<void> {
    const c = this.calls.get(callId);
    if (!c || this.failed) return Promise.resolve();
    // A call that is no longer the Worker's was closed when the next call began; the answer
    // still waits for every line the Worker sent before it.
    if (c === this.current) for (const part of c.parts.keys()) this.pump(c, part, true);
    const token = ++this.flushToken;
    return new Promise<void>((resolve) => {
      this.flushes.set(token, resolve);
      this.transport.post({ type: "flush", token, call: callId });
    });
  }

  /** Stops the Worker. */
  async close(): Promise<void> {
    this.closed = true;
    this.transport.close();
    for (const done of this.flushes.values()) done();
    this.flushes.clear();
  }

  // --- internals ----------------------------------------------------------------------------

  private ensureCall(callId: string): HostCall | null {
    const known = this.calls.get(callId);
    if (known === this.current && known) return known;
    if (known?.superseded) return null;
    const access = this.access(callId);
    if (!access) return null;
    const view = access.view;
    const ids = view.lines("live", { includeEcho: true, includeRetracted: true }).map((l) => l.id);
    let nextLive = 1;
    for (const id of ids) {
      const n = Number(/^l(\d+)$/.exec(id)?.[1] ?? 0);
      if (n >= nextLive) nextLive = n + 1;
    }
    // Hand the recognizer over: everything the previous call queued goes to the Worker first,
    // and the Worker closes that call's open lines before it starts this one.
    const prev = this.current;
    if (prev) {
      for (const part of prev.parts.keys()) this.pump(prev, part, true);
      prev.superseded = true;
    }
    const c: HostCall = {
      id: callId,
      access,
      nextLive,
      version: 0,
      listKey: "",
      parts: new Map(),
      lagLevel: 0,
      superseded: false,
    };
    this.calls.set(callId, c);
    this.current = c;
    this.beginCall(c);
    return c;
  }

  /** Tells the Worker which call it transcribes, with the call's speakers and decode list. */
  private beginCall(c: HostCall): void {
    const view = c.access.view;
    const spks = view
      .lines("live", { includeEcho: true, includeRetracted: true })
      .map((l) => l.spkRaw);
    this.transport.post({ type: "call", id: c.id, ...view.speakerState(), ids: spks });
    c.listKey = "";
    this.sendDecodeList(c);
  }

  private decodeList(c: HostCall): DecodeList {
    return callDecodeList(c.access.view, modelNameFor(this.o.models), this.o.vocab?.(c.id));
  }

  private sendDecodeList(c: HostCall): void {
    const list = this.decodeList(c);
    const key = JSON.stringify(list.entries);
    if (key === c.listKey) return;
    c.listKey = key;
    c.version++;
    for (const w of list.warnings) this.log("warn", w);
    this.transport.post({ type: "decode-list", list, version: c.version });
  }

  /** Moves audio from the ingest queues to the Worker, keeping at most `inflight` per channel. */
  private pump(c: HostCall, part: number, all: boolean): void {
    const pr = c.parts.get(part);
    // Audio messages carry no call id: only the Worker's own call may send any.
    if (!pr || this.failed || c !== this.current) return;
    for (const ch of CHANNELS) {
      const q = pr.ingest.queues[ch];
      for (;;) {
        const room = all
          ? Number.POSITIVE_INFINITY
          : this.inflight - (pr.posted[ch] - pr.acked[ch]);
        if (room <= 0 || q.size === 0) break;
        const chunks = q.take(Math.min(room, 10 * ASR_RATE));
        if (chunks.length === 0) break;
        const behind = (pr.ingest.pos[ch] - pr.acked[ch]) / ASR_RATE;
        for (const k of chunks) {
          const samples = k.samples.slice();
          pr.posted[ch] = k.start + samples.length;
          this.transport.post(
            { type: "audio", part, ch, start: k.start, samples, live: behind < 2 },
            [samples.buffer],
          );
        }
      }
    }
    this.checkLag(c, part);
  }

  private checkLag(c: HostCall, part: number): void {
    const pr = c.parts.get(part);
    if (!pr || pr.ended) return;
    let behind = 0;
    for (const ch of CHANNELS)
      behind = Math.max(behind, (pr.ingest.pos[ch] - pr.acked[ch]) / ASR_RATE);
    let level = 0;
    for (const l of this.lagLevels) if (behind > l) level = l;
    if (level === c.lagLevel) return;
    c.lagLevel = level;
    c.access.record({ type: "asr.lag", part, seconds: Math.round(behind * 10) / 10 });
  }

  private onWorker(m: FromWorker): void {
    // Results belong to the call they are tagged with; one whose call has ended is dropped.
    const c = "call" in m ? this.calls.get(m.call) : undefined;
    switch (m.type) {
      case "ready":
        this.loads = m.loads;
        this.resolveReady({ loads: m.loads });
        return;
      case "loads":
        this.loads = m.loads;
        return;
      case "failed":
        this.fail(m.error);
        return;
      case "flushed": {
        const done = this.flushes.get(m.token);
        this.flushes.delete(m.token);
        done?.();
        return;
      }
      case "log":
        this.log(m.level, m.msg);
        return;
      case "progress": {
        const pr = c?.parts.get(m.part);
        if (!c || !pr) return;
        pr.acked[m.ch] = Math.max(pr.acked[m.ch], m.pos);
        this.pump(c, m.part, pr.ended);
        return;
      }
      case "vocab": {
        if (!c || m.version !== c.version) return;
        // `vocab.used` lists what decoding really uses: the words that passed the tokenization
        // check, not the list the host asked for.
        const files = this.o.vocab?.(c.id).files ?? [];
        c.access.record({
          type: "vocab.used",
          entries: m.entries,
          files: files.map((f) => f.path),
          sha256: files.map((f) => f.sha256),
          model: m.model,
        });
        return;
      }
      case "seg":
        if (c) this.writeSeg(c, m);
        else {
          this.log(
            "warn",
            `live segment at ${m.a0.toFixed(1)} s dropped: its call has ended or is unknown`,
          );
        }
        return;
      case "provisional": {
        const clock = c?.access.view.part(m.part)?.clock;
        if (!c || !clock) return;
        c.access.view.provisional.update({
          ch: m.ch,
          part: m.part,
          pseq: m.pseq,
          text: m.text,
          w0: Math.round(clock.wallFromAudio(m.a0)),
          at: this.clock.now(),
        });
        return;
      }
      case "centroid":
        c?.access.record({ type: "speaker.centroid", spk: m.spk, vec: m.vec });
        return;
      case "merge":
        c?.access.record({ type: "speaker.merge", from: m.from, into: m.into });
        return;
    }
  }

  private writeSeg(c: HostCall, m: Extract<LiveOut, { type: "seg" }>): void {
    const clock = c.access.view.part(m.part)?.clock;
    if (!clock) {
      this.log("warn", `live segment for unknown part ${m.part} dropped`);
      return;
    }
    const w0 = Math.round(clock.wallFromAudio(m.a0));
    const w1 = Math.round(clock.wallFromAudio(m.a1));
    const id = `l${String(c.nextLive).padStart(6, "0")}`;
    const e = c.access.record({
      type: "seg",
      id,
      rev: 1,
      layer: "live",
      part: m.part,
      ch: m.ch,
      spk: m.spk,
      a0: round3(m.a0),
      a1: round3(m.a1),
      w0,
      w1,
      text: m.text,
      model: m.model,
      ...(m.lang ? { lang: m.lang } : {}),
    });
    if (!e) {
      this.log("warn", `live segment at ${m.a0.toFixed(1)} s dropped: the call's log is closed`);
      return;
    }
    c.nextLive++;
    c.access.view.provisional.commit(m.ch, w1);
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * The per-stream hotwords for a decode, or none. Whatever the model set prepared, a model that is
 * not a transducer never receives a list: sherpa-onnx exits the process on that call, and the
 * recording would die with it (TRAPS "Hotwords to a non-transducer model kill the process").
 */
export function streamHotwords(h: PreparedHotwords): string | undefined {
  if (h.recognizer.kind !== "transducer" || !h.arg) return undefined;
  return h.arg;
}

/**
 * A call's decode list as it stands: call-scoped adds, attendees and speaker names, then the
 * vocabulary files (decode-list.ts has the priority order and the cap).
 */
export function callDecodeList(view: CallView, model: string, vocab?: VocabSource): DecodeList {
  const names = view
    .roster()
    .map((r) => r.name)
    .filter((n): n is string => !!n);
  return buildDecodeList({
    model,
    callVocab: view.callVocabulary(),
    captureStartSeq: view.parts()[0]?.startSeq,
    names: [...new Set(names)],
    files: vocab?.entries ?? [],
  });
}

/** The recognizer's registry name for a model spec, known before any model loads. */
export function modelNameFor(spec: ModelSpec): string {
  return spec.kind === "sherpa" ? RECOGNIZER : spec.model;
}

/** Waits for the Worker to be ready, at most `ms`. */
export async function whenReady(asr: LiveAsr, clock: Clock, ms: number): Promise<boolean> {
  const r = await withDeadline(clock, asr.ready, ms);
  return r.ok;
}
