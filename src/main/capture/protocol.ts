/**
 * The capture helper protocol, `akou-capture/1` (docs/DESIGN.md section 2.4).
 *
 * - **stdout** carries binary packets, both channels already at 16 kHz mono float for the
 *   recognizer. All numbers are little-endian:
 *
 *   ```
 *   offset  0  magic "AKP1"
 *   offset  4  u8  channel (0 mic, 1 call)
 *   offset  5  u8  flags (bit 0 = zero-filled: the source delivered nothing for this slot)
 *   offset  6  u16 reserved (0)
 *   offset  8  u64 capture_ns (host clock that keeps running during sleep)
 *   offset 16  f64 file_seconds (position in this part's Opus file)
 *   offset 24  u32 frames
 *   offset 28  f32 samples[frames]
 *   ```
 *
 *   The rate is not in the packet: it is 16000 Hz by definition of the protocol.
 *
 * - **stderr** carries one JSON object per line, tagged by `type`. Lines that are not JSON (a
 *   library printing to stderr) are kept in the capture log and otherwise ignored.
 *
 * - **stdin** takes one command per line. Closing stdin means stop.
 *
 * The two clocks of a packet: `capture_ns` is the host clock and gives wall time through the
 * part's anchors (`part.started`, every `resume`); `file_seconds` is the position in the audio
 * file and gives `a0`/`a1`. The file clock stops while paused or asleep; the host clock does not.
 * The `capturing` line carries `capture_ns` of file position 0, which is the part's anchor.
 */

import type { Channel } from "../../core/log/events.ts";

export const PROTOCOL = "akou-capture/1";
export const PACKET_MAGIC = "AKP1";
export const PACKET_HEADER_BYTES = 28;
/** Every packet sample is at this rate. */
export const CAPTURE_RATE = 16000;
/** A packet longer than this is a protocol error, not audio. */
export const MAX_PACKET_FRAMES = CAPTURE_RATE * 10;
export const FLAG_ZERO_FILLED = 1;

const MAGIC_BYTES = new TextEncoder().encode(PACKET_MAGIC);

export interface Packet {
  ch: Channel;
  /** The source delivered nothing for this slot and the helper wrote zeros. */
  zeroFilled: boolean;
  /** Host clock, nanoseconds, of the first sample. */
  captureNs: bigint;
  /** Position of the first sample in this part's audio file, seconds. */
  fileSeconds: number;
  samples: Float32Array;
}

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export function channelCode(ch: Channel): number {
  return ch === "mic" ? 0 : 1;
}

export function encodePacket(p: Packet): Uint8Array {
  const out = new Uint8Array(PACKET_HEADER_BYTES + p.samples.length * 4);
  const v = new DataView(out.buffer);
  out.set(MAGIC_BYTES, 0);
  v.setUint8(4, channelCode(p.ch));
  v.setUint8(5, p.zeroFilled ? FLAG_ZERO_FILLED : 0);
  v.setUint16(6, 0, true);
  v.setBigUint64(8, p.captureNs, true);
  v.setFloat64(16, p.fileSeconds, true);
  v.setUint32(24, p.samples.length, true);
  for (let i = 0; i < p.samples.length; i++) {
    v.setFloat32(PACKET_HEADER_BYTES + i * 4, p.samples[i] as number, true);
  }
  return out;
}

/**
 * Decodes the stdout byte stream into packets. Reads may split a packet anywhere, including
 * inside the header; the decoder carries the remainder to the next read, so every frame is
 * delivered exactly once.
 */
export class PacketDecoder {
  private buf = new Uint8Array(0);
  private len = 0;
  /** Bytes consumed so far, for error messages. */
  private offset = 0;

  /** Feeds one read; returns the packets it completed. Throws `ProtocolError` on bad framing. */
  push(chunk: Uint8Array): Packet[] {
    this.append(chunk);
    const out: Packet[] = [];
    let pos = 0;
    while (this.len - pos >= PACKET_HEADER_BYTES) {
      const v = new DataView(this.buf.buffer, this.buf.byteOffset + pos, PACKET_HEADER_BYTES);
      for (let i = 0; i < 4; i++) {
        if (this.buf[pos + i] !== MAGIC_BYTES[i]) {
          throw new ProtocolError(`bad packet magic at byte ${this.offset + pos}`);
        }
      }
      const code = v.getUint8(4);
      if (code > 1) throw new ProtocolError(`bad channel ${code} at byte ${this.offset + pos}`);
      const frames = v.getUint32(24, true);
      if (frames > MAX_PACKET_FRAMES) {
        throw new ProtocolError(`packet of ${frames} frames at byte ${this.offset + pos}`);
      }
      const total = PACKET_HEADER_BYTES + frames * 4;
      if (this.len - pos < total) break;
      const samples = new Float32Array(frames);
      const body = new DataView(
        this.buf.buffer,
        this.buf.byteOffset + pos + PACKET_HEADER_BYTES,
        frames * 4,
      );
      for (let i = 0; i < frames; i++) samples[i] = body.getFloat32(i * 4, true);
      out.push({
        ch: code === 0 ? "mic" : "call",
        zeroFilled: (v.getUint8(5) & FLAG_ZERO_FILLED) !== 0,
        captureNs: v.getBigUint64(8, true),
        fileSeconds: v.getFloat64(16, true),
        samples,
      });
      pos += total;
    }
    this.consume(pos);
    return out;
  }

  /** Bytes held for an incomplete packet. */
  get pending(): number {
    return this.len;
  }

