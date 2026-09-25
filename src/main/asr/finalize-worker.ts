/**
 * The accurate final pass (docs/DESIGN.md section 3.3), in its own `finalize` Worker. It never
 * writes the log: it sends event drafts to the main thread, which appends them through the call's
 * one writer.
 *
 * 1. **Per part, per channel**, read the channel by index (left = mic, right = call; never "channel
 *    0") in 10-minute chunks, and check for energy **before any model loads**. A silent part costs
 *    no model load.
 * 2. **Whole timeline.** VAD only proposes cut points: every non-speech run of 0.3 s or more gets a
 *    cut at its quietest window, the pieces between cuts cover the whole timeline, and every piece
 *    above the silence floor is decoded. A short word the VAD missed sits inside a piece and is
 *    transcribed (TRAPS "VAD gating loses words").
 * 3. **Call channel:** speaker diarization over the call channel of **all parts concatenated**, so
 *    one person has one label (`s<N>`) for the whole call: Nemotron 3 Diarization at its 30.4 s
 *    latency through `akou-diarize` (`asr.diarizer` nemotron), or pyannote segmentation plus
 *    embeddings (`embeddings`). The call pieces are cut at the turn boundaries; where two turns
 *    overlap, a piece is labelled with the speaker active longest inside it (one channel carries
 *    one transcript, so overlapping voices share a line). Mic lines are `you`.
 * 4. Every span is gained and padded by `prepareSpan` (the one rule) and decoded with the call's
 *    decode list as it stands when the pass starts, recorded as `vocab.used`. A span the engine
 *    refuses is halved down to 20 s, and only the smallest failing piece is skipped and listed.
 * 5. **Output:** `seg` events with `layer: final` (a re-run first retracts the previous final
 *    lines), a `final.part.done` per part as its lines are written, `speaker.map` or
 *    `speaker.suggest` per final cluster (names carry over from the live layer), then one
 *    `final.done` with the parts, the skipped spans and a warning when the call channel had energy
 *    but produced no text.
 */

import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { workerData } from "node:worker_threads";
import type { Channel, EventDraft, LogEvent } from "../../core/log/events.ts";
import { fold } from "../../core/log/fold.ts";
import { readLog } from "../../core/log/reader.ts";
import { EVENTS_FILE } from "../../core/log/writer.ts";
import { CHANNELS, type Clock, realClock } from "../capture/engine.ts";
import type { DecodeList } from "../vocab/decode-list.ts";
import {
  ASR_RATE,
  type DiarizedSpan,
  loadModelSet,
  type ModelSet,
  type ModelSpec,
  type PreparedHotwords,
} from "./engine.ts";
import { callDecodeList, modelNameFor, streamHotwords, type VocabSource } from "./live-worker.ts";
import { peak, prepareSpan } from "./pad.ts";
import { siblingModule } from "./sibling.ts";
import { mapFinalToLive, type TimedLabel } from "./speakers.ts";

export interface FinalOptions {
  /** Audio read per step, seconds (no temporary WAV, no whole file in memory for the energy scan). */
  chunkSeconds: number;
  /** Longest span decoded at once, seconds. */
  maxSpanSeconds: number;
  /** A refused span is halved while longer than this, seconds. */
  minSplitSeconds: number;
  /** Peak below this is silence, dBFS. */
  silenceDbfs: number;
  /** A non-speech run this long proposes a cut point, seconds. */
  minGapSeconds: number;
  /** A piece with no diarization span within this many seconds is `s?`. */
  attachSeconds: number;
}

export const DEFAULT_FINAL: FinalOptions = {
  chunkSeconds: 600,
  maxSpanSeconds: 30,
  minSplitSeconds: 20,
  silenceDbfs: -50,
  minGapSeconds: 0.3,
  attachSeconds: 1,
};

/** One part's stereo audio at 16 kHz, read by channel index. */
export interface FinalAudio {
  /** Frames in the part; 0 when it has no audio. */
  length(part: number): number;
  read(part: number, ch: Channel, from: number, n: number): Float32Array;
  close?(): void;
}

/**
 * Where the Worker reads audio. The helper's Ogg Opus files need a decoder the app does not have
 * yet; until the helper can decode its own files, a part is read from a 16-bit stereo WAV at 16 kHz
 * (what hark and the fake helper produce) or through a module (tests).
 */
export type FinalAudioSpec =
  | { kind: "wav"; files: Record<number, string> }
  | { kind: "module"; path: string; options?: unknown };

