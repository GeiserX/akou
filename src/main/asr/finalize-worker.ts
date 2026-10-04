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
 *    embeddings (`embeddings`). The call pieces are cut where the turns change, each turn edge
 *    moved to the nearest pause (`timelinePieces`); where two turns overlap, a piece is labelled
 *    with the speaker active longest inside it (one channel carries one transcript, so
 *    overlapping voices share a line). Mic lines are `you`.
 * 4. Every span is gained and padded by `prepareSpan` (the one rule) and decoded with the call's
 *    decode list as it stands when the pass starts, recorded as `vocab.used`. A span the engine
 *    refuses is halved down to 20 s, and only the smallest failing piece is skipped and listed.
 *    The words come from Parakeet (the model set's recognizer) or, when the host names it
 *    (`asr.final.model`), from Qwen on llama-server: the call's language forced when it has one,
 *    lidc among several, the decode list as its glossary. Qwen gives no word times, so a line keeps
 *    its piece's times, and a Qwen that stays down fails the pass instead of costing its text.
 *    How far the pass is goes to the host as it decodes, never to the log.
 * 5. **Output:** `seg` events with `layer: final` (a re-run first retracts the previous final
 *    lines), a `final.part.done` per part as its lines are written, `speaker.map` or
 *    `speaker.suggest` per final cluster (names carry over from the live layer), then one
 *    `final.done` with the parts, the skipped spans and a warning when the call channel had energy
 *    but produced no text.
 *
 * Both passes decode a piece through `decodeUnit(engine, unit, samples, from, to, options, skip)`:
 * one engine, one span, and the engine's whole `Hypothesis` back (text, words with confidences, word
 * times in seconds on the timeline of `samples`, language, unit confidence), the refused-span halving
 * included. Parakeet goes through it as `hotwordEngine(prepared)`. A call's lines keep the text
 * only; a file job's result carries the words too (`jobWord`, SV-J4).
 *
 * A file job's pass runs any number of engines (`runEngines`, ASR-6): every engine decodes every
 * piece, one engine loaded at a time, and confidence ROVER fuses them (the `fusion` preset). A
 * call's pass runs one engine (Parakeet or Qwen, `asr.final.model`) unless the call asks for
 * `fusion`: then the pass cuts every part and channel into its pieces first, keeping a 16-bit copy
 * of each piece's audio (about 0.25 GB per hour of a two-channel call), runs the preset's engines
 * over all of them through the same `runEngines`, and writes the lines from the fused words.
 * `final.done` names the engines that decoded and the ones left out, and why.
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
  type FinalEngine,
  type FusionEngineSpec,
  type FusionSpec,
  type Hypothesis,
  loadModelSet,
  type ModelSet,
  type ModelSpec,
  type PreparedHotwords,
  type WordHyp,
} from "./engine.ts";
import type { FinalStep } from "./final-text.ts";
import { type BuiltFuser, fusionModelId } from "./fusion.ts";
import { callDecodeList, modelNameFor, streamHotwords, type VocabSource } from "./live-worker.ts";
import { peak, prepareSpan } from "./pad.ts";
import { RoverFuser } from "./rover.ts";
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
  /** A call piece with no diarization span within this many seconds is `s?` (a job's never is). */
  attachSeconds: number;
  /** A diarizer's turn edge cuts at the nearest pause within this many seconds of it. */
  snapSeconds: number;
}

export const DEFAULT_FINAL: FinalOptions = {
  chunkSeconds: 600,
  maxSpanSeconds: 30,
  minSplitSeconds: 20,
  silenceDbfs: -50,
  minGapSeconds: 0.3,
  attachSeconds: 1,
  snapSeconds: 0.5,
};

/** One part's stereo audio at 16 kHz, read by channel index. */
export interface FinalAudio {
  /** Frames in the part; 0 when it has no audio. */
  length(part: number): number;
  read(part: number, ch: Channel, from: number, n: number): Float32Array;
  close?(): void;
}

/**
 * Where the Worker reads audio: a part's Ogg Opus file decoded by the capture helper
 * (`akou-capture decode`, SV-P10), a 16-bit stereo WAV at 16 kHz beside it (what hark and the fake
 * helper produce), or a module (tests).
 */
export type FinalAudioSpec =
  | { kind: "opus"; command: string[]; files: Record<number, string> }
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
  /** The call's language for an engine that takes one (Qwen): a tag, or `auto`. */
  language?: string;
  /** The call's decode list as a glossary, for an engine that takes one (Qwen's context). */
  glossary?: readonly string[];
  /**
   * How far the pass is: seconds of the call covered and the call's length. Both channels count,
   * each by the audio it decodes, so it moves about evenly; nothing is written to the log for it.
   */
  progress?(done_s: number, total_s: number, step: FinalStep): void;
  options?: Partial<FinalOptions>;
}

export interface FinalResult {
  ok: boolean;
  /** The recognizer the pass decoded with. */
  model?: string;
  parts: number[];
  skipped: SkippedSpan[];
  warning?: string;
  error?: string;
  /** Seconds of call audio the pass decoded, for this machine's measured speed (SV-U6). */
  audio_s?: number;
  /**
   * Seconds the VAD and the recognizer spent on that audio (SV-U6). Model loads and speaker labels
   * are not in it, so it compares with the published decode speed.
   */
  decode_s?: number;
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

// ---------------------------------------------------------------------------
// Opus parts, decoded by the capture helper

/**
 * A part's Ogg Opus file, decoded by the helper that wrote it: `decode --info` for the length,
 * `decode --from F --frames N` for a range, stereo f32 at 16 kHz on stdout. The app has no Opus
 * decoder of its own and writes no WAV (SV-P10). A read decodes only its range, so the energy scan
 * never holds a whole part. The last range decoded is kept, both channels, and each read is a fresh
 * array. A part within one chunk is decoded once, since every later read asks for that same range.
 * A longer part is read one channel at a time (the energy check per channel, the speaker labels the
 * whole call, the text the whole mic and then the whole call), so the cache rarely hits and the part
 * is decoded up to three times.
 */
export class OpusParts implements FinalAudio {
  private readonly lengths = new Map<number, number>();
  /** The last range decoded, both channels interleaved. */
  private last: { part: number; from: number; n: number; stereo: Float32Array } | null = null;

  constructor(
    private readonly command: readonly string[],
    private readonly files: Record<number, string>,
  ) {}

  private run(part: number, args: string[]): Uint8Array {
    const file = this.files[part] as string;
    const r = Bun.spawnSync([...this.command, "decode", "--in", file, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      const lines = r.stderr.toString().trim().split("\n");
      let why = lines.at(-1) || `exit ${r.exitCode}`;
      try {
        why = (JSON.parse(why) as { msg?: string }).msg ?? why;
      } catch {}
      throw new Error(`the capture helper could not decode part ${part}: ${why}`);
    }
    return r.stdout;
  }

  length(part: number): number {
    if (!this.files[part]) return 0;
    let n = this.lengths.get(part);
    if (n === undefined) {
      const line = new TextDecoder().decode(this.run(part, ["--info"])).trim();
      n = Number((JSON.parse(line) as { frames?: unknown }).frames);
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error(`part ${part}: bad decode info ${line}`);
      this.lengths.set(part, n);
    }
    return n;
  }

  read(part: number, ch: Channel, from: number, n: number): Float32Array {
    let l = this.last;
    if (!l || l.part !== part || l.from !== from || l.n !== n) {
      const count = Math.max(0, Math.min(n, this.length(part) - from));
      const raw =
        count > 0
          ? this.run(part, ["--from", String(from), "--frames", String(count)])
          : new Uint8Array(0);
      // A pipe's bytes need not sit on a 4-byte boundary; copied only when they do not.
      const bytes = raw.byteOffset % 4 === 0 ? raw : new Uint8Array(raw);
      const frames = Math.min(count, raw.length >> 3);
      l = { part, from, n, stereo: new Float32Array(bytes.buffer, bytes.byteOffset, frames * 2) };
      this.last = l;
    }
    const out = new Float32Array(l.stereo.length >> 1);
    // Channel by index: left (0) is the mic, right (1) is the call.
    const off = ch === "mic" ? 0 : 1;
    for (let i = 0; i < out.length; i++) out[i] = l.stereo[2 * i + off] as number;
    return out;
  }

  close(): void {
    this.last = null;
  }
}

export async function openFinalAudio(spec: FinalAudioSpec): Promise<FinalAudio> {
  if (spec.kind === "opus") return new OpusParts(spec.command, spec.files);
  if (spec.kind === "wav") return new WavParts(spec.files);
  const mod = (await import(spec.path)) as { createAudio(o: unknown): FinalAudio };
  return mod.createAudio(spec.options);
}

// ---------------------------------------------------------------------------
// The pass

/**
 * Samples in -1..1 as 16-bit, clamped: how a fusion pass keeps its pieces between engines. The
 * scale is the readers' (`/ 32768`), so audio that came from 16-bit samples comes back exactly and
 * a fusion pass decodes what a single pass decodes.
 */
export function toPcm16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++)
    out[i] = Math.max(-32768, Math.min(32767, Math.round((x[i] as number) * 32768)));
  return out;
}