  private append(chunk: Uint8Array): void {
    if (this.len + chunk.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.len + chunk.length, this.buf.length * 2, 4096));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
  }

  private consume(n: number): void {
    if (n === 0) return;
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
    this.offset += n;
  }
}

// ---------------------------------------------------------------------------
// stderr messages

export interface HelloMsg {
  type: "hello";
  protocol: string;
  version: string;
  caps: string[];
}

export interface CapturingMsg {
  type: "capturing";
  mic: { id: string; name: string; rate: number } | null;
  call: { mode: string; rate: number } | null;
  exclude: string[];
  /** Host clock of file position 0. A decimal string, because u64 nanoseconds exceed 2^53. */
  capture_ns: string | number;
}

export interface FirstAudioMsg {
  type: "first_audio";
  ch: Channel;
  capture_ns: string | number;
}

export interface LevelMsg {
  type: "level";
  mic_dbfs: number;
  call_dbfs: number;
}

export interface HealthMsg {
  type: "health";
  ch: Channel;
  state: string;
  silent_for: number;
  rebuilds: number;
  detail: string;
}

export interface DeviceMsg {
  type: "device";
  ch: Channel;
  event: string;
  name: string;
}

export interface WarnMsg {
  type: "warn";
  code: string;
  msg: string;
}

export interface StoppedMsg {
  type: "stopped";
  file_seconds: number;
  reason: string;
}

export type HelperMessage =
  | HelloMsg
  | CapturingMsg
  | FirstAudioMsg
  | LevelMsg
  | HealthMsg
  | DeviceMsg
  | WarnMsg
  | StoppedMsg;

/** A stderr line: a protocol message, or text that only goes to the capture log. */
export type StderrLine = { kind: "msg"; msg: HelperMessage } | { kind: "text"; line: string };

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCh = (v: unknown): v is Channel => v === "mic" || v === "call";
const isNs = (v: unknown): boolean =>
  (isNum(v) && Number.isInteger(v) && v >= 0) || (isStr(v) && /^\d+$/.test(v));

function checkMessage(o: Record<string, unknown>): string | null {
  switch (o.type) {
    case "hello":
      return isStr(o.protocol) && isStr(o.version) && Array.isArray(o.caps) ? null : "hello";
    case "capturing": {
      const mic = o.mic as Record<string, unknown> | null;
      const call = o.call as Record<string, unknown> | null;
      if (mic !== null && (typeof mic !== "object" || !isStr(mic.name))) return "capturing.mic";
      if (call !== null && (typeof call !== "object" || !isStr(call.mode))) return "capturing.call";
      if (!Array.isArray(o.exclude) || !o.exclude.every(isStr)) return "capturing.exclude";
      return isNs(o.capture_ns) ? null : "capturing.capture_ns";
    }
    case "first_audio":
      return isCh(o.ch) && isNs(o.capture_ns) ? null : "first_audio";
    case "level":
      return isNum(o.mic_dbfs) && isNum(o.call_dbfs) ? null : "level";
    case "health":
      return isCh(o.ch) && isStr(o.state) && isNum(o.silent_for) && isNum(o.rebuilds)
        ? null
        : "health";
    case "device":
      return isCh(o.ch) && isStr(o.event) ? null : "device";
    case "warn":
      return isStr(o.code) ? null : "warn";
    case "stopped":
      return isNum(o.file_seconds) && isStr(o.reason) ? null : "stopped";
    default:
      return `unknown type ${String(o.type)}`;
  }
}

/** Parses one stderr line. A malformed JSON message is logged as text, never trusted. */
export function parseStderrLine(line: string): StderrLine {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return { kind: "text", line };
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return { kind: "text", line };
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { kind: "text", line };
  const rec = o as Record<string, unknown>;
  if (rec.type === "health") {
    rec.detail = isStr(rec.detail) ? rec.detail : "";
  }
  if (rec.type === "warn") {
    rec.msg = isStr(rec.msg) ? rec.msg : "";
  }
  if (checkMessage(rec) !== null) return { kind: "text", line };
  return { kind: "msg", msg: rec as unknown as HelperMessage };
}

export function nsFromWire(v: string | number): bigint {
  return typeof v === "string" ? BigInt(v) : BigInt(Math.round(v));
}

/** Splits a text stream into lines across reads. */
export class LineSplitter {
  private rest = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.rest += this.decoder.decode(chunk, { stream: true });
    const lines = this.rest.split("\n");
    this.rest = lines.pop() ?? "";
    return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l !== "");
  }

  /** The unterminated last line, at end of stream. */
  flush(): string[] {
    const r = this.rest + this.decoder.decode();
    this.rest = "";
    return r === "" ? [] : [r];
  }
}

// ---------------------------------------------------------------------------
// stdin commands

/**
 * DESIGN 2.4 lists `probe_call`, `rebuild_call`, `rebuild_mic` and `stop`, and says the app "tells
 * the helper to drop" audio while paused; `pause` and `resume` are those two instructions. A
 * helper that ignores them is still correct for the transcript: the app drops packets while
 * paused as well, and anchors the `resume` at the file position the helper really reached
 * (ingest.ts).
 */
export type HelperCommand =
  | "probe_call"
  | "rebuild_call"
  | "rebuild_mic"
  | "stop"
  | "pause"
  | "resume";

/** sysexits codes the helper exits with (DESIGN 2.4). */
export const EXIT = {
  ok: 0,
  usage: 64,
  noDevice: 66,
  unavailable: 69,
  software: 70,
  io: 74,
  permission: 77,
} as const;