export interface SkippedSpan {
  part: number;
  ch: Channel;
  a0: number;
  a1: number;
  error: string;
}

export interface FinalInput {
  events: readonly LogEvent[];
  audio: FinalAudio;
  decode: DecodeList | null;
  files?: readonly { path: string; sha256: string }[];
  pid?: number;
  /** The host already wrote `final.started` (finalizeCall), so the pass does not write it again. */
  announced?: boolean;
  options?: Partial<FinalOptions>;
}

export interface FinalResult {
  ok: boolean;
  parts: number[];
  skipped: SkippedSpan[];
  warning?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// WAV parts

export class WavParts implements FinalAudio {
  private readonly open = new Map<number, { fd: number; data: number; frames: number }>();

  constructor(private readonly files: Record<number, string>) {}

  private file(part: number): { fd: number; data: number; frames: number } | null {
    const cached = this.open.get(part);
    if (cached) return cached;
    const path = this.files[part];
    if (!path) return null;
    const fd = openSync(path, "r");
    const head = new Uint8Array(65536);
    const got = readSync(fd, head, 0, head.length, 0);
    const v = new DataView(head.buffer);
    const tag = (o: number) => String.fromCharCode(...head.subarray(o, o + 4));
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error(`${path} is not a WAV file`);
    let o = 12;
    let channels = 0;
    let rate = 0;
    let bits = 0;
    while (o + 8 <= got) {
      const id = tag(o);
      const size = v.getUint32(o + 4, true);
      if (id === "fmt ") {
        channels = v.getUint16(o + 10, true);
        rate = v.getUint32(o + 12, true);
        bits = v.getUint16(o + 22, true);
      } else if (id === "data") {
        if (channels !== 2 || bits !== 16 || rate !== ASR_RATE) {
          throw new Error(`${path}: need 16-bit stereo at ${ASR_RATE} Hz`);
        }
        const f = { fd, data: o + 8, frames: Math.floor(size / 4) };
        this.open.set(part, f);
        return f;
      }
      o += 8 + size + (size % 2);
    }
    throw new Error(`${path}: no data chunk in the first 64 KiB`);
  }

  length(part: number): number {
    return this.file(part)?.frames ?? 0;
  }

  read(part: number, ch: Channel, from: number, n: number): Float32Array {
    const f = this.file(part);
    if (!f) return new Float32Array(0);
    const count = Math.max(0, Math.min(n, f.frames - from));
    const bytes = new Uint8Array(count * 4);
    readSync(f.fd, bytes, 0, bytes.length, f.data + from * 4);
    const v = new DataView(bytes.buffer);
    const out = new Float32Array(count);
    // Channel by index: left (0) is the mic, right (1) is the call.
    const off = ch === "mic" ? 0 : 2;
    for (let i = 0; i < count; i++) out[i] = v.getInt16(i * 4 + off, true) / 32768;
    return out;
  }

