/**
 * What the app does with the packets of one part (docs/DESIGN.md sections 2.1, 2.4, 3.1 and 4.4).
 *
 * - **Pause** drops packets. **Mute** zeroes the mic copy; the timeline continues.
 * - **Alignment.** Both channels sit on the part's file timeline (`file_seconds`, 16 kHz). A
 *   channel whose packets skip ahead is filled with zeros, an overlap is trimmed so no frame is fed
 *   twice, and a channel that falls more than `maxLagSeconds` behind the other is filled with zeros
 *   up to that bound. No channel ever waits for the other (TRAPS T0.15, T0.16): the helper's
 *   aligner already writes zeros for a silent source, and this is the same rule applied again on
 *   the app side, so a helper that omits packets cannot make one channel run ahead unbounded.
 * - **Queues.** Each channel has a bounded queue for the recognizer (10 minutes by default). When
 *   it is full the oldest audio is dropped from memory and counted; the recognizer reads that span
 *   back from the audio file. Memory never grows with call length.
 * - **Sleep.** The host clock keeps running during sleep and the file does not; a jump of the host
 *   clock between two consecutive packets that the file position does not show is a `gap`.
 */

import type { Channel } from "../../core/log/events.ts";
import { CAPTURE_RATE, type Packet } from "./protocol.ts";

export interface PcmChunk {
  /** Sample index on the part's file timeline (16 kHz). */
  start: number;
  samples: Float32Array;
}

/** A queue of audio chunks with a hard cap in samples. */
export class PcmQueue {
  private chunks: PcmChunk[] = [];
  private head = 0;
  size = 0;
  /** Samples dropped because the queue was full. */
  dropped = 0;
  /** Largest `size` ever held. */
  peak = 0;

  constructor(readonly capacity: number) {}

  push(start: number, samples: Float32Array): void {
    if (samples.length === 0) return;
    this.chunks.push({ start, samples });
    this.size += samples.length;
    while (this.size > this.capacity) {
      const first = this.chunks[this.head] as PcmChunk;
      const over = this.size - this.capacity;
      if (first.samples.length <= over) {
        this.head++;
        this.size -= first.samples.length;
        this.dropped += first.samples.length;
      } else {
        this.chunks[this.head] = {
          start: first.start + over,
          samples: first.samples.subarray(over),
        };
        this.size -= over;
        this.dropped += over;
      }
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    this.peak = Math.max(this.peak, this.size);
  }

  /** Takes everything queued. */
  drain(): PcmChunk[] {
    const out = this.chunks.slice(this.head);
    this.chunks = [];
    this.head = 0;
    this.size = 0;
    return out;
  }
}

export interface GapSignal {
  /** File position where audio continued. */
  a: number;
  /** Host clock at the end of the last packet before the jump. */
  fromNs: bigint;
  /** Host clock where audio continued. */
  toNs: bigint;
}

export interface IngestOptions {
  /** Recognizer queue length per channel, seconds. Default 600 (DESIGN 3.1). */
  queueSeconds?: number;
  /** A channel this far behind the other is zero-filled. Default 1 s. */
  maxLagSeconds?: number;
  /** A host-clock jump larger than this, not seen in the file position, is a sleep gap. */
  sleepGapMs?: number;
  onGap?(g: GapSignal): void;
  /** First non-zero-filled packet of a channel. */
  onFirstAudio?(ch: Channel): void;
}

interface LastEnd {
  ns: bigint;
  file: number;
}

const other = (ch: Channel): Channel => (ch === "mic" ? "call" : "mic");

export class PartIngest {
  paused = false;
  muted = false;
  readonly queues: Record<Channel, PcmQueue>;
  /** Samples on the timeline per channel, zero fill included. */
  readonly pos: Record<Channel, number> = { mic: 0, call: 0 };
  readonly zeroFilled: Record<Channel, number> = { mic: 0, call: 0 };
  readonly firstAudio: Record<Channel, boolean> = { mic: false, call: false };
  /** Packets seen per channel (not dropped by pause). */
  readonly packets: Record<Channel, number> = { mic: 0, call: 0 };
  droppedWhilePaused = 0;
  /** Latest end of audio in the file, seconds. */
  fileSeconds = 0;
  private readonly lastEnd: Record<Channel, LastEnd | null> = { mic: null, call: null };
  private lastGapA = -1;
  private readonly maxLag: number;
  private readonly sleepGapNs: bigint;

  constructor(private readonly o: IngestOptions = {}) {
    const cap = Math.round((o.queueSeconds ?? 600) * CAPTURE_RATE);
    this.queues = { mic: new PcmQueue(cap), call: new PcmQueue(cap) };
    this.maxLag = Math.round((o.maxLagSeconds ?? 1) * CAPTURE_RATE);
    this.sleepGapNs = BigInt(Math.round((o.sleepGapMs ?? 2000) * 1e6));
  }

  pause(): void {
    this.paused = true;
  }

  /** Audio after a resume is not compared with audio before it for sleep gaps. */
  resume(): void {
    this.paused = false;
    this.lastEnd.mic = null;
    this.lastEnd.call = null;
  }

  push(p: Packet): void {
    const n = p.samples.length;
    if (this.paused) {
      this.droppedWhilePaused += n;
      return;
    }
    this.packets[p.ch]++;
    this.detectGap(p);
    const endFile = p.fileSeconds + n / CAPTURE_RATE;
    this.lastEnd[p.ch] = {
      ns: p.captureNs + BigInt(Math.round((n / CAPTURE_RATE) * 1e9)),
      file: endFile,
    };
    this.fileSeconds = Math.max(this.fileSeconds, endFile);

    if (!p.zeroFilled && !this.firstAudio[p.ch]) {
      this.firstAudio[p.ch] = true;
      this.o.onFirstAudio?.(p.ch);
    }

    let samples = p.samples;
    if (p.ch === "mic" && this.muted) samples = new Float32Array(n);
    const expected = Math.round(p.fileSeconds * CAPTURE_RATE);
    if (expected > this.pos[p.ch]) this.fill(p.ch, expected);
    if (expected < this.pos[p.ch]) {
      const overlap = this.pos[p.ch] - expected;
      if (overlap >= n) return;
      samples = samples.subarray(overlap);
    }
    this.queues[p.ch].push(this.pos[p.ch], samples);
    this.pos[p.ch] += samples.length;
    const o = other(p.ch);
    if (this.pos[p.ch] - this.pos[o] > this.maxLag) this.fill(o, this.pos[p.ch] - this.maxLag);
  }

  private fill(ch: Channel, to: number): void {
    let left = to - this.pos[ch];
    // Fill in bounded blocks so a long outage never allocates one huge array.
    const block = CAPTURE_RATE * 10;
    while (left > 0) {
      const k = Math.min(left, block);
      this.queues[ch].push(this.pos[ch], new Float32Array(k));
      this.pos[ch] += k;
      this.zeroFilled[ch] += k;
      left -= k;
    }
  }

  private detectGap(p: Packet): void {
    const prev = this.lastEnd[p.ch];
    if (!prev) return;
    const fileAdvanceNs = BigInt(Math.round((p.fileSeconds - prev.file) * 1e9));
    const jump = p.captureNs - prev.ns - fileAdvanceNs;
    if (jump <= this.sleepGapNs) return;
    // Both channels see the same jump; report it once.
    if (Math.abs(p.fileSeconds - this.lastGapA) < 0.5) return;
    this.lastGapA = p.fileSeconds;
    this.o.onGap?.({ a: p.fileSeconds, fromNs: prev.ns, toNs: p.captureNs });
  }
}
