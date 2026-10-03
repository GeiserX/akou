/**
 * The live transcript (docs/DESIGN.md sections 1.1, 1.5, 3.1 and 3.2): one `live-asr` Worker that
 * turns each channel's 16 kHz audio into segments, provisional lines and speaker labels, and the
 * host on the main thread that feeds it and writes what it finds to the log.
 *
 * A call runs one of two recognition paths, chosen when it starts (`asr.live.engine`,
 * live-engines.ts). With a streaming engine (Nemotron), each channel is one stream for the whole
 * call behind a causal gain, and lines are cut from its tokens (live-stream.ts): a word once shown
 * is never taken back, and the provisional line is the open line's words so far. Without one (its
 * model not downloaded), steps 1 to 4 below re-decode VAD windows with the offline recognizer.
 * Speakers (step 5) are the same on both.
 *
 * The second pass (`asr.review.model`, live-setups.ts, ASR-7) rewrites each streaming line once
 * during the call, as a new revision of the same `seg` (upgrade.ts): once the speaker stops, the
 * Worker hands the utterance's audio to the host, and every `asr.review.everySeconds` the host
 * sends the utterances closed since then to the reviewer (Qwen in one request; Parakeet, back on
 * this Worker's recognizer, each utterance alone) and cuts its words back into their lines. A word
 * shown is never taken back while its line is open; the review replaces whole closed lines. A
 * review still waiting when the next one is due is skipped, and a reviewer that falls behind two
 * reviews in a row is off for the rest of the call. A line a person
 * edited or retracted keeps their text, a line that gets no words keeps its own, and nothing is
 * written after the call's `call.ended`: an answer that comes later is dropped, and the final pass
 * covers it.
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
  type Hypothesis,
  type LiveEngine,
  type LiveStream,
  type LiveToken,
  loadModelSet,
  type ModelSet,
  type ModelSpec,
  type PreparedHotwords,
  type StreamDiarizer,
  type Vad,
  type WordHyp,
} from "./engine.ts";
import { DEFAULT_FINAL, timelinePieces } from "./finalize-worker.ts";
import { isLiveEngine, LIVE_ENGINES, type LiveChoice, streamLanguage } from "./live-engines.ts";
import { CausalGain, StreamChannel, type StreamLine } from "./live-stream.ts";
import { RECOGNIZER } from "./models.ts";
import { gainFor, prepareSpan } from "./pad.ts";
import { siblingModule } from "./sibling.ts";
import {
  highestLabel,
  LiveSpeakers,
  MIN_EMBED_SECONDS,
  type SpeakerEvent,
  StreamSpeakers,
} from "./speakers.ts";
import {
  joinUtterances,
  reviewBatches,
  reviewCap,
  splitToLines,
  UTTERANCE_MAX_SECONDS,
} from "./upgrade.ts";

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
      /** The line's key within the Worker, for the upgrade's revisions of it. */
      key?: number;
    }
  | UpgradeOut
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

/** An utterance of written streaming lines that closed, for the second pass to rewrite. */
export interface UpgradeOut {
  type: "upgrade";
  /** The `key` of each of its lines' `seg`, in order. */
  keys: number[];
  /** Each line's streaming text, which Qwen's words are cut back into. */
  lines: string[];
  /** The utterance's audio, gained and padded: what the reviewer decodes. */
  samples: Float32Array;
}

/**
 * A dictation's buffer decoded whole on the loaded recognizer (docs/ux/DICTATION.md DC-E1). Word
 * times are seconds into the buffer; `c` is the word's confidence, 0 to 1.
 */
export interface Decoded {
  text: string;
  words: { w: string; s: number; e: number; c: number }[];
  language: string | null;
  /** The recognizer's registry name. */
  model: string;
  /** Decode time over every span, milliseconds. */
  ms: number;
  /** How many spans of at most `DICTATION_SPAN_SECONDS` the buffer was cut into. */
  spans: number;
  /** A review's slowest single decode, milliseconds: how long it held the live lines at once. */
  slowest?: number;
}

/**
 * The longest span a dictation decode sends to the recognizer: the final pass's `maxSpanSeconds`
 * (a literal, since finalize-worker.ts imports this module; a test holds the two equal), so a
 * 20-minute latched session never holds the Worker for one long decode, and a live call waits at
 * most one span for its next segment.
 */