/** 16-bit samples back to -1..1, as the readers turn them into floats. */
export function fromPcm16(x: Int16Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = (x[i] as number) / 32768;
  return out;
}

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
 *
 * `turns` (seconds) are a diarizer's turns, and their edges are cut points, but not as they
 * stand: the model places an edge a frame or two off the pause it belongs to, and a cut there
 * leaves the tail of a word, or a sliver of the pause, as a piece of its own, which an engine
 * decodes into a filler ("Yeah.") or a fragment. Each edge moves to the quietest window of the
 * nearest pause within `snapSeconds`, the window a non-speech run's own cut takes, so the edges
 * and the run's cut are one cut. With no pause in reach (the speakers change with no pause
 * between them) the edge cuts at the quietest window within reach. An edge reaches at most
 * under half its turn, so a short turn's two edges never meet on one cut and a quick "ok" keeps
 * its own piece and label. A pause is a window the VAD `heard` no speech in; `speech` may count
 * more as speech (a job keeps a pad beside the speech), and a pause of `heard` inside that never
 * takes a cut of its own.
 */
export function timelinePieces(
  samples: Float32Array,
  speech: readonly boolean[],
  window: number,
  o: FinalOptions,
  turns: readonly { start: number; end: number }[] = [],
  heard: readonly boolean[] = speech,
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
  const snapEdge = (at: number, reach: number): number => {
    const c = Math.min(nWin - 1, Math.max(0, at));
    for (let d = 0; d <= reach; d++) {
      for (const w of [c - d, c + d]) {
        if (w < 0 || w >= nWin || heard[w]) continue;
        let a = w;
        while (a > 0 && !heard[a - 1]) a--;
        let e = w + 1;
        while (e < nWin && !heard[e]) e++;
        return quietest(a, e);
      }
    }
    return quietest(Math.max(0, c - reach), Math.min(nWin, c + reach + 1));
  };
  const snapWins = Math.round((o.snapSeconds * ASR_RATE) / window);
  const cuts = new Set<number>();
  for (const t of turns) {
    const a = Math.round((t.start * ASR_RATE) / window);
    const b = Math.round((t.end * ASR_RATE) / window);
    const reach = Math.min(snapWins, Math.max(0, Math.floor((b - a - 1) / 2)));
    cuts.add(snapEdge(a, reach));
    cuts.add(snapEdge(b, reach));
  }
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
  engine?: FinalEngine | FusionPass,
): Promise<FinalResult> {
  const o = { ...DEFAULT_FINAL, ...input.options };
  const fusion = engine && "engines" in engine ? engine : null;
  const one = engine && !("engines" in engine) ? engine : undefined;
  const view = fold(input.events);
  const audio = input.audio;
  const chunk = Math.round(o.chunkSeconds * ASR_RATE);
  const floor = 10 ** (o.silenceDbfs / 20);
  const parts = view
    .parts()
    .map((p) => p.part)
    .filter((p) => audio.length(p) > 0);
  const skipped: SkippedSpan[] = [];
  // With an engine (Qwen) the model set's recognizer is never prepared, so it never loads. The
  // recognizer's name is known before it loads; the lines take the loaded one's own. A fusion
  // pass is named by its whole list until it has run, then by the engines that decoded.
  let modelId = fusion
    ? fusion.engines.length === 1
      ? (fusion.engines[0] as FinalEngine).id
      : fusionModelId(
          fusion.fuser,
          fusion.engines.map((e) => e.id),
        )
    : one
      ? one.id
      : models.recognizerModel;
  let step = "energy";
  if (!input.announced)
    emit({ type: "final.started", pid: input.pid ?? process.pid, model: modelId });
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
      emit({ type: "final.done", parts, skipped: [], model: modelId });
      return { ok: true, parts, skipped, model: modelId };
    }

    // Progress: the call's length, and the audio of every channel with sound as the work.
    const callSeconds = parts.reduce((n, p) => n + audio.length(p), 0) / ASR_RATE;
    let work = 0;
    for (const p of parts)
      for (const ch of CHANNELS) if (energy.get(`${p}:${ch}`)) work += audio.length(p);
    let worked = 0;
    // Only decoding moves the figure; before it, the step says what the pass is doing.
    const progress = (inChannel: number, at: FinalStep = "decoding") =>
      input.progress?.(
        work > 0 ? Math.min(callSeconds, (callSeconds * (worked + inChannel)) / work) : 0,
        callSeconds,
        at,
      );

    step = "models";
    progress(0, "starting");
    // Qwen's llama-server starts now, so the step says so while it loads. A start that fails is
    // tried again by the first piece's decode, which restarts it once before the pass fails.
    if (one) {
      try {
        await one.load();
      } catch (err) {
        log("warn", `${one.id} did not start: ${(err as Error).message}; trying again`);
      }
    }
    const glossary = input.glossary ?? input.decode?.entries.map((e) => e.term) ?? [];
    const hw = engine ? null : models.prepare(input.decode);
    if (hw) modelId = hw.recognizer.model;
    emit({
      type: "vocab.used",
      entries: hw ? hw.entries : [...glossary],
      files: (input.files ?? []).map((f) => f.path),
      sha256: (input.files ?? []).map((f) => f.sha256),
      model: hw ? hw.recognizer.model : modelId,
    });
    for (const d of hw?.dropped ?? []) log("error", `hotword "${d.term}" dropped: ${d.reason}`);
    for (const w of hw?.warnings ?? []) log("warn", w);
    const unit = { lang: input.language ?? "auto", glossary };
    const decoder = fusion ? null : (one ?? hotwordEngine(hw as PreparedHotwords));

    // 3. Diarization over the call channel of all parts, concatenated.
    step = "diarize";
    const callParts = parts.filter((p) => energy.get(`${p}:call`));
    const spansByPart = new Map<number, DiarizedSpan[]>();
    if (callParts.length > 0) {
      progress(0, "speakers");
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

    // 2 and 4. Whole-timeline decode, per part. The recognizer loaded in `prepare` above.
    step = "decode";
    progress(0);
    const decodeFrom = performance.now();
    const languages = new Set<string>();
    let callText = false;
    let callEnergy = false;
    const finals: TimedLabel[] = [];
    type Line = Omit<Extract<EventDraft, { type: "seg" }>, "id">;
    /** A decoded piece as a line of part `p`, or nothing when it has no text. */
    const lineOf = (
      p: number,
      ch: Channel,
      piece: Piece,
      r: Hypothesis,
      clock: { wallFromAudio(a: number): number },
      spans: readonly DiarizedSpan[],
    ): Line | null => {
      if (r.lang) languages.add(r.lang);
      if (r.text === "") return null;
      if (ch === "call") callText = true;
      const a0 = piece.from / ASR_RATE;
      const a1 = piece.to / ASR_RATE;
      const spk = ch === "mic" ? "you" : labelPiece(piece, spans, o.attachSeconds);
      const w0 = Math.round(clock.wallFromAudio(a0));
      const w1 = Math.round(clock.wallFromAudio(a1));
      if (ch === "call") finals.push({ spk, t0: w0, t1: w1 });
      return {
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
        model: modelId,
        ...(r.lang ? { lang: r.lang } : {}),
      };
    };
    const closePart = (p: number, lines: Line[]) => {
      lines.sort((a, b) => (a.w0 as number) - (b.w0 as number) || (a.ch === "mic" ? -1 : 1));
      for (const l of lines) {
        layer.push({ ...l, id: `f${String(nextFinal).padStart(6, "0")}` } as EventDraft);
        nextFinal++;
      }
      layer.push({ type: "final.part.done", part: p });
    };
    let fused: { engines: string[]; dropped: EngineDrop[] } | null = null;
    if (fusion) {
      // Every piece of every part and channel first, each with a copy of its audio: each engine in
      // turn decodes all of them (`runEngines`), so the channels cannot be read one at a time.
      const units: {
        p: number;
        ch: Channel;
        piece: Piece;
        /** The piece's audio as 16-bit samples, half the memory, widened again for each decode. */
        pcm: Int16Array;
        spans: readonly DiarizedSpan[];
      }[] = [];
      for (const p of parts) {
        if (!view.part(p)?.clock) continue;
        for (const ch of CHANNELS) {
          if (!energy.get(`${p}:${ch}`)) continue;
          if (ch === "call") callEnergy = true;
          const samples = readAll(audio, p, ch, chunk);
          const { flags, window } = speechFlags(samples, models);
          const spans = spansByPart.get(p) ?? [];
          for (const piece of timelinePieces(samples, flags, window, o, ch === "call" ? spans : []))
            units.push({
              p,
              ch,
              piece,
              pcm: toPcm16(samples.subarray(piece.from, piece.to)),
              spans,
            });
        }
      }
      const total = units.reduce((n, u) => n + u.pcm.length, 0);
      const ends: number[] = [];
      for (const u of units) ends.push((ends.at(-1) ?? 0) + u.pcm.length);
      const pass =
        units.length > 0
          ? await runEngines(
              fusion.engines,
              units.map((u) => ({
                // A fresh array per engine's decode: nothing holds the widened copy after it.
                get samples() {
                  return fromPcm16(u.pcm);
                },
                from: 0,
                to: u.pcm.length,
              })),
              {
                fuser: fusion.fuser,
                lang: unit.lang,
                glossary,
                minSplitSeconds: o.minSplitSeconds,
                memoryBudgetMb: fusion.memoryBudgetMb,
                log,
                // Piece by piece over every engine, as a job's pass counts it: engine `k` of `n`
                // at piece `u` has done `k` whole passes and `ends[u]` samples of one more.
                onUnit: (u, k, n) => {
                  const done = (k * total + (ends[u] as number)) / (n * total);
                  input.progress?.(callSeconds * done, callSeconds, "decoding");
                },
              },
            )
          : null;
      if (pass) modelId = pass.model;
      fused = {
        engines: (pass?.ran ?? []).filter((r) => r.units > 0).map((r) => r.id),
        dropped: [...(fusion.dropped ?? []), ...(pass?.dropped ?? [])],
      };
      for (const k of pass?.skipped ?? []) {
        const u = units[k.unit] as (typeof units)[number];
        skipped.push({
          part: u.p,
          ch: u.ch,
          a0: (u.piece.from + k.from) / ASR_RATE,
          a1: (u.piece.from + k.to) / ASR_RATE,
          error: k.error,
        });
      }
      for (const p of parts) {
        const clock = view.part(p)?.clock;
        if (!clock) continue;
        const lines: Line[] = [];
        for (const [k, u] of units.entries()) {
          if (u.p !== p) continue;
          const l = lineOf(
            p,
            u.ch,
            u.piece,
            (pass as EnginesResult).hyps[k] as Hypothesis,
            clock,
            u.spans,
          );
          if (l) lines.push(l);
        }
        closePart(p, lines);
      }
    } else {
      for (const p of parts) {
        const clock = view.part(p)?.clock;
        if (!clock) continue;
        const lines: Line[] = [];
        for (const ch of CHANNELS) {
          if (!energy.get(`${p}:${ch}`)) continue;
          if (ch === "call") callEnergy = true;
          const samples = readAll(audio, p, ch, chunk);
          const { flags, window } = speechFlags(samples, models);
          const spans = spansByPart.get(p) ?? [];
          const turns = ch === "call" ? spans : [];
          for (const piece of timelinePieces(samples, flags, window, o, turns)) {
            const skip = (from: number, to: number, error: string) =>
              skipped.push({ part: p, ch, a0: from / ASR_RATE, a1: to / ASR_RATE, error });
            // Qwen: an engine that stays down (it failed twice) fails the pass, never falls back.
            // The words come back with the text; the log keeps the text only.
            const r = await decodeUnit(
              decoder as FinalEngine,
              unit,
              samples,
              piece.from,
              piece.to,
              o,
              skip,
            );
            progress(piece.to);
            const l = lineOf(p, ch, piece, r, clock, spans);
            if (l) lines.push(l);
          }
          worked += samples.length;
          progress(0);
        }
        closePart(p, lines);
      }
    }
    const decode_s = (performance.now() - decodeFrom) / 1000;
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
      model: modelId,
      ...(fused ? { engines: fused.engines, dropped: fused.dropped } : {}),
    });
    const audio_s = parts.reduce((n, p) => n + audio.length(p), 0) / ASR_RATE;
    return {
      ok: true,
      model: modelId,
      parts,
      skipped,
      audio_s,
      decode_s,
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    const error = (err as Error).message;
    emit({ type: "final.failed", step, error });
    return { ok: false, model: modelId, parts, skipped, error };
  }
}

