/**
 * hark as an alternative macOS helper during M0 and M1 (docs/DESIGN.md section 2.4).
 *
 * `hark --system --mix --tracks stereo --capture-backend coreaudio -a - --raw -r 16000 -b 16`
 * writes interleaved 16-bit stereo on stdout, mic on the left and call on the right. This dialect,
 * `stereo-s16le`, adapts that byte stream into the same packets the `akou-capture/1` helper sends:
 *
 * - Time comes from the byte count, because hark's two channels share one clock. A frame is 4
 *   bytes; frame `n` is at `file_seconds = n / 16000` and at `capture_ns = anchor + n / 16000 s`,
 *   where the anchor is the app's monotonic clock when the first byte arrived.
 * - hark speaks no JSON, so the dialect synthesises `hello`, `capturing` (at the first byte, which
 *   is when audio is flowing), `first_audio` for both channels, and `stopped` at exit. hark's own
 *   stderr goes to the capture log only.
 * - hark stops on SIGINT; the stop budget and the kill after it are the same as for the helper.
 *
 * It is a fallback, not the plan: hark's "silent tap blocks the mic" trap (T0.16) stays open here,
 * because hark clocks the mic from the tap. The app's packet watchdog is what notices it.
 *
 * `inputFile` runs hark on an audio file with `-i` instead of live capture. Tests use only that
 * mode: live capture needs permission grants and must never be triggered from a test.
 */

import type { Channel } from "../../core/log/events.ts";
import {
  type CaptureEngine,
  type CaptureHandlers,
  type CaptureSession,
  type CaptureStartOptions,
  type Clock,
  realClock,
} from "./engine.ts";
import { ChildCaptureSession, type Dialect } from "./helper.ts";
import { CAPTURE_RATE, type Packet } from "./protocol.ts";

export const STEREO_S16LE = "stereo-s16le";
const BYTES_PER_FRAME = 4;

/** The live flags from the capture spike. */
export const HARK_LIVE_ARGS = [
  "--system",
  "--mix",
  "--tracks",
  "stereo",
  "--capture-backend",
  "coreaudio",
  "-a",
  "-",
  "--raw",
  "-r",
  "16000",
  "-b",
  "16",
] as const;

export interface HarkEngineOptions {
  /** The hark binary, with any leading arguments (tests put the fake helper here). */
  command: string[];
  /** Read this file with `-i` instead of capturing live. */
  inputFile?: string;
  clock?: Clock;
}

export function harkArgs(
  o: Pick<HarkEngineOptions, "inputFile">,
  opts: CaptureStartOptions,
): string[] {
  if (o.inputFile) {
    // File mode: --tracks is live-only, so ask for two channels explicitly.
    return ["-i", o.inputFile, "-a", "-", "--raw", "-r", "16000", "-b", "16", "-c", "2"];
  }
  const args: string[] = [...HARK_LIVE_ARGS];
  if (opts.mic !== "default" && opts.mic !== "none") args.push("-d", opts.mic);
  return args;
}

/**
 * Deinterleaves s16le stereo into per-channel float packets. A read may end inside a frame or
 * inside a sample; the remainder is carried, so every frame is converted exactly once (TRAPS
 * T1.11).
 */
export class StereoS16Decoder {
  private carry = new Uint8Array(0);
  /** Frames converted so far. */
  frames = 0;

  constructor(private readonly anchorNs: () => bigint) {}

  push(chunk: Uint8Array): Packet[] {
    let bytes = chunk;
    if (this.carry.length > 0) {
      bytes = new Uint8Array(this.carry.length + chunk.length);
      bytes.set(this.carry, 0);
      bytes.set(chunk, this.carry.length);
    }
    const n = Math.floor(bytes.length / BYTES_PER_FRAME);
    this.carry = bytes.slice(n * BYTES_PER_FRAME);
    if (n === 0) return [];
    const v = new DataView(bytes.buffer, bytes.byteOffset, n * BYTES_PER_FRAME);
    const mic = new Float32Array(n);
    const call = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      mic[i] = v.getInt16(i * 4, true) / 32768;
      call[i] = v.getInt16(i * 4 + 2, true) / 32768;
    }
    const start = this.frames;
    this.frames += n;
    const fileSeconds = start / CAPTURE_RATE;
    const captureNs = this.anchorNs() + (BigInt(start) * 1_000_000_000n) / BigInt(CAPTURE_RATE);
    const packet = (ch: Channel, samples: Float32Array): Packet => ({
      ch,
      zeroFilled: false,
      captureNs,
      fileSeconds,
      samples,
    });
    return [packet("mic", mic), packet("call", call)];
  }

  /** Bytes held for an incomplete frame. */
  get pending(): number {
    return this.carry.length;
  }
}

function harkDialect(
  s: ChildCaptureSession,
  clock: Clock,
  opts: CaptureStartOptions,
  version: string,
): Dialect {
  let anchor: bigint | null = null;
  const decoder = new StereoS16Decoder(() => anchor ?? 0n);
  let stopping = false;
  s.emitMessage({ type: "hello", protocol: STEREO_S16LE, version, caps: ["stereo-s16le"] });
  return {
    name: STEREO_S16LE,
    stdout(chunk) {
      if (anchor === null) {
        anchor = clock.mono();
        s.emitMessage({
          type: "capturing",
          mic:
            opts.mic === "none"
              ? null
              : { id: opts.mic, name: "hark microphone", rate: CAPTURE_RATE },
          call: { mode: opts.call, rate: CAPTURE_RATE },
          exclude: [],
          capture_ns: anchor.toString(),
        });
        s.emitMessage({ type: "first_audio", ch: "mic", capture_ns: anchor.toString() });
        s.emitMessage({ type: "first_audio", ch: "call", capture_ns: anchor.toString() });
      }
      for (const p of decoder.push(chunk)) s.emitPacket(p);
    },
    end() {
      s.emitMessage({
        type: "stopped",
        file_seconds: decoder.frames / CAPTURE_RATE,
        reason: stopping ? "stop" : "eof",
      });
    },
    requestStop(child) {
      stopping = true;
      child.closeStdin();
      child.signal("SIGINT");
    },
  };
}

export class HarkEngine implements CaptureEngine {
  readonly name = "hark";
  private readonly clock: Clock;
  constructor(
    private readonly o: HarkEngineOptions,
    private readonly version = "unknown",
  ) {
    this.clock = o.clock ?? realClock;
  }

  start(opts: CaptureStartOptions, handlers: CaptureHandlers): CaptureSession {
    const argv = [...this.o.command, ...harkArgs(this.o, opts)];
    return new ChildCaptureSession(
      { argv, logPath: opts.logPath, clock: this.clock },
      handlers,
      (s) => harkDialect(s, this.clock, opts, this.version),
    );
  }
}