export const DICTATION_SPAN_SECONDS = 30;

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
  /** The streaming engine's stream, when the call runs one (live-stream.ts); else VAD windows. */
  live: StreamChannel | null;
  /** The second pass's open utterance: its written lines so far and their audio's span. */
  utt: { part: number; from: number; to: number; keys: number[]; lines: string[] } | null;
  /** The open line's text as last published, so an unchanged line is not published again. */
  shown: string;
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
  private dictationVad: Vad | null = null;
  /** Dictations streaming their words (DC-E5 live words), by the host's token. */
  private readonly dictations = new Map<number, { stream: LiveStream; gain: CausalGain }>();
  /** The call's streaming engine, or null for VAD windows re-decoded by the recognizer. */
  private engine: LiveEngine | null = null;
  /** The call has a second pass: each closed utterance goes to the host for review. */
  private upgrade = false;
  /** The last line key given out; keys never repeat within a Worker. */
  private lineKey = 0;
  /** Upgrades whose last line still waits for its speaker label, sent right after that `seg`. */
  private readonly heldUpgrades = new Map<number, UpgradeOut>();

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
      live: null,
      utt: null,
      shown: "",
    });
    this.chans = new Map(CHANNELS.map((ch) => [ch, state(ch)]));
  }

  private sec(n: number): number {
    return Math.round(n * ASR_RATE);
  }

  get recognizerModel(): string {
    return this.models.recognizerModel;
  }

  /**
   * A new call: clusters restored from its log. What the previous call still had open is closed
   * and emitted first, so a call started while the last one is stopping (TRAPS T0.9) never costs
   * the last one its final words.
   */
  async beginCall(
    state: Parameters<LiveSpeakers["restore"]>[0] & {
      ids?: string[];
      live?: LiveChoice;
      upgrade?: boolean;
    },
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
    this.startEngine(state.live);
    this.upgrade = this.engine !== null && state.upgrade === true;
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

  /**
   * The new call's live engine: a stream per channel for the whole call, or none (VAD windows
   * re-decoded by the recognizer). An engine that does not load leaves the call on the recognizer.
   */
  private startEngine(choice: LiveChoice | undefined): void {
    let closed = false;
    for (const st of this.chans.values()) {
      closed ||= st.live !== null;
      st.live?.close();
      st.live = null;
    }
    // A stream's native state (the encoder's caches) is freed only when it is collected, and the
    // JavaScript heap is too small to ask for that on its own: collect the last call's now.
    if (closed) Bun.gc(true);
    this.engine = null;
    if (!choice) return;
    try {
      if (!this.models.liveEngine) throw new Error("this model set has no streaming engine");
      this.engine = this.models.liveEngine(choice.engine);
    } catch (err) {
      this.emit({
        type: "log",
        level: "error",
        msg: `live: ${choice.engine} did not load (${(err as Error).message}); this call's live lines come from ${this.models.recognizerModel}`,
      });
      return;
    }
    const engine = this.engine;
    for (const st of this.chans.values()) {
      st.live = new StreamChannel(engine.open(choice.lang), {
        pause: this.o.segmentPause,
        window: this.o.segmentWindow,
        tierMs: engine.tierMs,
      });
    }
  }

  /**
   * The call's decode list. Takes effect for the next stream; loads the recognizer now, when its
   * files are here: a machine that never downloaded Parakeet (no chosen setup uses it) loads it only
   * if a decode ever asks for it.
   */
  setDecodeList(list: DecodeList | null, version: number): void {
    this.list = list;
    this.listVersion = version;
    this.prepared = null;
    if (this.models.recognizerHere?.() !== false) this.hot();
  }

  unmerge(from: string, into: string): void {
    this.speakers.unmerge(from, into);
  }

  /**
   * A dictation buffer cut at pauses into spans of at most `DICTATION_SPAN_SECONDS`, with the final
   * pass's rule (`timelinePieces`), judged by a VAD of its own so a call's channels keep theirs.
   * The cut is judged on a copy gained as each span is decoded (`gainFor`, +20 dB at most): on the
   * raw signal of a quiet microphone the rule's -50 dBFS trim takes the ends of words, and a clip
   * whose peak is under it gives no span at all. The spans index the buffer as it was.
   */
  dictationSpans(samples: Float32Array): { from: number; to: number }[] {
    const g = gainFor(samples);
    const gained = g === 1 ? samples : samples.map((v) => v * g);
    const { speech, window } = this.dictationSpeech(gained);
    return timelinePieces(gained, speech, window, {
      ...DEFAULT_FINAL,
      maxSpanSeconds: DICTATION_SPAN_SECONDS,
    });
  }

  /**
   * The dictation VAD's verdict on each window of a buffer, by a VAD of its own so a call's
   * channels keep theirs. No window of speech is DC-E6's silence guard: nothing is decoded.
   */
  dictationSpeech(samples: Float32Array): { speech: boolean[]; window: number } {
    this.dictationVad ??= this.models.vad();
    const vad = this.dictationVad;
    const w = vad.windowSize;
    const speech: boolean[] = [];
    const pad = new Float32Array(w);
    for (let at = 0; at < samples.length; at += w) {
      let win = samples.subarray(at, at + w);
      if (win.length < w) {
        pad.fill(0);
        pad.set(win);
        win = pad;
      }
      speech.push(vad.accept(win));
    }
    vad.reset();
    return { speech, window: w };
  }

  /**
   * One span of a dictation on the loaded recognizer, with no hotwords: a call's decode list never
   * biases a dictation, and passing none never reloads the model.
   */
  decodeDictationSpan(
    samples: Float32Array,
    span: { from: number; to: number },
  ): { text: string; lang?: string; words: Decoded["words"]; model: string; ms: number } {
    const rec = this.hot().recognizer;
    const t = performance.now();
    const r = rec.decode(prepareSpan(samples.subarray(span.from, span.to)));
    const ms = performance.now() - t;
    const off = span.from / ASR_RATE;
    const words = (r.words ?? []).map((x: WordHyp) => ({
      w: x.w,
      s: round3(off + (x.t0 ?? 0)),
      e: round3(off + (x.t1 ?? x.t0 ?? 0)),
      c: round3(x.conf ?? 0),
    }));
    return { text: r.text.trim(), lang: r.lang, words, model: rec.model, ms };
  }

  /**
   * One utterance of the second pass, whole, on the loaded recognizer, with the call's decode list
   * as its hotwords where the decoding takes them (`streamHotwords`: beam, not the default greedy).
   * The utterance comes already gained and padded (`upgradeUtterance`), so it is decoded as it is:
   * a second `prepareSpan` would gain a quiet one twice. Only its text: the words go back into lines
   * by text.
   */
  decodeUtterance(samples: Float32Array): { text: string; model: string; ms: number } {
    const h = this.hot();
    const t = performance.now();
    const r = h.recognizer.decode(samples, streamHotwords(h));
    return { text: r.text.trim(), model: h.recognizer.model, ms: performance.now() - t };
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
    st.shown = "";
    st.utt = null;
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
    if (st.live) {
      this.streamAudio(st, st.live, part, samples);
      this.emit({ type: "progress", part, ch, pos: st.pos });
      return;
    }
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
    if (st.live) {
      this.lines(st, st.live.flush());
      return;
    }
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
    this.emitLine(st, st.part, from, to, samples, r);
  }

  // --- the streaming engine -----------------------------------------------------------------

  /** Audio for a channel whose call runs a streaming engine: lines as the engine closes them. */
  private streamAudio(
    st: ChannelState,
    sc: StreamChannel,
    part: number,
    samples: Float32Array,
  ): void {
    const at = st.pos;
    st.pos += samples.length;
    this.lines(st, sc.push(part, at, samples));
    const open = sc.open();
    st.inSpeech = open !== null;
    if (open) {
      st.segStart = open.from;
      if (this.live && open.text !== st.shown) {
        st.shown = open.text;
        st.pseq++;
        this.emit({
          type: "provisional",
          part: open.part,
          ch: st.ch,
          pseq: st.pseq,
          a0: open.from / ASR_RATE,
          text: open.text,
        });
      }
    }
    const keep = sc.keepFrom(part);
    // An open utterance keeps its audio for the upgrade.
    if (keep !== null) st.audio.trimTo(st.utt ? Math.min(keep, st.utt.from) : keep);
  }

  /** Writes the lines the stream closed; on the `upgrade` setup they gather into utterances. */
  private lines(st: ChannelState, lines: readonly StreamLine[]): void {
    const model = this.engine?.id ?? this.models.recognizerModel;
    for (const l of lines) {
      st.shown = "";
      if (l.to > l.from) {
        const samples = st.audio.slice(l.from, l.to);
        const key = this.emitLine(st, l.part, l.from, l.to, samples, { text: l.text, model });
        if (key !== null && this.upgrade) {
          if (st.utt && st.utt.part !== l.part) this.upgradeUtterance(st);
          st.utt ??= { part: l.part, from: l.from, to: l.to, keys: [], lines: [] };
          st.utt.to = l.to;
          st.utt.keys.push(key);
          st.utt.lines.push(l.text);
        }
      }
      const long = st.utt && st.utt.to - st.utt.from >= UTTERANCE_MAX_SECONDS * ASR_RATE;
      if (l.stopped || long) this.upgradeUtterance(st);
    }
    st.inSpeech = st.live?.open() != null;
  }

  /**
   * The closed utterance's lines and audio, for Qwen, sent right after its last line's `seg` (held
   * with it while the stream diarizer decides that line's speaker).
   */
  private upgradeUtterance(st: ChannelState): void {
    const utt = st.utt;
    st.utt = null;
    if (!utt || utt.keys.length === 0) return;
    const last = utt.keys.at(-1) as number;
    const u: UpgradeOut = {
      type: "upgrade",
      keys: utt.keys,
      lines: utt.lines,
      samples: prepareSpan(st.audio.slice(utt.from, utt.to)),
    };
    if (this.pending.some((p) => p.seg.key === last)) this.heldUpgrades.set(last, u);
    else this.emit(u);
  }

  /**
   * One closed line: labelled, or held for the stream diarizer's decision on its audio. Answers
   * the line's key, or null when it has no text and nothing is written.
   */
  private emitLine(
    st: ChannelState,
    part: number,
    from: number,
    to: number,
    samples: Float32Array,
    r: { text: string; lang?: string; model: string },
  ): number | null {
    if (r.text === "") return null;
    const a0 = from / ASR_RATE;
    const a1 = to / ASR_RATE;
    const key = ++this.lineKey;
    if (st.ch === "call" && this.labels === "stream") {
      const seg = {
        type: "seg" as const,
        part,
        ch: st.ch,
        a0,
        a1,
        text: r.text,
        model: r.model,
        key,
        ...(r.lang ? { lang: r.lang } : {}),
      };
      const s = this.stream && !this.stream.dead ? this.stream : null;
      const range = s ? streamRange(s, part, from, to) : null;
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
      return key;
    }
    let spk = "you";
    if (st.ch === "call") {
      let emb: Float32Array | null = null;
      if (a1 - a0 >= MIN_EMBED_SECONDS) {
        this.embedder ??= this.models.embedder();
        emb = this.embedder.embed(samples);
      }
      spk = this.speakers.assign(part, a0, a1, emb);
    }
    this.emit({
      type: "seg",
      part,
      ch: st.ch,
      a0,
      a1,
      text: r.text,
      spk,
      model: r.model,
      key,
      ...(r.lang ? { lang: r.lang } : {}),
    });
    if (st.ch === "call") {
      for (const m of this.speakers.merges()) this.emit(m);
      for (const c of this.speakers.centroids(this.now())) this.emit(c);
    }
    return key;
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
      const u = p.seg.key === undefined ? undefined : this.heldUpgrades.get(p.seg.key);
      if (u && p.seg.key !== undefined) {
        this.heldUpgrades.delete(p.seg.key);
        this.emit(u);
      }
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

  /**
   * Lets go of what the last call and the dictations loaded (`LiveAsr.releaseIdle`): the call's
   * streams and its stream diarizer, the streaming engine, the recognizer and the embedder. Only
   * while no call is on the Worker and no dictation is open; the next use loads what it needs.
   */
  release(): void {
    this.stop();
    this.engine = null;
    this.prepared = null;
    this.embedder = null;
  }

  /** Stops the stream diarizer and the live streams (the transcriber is closing). */
  /**
   * Opens a dictation's stream (DC-E5 live words) on the streaming engine a call is running when it
   * hears `languages`, so the model is never loaded twice; with no call on one, on `want`, loaded
   * now if another is. Throws while a call (`callActive`) runs an engine that does not hear them:
   * loading another would take the call's from under it. The engine of a call that has ended is
   * let go first, since a set holds one. Answers the engine and the stream's language.
   */
  openDictation(
    token: number,
    want: LiveChoice,
    languages: readonly string[],
    callActive: boolean,
  ): LiveChoice {
    if (!callActive && this.engine && this.engine.id !== want.engine) this.startEngine(undefined);
    let engine = this.engine;
    if (engine) {
      const id = engine.id;
      const info = isLiveEngine(id) ? LIVE_ENGINES[id] : null;
      const hears = (l: string) => (info?.languages as readonly string[] | undefined)?.includes(l);
      const fits =
        id === want.engine ||
        (info !== null &&
          (languages.length === 0 ? info.multilingual : languages.every((l) => hears(l))));
      if (!fits) throw new Error(`a call runs ${id}, which does not hear ${languages.join(", ")}`);
    } else {
      if (!this.models.liveEngine) throw new Error("this model set has no streaming engine");
      engine = this.models.liveEngine(want.engine);
    }
    const lang =
      engine.id === want.engine
        ? want.lang
        : isLiveEngine(engine.id)
          ? streamLanguage(engine.id, languages)
          : "auto";
    this.dictations.get(token)?.stream.close();
    this.dictations.set(token, { stream: engine.open(lang), gain: new CausalGain() });
    return { engine: engine.id, lang };
  }

  /**
   * Loads what a dictation needs before its first press (DC-E7): its VAD, the streaming model its
   * words would come from, and the recognizer only when its text comes from it (`recognizer`: no
   * streaming model, or `fast`), so the first press after launch waits for none of them and an idle
   * app holds no Parakeet it does not use. A running call's engine is never replaced for it; an
   * ended call's is let go first, as `openDictation` does.
   */
  warmDictation(want: LiveChoice | null, callActive: boolean, recognizer = want === null): void {
    this.dictationVad ??= this.models.vad();
    if (recognizer && this.models.recognizerHere?.() !== false) this.hot();
    if (!want || !this.models.liveEngine) return;
    if (!callActive && this.engine && this.engine.id !== want.engine) this.startEngine(undefined);
    if (!this.engine) this.models.liveEngine(want.engine);
  }

  /** A dictation's audio: the words its stream decoded since the last push. */
  dictationAudio(token: number, samples: Float32Array): LiveToken[] {
    const d = this.dictations.get(token);
    return d ? d.stream.push(d.gain.apply(samples)) : [];
  }

  /** Ends a dictation's stream: with `flush`, the words its last audio still held. */
  closeDictation(token: number, flush: boolean): LiveToken[] {
    const d = this.dictations.get(token);
    if (!d) return [];
    this.dictations.delete(token);
    const tail = flush ? d.stream.flush() : [];
    d.stream.close();
    return tail;
  }

  stop(): void {
    for (const token of [...this.dictations.keys()]) this.closeDictation(token, false);
    this.stream?.d.close();
    this.stream = null;
    for (const st of this.chans.values()) {
      st.live?.close();
      st.live = null;
    }
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
      /** The call's streaming engine; absent for VAD windows re-decoded by the recognizer. */
      live?: LiveChoice;
      /** The call has a second pass: each closed utterance's lines go to the host for review. */
      upgrade?: boolean;
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
  | { type: "flush"; token: number; call: string }
  /**
   * A dictation's buffer (DC-E1), decoded span by span on the loaded recognizer. `language` is
   * accepted and not sent: Parakeet picks the language itself.
   */
  | { type: "decode"; token: number; samples: Float32Array; language?: string }
  /** Whether the dictation VAD hears any speech in a buffer (DC-E6), before any engine decodes it. */
  | { type: "speech"; token: number; samples: Float32Array }
  /**
   * The second pass's Parakeet review: each utterance decoded alone on the loaded recognizer with
   * the call's decode list, answered as one `decoded`.
   */
  | { type: "review"; token: number; parts: Float32Array[] }
  /** A review whose call has ended: the utterances not decoded yet are not decoded. */
  | { type: "review.cancel"; token: number }
  /**
   * A dictation's words as it records (DC-E5 live words): a stream opened on `choice`, or on the
   * engine a call runs when it hears `languages`; its audio; its end, flushed for its last words.
   */
  | {
      type: "dstream-open";
      token: number;
      choice: LiveChoice;
      languages: string[];
      /** A call is running on the Worker now: its engine is never replaced for a dictation. */
      callActive: boolean;
    }
  | { type: "dstream-audio"; token: number; samples: Float32Array }
  | { type: "dstream-close"; token: number; flush: boolean }
  /**
   * Loads a dictation's models ahead of its first press (DC-E7): the streaming one on `choice`, and
   * the recognizer when `recognizer` says the dictation's text comes from it.
   */
  | {
      type: "dwarm";
      token: number;
      choice: LiveChoice | null;
      callActive: boolean;
      recognizer: boolean;
    }
  /**
   * Lets go of every model the Worker holds (`LiveAsr.releaseIdle`): sent only while no call is on
   * it and no dictation is open. What comes after it loads its models again.
   */
  | { type: "release" };

export type FromWorker =
  | { type: "ready"; loads: Record<string, number> }
  | { type: "flushed"; token: number }
  | { type: "failed"; error: string }
  | { type: "loads"; loads: Record<string, number> }
  | ({ type: "decoded"; token: number } & Decoded)
  | { type: "decode.failed"; token: number; error: string }
  | { type: "speech"; token: number; speech: boolean }
  /** A dictation's stream opened, on this engine and language, with its load time (0 if loaded). */
  | { type: "dstream"; token: number; choice: LiveChoice; ms: number }
  | { type: "dstream.failed"; token: number; error: string }
  /** Words a dictation's stream decoded; `done` after its close, with the last of them. */
  | { type: "dstream-words"; token: number; tokens: LiveToken[]; done: boolean }
  /** A dictation's models are loaded, or `error` says why not. */
  | { type: "dwarmed"; token: number; error?: string }
  /** Tagged with the call it belongs to, so a late result never lands in the next call. */
  | (LiveOut & { call: string });

/** The Worker's side, shared by the real Worker and the in-thread transport used in tests. */
export class WorkerSide {
  private pipeline: LivePipeline | null = null;
  private models: ModelSet | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Reviews given up (`review.cancel`): their next utterance is not decoded. */
  private readonly cancelled = new Set<number>();
  /** Reviews still decoding: a cancel for any other token came after its answer and is dropped. */
  private readonly reviewing = new Set<number>();
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
        case "decode":
          this.decode(p, m);
          break;
        case "review":
          this.review(p, m);
          break;
        case "review.cancel":
          if (this.reviewing.has(m.token)) this.cancelled.add(m.token);
          break;
        case "speech":
          this.reply({
            type: "speech",
            token: m.token,
            speech: p.dictationSpeech(m.samples).speech.includes(true),
          });
          break;
        case "dstream-open": {
          const t = performance.now();
          const choice = p.openDictation(m.token, m.choice, m.languages, m.callActive);
          this.reply({
            type: "dstream",
            token: m.token,
            choice,
            ms: Math.round(performance.now() - t),
          });
          this.reply({ type: "loads", loads: { ...(this.models?.loads ?? {}) } });
          break;
        }
        case "dstream-audio": {
          const tokens = p.dictationAudio(m.token, m.samples);
          if (tokens.length > 0)
            this.reply({ type: "dstream-words", token: m.token, tokens, done: false });
          break;
        }
        case "dwarm":
          p.warmDictation(m.choice, m.callActive, m.recognizer);
          this.reply({ type: "loads", loads: { ...(this.models?.loads ?? {}) } });
          this.reply({ type: "dwarmed", token: m.token });
          break;
        case "dstream-close":
          this.reply({
            type: "dstream-words",
            token: m.token,
            tokens: p.closeDictation(m.token, m.flush),
            done: true,
          });
          break;
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
        case "release":
          p.release();
          // The native memory comes back once the models are collected (`ModelSet.release`).
          await this.models?.release?.();
          this.reply({ type: "loads", loads: { ...(this.models?.loads ?? {}) } });
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
      if (m.type === "decode" || m.type === "speech" || m.type === "review")
        this.reply({ type: "decode.failed", token: m.token, error: (err as Error).message });
      if (m.type === "dstream-open" || m.type === "dstream-close" || m.type === "dstream-audio") {
        // A stream whose audio failed is dropped here too, and the host stops waiting on it.
        if (m.type === "dstream-audio") {
          try {
            this.pipeline?.closeDictation(m.token, false);
          } catch {
            // Already broken: the reply below is what the host needs.
          }
        }
        this.reply({ type: "dstream.failed", token: m.token, error: (err as Error).message });
      }
      if (m.type === "dwarm")
        this.reply({ type: "dwarmed", token: m.token, error: (err as Error).message });
    }
  }

  /**
   * A Parakeet review: one utterance per turn of the event loop, like a dictation's spans, so the
   * call's audio is transcribed between two of them.
   */
  private review(p: LivePipeline, m: Extract<ToWorker, { type: "review" }>): void {
    const texts: string[] = [];
    let ms = 0;
    let slowest = 0;
    let model = p.recognizerModel;
    this.reviewing.add(m.token);
    const reply = (r: FromWorker): void => {
      this.reviewing.delete(m.token);
      this.cancelled.delete(m.token);
      this.reply(r);
    };
    const step = (i: number) => (): void => {
      try {
        if (this.cancelled.has(m.token)) {
          reply({ type: "decode.failed", token: m.token, error: "the review was given up" });
          return;
        }
        const part = m.parts[i];
        if (part) {
          const r = p.decodeUtterance(part);
          ms += r.ms;
          slowest = Math.max(slowest, r.ms);
          model = r.model;
          if (r.text !== "") texts.push(r.text);
          setTimeout(() => {
            this.queue = this.queue.then(step(i + 1));
          }, 0);
          return;
        }
        reply({
          type: "decoded",
          token: m.token,
          text: texts.join(" "),
          words: [],
          language: null,
          model,
          ms: Math.round(ms),
          spans: m.parts.length,
          slowest: Math.round(slowest),
        });
      } catch (err) {
        reply({ type: "decode.failed", token: m.token, error: (err as Error).message });
      }
    };
    step(0)();
  }

  /**
   * A dictation decode: one span per turn of the event loop, each queued behind whatever arrived
   * while the last one ran, so a live call's audio is transcribed between two spans and its next
   * segment waits at most one span. The next span is queued from a timer, never a microtask: a
   * Worker's messages are tasks, and microtasks all run before the next task, so a promise chain
   * alone would run every span before any call audio.
   */
  private decode(p: LivePipeline, m: Extract<ToWorker, { type: "decode" }>): void {
    const spans = p.dictationSpans(m.samples);
    const texts: string[] = [];
    const words: Decoded["words"] = [];
    // Characters per detected language: the dictation's language is the one most of it is in.
    const heard = new Map<string, number>();
    let ms = 0;
    let model = p.recognizerModel;
    const step = (i: number) => (): void => {
      try {
        if (i < spans.length) {
          const r = p.decodeDictationSpan(m.samples, spans[i] as { from: number; to: number });
          ms += r.ms;
          model = r.model;
          if (r.lang) heard.set(r.lang, (heard.get(r.lang) ?? 0) + Math.max(1, r.text.length));
          if (r.text !== "") texts.push(r.text);
          words.push(...r.words);
          setTimeout(() => {
            this.queue = this.queue.then(step(i + 1));
          }, 0);
          return;
        }
        let language: string | null = null;
        for (const [l, n] of heard)
          if (language === null || n > (heard.get(language) ?? 0)) language = l;
        this.reply({
          type: "decoded",
          token: m.token,
          text: texts.join(" "),
          words,
          language,
          model,
          ms: Math.round(ms),
          spans: spans.length,
        });
      } catch (err) {
        this.reply({ type: "decode.failed", token: m.token, error: (err as Error).message });
      }
    };
    // The first span now; each later one behind whatever arrived meanwhile.
    step(0)();
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
  /**
   * The streaming engine a call runs, asked when the call takes the Worker, so a changed setting
   * applies from the next call. Null or absent: VAD windows re-decoded by the recognizer.
   */
  liveEngine?(callId: string): LiveChoice | null;
  /**
   * The second pass of a call that has one, asked once per call after `liveEngine`; null or absent
   * for none.
   */
  review?(callId: string): LiveReview | null;
  /** How often the second pass reviews, ms, over the call's own interval. Tests only. */
  reviewEveryMs?: number;
  /** Backlog levels that write `asr.lag`, seconds. */
  lagLevels?: readonly number[];
  /** Audio in flight to the Worker per channel, seconds; the rest waits in the ingest queue. */
  inflightSeconds?: number;
  clock?: Clock;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
  /** Runs the pipeline on this thread. Tests only: the app always uses the Worker. */
  inThread?: boolean;
  /**
   * `asr.modelIdleMinutes`, read at each check: the Worker lets go of its models once no call and
   * no dictation has used them for this long (0: as soon as none does). Absent: they stay loaded.
   */
  idleMinutes?(): number;
  /** The Worker let go of its models: the host loads again what a dictation needs to start fast. */
  onRelease?(): void;
}

interface Transport {
  post(m: ToWorker, transfer?: ArrayBuffer[]): void;
  close(): void;
}

/**
 * A dictation's stream on the Worker (DC-E5 live words): its audio as it records, its words through
 * the `onWords` it was opened with, as the engine decodes them.
 */
export interface DictationStream {
  /** The engine and language it runs on and its load time; rejects when it could not open. */
  readonly opened: Promise<LiveChoice & { ms: number }>;
  push(samples: Float32Array): void;
  /** Flushes its last audio: resolves once its last words came through `onWords`. */
  finish(): Promise<void>;
  /** Drops it: no more words come. */
  cancel(): void;
  /**
   * Settles when the stream is lost after it opened (the Worker failed or refused it): no more
   * words come, and the preview decodes again instead. Never settles for a stream that ends well.
   */
  readonly lost: Promise<Error>;
}

interface HostDictationStream {
  onWords(tokens: LiveToken[]): void;
  opened: { resolve(c: LiveChoice & { ms: number }): void; reject(e: Error): void };
  lost(e: Error): void;
  done: { resolve(): void; reject(e: Error): void } | null;
  cancelled: boolean;
}

/**
 * The model of a second pass: a review's closed utterances, each gained and padded, to its
 * hypothesis. `samples` is them joined by `joinUtterances` (what Qwen decodes), `parts` each one
 * alone (what Parakeet decodes).
 */
export interface LineUpgrader {
  decode(
    samples: Float32Array,
    o: { glossary: readonly string[]; signal: AbortSignal; parts: readonly Float32Array[] },
  ): Promise<Hypothesis>;
}

/**
 * One utterance of Parakeet's pass that took longer than this, milliseconds, held the call's live
 * lines that long (the Worker decodes it between two chunks of the call's audio): the pass goes
 * off for the rest of the call. Measured on the reference Mac mini at `asr.threads` 2, while other
 * builds loaded it: a 30 s utterance, the longest there is, took 1.8 to 2.1 s greedy and 2.1 to
 * 2.5 s under beam (docs/research/asr-architecture.md section 3.2). Twice that is a machine too
 * slow to review with Parakeet during a call.
 */
export const REVIEW_STALL_MAX_MS = 4000;

/** A second pass that must not go on for this call; the message says why, for the log. */
export class ReviewOff extends Error {}

/**
 * Parakeet's pass, on the recognizer the live Worker holds: each utterance alone (`parts`), never
 * the joined audio, which read worse than the stream alone. Only its text: the words go back into
 * the lines by text. A decode that held the live lines past `REVIEW_STALL_MAX_MS` turns it off.
 */
export function recognizerReviewer(
  review: (parts: readonly Float32Array[], signal: AbortSignal) => Promise<Decoded>,
): LineUpgrader {
  return {
    decode: async (_joined, o) => {
      const d = await review(o.parts, o.signal);
      if ((d.slowest ?? 0) > REVIEW_STALL_MAX_MS) {
        throw new ReviewOff(
          `one sentence took ${((d.slowest ?? 0) / 1000).toFixed(1)} s, holding the live lines`,
        );
      }
      return { engine: d.model, text: d.text, words: [], ms: d.ms };
    },
  };
}

/** A call's second pass: its model, its name for the log, and how often it reviews. */
export interface LiveReview {
  name: string;
  reviewer: LineUpgrader;
  everySeconds: number;
  /** The reviewer cannot take a request now (a final pass holds Qwen's GPU); absent: never. */
  busy?: () => boolean;
}

/**
 * How long a read of the call's lines waits for the second pass to review what has closed, ms:
 * past it the read answers with what is reviewed so far and says how many lines are still not.
 */
export const REVIEW_READ_WAIT_MS = 30_000;

/**
 * Reviews in a row that had not finished when the next one was due, after which the second pass
 * is off for the rest of the call: it is not keeping up with the call.
 */
export const REVIEW_BEHIND_MAX = 2;

/** A written line of an utterance: its id and its streaming text. */
interface UpgradeLine {
  id: string;
  text: string;
}

/** A closed utterance on the host: its written lines and its audio. */
interface UpgradeJob {
  lines: UpgradeLine[];
  samples: Float32Array;
}

/** A reviewed call's state on the host. */
interface HostUpgrade {
  /** The reviewer's name, for the log. */
  name: string;
  qwen: LineUpgrader;
  /** How often it reviews, ms, and the most audio one request carries, seconds. */
  everyMs: number;
  capSeconds: number;
  /** Its written lines by the key the Worker gave them, until their utterance closes. */
  keys: Map<number, string>;
  /** Utterances closed since the last review, oldest first. */
  closed: UpgradeJob[];
  /** Reviews waiting for Qwen, oldest first: each one request of whole utterances. */
  waiting: UpgradeJob[][];
  busy: boolean;
  /** The next review, armed when an utterance closes and none is armed. */
  timer: unknown;
  /** Reviews in a row that had not finished when the next one was due. */
  behind: number;
  /** The first request the last timer queued: still waiting at the next one, it is behind. */
  lastQueued: UpgradeJob[] | null;
  /** The reviewer did not keep up: nothing more of this call is reviewed. */
  off: boolean;
  /** Aborted at `call.ended`: the request in flight is given up. */
  ended: AbortController;
  /** The call's decode list as Qwen's glossary. */
  glossary: string[];
  /** The last failure logged, so a failing reviewer is logged once, not per line. */
  failed: string;
  /** Lines of the request the reviewer has now. */
  inFlight: number;
  /** Settles when the review loop running now stops; null while none runs. */
  drained: Promise<void> | null;
  /** A reader's pass in progress, which a second reader shares; null while none runs. */
  readPass: Promise<void> | null;
  /** The reviewer cannot take a request now (Qwen's GPU is a final pass's): a read does not wait. */
  busyElsewhere?: () => boolean;
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
  /** The call's streaming engine, asked once: a Worker that takes the call over keeps it. */
  live?: LiveChoice | null;
  /** The call's second pass, asked once with the engine; null for none. */
  upgrade?: HostUpgrade | null;
}

/** Worker answers that end a use of the models (`LiveAsr.releaseIdle`). */
const USE_ENDS: ReadonlySet<FromWorker["type"]> = new Set([
  "decoded",
  "decode.failed",
  "speech",
  "dstream.failed",
  "dstream-words",
]);

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
  /** Dictation decodes waiting for their answer, by token. */
  private readonly decodes = new Map<
    number,
    { resolve: (d: Decoded) => void; reject: (e: Error) => void }
  >();
  private decodeToken = 0;
  /** Speech checks waiting for their answer, by token; tokens are shared with the decodes. */
  private readonly speeches = new Map<
    number,
    { resolve: (speech: boolean) => void; reject: (e: Error) => void }
  >();
  /** Dictation streams open on the Worker, by token (DC-E5 live words). */
  private readonly dstreams = new Map<number, HostDictationStream>();
  /** Warm-ups of a dictation's models on the Worker, by token (DC-E7). */
  private readonly warms = new Map<number, { resolve(): void; reject(e: Error): void }>();
  private failed: string | null = null;
  private closed = false;
  /** A call or a dictation used the Worker's models since they were last let go. */
  private used = false;
  private lastUse = 0;
  /** Wakes `releaseIdle` when the models' idle time is up. */
  private idleTimer: unknown = null;
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
    this.dropDecodes(`the recognizer stopped (${error})`);
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
    this.dropDecodes(`the recognizer failed: ${error}`);
  }

  private dropDecodes(why: string): void {
    for (const d of this.decodes.values()) d.reject(new Error(why));
    this.decodes.clear();
    for (const d of this.speeches.values()) d.reject(new Error(why));
    this.speeches.clear();
    for (const d of this.dstreams.values()) {
      d.opened.reject(new Error(why));
      d.done?.reject(new Error(why));
      d.lost(new Error(why));
    }
    this.dstreams.clear();
    for (const w of this.warms.values()) w.reject(new Error(why));
    this.warms.clear();
  }

  /**
   * Loads a dictation's models on the Worker before its first press (DC-E7): its VAD, the
   * streaming model on `choice` unless a call runs one, and the recognizer when the dictation's
   * text comes from it (`recognizer`; by default only with no streaming model). Sent before the
   * Worker is ready, it runs right after the Worker's start, ahead of anything asked later.
   */
  warmDictation(choice: LiveChoice | null, recognizer = choice === null): Promise<void> {
    if (this.failed) return Promise.reject(new Error(`the recognizer failed: ${this.failed}`));
    if (this.closed) return Promise.reject(new Error("the recognizer is closed"));
    const token = ++this.decodeToken;
    return new Promise<void>((resolve, reject) => {
      this.warms.set(token, { resolve, reject });
      this.transport.post({
        type: "dwarm",
        token,
        choice,
        callActive: this.current !== null,
        recognizer,
      });
    });
  }

  /**
   * Opens a dictation's stream on the Worker's streaming engine (DC-E5 live words): the one a call
   * runs when it hears `languages`, never a second copy of it, else `choice`. Sent before the
   * Worker is ready, it waits for its model like a decode.
   */
  openDictation(
    choice: LiveChoice,
    languages: readonly string[],
    onWords: (tokens: LiveToken[]) => void,
  ): DictationStream {
    this.touch();
    const token = ++this.decodeToken;
    let resolveOpened!: (c: LiveChoice & { ms: number }) => void;
    let rejectOpened!: (e: Error) => void;
    const opened = new Promise<LiveChoice & { ms: number }>((res, rej) => {
      resolveOpened = res;
      rejectOpened = rej;
    });
    opened.catch(() => {});
    let lose!: (e: Error) => void;
    const lost = new Promise<Error>((res) => {
      lose = res;
    });
    const d: HostDictationStream = {
      onWords,
      opened: { resolve: resolveOpened, reject: rejectOpened },
      lost: lose,
      done: null,
      cancelled: false,
    };
    const gone = this.failed ?? (this.closed ? "the recognizer is closed" : null);
    if (gone) {
      rejectOpened(new Error(gone));
    } else {
      this.dstreams.set(token, d);
      this.transport.post({
        type: "dstream-open",
        token,
        choice,
        languages: [...languages],
        callActive: this.current !== null,
      });
    }
    return {
      opened,
      lost,
      push: (samples) => {
        if (d.cancelled || !this.dstreams.has(token)) return;
        const copy = samples.slice();
        this.transport.post({ type: "dstream-audio", token, samples: copy }, [copy.buffer]);
      },
      finish: () => {
        if (d.cancelled || !this.dstreams.has(token))
          return Promise.reject(new Error("the dictation's stream is not open"));
        return new Promise<void>((resolve, reject) => {
          d.done = { resolve, reject };
          this.transport.post({ type: "dstream-close", token, flush: true });
        });
      },
      cancel: () => {
        if (d.cancelled) return;
        d.cancelled = true;
        if (this.dstreams.delete(token))
          this.transport.post({ type: "dstream-close", token, flush: false });
      },
    };
  }

  /**
   * Decodes a dictation's buffer on the Worker's already loaded recognizer (DC-E1): never a second
   * copy of the model. Sent before the Worker is ready, it waits for the model to load and keeps
   * the audio. Between two of its spans the Worker takes whatever call audio has arrived.
   */
  decode(samples: Float32Array, o: { language?: string } = {}): Promise<Decoded> {
    if (this.failed) return Promise.reject(new Error(`the recognizer failed: ${this.failed}`));
    if (this.closed) return Promise.reject(new Error("the recognizer is closed"));
    this.touch();
    const token = ++this.decodeToken;
    const copy = samples.slice();
    return new Promise<Decoded>((resolve, reject) => {
      this.decodes.set(token, { resolve, reject });
      this.transport.post(
        {
          type: "decode",
          token,
          samples: copy,
          ...(o.language ? { language: o.language } : {}),
        },
        [copy.buffer],
      );
    });
  }

  /**
   * The second pass's Parakeet review of a call's utterances, on the Worker's already loaded
   * recognizer with the call's decode list: never a second copy of the model. The Worker takes the
   * call's audio between two utterances.
   */
  review(parts: readonly Float32Array[], signal?: AbortSignal): Promise<Decoded> {
    if (this.failed) return Promise.reject(new Error(`the recognizer failed: ${this.failed}`));
    if (this.closed) return Promise.reject(new Error("the recognizer is closed"));
    if (signal?.aborted) return Promise.reject(new Error("the review was given up"));
    this.touch();
    const token = ++this.decodeToken;
    const copies = parts.map((p) => p.slice());
    return new Promise<Decoded>((resolve, reject) => {
      this.decodes.set(token, { resolve, reject });
      // The call ended: the Worker decodes no more of it, and the answer is not waited for.
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.decodes.delete(token)) return;
          this.transport.post({ type: "review.cancel", token });
          reject(new Error("the review was given up"));
        },
        { once: true },
      );
      this.transport.post(
        { type: "review", token, parts: copies },
        copies.map((c) => c.buffer),
      );
    });
  }

  /**
   * Whether the dictation VAD hears speech anywhere in a buffer (DC-E6): a buffer with none is
   * never handed to an engine, whichever it is, so none can invent a sentence from room noise.
   */
  speech(samples: Float32Array): Promise<boolean> {
    if (this.failed) return Promise.reject(new Error(`the recognizer failed: ${this.failed}`));
    if (this.closed) return Promise.reject(new Error("the recognizer is closed"));
    this.touch();
    const token = ++this.decodeToken;
    const copy = samples.slice();
    return new Promise<boolean>((resolve, reject) => {
      this.speeches.set(token, { resolve, reject });
      this.transport.post({ type: "speech", token, samples: copy }, [copy.buffer]);
    });
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
        this.endUpgrade(c);
        // The idle time counts from the call's end.
        this.touch();
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

  /**
   * Lets the Worker go of its models once nothing has used them for `idleMinutes`: no call on it,
   * no dictation open or decoding. What a dictation needs to start fast is loaded again at once
   * (`onRelease`); everything else waits for its next use. The idle timer calls it; a test with its
   * own clock calls it too. Answers whether the models were let go.
   */
  releaseIdle(): boolean {
    this.disarmIdle();
    const minutes = this.o.idleMinutes?.();
    if (minutes === undefined || !this.used || this.closed || this.failed) return false;
    const idleMs = Math.max(0, minutes) * 60_000;
    const busy =
      this.current !== null ||
      this.dstreams.size > 0 ||
      this.decodes.size > 0 ||
      this.speeches.size > 0 ||
      // A warm-up still loading: a release now would undo it.
      this.warms.size > 0;
    const left = busy ? idleMs : idleMs - (this.clock.now() - this.lastUse);
    if (busy || left > 0) {
      this.idleTimer = this.clock.setTimeout(() => this.releaseIdle(), Math.max(1000, left));
      return false;
    }
    this.used = false;
    this.transport.post({ type: "release" });
    this.log("info", `models unloaded after ${minutes} min with no call or dictation`);
    this.o.onRelease?.();
    return true;
  }

  /** A call or a dictation uses the models: the idle time starts again. */
  private touch(): void {
    this.used = true;
    this.lastUse = this.clock.now();
    const minutes = this.o.idleMinutes?.();
    if (this.idleTimer !== null || minutes === undefined) return;
    this.idleTimer = this.clock.setTimeout(
      () => this.releaseIdle(),
      Math.max(1000, minutes * 60_000),
    );
  }

  private disarmIdle(): void {
    if (this.idleTimer !== null) this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Stops the Worker. */
  async close(): Promise<void> {
    this.closed = true;
    this.disarmIdle();
    for (const c of this.calls.values()) this.endUpgrade(c);
    this.transport.close();
    for (const done of this.flushes.values()) done();
    this.flushes.clear();
    this.dropDecodes("the recognizer is closed");
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
    this.touch();
    this.beginCall(c);
    return c;
  }

  /** Tells the Worker which call it transcribes, with the call's speakers and decode list. */
  private beginCall(c: HostCall): void {
    const view = c.access.view;
    const spks = view
      .lines("live", { includeEcho: true, includeRetracted: true })
      .map((l) => l.spkRaw);
    if (c.live === undefined) c.live = this.o.liveEngine?.(c.id) ?? null;
    const live = c.live;
    if (c.upgrade === undefined) {
      const review = live ? (this.o.review?.(c.id) ?? null) : null;
      c.upgrade = review
        ? {
            name: review.name,
            qwen: review.reviewer,
            everyMs: this.o.reviewEveryMs ?? review.everySeconds * 1000,
            capSeconds: reviewCap(review.everySeconds),
            keys: new Map(),
            closed: [],
            waiting: [],
            busy: false,
            timer: null,
            behind: 0,
            lastQueued: null,
            off: false,
            ended: new AbortController(),
            glossary: [],
            failed: "",
            inFlight: 0,
            drained: null,
            readPass: null,
            ...(review.busy ? { busyElsewhere: review.busy } : {}),
          }
        : null;
    }
    // A Worker taking the call over numbers its lines afresh.
    c.upgrade?.keys.clear();
    this.transport.post({
      type: "call",
      id: c.id,
      ...view.speakerState(),
      ids: spks,
      ...(live ? { live } : {}),
      ...(c.upgrade ? { upgrade: true } : {}),
    });
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
    if (c.upgrade) c.upgrade.glossary = list.entries.map((e) => e.term);
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
    // A dictation's answer ends a use: the idle time counts from it.
    if (USE_ENDS.has(m.type)) this.touch();
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
      case "decoded": {
        const d = this.decodes.get(m.token);
        this.decodes.delete(m.token);
        const { type: _t, token: _k, ...result } = m;
        d?.resolve(result);
        return;
      }
      case "decode.failed": {
        const d = this.decodes.get(m.token) ?? this.speeches.get(m.token);
        this.decodes.delete(m.token);
        this.speeches.delete(m.token);
        d?.reject(new Error(m.error));
        return;
      }
      case "speech": {
        const d = this.speeches.get(m.token);
        this.speeches.delete(m.token);
        d?.resolve(m.speech);
        return;
      }
      case "dstream": {
        this.dstreams.get(m.token)?.opened.resolve({ ...m.choice, ms: m.ms });
        return;
      }
      case "dstream.failed": {
        const d = this.dstreams.get(m.token);
        this.dstreams.delete(m.token);
        d?.opened.reject(new Error(m.error));
        d?.done?.reject(new Error(m.error));
        d?.lost(new Error(m.error));
        return;
      }
      case "dwarmed": {
        const w = this.warms.get(m.token);
        this.warms.delete(m.token);
        if (m.error) w?.reject(new Error(m.error));
        else w?.resolve();
        return;
      }
      case "dstream-words": {
        const d = this.dstreams.get(m.token);
        if (!d || d.cancelled) return;
        if (m.tokens.length > 0) d.onWords(m.tokens);
        if (m.done) {
          this.dstreams.delete(m.token);
          d.done?.resolve();
        }
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
        for (const w of m.warnings) this.log("warn", w);
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
      case "upgrade":
        if (c) this.upgradeLine(c, m);
        return;
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
    if (c.upgrade && m.key !== undefined) c.upgrade.keys.set(m.key, id);
  }

  // --- the second pass -----------------------------------------------------------------------

  /** A closed utterance: it waits for the next review, whose words become its lines' next revisions. */
  private upgradeLine(c: HostCall, m: UpgradeOut): void {
    const u = c.upgrade;
    if (!u) return;
    const lines: UpgradeLine[] = [];
    m.keys.forEach((key, i) => {
      const id = u.keys.get(key);
      u.keys.delete(key);
      if (id) lines.push({ id, text: m.lines[i] as string });
    });
    if (lines.length === 0 || u.off || u.ended.signal.aborted) return;
    u.closed.push({ lines, samples: m.samples });
    u.timer ??= this.clock.setTimeout(() => this.reviewDue(c, u), u.everyMs);
  }

  /**
   * A review is due: the utterances closed since the last one go to the reviewer, whole, in
   * requests of at most `reviewCap` of the interval. A review still waiting from the one before is
   * skipped (its lines keep the streaming text), and after `REVIEW_BEHIND_MAX` reviews in a row
   * behind, the second pass is off for the rest of the call.
   */
  private reviewDue(c: HostCall, u: HostUpgrade): void {
    u.timer = null;
    if (u.off) return;
    // A reader's pass is running: its request is ahead of the timer, not behind the call, so
    // nothing waiting is dropped. The reviewer is behind only when the last timer's request has
    // not even started, as reads one after another would otherwise keep it on however slow it is.
    if (u.readPass) {
      if (u.lastQueued && u.waiting.includes(u.lastQueued)) {
        u.behind++;
        if (u.behind >= REVIEW_BEHIND_MAX) {
          this.reviewOff(u);
          return;
        }
      } else {
        u.behind = 0;
      }
      this.queueReview(c, u);
      return;
    }
    if (u.busy || u.waiting.length > 0) {
      u.behind++;
      const late = u.waiting.splice(0).flatMap((r) => r.flatMap((j) => j.lines.map((l) => l.id)));
      if (u.behind >= REVIEW_BEHIND_MAX) {
        this.reviewOff(u);
        return;
      }
      if (late.length > 0) {
        this.log(
          "warn",
          `second pass: ${u.name} is behind; ${late.join(", ")} keep the streaming text`,
        );
      }
    } else {
      u.behind = 0;
    }
    this.queueReview(c, u);
  }

  /** The timer's review: the utterances closed since the last one, queued for the reviewer. */
  private queueReview(c: HostCall, u: HostUpgrade): void {
    const batches = reviewBatches(u.closed.splice(0), u.capSeconds);
    u.lastQueued = batches[0] ?? null;
    u.waiting.push(...batches);
    void this.runQwen(c, u);
  }

  /** The reviewer did not keep up: nothing more of this call is reviewed. */
  private reviewOff(u: HostUpgrade): void {
    u.off = true;
    u.closed.length = 0;
    u.waiting.length = 0;
    this.log(
      "warn",
      `second pass: ${u.name} did not keep up with the call (${u.behind} reviews in a row behind); the rest of the call keeps the streaming text`,
    );
  }

  /** Decodes the waiting reviews, one at a time, and writes each one's words. */
  private async runQwen(c: HostCall, u: HostUpgrade): Promise<void> {
    if (u.busy) return;
    u.busy = true;
    let done = () => {};
    u.drained = new Promise<void>((resolve) => {
      done = resolve;
    });
    try {
      for (;;) {
        const review = u.waiting.shift();
        if (!review || u.ended.signal.aborted || u.off) break;
        const parts = review.map((j) => j.samples);
        const job = { lines: review.flatMap((j) => j.lines), samples: joinUtterances(parts) };
        u.inFlight = job.lines.length;
        let qwen: Hypothesis;
        try {
          qwen = await u.qwen.decode(job.samples, {
            glossary: u.glossary,
            signal: u.ended.signal,
            parts,
          });
        } catch (err) {
          const why = (err as Error).message;
          if (err instanceof ReviewOff) {
            u.off = true;
            u.waiting.length = 0;
            u.closed.length = 0;
            this.log(
              "warn",
              `second pass: ${u.name} is off for the rest of the call: ${why}; the lines keep the streaming text`,
            );
            break;
          }
          if (!u.ended.signal.aborted && why !== u.failed) {
            u.failed = why;
            this.log(
              "warn",
              `second pass: ${u.name} failed (${why}); lines keep the streaming text`,
            );
          }
          continue;
        }
        u.failed = "";
        this.revise(c, job.lines, qwen);
      }
    } finally {
      u.inFlight = 0;
      u.busy = false;
      u.drained = null;
      done();
    }
  }

  /**
   * Review before a read (review-on-read): when a reader asks for the call's lines, the second pass
   * first reviews the utterances closed and not reviewed yet, so an agent that follows the call
   * reads corrected lines. The newest cap's worth goes first; older ones stay for the timer. Waits
   * at most `waitMs`, then answers how many closed lines are still not reviewed. Concurrent reads
   * share one pass, and a read right after the timer's pass finds nothing to do. Null when the call
   * has no second pass running: Off, gone off, or ended (the final pass owns the rest), including
   * when that happens during the wait, which then ends at once: no later read would review them.
   */
  async reviewForRead(
    callId: string,
    waitMs = REVIEW_READ_WAIT_MS,
  ): Promise<{ unreviewed: number } | null> {
    const c = this.calls.get(callId);
    const u = c?.upgrade;
    if (!c || !u || u.off || u.ended.signal.aborted) return null;
    if (!u.readPass && !u.busyElsewhere?.()) {
      const pass = this.readPass(c, u);
      u.readPass = pass;
      void pass.finally(() => {
        if (u.readPass === pass) u.readPass = null;
      });
    }
    const pass = u.readPass;
    if (pass) {
      let timer: unknown = null;
      let onEnd = () => {};
      await Promise.race([
        pass,
        new Promise<void>((resolve) => {
          timer = this.clock.setTimeout(resolve, waitMs);
        }),
        new Promise<void>((resolve) => {
          onEnd = resolve;
          u.ended.signal.addEventListener("abort", onEnd, { once: true });
        }),
      ]);
      if (timer !== null) this.clock.clearTimeout(timer);
      u.ended.signal.removeEventListener("abort", onEnd);
    }
    if (u.off || u.ended.signal.aborted) return null;
    return { unreviewed: unreviewedLines(u) };
  }

  private async readPass(c: HostCall, u: HostUpgrade): Promise<void> {
    if (u.closed.length > 0) {
      // The newest cap's worth, whole utterances; older ones are left to the timer.
      const cap = u.capSeconds * ASR_RATE;
      let from = u.closed.length;
      let n = 0;
      while (from > 0) {
        const len = (u.closed[from - 1] as UpgradeJob).samples.length;
        if (from < u.closed.length && n + len > cap) break;
        n += len;
        from--;
      }
      const newest = u.closed.splice(from);
      if (u.closed.length === 0 && u.timer !== null) {
        this.clock.clearTimeout(u.timer);
        u.timer = null;
      }
      u.waiting.push(...reviewBatches(newest, u.capSeconds));
    }
    for (;;) {
      if (u.off || u.ended.signal.aborted) return;
      if (!u.busy) {
        if (u.waiting.length === 0) return;
        void this.runQwen(c, u);
      }
      await u.drained;
    }
  }

  /**
   * Writes the reviewer's hypothesis of an utterance as the next revision of each of its lines, its
   * words cut back into them. Nothing is written once the call has ended. A line a person edited,
   * retracted or fixed a word on, or one that gets no words, is left as it is.
   */
  private revise(c: HostCall, lines: readonly UpgradeLine[], h: Hypothesis): void {
    if (this.calls.get(c.id) !== c) {
      this.log(
        "warn",
        `second pass of ${lines.map((l) => l.id).join(", ")} dropped: its call has ended`,
      );
      return;
    }
    const words = h.words.length > 0 ? h.words.map((w) => w.w) : h.text.split(/\s+/);
    const parts = splitToLines(
      lines.map((l) => l.text),
      words.filter((w) => w !== ""),
    );
    // A line a person fixed a word on (a line-scoped pair of the call, #186's fix) keeps its words:
    // the fix is a pair, not a revision, so `by` alone does not show it.
    const fixed = new Set(c.access.view.callVocabulary().flatMap((v) => v.segs ?? []));
    lines.forEach((l, i) => {
      const seg = c.access.view.segment(l.id);
      if (!seg || seg.text === null || seg.by !== undefined || fixed.has(l.id)) return;
      const text = (parts[i] as string).trim();
      if (text === "") return;
      c.access.record({
        type: "seg",
        id: l.id,
        rev: seg.rev + 1,
        text,
        model: h.engine,
        ...(h.lang ? { lang: h.lang } : {}),
      });
    });
  }

  /** The call ended: the request in flight is given up and nothing waiting is decoded. */
  private endUpgrade(c: HostCall): void {
    const u = c.upgrade;
    if (!u) return;
    u.ended.abort();
    if (u.timer !== null) this.clock.clearTimeout(u.timer);
    u.timer = null;
    u.waiting.length = 0;
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

/** The closed lines of a reviewed call the second pass has not written yet. */
function unreviewedLines(u: HostUpgrade): number {
  return (
    u.closed.reduce((n, j) => n + j.lines.length, 0) +
    u.waiting.reduce((n, r) => n + r.reduce((m, j) => m + j.lines.length, 0), 0) +
    u.inFlight
  );
}