/**
 * Decodes `samples[from, to)` with one engine and returns the engine's whole `Hypothesis`: the text
 * trimmed, the words with their confidences, the language, the unit confidence and the decode time.
 * The span is gained and padded by `prepareSpan` first. Word times come back in seconds on the
 * timeline of `samples` (the span's start added) and clamped into the span, since the padding after
 * a short span is no audio; a word the engine gave no times (Qwen gives none) keeps none.
 *
 * A span the engine refuses is halved while longer than `minSplitSeconds`, and the halves are
 * joined (`joinHalves`); only the smallest refused piece is skipped, reported to `skip` and decoded
 * as an empty hypothesis. An error marked `fatal` (the engine is down: Qwen's llama-server failed
 * twice) ends the caller's pass instead of costing one span, so a job never comes back done with its
 * text missing.
 */
export async function decodeUnit(
  engine: FinalEngine,
  unit: { lang: string; glossary: readonly string[]; allowed?: readonly string[] },
  samples: Float32Array,
  from: number,
  to: number,
  o: Pick<FinalOptions, "minSplitSeconds">,
  skip: (from: number, to: number, error: string) => void = () => {},
): Promise<Hypothesis> {
  try {
    const h = await engine.decode({ ...unit, samples: prepareSpan(samples.subarray(from, to)) });
    const a = from / ASR_RATE;
    const b = to / ASR_RATE;
    const at = (t: number) => Math.min(b, a + Math.max(0, t));
    const out: Hypothesis = {
      engine: h.engine,
      text: h.text.trim(),
      words: h.words.map((w) => {
        const x: WordHyp = { ...w };
        if (w.t0 !== undefined) x.t0 = at(w.t0);
        if (w.t1 !== undefined) x.t1 = at(w.t1);
        return x;
      }),
      ms: h.ms,
    };
    if (h.lang) out.lang = h.lang;
    if (h.conf !== undefined) out.conf = h.conf;
    return out;
  } catch (err) {
    if ((err as { fatal?: boolean }).fatal) throw err;
    if (to - from > o.minSplitSeconds * ASR_RATE) {
      const mid = from + Math.floor((to - from) / 2);
      const x = await decodeUnit(engine, unit, samples, from, mid, o, skip);
      const y = await decodeUnit(engine, unit, samples, mid, to, o, skip);
      return joinHalves(x, y);
    }
    skip(from, to, (err as Error).message);
    return { engine: engine.id, text: "", words: [], ms: 0 };
  }
}

/**
 * Two halves of a refused span as one hypothesis: the texts joined with a space (an empty half adds
 * nothing), the words in order, the first language either half heard, the decode times summed and
 * the unit confidences averaged.
 */
export function joinHalves(a: Hypothesis, b: Hypothesis): Hypothesis {
  const out: Hypothesis = {
    engine: a.engine,
    text: [a.text, b.text].filter((t) => t !== "").join(" "),
    words: [...a.words, ...b.words],
    ms: a.ms + b.ms,
  };
  const lang = a.lang ?? b.lang;
  if (lang) out.lang = lang;
  const confs = [a.conf, b.conf].filter((c) => c !== undefined);
  if (confs.length > 0) out.conf = confs.reduce((x, y) => x + y, 0) / confs.length;
  return out;
}

/**
 * The prepared recognizer (Parakeet on sherpa-onnx, or the CI fake) as a `FinalEngine` that decodes
 * with the decode list's hotwords where the decoding takes them (`streamHotwords`), so the call and
 * job passes decode it through `decodeUnit` as they do Qwen. Loading is `prepare`'s, done already.
 */
export function hotwordEngine(hw: PreparedHotwords): FinalEngine {
  const rec = hw.recognizer;
  return {
    id: rec.model,
    features: { confidence: true, timestamps: true, glossary: false, languageId: false },
    load: async () => {},
    unload: async () => {},
    decode: async (u) => {
      const t = performance.now();
      const r = rec.decode(u.samples, streamHotwords(hw));
      const h: Hypothesis = {
        engine: rec.model,
        text: r.text,
        words: r.words ?? [],
        ms: performance.now() - t,
      };
      if (r.lang) h.lang = r.lang;
      return h;
    },
  };
}