  close(): void {
    for (const f of this.open.values()) closeSync(f.fd);
    this.open.clear();
  }
}

export async function openFinalAudio(spec: FinalAudioSpec): Promise<FinalAudio> {
  if (spec.kind === "wav") return new WavParts(spec.files);
  const mod = (await import(spec.path)) as { createAudio(o: unknown): FinalAudio };
  return mod.createAudio(spec.options);
}

// ---------------------------------------------------------------------------
// The pass

function readAll(audio: FinalAudio, part: number, ch: Channel, chunk: number): Float32Array {
  const n = audio.length(part);
  const out = new Float32Array(n);
  for (let at = 0; at < n; at += chunk) out.set(audio.read(part, ch, at, chunk), at);
  return out;
}

function hasEnergy(audio: FinalAudio, part: number, ch: Channel, chunk: number, floor: number) {
  const n = audio.length(part);
  for (let at = 0; at < n; at += chunk)
    if (peak(audio.read(part, ch, at, chunk)) >= floor) return true;
  return false;
}

interface Piece {
  from: number;
  to: number;
  spk?: string;
}

/**
 * Pieces that cover the whole timeline, cut inside non-speech runs at their quietest window, split
 * further so none is longer than `maxSpan`, then trimmed to where they rise above the floor. Pieces
 * that never do are silence and dropped.
 */
export function timelinePieces(
  samples: Float32Array,
  speech: readonly boolean[],
  window: number,
  o: FinalOptions,
  cutsAt: readonly number[] = [],
): Piece[] {
  const floor = 10 ** (o.silenceDbfs / 20);
  const nWin = Math.ceil(samples.length / window);
  const rms = new Float64Array(nWin);
  for (let w = 0; w < nWin; w++) {
    let s = 0;
    const a = w * window;
    const b = Math.min(samples.length, a + window);
    for (let i = a; i < b; i++) s += (samples[i] as number) ** 2;
    rms[w] = Math.sqrt(s / Math.max(1, b - a));
  }
  const quietest = (a: number, b: number) => {
    let best = a;
    for (let w = a; w < b; w++) if ((rms[w] as number) < (rms[best] as number)) best = w;
    return best;
  };
  const cuts = new Set<number>(cutsAt.map((c) => Math.round(c / window)));
  const gapWins = Math.ceil((o.minGapSeconds * ASR_RATE) / window);
  for (let w = 0; w < nWin; ) {
    if (speech[w]) {
      w++;
      continue;
    }
    let e = w;
    while (e < nWin && !speech[e]) e++;
    if (e - w >= gapWins) cuts.add(quietest(w, e));
    w = e;
  }
  const bounds = [0, ...[...cuts].filter((c) => c > 0 && c < nWin).sort((a, b) => a - b), nWin];
  const maxWins = Math.floor((o.maxSpanSeconds * ASR_RATE) / window);
  const out: Piece[] = [];
  const add = (a: number, b: number) => {
    if (b - a > maxWins) {
      const m = quietest(a + Math.floor((b - a) / 4), b - Math.floor((b - a) / 4));
      const mid = m > a && m < b ? m : a + Math.floor((b - a) / 2);
      add(a, mid);
      add(mid, b);
      return;
    }
    let s = a;
    while (s < b && !windowPeakAbove(samples, s, window, floor)) s++;
    let e = b;
    while (e > s && !windowPeakAbove(samples, e - 1, window, floor)) e--;
    if (e > s) out.push({ from: s * window, to: Math.min(samples.length, e * window) });
  };
  for (let i = 0; i + 1 < bounds.length; i++) add(bounds[i] as number, bounds[i + 1] as number);
  return out;
}

function windowPeakAbove(x: Float32Array, w: number, window: number, floor: number): boolean {
  const b = Math.min(x.length, (w + 1) * window);
  for (let i = w * window; i < b; i++) if (Math.abs(x[i] as number) >= floor) return true;
  return false;
}

function speechFlags(
  samples: Float32Array,
  models: ModelSet,
): { flags: boolean[]; window: number } {
  const vad = models.vad();
  const w = vad.windowSize;
  const flags: boolean[] = [];
  const pad = new Float32Array(w);
  for (let at = 0; at < samples.length; at += w) {
    let win = samples.subarray(at, at + w);
    if (win.length < w) {
      pad.fill(0);
      pad.set(win);
      win = pad;
    }
    flags.push(vad.accept(win));
  }
  vad.reset();
  return { flags, window: w };
}

/**
 * Labels a call piece with the speaker whose turns cover most of it (overlapping turns each count
 * their own time), or the speaker of the nearest turn within reach.
 */
function labelPiece(p: Piece, spans: readonly DiarizedSpan[], reach: number): string {
  const a = p.from / ASR_RATE;
  const b = p.to / ASR_RATE;
  const cover = new Map<number, number>();
  for (const s of spans) {
    const o = Math.min(b, s.end) - Math.max(a, s.start);
    if (o > 0) cover.set(s.speaker, (cover.get(s.speaker) ?? 0) + o);
  }
  let best = -1;
  let bestO = 0;
  for (const [spk, o] of cover) {
    if (o > bestO || (o === bestO && spk < best)) {
      bestO = o;
      best = spk;
    }
  }
  if (best >= 0) return `s${best}`;
  let near: DiarizedSpan | null = null;
  let d = reach;
  for (const s of spans) {
    const gap = Math.max(s.start - b, a - s.end);
    if (gap < d) {
      d = gap;
      near = s;
    }
  }
  return near ? `s${near.speaker}` : "s?";
}

export async function runFinalPass(
  input: FinalInput,
  models: ModelSet,
  emit: (d: EventDraft) => void,
  log: (level: "info" | "warn" | "error", msg: string) => void = () => {},
): Promise<FinalResult> {
  const o = { ...DEFAULT_FINAL, ...input.options };
  const view = fold(input.events);
  const audio = input.audio;
  const chunk = Math.round(o.chunkSeconds * ASR_RATE);
  const floor = 10 ** (o.silenceDbfs / 20);
  const parts = view
    .parts()
    .map((p) => p.part)
    .filter((p) => audio.length(p) > 0);
  const skipped: SkippedSpan[] = [];
  let step = "energy";
  if (!input.announced) emit({ type: "final.started", pid: input.pid ?? process.pid });
  try {
    // 1. Energy, before any model loads.
    const energy = new Map<string, boolean>();
    for (const p of parts)
      for (const ch of CHANNELS) energy.set(`${p}:${ch}`, hasEnergy(audio, p, ch, chunk, floor));
    const any = [...energy.values()].some(Boolean);

    // A re-run replaces the whole final layer: earlier final lines are retracted. The retractions
    // and the new layer are held until every part is decoded, so a pass that fails or is stopped
    // leaves the previous layer whole.
    let nextFinal = 1;
    const layer: EventDraft[] = [];
    for (const l of view.lines("final", { includeEcho: true, includeRetracted: true })) {
      const n = Number(/^f(\d+)$/.exec(l.id)?.[1] ?? 0);
      if (n >= nextFinal) nextFinal = n + 1;
      if (!l.retracted)
        layer.push({ type: "seg", id: l.id, rev: l.rev + 1, text: null, by: "app" });
    }

    if (!any) {
      for (const d of layer) emit(d);
      for (const p of parts) emit({ type: "final.part.done", part: p });
      emit({ type: "final.done", parts, skipped: [] });
      return { ok: true, parts, skipped };
    }

    step = "models";
    const hw = models.prepare(input.decode);
    emit({
      type: "vocab.used",
      entries: hw.entries,
      files: (input.files ?? []).map((f) => f.path),
      sha256: (input.files ?? []).map((f) => f.sha256),
      model: hw.recognizer.model,
    });
    for (const d of hw.dropped) log("error", `hotword "${d.term}" dropped: ${d.reason}`);

    // 3. Diarization over the call channel of all parts, concatenated.
    step = "diarize";
    const callParts = parts.filter((p) => energy.get(`${p}:call`));
    const spansByPart = new Map<number, DiarizedSpan[]>();
    if (callParts.length > 0) {
      const lens = callParts.map((p) => audio.length(p));
      const all = new Float32Array(lens.reduce((a, b) => a + b, 0));
      let off = 0;
      for (const [i, p] of callParts.entries()) {
        all.set(readAll(audio, p, "call", chunk), off);
        off += lens[i] as number;
      }
      // A diarizer that crashes, hangs past its deadline or errors costs the labels, not the pass.
      let spans: DiarizedSpan[] = [];
      try {
        spans = await models.diarizer().process(all);
      } catch (err) {
        log(
          "error",
          `speaker labels failed, the final pass goes on without them: ${(err as Error).message}`,
        );
      }
      off = 0;
      for (const [i, p] of callParts.entries()) {
        const a = off / ASR_RATE;
        const b = (off + (lens[i] as number)) / ASR_RATE;
        spansByPart.set(
          p,
          spans
            .filter((s) => s.end > a && s.start < b)
            .map((s) => ({
              start: Math.max(0, s.start - a),
              end: Math.min(b, s.end) - a,
              speaker: s.speaker,
            })),
        );
        off += lens[i] as number;
      }
    }

    // 2 and 4. Whole-timeline decode, per part.
    step = "decode";
    const languages = new Set<string>();
    let callText = false;
    let callEnergy = false;
    const finals: TimedLabel[] = [];
    for (const p of parts) {
      const clock = view.part(p)?.clock;
      if (!clock) continue;
      const lines: Omit<Extract<EventDraft, { type: "seg" }>, "id">[] = [];
      for (const ch of CHANNELS) {
        if (!energy.get(`${p}:${ch}`)) continue;
        if (ch === "call") callEnergy = true;
        const samples = readAll(audio, p, ch, chunk);
        const { flags, window } = speechFlags(samples, models);
        const spans = spansByPart.get(p) ?? [];
        const cuts =
          ch === "call" ? spans.flatMap((s) => [s.start * ASR_RATE, s.end * ASR_RATE]) : [];
        for (const piece of timelinePieces(samples, flags, window, o, cuts)) {
          const r = decodeHalving(samples, piece.from, piece.to, hw, o, (from, to, error) =>
            skipped.push({ part: p, ch, a0: from / ASR_RATE, a1: to / ASR_RATE, error }),
          );
          if (r.lang) languages.add(r.lang);
          if (r.text === "") continue;
          if (ch === "call") callText = true;
          const a0 = piece.from / ASR_RATE;
          const a1 = piece.to / ASR_RATE;
          const spk = ch === "mic" ? "you" : labelPiece(piece, spans, o.attachSeconds);
          const w0 = Math.round(clock.wallFromAudio(a0));
          const w1 = Math.round(clock.wallFromAudio(a1));
          if (ch === "call") finals.push({ spk, t0: w0, t1: w1 });
          lines.push({
            type: "seg",
            rev: 1,
            layer: "final",
            part: p,
            ch,
            spk,
            a0: round3(a0),
            a1: round3(a1),
            w0,
            w1,
            text: r.text,
            model: hw.recognizer.model,
            ...(r.lang ? { lang: r.lang } : {}),
          });
        }
      }
      lines.sort((a, b) => (a.w0 as number) - (b.w0 as number) || (a.ch === "mic" ? -1 : 1));
      for (const l of lines) {
        layer.push({ ...l, id: `f${String(nextFinal).padStart(6, "0")}` } as EventDraft);
        nextFinal++;
      }
      layer.push({ type: "final.part.done", part: p });
    }
    for (const d of layer) emit(d);

    // 4 (names). Final clusters to live clusters, jointly.
    step = "map";
    const lives: TimedLabel[] = view
      .lines("live")
      .filter((l) => l.ch === "call")
      .map((l) => ({ spk: l.spk, t0: l.w0, t1: l.w1 }));
    for (const m of mapFinalToLive(finals, lives)) {
      emit({
        type: m.confirmed ? "speaker.map" : "speaker.suggest",
        final: m.final,
        live: m.live,
        overlap: m.overlap,
      });
    }

    const warning =
      callEnergy && !callText
        ? "the call channel has sound but the final pass produced no text for it"
        : undefined;
    emit({
      type: "final.done",
      parts,
      skipped,
      ...(languages.size > 0 ? { languages: [...languages].sort() } : {}),
      ...(warning ? { warning } : {}),
    });
    return { ok: true, parts, skipped, ...(warning ? { warning } : {}) };
  } catch (err) {
    const error = (err as Error).message;
    emit({ type: "final.failed", step, error });
    return { ok: false, parts, skipped, error };
  }
}

/** Decodes `[from, to)`; a refused span is halved while longer than `minSplitSeconds`. */
function decodeHalving(
  samples: Float32Array,
  from: number,
  to: number,
  hw: PreparedHotwords,
  o: FinalOptions,
  skip: (from: number, to: number, error: string) => void,
): { text: string; lang?: string } {
  try {
    const r = hw.recognizer.decode(prepareSpan(samples.subarray(from, to)), streamHotwords(hw));
    return { text: r.text.trim(), lang: r.lang };
  } catch (err) {
    if (to - from > o.minSplitSeconds * ASR_RATE) {
      const mid = from + Math.floor((to - from) / 2);
      const a = decodeHalving(samples, from, mid, hw, o, skip);
      const b = decodeHalving(samples, mid, to, hw, o, skip);
      return { text: [a.text, b.text].filter((t) => t !== "").join(" "), lang: a.lang ?? b.lang };
    }
    skip(from, to, (err as Error).message);
    return { text: "" };
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Worker entry and host

export const FINALIZE_WORKER_NAME = "akou-finalize";

type ToFinal = {
  type: "run";
  events: LogEvent[];
  audio: FinalAudioSpec;
  models: ModelSpec;
  decode: DecodeList | null;
  files: { path: string; sha256: string }[];
  options?: Partial<FinalOptions>;
};

type FromFinal =
  | { type: "event"; draft: EventDraft }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | { type: "done"; result: FinalResult; loads: Record<string, number> };

async function runInWorker(m: ToFinal, reply: (r: FromFinal) => void): Promise<void> {
  let result: FinalResult;
  let loads: Record<string, number> = {};
  const emit = (draft: EventDraft) => reply({ type: "event", draft });
  try {
    const models = await loadModelSet(m.models);
    const audio = await openFinalAudio(m.audio);
    try {
      result = await runFinalPass(
        {
          events: m.events,
          audio,
          decode: m.decode,
          files: m.files,
          announced: true,
          options: m.options,
        },
        models,
        emit,
        (level, msg) => reply({ type: "log", level, msg }),
      );
    } finally {
      audio.close?.();
    }
    loads = { ...models.loads };
  } catch (err) {
    const error = (err as Error).message;
    emit({ type: "final.failed", step: "start", error });
    result = { ok: false, parts: [], skipped: [], error };
  }
  reply({ type: "done", result, loads });
}

declare const self: Worker;
if (!Bun.isMainThread && workerData === FINALIZE_WORKER_NAME) {
  const post = (m: FromFinal) => self.postMessage(m);
  const toLog =
    (level: "info" | "warn" | "error") =>
    (...args: unknown[]) =>
      post({ type: "log", level, msg: args.map(String).join(" ") });
  console.log = toLog("info");
  console.info = toLog("info");
  console.warn = toLog("warn");
  console.error = toLog("error");
  self.onmessage = (e: MessageEvent<ToFinal>) => void runInWorker(e.data, post);
}

/** What the host needs of a call: its folder, its writer, and a hold on it past the call's end. */
export interface FinalCall {
  readonly dir: string;
  record(draft: EventDraft): LogEvent | null;
  holdWriter(): () => void;
}

export interface FinalizeOptions {
  models: ModelSpec;
  audio: FinalAudioSpec;
  vocab?: VocabSource;
  options?: Partial<FinalOptions>;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
  /** Runs the pass on this thread. Tests only. */
  inThread?: boolean;
  /** The pass's deadline; defaults to `finalBudgetMs` of the call. */
  budgetMs?: number;
  clock?: Clock;
}

/** Least time a final pass gets, however short the call. */
export const FINAL_MIN_BUDGET_MS = 60_000;

/**
 * How long a final pass may take: half the call's recorded length (DESIGN 3.3 targets 10 to 25 %),
 * and never under a minute. A pass past it is stuck, not slow.
 */
export function finalBudgetMs(events: readonly LogEvent[]): number {
  let seconds = 0;
  for (const e of events) if (e.type === "part.ended") seconds += e.fileSeconds;
  return Math.max(FINAL_MIN_BUDGET_MS, Math.round(seconds * 500));
}

/**
 * Runs the final pass for a call that has ended and appends what it produces. The call's writer is
 * held for the whole pass, so a pass that runs after Stop still writes through the one writer. A
 * pass that outlives its budget (a Worker stuck in a native call answers nothing) is terminated,
 * recorded as `final.failed {step: timeout}`, and the writer released: nothing waits on the
 * Worker without a deadline.
 */
export async function finalizeCall(
  call: FinalCall,
  o: FinalizeOptions,
): Promise<FinalResult & { loads: Record<string, number> }> {
  const release = call.holdWriter();
  // Written before the first await, so the pass is in the log by the time the caller answers: a
  // `finalize --force` followed by `akou wait` never takes the earlier final.done for this one.
  call.record({ type: "final.started", pid: process.pid });
  try {
    const { events } = await readLog(join(call.dir, EVENTS_FILE));
    const view = fold(events);
    const msg: ToFinal = {
      type: "run",
      events,
      audio: o.audio,
      models: o.models,
      decode: callDecodeList(view, modelNameFor(o.models), o.vocab),
      files: [...(o.vocab?.files ?? [])],
      options: o.options,
    };
    const clock = o.clock ?? realClock;
    const budget = o.budgetMs ?? finalBudgetMs(events);
    type Out = FinalResult & { loads: Record<string, number> };
    return await new Promise<Out>((resolve) => {
      let settled = false;
      let w: Worker | null = null;
      const finish = (r: Out) => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timer);
        w?.terminate();
        resolve(r);
      };
      const failWith = (step: string, error: string) => {
        if (settled) return;
        call.record({ type: "final.failed", step, error });
        finish({ ok: false, parts: [], skipped: [], error, loads: {} });
      };
      const timer = clock.setTimeout(
        () => failWith("timeout", `the final pass did not finish within ${budget} ms`),
        budget,
      );
      // Nothing the pass sends after its end (a timeout) reaches the log.
      const onReply = (r: FromFinal) => {
        if (settled) return;
        if (r.type === "event") call.record(r.draft);
        else if (r.type === "log") o.onLog?.(r.level, r.msg);
        else finish({ ...r.result, loads: r.loads });
      };
      if (o.inThread) {
        void runInWorker(msg, onReply);
        return;
      }
      w = new Worker(siblingModule(import.meta.url, "finalize-worker"), {
        workerData: FINALIZE_WORKER_NAME,
      } as WorkerOptions);
      w.onmessage = (e: MessageEvent<FromFinal>) => onReply(e.data);
      w.onerror = (e) => failWith("worker", e.message);
      w.postMessage(msg);
    });
  } finally {
    release();
  }
}