// ---------------------------------------------------------------------------
// The N-engine pass (ASR-6)

/** One unit of the N-engine pass: `samples[from, to)`, a piece of the timeline. */
export interface EngineUnit {
  samples: Float32Array;
  from: number;
  to: number;
}

/** An engine that loaded and decoded in the pass. */
export interface EngineRun {
  id: string;
  /** Units it decoded whole; the fused model id names the engines with at least one. */
  units: number;
  /** Seconds it spent decoding, refused units included, its load not counted. */
  decode_s: number;
  /** Seconds its load took (a llama-server's start, a model read from disk). */
  load_s: number;
}

/** An engine the pass went on without, and why. */
export interface EngineDrop {
  engine: string;
  reason: string;
  /** Units it was dropped for; null when it decoded none (over budget, or it would not load). */
  units: number | null;
}

export interface EnginesOptions {
  /** `asr.fusion`. */
  fuser: BuiltFuser;
  /** The job's or call's language: forced on every engine when it is not `auto`. */
  lang: string;
  glossary: readonly string[];
  /** The languages an `auto` decode may choose among (a job's `languages[]`), over the engine's. */
  allowed?: readonly string[];
  minSplitSeconds: number;
  /** An engine whose `memoryMb` is over this is dropped before it loads. 0 or absent: none. */
  memoryBudgetMb?: number;
  log?(level: "info" | "warn" | "error", msg: string): void;
  /**
   * Unit `u` was decoded, whole or in part, by the engine whose turn is `k` of `n` (0-based, in the
   * order the engines run, a dropped one's turn included): a job's progress over every engine.
   */
  onUnit?(u: number, k: number, n: number): void;
}

export interface EnginesResult {
  /** One hypothesis per unit, fused; word times on the timeline of the unit's samples. */
  hyps: Hypothesis[];
  /**
   * The pieces of a unit no engine decoded: when every engine refused some of a unit, the first
   * engine's partial hypothesis stands and its refused pieces are listed here.
   */
  skipped: { unit: number; from: number; to: number; error: string }[];
  /**
   * The model the result carries: with a list of one, that engine's id; with more,
   * `<fuser>(<id>,<id>,...)` over the engines that decoded at least one unit, in list order.
   */
  model: string;
  ran: EngineRun[];
  dropped: EngineDrop[];
}

/** A hypothesis with text and no words gets its words from the text, with no times or confidence. */
function withWords(h: Hypothesis): Hypothesis {
  if (h.words.length > 0 || h.text === "") return h;
  return {
    ...h,
    words: h.text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => ({ w })),
  };
}

/**
 * Runs `engines` over `units`, one engine after another, then fuses each unit (ASR-6,
 * docs/research/asr-architecture.md sections 4 and 5).
 *
 * - **One engine at a time.** Each engine loads before its turn and, with more than one in the
 *   list, unloads after it, so one Metal model is resident at a time (section 2.3: two Metal engines
 *   together ran out of memory, and llama-server answered 500 until restarted). A list of one keeps
 *   its engine loaded, as a single-engine job always has (Qwen's llama-server stays up between jobs).
 * - **The memory budget.** An engine whose estimate is over `memoryBudgetMb` is dropped before it
 *   loads. The engines never run together, so each is held against the budget alone.
 * - **The language.** The job's language, when it has one, is forced on every engine. On `auto`
 *   the first engine in the list that identifies languages (Qwen, Whisper) runs first, and each
 *   later engine decodes a unit in the language the earliest such engine in the list reported for
 *   it, so Canary, which must be told one, gets it, and Whisper does not wander into another. A unit
 *   no engine reported a language for stays `auto`.
 * - **A failing engine is isolated.** An engine that will not load (it is tried twice) is dropped
 *   for the whole pass; one that refuses part of a unit even after halving is dropped for that unit;
 *   one whose error is `fatal` (Qwen's llama-server down after a restart, a transcribe-cpp model
 *   that will not open) is dropped for the rest of the pass and keeps the units it decoded. The pass
 *   fails only when a unit is left with no engine: it throws, with the engine's own error when the
 *   list has one engine. A unit every engine refused part of keeps the first engine's partial
 *   hypothesis, its refused pieces listed, as a single-engine pass always has.
 * - **The fuser**, in list order: `rover-conf` and `rover-freq` vote word by word
 *   (`RoverFuser`), `first` takes the first engine's hypothesis. A unit one engine decoded is that
 *   engine's hypothesis. An engine that gives text and no words gets the text's words.
 */
export async function runEngines(
  engines: readonly FinalEngine[],
  units: readonly EngineUnit[],
  o: EnginesOptions,
): Promise<EnginesResult> {
  const log = o.log ?? (() => {});
  const n = engines.length;
  if (n === 0) throw new Error("no engine to run");
  type Partial = { h: Hypothesis; skips: EnginesResult["skipped"] };
  const whole: (Hypothesis | null)[][] = engines.map(() => units.map(() => null));
  const partial: (Partial | null)[][] = engines.map(() => units.map(() => null));
  /** The language a unit was heard in, and the list index of the engine that said so. */
  const heard: ({ lang: string; by: number } | null)[] = units.map(() => null);
  const runs: (EngineRun | null)[] = engines.map(() => null);
  const dropped: EngineDrop[] = [];
  const errors: (Error | null)[] = engines.map(() => null);
  const remaining = engines.map((_, i) => i);
  let identified = false;
  while (remaining.length > 0) {
    // On `auto`, the first engine that identifies languages goes first, so the rest can use it.
    let at = 0;
    if (o.lang === "auto" && !identified) {
      const k = remaining.findIndex((i) => (engines[i] as FinalEngine).features.languageId);
      if (k >= 0) at = k;
    }
    const idx = remaining.splice(at, 1)[0] as number;
    const e = engines[idx] as FinalEngine;
    const turn = n - remaining.length - 1;
    const drop = (reason: string, units: number | null, err: Error) => {
      dropped.push({ engine: e.id, reason, units });
      errors[idx] = err;
      log("warn", `${e.id} dropped${units === null ? "" : ` for ${units} unit(s)`}: ${reason}`);
    };
    const budget = o.memoryBudgetMb ?? 0;
    if (budget > 0 && e.memoryMb !== undefined && e.memoryMb > budget) {
      const reason = `needs about ${e.memoryMb} MB, over the memory budget of ${budget} MB (asr.memoryBudgetMb)`;
      drop(reason, null, new Error(`${e.id} ${reason}`));
      continue;
    }
    let loadError: Error | null = null;
    const loadFrom = performance.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await e.load();
        loadError = null;
        break;
      } catch (err) {
        loadError = err as Error;
        if (attempt === 0) log("warn", `${e.id} did not load: ${loadError.message}; trying again`);
      }
    }
    if (loadError) {
      drop(`did not load: ${loadError.message}`, null, loadError);
      await e.unload().catch(() => {});
      continue;
    }
    const run: EngineRun = {
      id: e.id,
      units: 0,
      decode_s: 0,
      load_s: round3((performance.now() - loadFrom) / 1000),
    };
    let refused = 0;
    let firstRefusal = "";
    try {
      for (const [u, unit] of units.entries()) {
        const lang = o.lang !== "auto" ? o.lang : (heard[u]?.lang ?? "auto");
        const skips: EnginesResult["skipped"] = [];
        const t = performance.now();
        let h: Hypothesis;
        try {
          h = await decodeUnit(
            e,
            { lang, glossary: o.glossary, allowed: o.allowed },
            unit.samples,
            unit.from,
            unit.to,
            o,
            (from, to, error) => skips.push({ unit: u, from, to, error }),
          );
        } catch (err) {
          // Fatal: the engine is down for the rest of the pass, and keeps the units it decoded.
          drop((err as Error).message, units.length - u, err as Error);
          break;
        }
        run.decode_s += (performance.now() - t) / 1000;
        o.onUnit?.(u, turn, n);
        // Fusion aligns words; a single engine's result keeps exactly what the engine gave.
        if (n > 1) h = withWords(h);
        const said = heard[u];
        if (h.lang && (!said || said.by > idx)) heard[u] = { lang: h.lang, by: idx };
        if (skips.length > 0) {
          (partial[idx] as (Partial | null)[])[u] = { h, skips };
          refused++;
          firstRefusal ||= (skips[0] as { error: string }).error;
          continue;
        }
        (whole[idx] as (Hypothesis | null)[])[u] = h;
        run.units++;
      }
    } finally {
      if (n > 1) {
        await e.unload().catch((err) => log("warn", `${e.id}: unload failed: ${err}`));
      }
    }
    if (refused > 0) {
      dropped.push({ engine: e.id, reason: firstRefusal, units: refused });
      log("warn", `${e.id} refused ${refused} unit(s): ${firstRefusal}`);
    }
    run.decode_s = round3(run.decode_s);
    runs[idx] = run;
    if (e.features.languageId && run.units > 0) identified = true;
  }

  const fuser = o.fuser === "first" ? null : new RoverFuser(o.fuser);
  const hyps: Hypothesis[] = [];
  const skipped: EnginesResult["skipped"] = [];
  for (const [u] of units.entries()) {
    const done = whole.flatMap((row) => (row[u] ? [row[u] as Hypothesis] : []));
    if (done.length > 0) {
      hyps.push(fuser && done.length > 1 ? fuser.fuseSync(done) : (done[0] as Hypothesis));
      continue;
    }
    const part = partial.find((row) => row[u])?.[u];
    if (part) {
      hyps.push(part.h);
      skipped.push(...part.skips);
      continue;
    }
    // Every engine was dropped before it decoded this unit: no engine is left.
    const only = n === 1 ? errors[0] : null;
    if (only) throw only;
    throw Object.assign(
      new Error(
        `no engine is left to decode with: ${dropped.map((d) => `${d.engine}: ${d.reason}`).join("; ")}`,
      ),
      { code: "engine_unavailable", fatal: true },
    );
  }
  const ran = runs.filter((r): r is EngineRun => r !== null);
  const model =
    n === 1
      ? (engines[0] as FinalEngine).id
      : fusionModelId(
          o.fuser,
          ran.filter((r) => r.units > 0).map((r) => r.id),
        );
  return { hyps, skipped, model, ran, dropped };
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
  | { type: "progress"; done_s: number; total_s: number; step: FinalStep }
  /** A child process the Worker started (llama-server) or saw end, for the host to kill orphans. */
  | { type: "child"; pid: number; alive: boolean }
  | { type: "done"; result: FinalResult; loads: Record<string, number> };

/** The Worker sends its progress at most this often, ms; the last value always goes. */
const PROGRESS_EVERY_MS = 1000;

async function runInWorker(m: ToFinal, reply: (r: FromFinal) => void): Promise<void> {
  let result: FinalResult;
  let loads: Record<string, number> = {};
  const emit = (draft: EventDraft) => reply({ type: "event", draft });
  const log = (level: "info" | "warn" | "error", msg: string) => reply({ type: "log", level, msg });
  let models: ModelSet | undefined;
  let engine: FinalEngine | undefined;
  let fused: FinalEngine[] = [];
  // The VAD and the speaker labels come from the model set; the words from Qwen when it is named,
  // or from the fusion list's engines.
  const { final: llama, fusion, ...setSpec } = m.models;
  let sent = Number.NEGATIVE_INFINITY;
  let sentStep: FinalStep | null = null;
  // A new step always goes; within decoding, at most once a second, and the last figure.
  const progress = (done_s: number, total_s: number, step: FinalStep) => {
    const now = performance.now();
    if (step === sentStep && now - sent < PROGRESS_EVERY_MS && done_s < total_s) return;
    sent = now;
    sentStep = step;
    reply({ type: "progress", done_s, total_s, step });
  };
  try {
    models = await loadModelSet(setSpec as ModelSpec);
    if (fusion) fused = await fusionEngines(fusion, models, m.decode, reply);
    else if (llama) {
      const { createLlamaEngine } = await import("./llama-server.ts");
      engine = createLlamaEngine(llama, {
        onChild: (pid, alive) => reply({ type: "child", pid, alive }),
        log,
      });
    }
    const langs =
      llama?.languages ??
      fusion?.engines.flatMap((e) => ("languages" in e && e.languages ? [e.languages] : []))[0] ??
      [];
    const audio = await openFinalAudio(m.audio);
    try {
      result = await runFinalPass(
        {
          events: m.events,
          audio,
          decode: m.decode,
          files: m.files,
          announced: true,
          // One language is forced; several are lidc among them (QwenEngine's `allowed`).
          language: langs.length === 1 ? (langs[0] as string) : "auto",
          progress,
          options: m.options,
        },
        models,
        emit,
        log,
        fusion
          ? {
              engines: fused,
              fuser: fusion.fuser,
              memoryBudgetMb: fusion.memoryBudgetMb,
              dropped: fusion.dropped,
            }
          : engine,
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
  // Qwen's llama-server stops with the pass: it holds the GPU and gigabytes of memory. So does
  // every engine of a fusion list (one left loaded when it was the only one).
  await engine?.unload().catch(() => {});
  for (const e of fused) await e.unload().catch(() => {});
  // Before the answer: the host terminates this Worker on it, and a terminated Worker never frees
  // a model still waiting on its finalizer (`ModelSet.release`).
  await models?.release?.();
  reply({ type: "done", result, loads });
}

declare const self: Worker;
if (!Bun.isMainThread && workerData === FINALIZE_WORKER_NAME) {
  const post = (m: FromFinal | FromJob) => self.postMessage(m);
  const toLog =
    (level: "info" | "warn" | "error") =>
    (...args: unknown[]) =>
      post({ type: "log", level, msg: args.map(String).join(" ") });
  console.log = toLog("info");
  console.info = toLog("info");
  console.warn = toLog("warn");
  console.error = toLog("error");
  self.onmessage = (e: MessageEvent<ToFinal | ToJob>) =>
    void (e.data.type === "job" ? runJobInWorker(e.data, post) : runInWorker(e.data, post));
}

/** What the host needs of a call: its folder, its writer, and a hold on it past the call's end. */
export interface FinalCall {
  readonly dir: string;
  record(draft: EventDraft): LogEvent | null;
  holdWriter(): () => void;
}

export interface FinalizeOptions {
  /** The model set; with `final`, Qwen on llama-server writes the words. */
  models: ModelSpec;
  audio: FinalAudioSpec;
  vocab?: VocabSource;
  options?: Partial<FinalOptions>;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
  /** How far the pass is (`FinalInput.progress`), at most once a second, and each new step. */
  onProgress?(done_s: number, total_s: number, step: FinalStep): void;
  /**
   * Waited for after `final.started` is written and before the pass starts: the Qwen pass ahead,
   * one at a time. The budget counts from when it resolves.
   */
  waitFor?: Promise<unknown>;
  /** The wait is over and the pass starts. */
  onStarted?(): void;
  /**
   * Aborts the pass (the app quitting): its Worker is terminated and its llama-server stopped,
   * nothing more is written, and the next start's catch-up runs it again.
   */
  signal?: AbortSignal;
  /** Runs the pass on this thread. Tests only. */
  inThread?: boolean;
  /** The pass's deadline; defaults to `finalBudgetMs` of the call. */
  budgetMs?: number;
  clock?: Clock;
}

/** Least time a final pass gets, however short the call. */
export const FINAL_MIN_BUDGET_MS = 60_000;

/**
 * Time a pass on Qwen gets beyond its budget: llama-server's own start, which may unpack its build
 * and load the model, and which it is given up to 300 s for (`LlamaServer`'s health deadline).
 */
export const FINAL_LLAMA_START_MS = 300_000;

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
  const fusion = o.models.fusion;
  const model = fusion
    ? fusion.engines.length === 1
      ? (fusion.engines[0] as FusionEngineSpec).engine
      : fusionModelId(
          fusion.fuser,
          fusion.engines.map((e) => e.engine),
        )
    : (o.models.final?.engine ?? modelNameFor(o.models));
  // Written before the first await, so the pass is in the log by the time the caller answers: a
  // `finalize --force` followed by `akou wait` never takes the earlier final.done for this one.
  call.record({ type: "final.started", pid: process.pid, model });
  type Out = FinalResult & { loads: Record<string, number> };
  const quit: Out = {
    ok: false,
    model,
    parts: [],
    skipped: [],
    error: "akou quit during the pass; it runs again at the next start",
    loads: {},
  };
  try {
    if (o.waitFor) {
      // The signal lives as long as the app: every listener added here is removed again.
      let onWaitAbort = () => {};
      const aborted = new Promise<void>((r) => {
        onWaitAbort = () => r();
        o.signal?.addEventListener("abort", onWaitAbort, { once: true });
      });
      try {
        await Promise.race([o.waitFor.catch(() => {}), aborted]);
      } finally {
        o.signal?.removeEventListener("abort", onWaitAbort);
      }
    }
    if (o.signal?.aborted) return quit;
    o.onStarted?.();
    const { events } = await readLog(join(call.dir, EVENTS_FILE));
    const view = fold(events);
    const msg: ToFinal = {
      type: "run",
      events,
      audio: o.audio,
      models: o.models,
      decode: callDecodeList(view, model, o.vocab),
      files: [...(o.vocab?.files ?? [])],
      options: o.options,
    };
    const clock = o.clock ?? realClock;
    // A fusion pass decodes the call once per engine, one after another.
    const llama = o.models.final || fusion?.engines.some((e) => e.kind === "llama-server");
    const budget =
      o.budgetMs ??
      finalBudgetMs(events) * Math.max(1, fusion?.engines.length ?? 1) +
        (llama ? FINAL_LLAMA_START_MS : 0);
    return await new Promise<Out>((resolve) => {
      let settled = false;
      let w: Worker | null = null;
      /** llama-server processes the Worker runs: a terminated Worker cannot stop them. */
      const kids = new Set<number>();
      const onAbort = () => finish(quit);
      const finish = (r: Out) => {
        if (settled) return;
        settled = true;
        o.signal?.removeEventListener("abort", onAbort);
        clock.clearTimeout(timer);
        w?.terminate();
        for (const pid of kids) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Already gone.
          }
        }
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
      // Quitting: the Worker and its llama-server go now, and the log keeps `final.started`.
      o.signal?.addEventListener("abort", onAbort, { once: true });
      if (o.signal?.aborted) return finish(quit);
      // Nothing the pass sends after its end (a timeout) reaches the log.
      const onReply = (r: FromFinal) => {
        if (settled) return;
        if (r.type === "event") call.record(r.draft);
        else if (r.type === "log") o.onLog?.(r.level, r.msg);
        else if (r.type === "progress") o.onProgress?.(r.done_s, r.total_s, r.step);
        else if (r.type === "child") {
          if (r.alive) kids.add(r.pid);
          else kids.delete(r.pid);
        } else finish({ ...r.result, loads: r.loads });
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

// ---------------------------------------------------------------------------
// A file job: one channel, no "you" (docs/ux/SERVER.md SV-J7, SV-R5)

/** Speech found by the VAD is kept with this much audio around it; the rest is trimmed (SV-R5). */
export const JOB_TRIM_PAD_SECONDS = 0.5;

export interface JobPassInput {
  /** 16 kHz mono. */
  samples: Float32Array;
  /**
   * Label the lines with speakers (`s<N>`, the nearest turn's for a line outside every turn);
   * otherwise, or when the speaker model finds no turns, every speaker is null.
   */
  diarize: boolean;
  /** The job's hotwords, or null. */
  decode: DecodeList | null;
  /** The job's language (`auto` or a tag): forced on an engine that takes one (Qwen). */
  language?: string;
  /** The job's keywords as a glossary, for an engine that takes one (Qwen's context). */
  glossary?: readonly string[];
  /** The languages an `auto` decode may choose among (the job's `languages[]`), over the engine's. */
  languages?: readonly string[];
  options?: Partial<FinalOptions>;
  /** Told as the pass moves: its stage, and the seconds of audio it has transcribed of the total. */
  progress?: (p: JobProgress) => void;
}

/** Where a running job is (akou-5an.116): reading its file, labelling speakers, transcribing. */
export interface JobProgress {
  stage: "decode" | "diarize" | "transcribe";
  /** Seconds of the file transcribed so far; 0 before the transcribing starts. */
  done_s: number;
  /** The file's length in seconds; null while the file is still being read. */
  total_s: number | null;
}

/** Wall seconds per stage of a job (akou-5an.115); `diarize_s` is null when no labels were asked. */
export interface JobTimings {
  decode_s: number;
  diarize_s: number | null;
  transcribe_s: number;
}

export interface JobSegment {
  /** Seconds into the file. */
  s: number;
  e: number;
  text: string;
  speaker: string | null;
}

/**
 * One word of a job (SV-J4). `s` and `e` are seconds into the file, null from an engine that gives
 * no word times (Qwen); `c` is the engine's confidence, 0 to 1, null from one that gives none.
 */
export interface JobWord {
  w: string;
  s: number | null;
  e: number | null;
  c: number | null;
}

/** Whether a job's speaker labels were made (SV-J4). */
export interface JobSpeakers {
  /** The job asked for `diarize`. */
  asked: boolean;
  /** Its segments carry speaker labels: the speaker model ran and found turns. */
  labelled: boolean;
  /** Why the speaker model failed (a missing helper, a missed deadline), or null. */
  error: string | null;
}

export interface JobPassResult {
  text: string;
  segments: JobSegment[];
  /** Every word of the segments, in order (`jobWord`). */
  words: JobWord[];
  /**
   * Mean of the words' confidences; with none, the mean of the units' own confidences (Qwen's mean
   * token log-probability); else null.
   */
  confidence: number | null;
  /** Detected by the engine, when it detects one (Parakeet does not). */
  language: string | null;
  duration_s: number;
  /** The recognizer's registry name, or null when nothing was decoded. */
  model: string | null;
  /** Spans the engine refused even after halving to `minSplitSeconds`: their words are missing. */
  skipped: { s: number; e: number; error: string }[];
  speakers: JobSpeakers;
  /** The speaker model ran and answered: false when it failed, or the file had no speech for it. */
  diarized: boolean;
  /**
   * Seconds the VAD and the recognizer spent on the file (SV-U6), without speaker labels or the
   * recognizer's load. Absent when the pass did not decode, or when an engine had to start for it.
   * With several engines, the VAD and every engine's decode time, summed.
   */
  decode_s?: number;
  /** Wall seconds of the pass's two stages, model loads and an engine's start included. */
  stages?: { diarize_s: number | null; transcribe_s: number };
  /**
   * The N-engine pass (ASR-6), for a job that ran one: the fuser, each engine that loaded with the
   * units it decoded whole and its decode seconds, and each engine the pass went on without, why,
   * and for how many units (null: all of them).
   */
  fusion?: { fuser: BuiltFuser; engines: EngineRun[]; dropped: EngineDrop[] };
}

/** The N-engine pass of a job: the engines in priority order, the fuser, the memory budget. */
export interface FusionPass {
  engines: readonly FinalEngine[];
  fuser: BuiltFuser;
  /** MB; 0 or absent: none. */
  memoryBudgetMb?: number;
  /** Engines of the list the host left out before the pass (not downloaded), and why. */
  dropped?: readonly EngineDrop[];
}

/**
 * The final pass over one channel. The same rules as a call's channel: energy before any model
 * loads, VAD cut points, pieces over the whole timeline, `prepareSpan`, and the halving of a span
 * the engine refuses. Two rules are the job's own (SV-R5): a file in which the VAD finds no speech
 * at all is not decoded, and the audio before the first and after the last speech the VAD finds
 * (less `JOB_TRIM_PAD_SECONDS`) is trimmed, so an engine never sees room noise on its own and
 * cannot invent a sentence from it. Inside the speech the whole-timeline rule holds, so a word the
 * VAD missed between two runs of speech is still decoded.
 */
export async function runJobPass(
  input: JobPassInput,
  models: ModelSet,
  log: (level: "info" | "warn" | "error", msg: string) => void = () => {},
  engine?: FinalEngine | FusionPass,
): Promise<JobPassResult> {
  const o = { ...DEFAULT_FINAL, ...input.options };
  const fusion = engine && "engines" in engine ? engine : null;
  const one = engine && !("engines" in engine) ? engine : undefined;
  const x = input.samples;
  const duration_s = round3(x.length / ASR_RATE);
  const tell = (stage: JobProgress["stage"], done: number) =>
    input.progress?.({ stage, done_s: round3(done), total_s: duration_s });
  const passFrom = performance.now();
  let diarize_s: number | null = null;
  const empty: JobPassResult = {
    text: "",
    segments: [],
    words: [],
    confidence: null,
    language: null,
    duration_s,
    model: null,
    skipped: [],
    // Nothing to label: no speech, so no speaker model runs.
    speakers: { asked: input.diarize, labelled: false, error: null },
    diarized: false,
  };
  if (peak(x) < 10 ** (o.silenceDbfs / 20)) return empty;
  // With an engine the model set's recognizer is never prepared, so it never loads; in a fusion
  // list it loads in its own turn.
  const hw = engine ? null : models.prepare(input.decode);
  for (const d of hw?.dropped ?? []) log("error", `hotword "${d.term}" dropped: ${d.reason}`);
  const engines: readonly FinalEngine[] = fusion
    ? fusion.engines
    : [one ?? hotwordEngine(hw as PreparedHotwords)];
  // Until the pass has run, the model is the fused id over the whole list.
  let modelId =
    engines.length > 1
      ? fusionModelId(
          fusion?.fuser ?? "first",
          engines.map((e) => e.id),
        )
      : (engines[0] as FinalEngine).id;
  const vadFrom = performance.now();
  const { flags, window } = speechFlags(x, models);
  const vadS = (performance.now() - vadFrom) / 1000;
  const first = flags.indexOf(true);
  if (first < 0) return { ...empty, model: modelId };
  const last = flags.lastIndexOf(true);
  const pad = Math.round((JOB_TRIM_PAD_SECONDS * ASR_RATE) / window);
  const w0 = Math.max(0, first - pad);
  const w1 = Math.min(flags.length, last + 1 + pad);
  const from = w0 * window;
  const samples = x.subarray(from, Math.min(x.length, w1 * window));
  let spans: DiarizedSpan[] = [];
  let diarizeError: string | null = null;
  if (input.diarize) {
    tell("diarize", 0);
    const diarizeFrom = performance.now();
    // A diarizer that fails costs the labels, not the job, as on a call.
    try {
      spans = await models.diarizer().process(samples);
    } catch (err) {
      diarizeError = (err as Error).message;
      log("error", `speaker labels failed, the job goes on without them: ${diarizeError}`);
    }
    diarize_s = round3((performance.now() - diarizeFrom) / 1000);
  }
  // Where the speech starts, of every engine's pass over the file (the share each piece adds below).
  tell("transcribe", from / ASR_RATE / engines.length);
  const skipped: JobPassResult["skipped"] = [];
  const segments: JobSegment[] = [];
  const words: JobWord[] = [];
  const unitConfs: number[] = [];
  const offset = from / ASR_RATE;
  // Characters of text per detected language: the job's language is the one most of it is in, so
  // a filler the model hears as another language at the start does not name the whole file.
  const heard = new Map<string, number>();
  // The pad counts as speech, so it stays with the speech beside it and never becomes a piece of
  // noise on its own.
  const heardSpeech = flags.slice(w0, w1);
  const kept = heardSpeech.map((f, i) => f || i < first - w0 || i > last - w0);
  // A piece in which the VAD found no speech is never decoded: a turn edge inside the pad can
  // leave one, and an engine that writes text on noise (Qwen answers a filler) would put a word
  // there that the plain run does not have.
  const pieces = timelinePieces(samples, kept, window, o, spans, heardSpeech).filter((piece) =>
    heardSpeech.slice(Math.floor(piece.from / window), Math.ceil(piece.to / window)).includes(true),
  );
  const pass = await runEngines(
    engines,
    pieces.map((p) => ({ samples, from: p.from, to: p.to })),
    {
      fuser: fusion?.fuser ?? "first",
      lang: input.language ?? "auto",
      glossary: input.glossary ?? [],
      allowed: input.languages,
      minSplitSeconds: o.minSplitSeconds,
      memoryBudgetMb: fusion?.memoryBudgetMb,
      log,
      // The transcribe stage's progress, piece by piece over every engine: with `n` engines the
      // file is gone through `n` times, so engine `k` at second `end` has done `k` passes and
      // `end` seconds of one more, of `n` whole passes.
      onUnit: (u, k, n) => {
        const end = (from + (pieces[u] as { to: number }).to) / ASR_RATE;
        tell("transcribe", (k * duration_s + end) / n);
      },
    },
  );
  if (engines.length > 1) modelId = pass.model;
  for (const k of pass.skipped) {
    skipped.push({
      s: round3((from + k.from) / ASR_RATE),
      e: round3((from + k.to) / ASR_RATE),
      error: k.error,
    });
  }
  for (const [u, piece] of pieces.entries()) {
    const r = pass.hyps[u] as Hypothesis;
    if (r.lang) heard.set(r.lang, (heard.get(r.lang) ?? 0) + Math.max(1, r.text.length));
    if (r.text === "") continue;
    for (const w of r.words) words.push(jobWord(w, offset));
    if (r.conf !== undefined) unitConfs.push(r.conf);
    segments.push({
      s: round3((from + piece.from) / ASR_RATE),
      e: round3((from + piece.to) / ASR_RATE),
      text: r.text,
      // A job's piece outside every turn takes the nearest turn's speaker, never `s?`, a label a
      // client would read as one more speaker (SV-J4); no turns at all is no labels.
      speaker: spans.length > 0 ? labelPiece(piece, spans, Number.POSITIVE_INFINITY) : null,
    });
  }
  const decode_s = vadS + pass.ran.reduce((t, r) => t + r.decode_s, 0);
  let language: string | null = null;
  for (const [lang, n] of heard)
    if (language === null || n > (heard.get(language) as number)) language = lang;
  const cs = words.flatMap((w) => (w.c === null ? [] : [w.c]));
  const confs = cs.length > 0 ? cs : unitConfs.flatMap((c) => clampConf(c) ?? []);
  return {
    text: segments.map((s) => s.text).join(" "),
    segments,
    words,
    confidence: confs.length > 0 ? round3(confs.reduce((a, b) => a + b, 0) / confs.length) : null,
    language,
    duration_s,
    model: modelId,
    skipped,
    speakers: { asked: input.diarize, labelled: spans.length > 0, error: diarizeError },
    diarized: input.diarize && diarizeError === null,
    decode_s,
    stages: {
      diarize_s,
      transcribe_s: round3((performance.now() - passFrom) / 1000 - (diarize_s ?? 0)),
    },
    ...(fusion
      ? { fusion: { fuser: fusion.fuser, engines: pass.ran, dropped: pass.dropped } }
      : {}),
  };
}

/**
 * A confidence as a result carries it: clamped into 0..1 and rounded to three places, so an engine
 * that reports more than certainty gives 1, never 1.5, and one below 0 gives 0. A value that is no
 * number (NaN, infinite) or absent is null.
 */
export function clampConf(c: number | undefined): number | null {
  if (c === undefined || !Number.isFinite(c)) return null;
  return round3(Math.min(1, Math.max(0, c)));
}

/**
 * One word of a hypothesis (times in seconds into the decoded samples, as `decodeUnit` gives them)
 * as a job's result word: `offset` seconds added and rounded to milliseconds, null times for an
 * engine that gives none (both, when it gives no start), the confidence through `clampConf`. A word
 * with a start and no end ends where it starts.
 */
export function jobWord(w: WordHyp, offset: number): JobWord {
  const s = w.t0 === undefined ? null : round3(offset + w.t0);
  return {
    w: w.w,
    s,
    e: s === null || w.t1 === undefined ? s : round3(offset + w.t1),
    c: clampConf(w.conf),
  };
}

type ToJob = {
  type: "job";
  samples: Float32Array;
  models: ModelSpec;
  decode: DecodeList | null;
  diarize: boolean;
  language?: string;
  glossary?: readonly string[];
  languages?: readonly string[];
  options?: Partial<FinalOptions>;
};

type FromJob =
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | ({ type: "progress" } & JobProgress)
  /** A child process the Worker started (llama-server) or saw end, for the host to kill orphans. */
  | { type: "child"; pid: number; alive: boolean }
  | { type: "job.done"; result: JobPassResult; loads: Record<string, number> }
  | { type: "job.failed"; error: string; code?: string; loads: Record<string, number> };

/** The job Worker keeps its models between jobs: loaded once per Worker, keyed by the spec. */
let jobModels: { key: string; set: Promise<ModelSet> } | null = null;
/** And its llama-server engine, kept running between jobs, keyed by its own spec. */
let jobEngine: { key: string; engine: FinalEngine } | null = null;

async function engineFor(m: ToJob, reply: (r: FromJob) => void): Promise<FinalEngine | undefined> {
  const spec = m.models.final;
  const key = spec ? JSON.stringify(spec) : "";
  if (jobEngine && jobEngine.key !== key) {
    await jobEngine.engine.unload();
    jobEngine = null;
  }
  if (!spec) return undefined;
  if (!jobEngine) {
    const { createLlamaEngine } = await import("./llama-server.ts");
    const engine = createLlamaEngine(spec, {
      onChild: (pid, alive) => reply({ type: "child", pid, alive }),
      log: (level, msg) => reply({ type: "log", level, msg }),
    });
    jobEngine = { key, engine };
  }
  return jobEngine.engine;
}

/**
 * The model set's recognizer (Parakeet) as an engine of a fusion list, under the list's id for it:
 * it is prepared in its own turn, with the job's hotwords where the decoding takes them, and the
 * set keeps it loaded after, as it does for every job (it runs on the CPU, never on Metal).
 */
export function recognizerEngine(
  id: string,
  models: ModelSet,
  decode: DecodeList | null,
  log: (level: "info" | "warn" | "error", msg: string) => void = () => {},
): FinalEngine {
  let inner: FinalEngine | null = null;
  const load = async () => {
    if (inner) return;
    const hw = models.prepare(decode);
    for (const d of hw.dropped) log("error", `hotword "${d.term}" dropped: ${d.reason}`);
    inner = hotwordEngine(hw);
  };
  return {
    id,
    features: { confidence: true, timestamps: true, glossary: false, languageId: false },
    load,
    unload: async () => {},
    decode: async (u) => {
      await load();
      return { ...(await (inner as FinalEngine).decode(u)), engine: id };
    },
  };
}

/** An engine with its memory estimate, for the pass's budget. */
function withMemory(e: FinalEngine, memoryMb: number | undefined): FinalEngine {
  if (memoryMb === undefined) return e;
  return {
    id: e.id,
    features: e.features,
    memoryMb,
    load: () => e.load(),
    unload: () => e.unload(),
    decode: (u) => e.decode(u),
  };
}

/**
 * The engines of a job's fusion list, in its order. One that cannot even be built (no llama-server
 * to run, a module that fails) is an engine whose load fails, so the pass drops it and goes on.
 */
async function fusionEngines(
  spec: FusionSpec,
  models: ModelSet,
  decode: DecodeList | null,
  reply: (r: Extract<FromJob, { type: "log" | "child" }>) => void,
): Promise<FinalEngine[]> {
  const log = (level: "info" | "warn" | "error", msg: string) => reply({ type: "log", level, msg });
  const out: FinalEngine[] = [];
  for (const s of spec.engines) {
    let e: FinalEngine;
    try {
      if (s.kind === "recognizer") e = recognizerEngine(s.engine, models, decode, log);
      else if (s.kind === "llama-server") {
        const { createLlamaEngine } = await import("./llama-server.ts");
        e = createLlamaEngine(s, {
          onChild: (pid, alive) => reply({ type: "child", pid, alive }),
          log,
        });
      } else if (s.kind === "transcribe-cpp") {
        const { createTranscribeCppEngine } = await import("./transcribe-cpp.ts");
        e = createTranscribeCppEngine(s.engine, s.modelsDir, {
          allowed: s.languages ?? [],
          log,
        });
      } else {
        const mod = (await import(s.path)) as {
          createEngine(o: unknown, engine: string): FinalEngine;
        };
        e = mod.createEngine(s.options, s.engine);
      }
    } catch (err) {
      const why = (err as Error).message;
      e = {
        id: s.engine,
        features: { confidence: false, timestamps: false, glossary: false, languageId: false },
        load: async () => {
          throw new Error(why);
        },
        unload: async () => {},
        decode: async () => {
          throw Object.assign(new Error(why), { fatal: true });
        },
      };
    }
    out.push(withMemory(e, s.memoryMb));
  }
  return out;
}

async function runJobInWorker(m: ToJob, reply: (r: FromJob) => void): Promise<void> {
  let lastSent = Number.NEGATIVE_INFINITY;
  let lastStage: JobProgress["stage"] | null = null;
  const { final: _, fusion, ...setSpec } = m.models;
  const key = JSON.stringify(setSpec);
  if (jobModels?.key !== key) jobModels = { key, set: loadModelSet(setSpec as ModelSpec) };
  let models: ModelSet | null = null;
  let fused: FinalEngine[] = [];
  try {
    models = await jobModels.set;
    // An engine that starts for this job starts inside its first decode, so the job's decode time
    // would carry the start: such a job reports none.
    const starts =
      m.models.final !== undefined && jobEngine?.key !== JSON.stringify(m.models.final);
    // A fusion job stops a llama-server kept from an earlier job: one Metal engine at a time.
    const single = await engineFor(m, reply);
    if (fusion) fused = await fusionEngines(fusion, models, m.decode, reply);
    const engine: FinalEngine | FusionPass | undefined = fusion
      ? { engines: fused, fuser: fusion.fuser, memoryBudgetMb: fusion.memoryBudgetMb }
      : single;
    const result = await runJobPass(
      {
        samples: m.samples,
        diarize: m.diarize,
        decode: m.decode,
        language: m.language,
        glossary: m.glossary,
        languages: m.languages,
        options: m.options,
        progress: (p) => {
          // A new stage always goes; within one, at most once a second, and the last figure.
          const now = performance.now();
          if (
            p.stage === lastStage &&
            now - lastSent < PROGRESS_EVERY_MS &&
            p.done_s < (p.total_s ?? 0)
          ) {
            return;
          }
          lastSent = now;
          lastStage = p.stage;
          reply({ type: "progress", ...p });
        },
      },
      models,
      (level, msg) => reply({ type: "log", level, msg }),
      engine,
    ).finally(async () => {
      // A fusion list's engines are the job's own: none is kept running after it.
      for (const e of fused) await e.unload().catch(() => {});
    });
    if (starts) delete result.decode_s;
    reply({ type: "job.done", result, loads: { ...models.loads } });
  } catch (err) {
    if (!models) jobModels = null;
    reply({
      type: "job.failed",
      error: (err as Error).message,
      code: (err as { code?: string }).code,
      loads: { ...models?.loads },
    });
  }
}

/**
 * One long-lived finalize Worker for file jobs: the models load once and serve every job after.
 * One job at a time. `cancel` terminates the Worker (a decode stuck in a native call answers
 * nothing), so the job in it ends at once and the next job starts a fresh Worker (SV-J6).
 */
export class JobWorker {
  private w: Worker | null = null;
  private busy: { reject(e: Error): void } | null = null;
  private lastLoads: Record<string, number> = {};
  /** Child processes the Worker runs (llama-server): killed with it, never left behind. */
  private readonly kids = new Set<number>();

  constructor(
    private readonly models: ModelSpec,
    private readonly onLog?: (level: "info" | "warn" | "error", msg: string) => void,
  ) {}

  run(input: Omit<JobPassInput, "options"> & { options?: Partial<FinalOptions> }) {
    const onProgress = input.progress;
    if (this.busy) return Promise.reject(new Error("the job Worker is busy"));
    this.w ??= new Worker(siblingModule(import.meta.url, "finalize-worker"), {
      workerData: FINALIZE_WORKER_NAME,
    } as WorkerOptions);
    const w = this.w;
    return new Promise<JobPassResult>((resolve, reject) => {
      const done = () => {
        this.busy = null;
        w.onmessage = null;
        w.onerror = null;
      };
      this.busy = {
        reject: (e) => {
          done();
          reject(e);
        },
      };
      w.onmessage = (e: MessageEvent<FromJob>) => {
        const r = e.data;
        if (r.type === "log") return this.onLog?.(r.level, r.msg);
        if (r.type === "progress") {
          const { type: _t, ...p } = r;
          return onProgress?.(p);
        }
        if (r.type === "child") {
          if (r.alive) this.kids.add(r.pid);
          else this.kids.delete(r.pid);
          return;
        }
        this.lastLoads = r.loads;
        done();
        if (r.type === "job.done") resolve(r.result);
        else reject(Object.assign(new Error(r.error), r.code ? { code: r.code } : {}));
      };
      w.onerror = (e) => {
        // A Worker that died is not reused, and nor is anything it started.
        this.w = null;
        w.terminate();
        this.killChildren();
        done();
        reject(new Error(e.message));
      };
      const msg: ToJob = {
        type: "job",
        samples: input.samples,
        models: this.models,
        decode: input.decode,
        diarize: input.diarize,
        language: input.language,
        glossary: input.glossary,
        languages: input.languages,
        options: input.options,
      };
      // Transferred, not cloned: a long job's audio is held once, by the Worker.
      w.postMessage(msg, [input.samples.buffer as ArrayBuffer]);
    });
  }

  /** Stops the job in flight: the Worker is terminated and `run` rejects with `reason`. */
  cancel(reason = "cancelled"): void {
    const w = this.w;
    this.w = null;
    w?.terminate();
    this.killChildren();
    this.busy?.reject(new Error(reason));
  }

  /** The child processes the Worker runs now. */
  children(): number[] {
    return [...this.kids];
  }

  /** A terminated Worker cannot stop its children, so the host does. */
  private killChildren(): void {
    for (const pid of this.kids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    this.kids.clear();
  }

  /** Model loads in the Worker so far, as of the last job. */
  loads(): Record<string, number> {
    return { ...this.lastLoads };
  }

  close(): void {
    this.cancel("the job Worker closed");
  }
}
