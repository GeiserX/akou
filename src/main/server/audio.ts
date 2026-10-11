/**
 * A job's upload as the recognizer's input: 16 kHz mono float. A 16-bit PCM WAV at 16 kHz is read
 * here, with its channels averaged, so a desktop with no ffmpeg can still transcribe what akou
 * itself writes and what `akou transcribe` sends most often. Every other container, and a WAV at
 * any other rate or depth, goes through ffmpeg (`decodeAudio`, SV-P6).
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { decodeAudio, tooLong } from "../asr/decode.ts";
import { ASR_RATE } from "../asr/engine.ts";

/** The WAV's layout when it is 16-bit PCM at 16 kHz, else null. */
function pcm16k(path: string): { data: number; bytes: number; channels: number } | null {
  const fd = openSync(path, "r");
  try {
    const head = new Uint8Array(65536);
    const got = readSync(fd, head, 0, head.length, 0);
    const v = new DataView(head.buffer);
    const tag = (o: number) => String.fromCharCode(...head.subarray(o, o + 4));
    if (got < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
    let o = 12;
    let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
    while (o + 8 <= got) {
      const id = tag(o);
      const size = v.getUint32(o + 4, true);
      if (id === "fmt ") {
        fmt = {
          format: v.getUint16(o + 8, true),
          channels: v.getUint16(o + 10, true),
          rate: v.getUint32(o + 12, true),
          bits: v.getUint16(o + 22, true),
        };
      } else if (id === "data") {
        if (fmt?.format !== 1 || fmt.bits !== 16 || fmt.rate !== ASR_RATE) return null;
        if (fmt.channels < 1) return null;
        // A streaming writer (ffmpeg or sox to a pipe, arecord) cannot seek back to fill in the
        // size, so it leaves 0 or 0xFFFFFFFF: the audio then runs to the end of the file. Any size
        // is capped at what the file holds.
        const rest = Math.max(0, fstatSync(fd).size - (o + 8));
        const bytes = size === 0 || size > rest ? rest : size;
        return { data: o + 8, bytes, channels: fmt.channels };
      }
      o += 8 + size + (size % 2);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function readPcm(path: string, w: { data: number; bytes: number; channels: number }): Float32Array {
  const fd = openSync(path, "r");
  try {
    const frameBytes = 2 * w.channels;
    const frames = Math.floor(w.bytes / frameBytes);
    const out = new Float32Array(frames);
    const chunk = 65536 * frameBytes;
    const buf = new Uint8Array(chunk);
    let frame = 0;
    for (let at = 0; frame < frames; at += chunk) {
      const got = readSync(fd, buf, 0, Math.min(chunk, (frames - frame) * frameBytes), w.data + at);
      if (got <= 0) break;
      const v = new DataView(buf.buffer, 0, got);
      for (let i = 0; i + frameBytes <= got; i += frameBytes, frame++) {
        let s = 0;
        for (let c = 0; c < w.channels; c++) s += v.getInt16(i + 2 * c, true);
        out[frame] = s / w.channels / 32768;
      }
    }
    return frame === frames ? out : out.subarray(0, frame);
  } finally {
    closeSync(fd);
  }
}

/** The upload at `path` as 16 kHz mono samples; ffmpeg for anything but a 16 kHz PCM WAV. */
export async function readUploadAudio(
  path: string,
  o: { signal?: AbortSignal; ffmpeg?: readonly string[]; maxSamples?: number } = {},
): Promise<Float32Array> {
  const wav = pcm16k(path);
  if (wav) {
    if (o.maxSamples !== undefined && Math.floor(wav.bytes / (2 * wav.channels)) > o.maxSamples)
      throw tooLong(basename(path), o.maxSamples);
    return readPcm(path, wav);
  }
  return decodeAudio(path, o);
}

/**
 * A 44-byte PCM WAV header whose sizes say "to the end of the file" (0xFFFFFFFF), for audio whose
 * length is not known while it is written: a dictation streamed during the hold (DC-R6) and a
 * Wyoming chunk stream (SV-C2). At 16 kHz and 16 bits it is read here with no ffmpeg; any other
 * rate or depth goes through ffmpeg, which reads such a header to the end too.
 */
export function streamingWavHeader(rate: number, bits: number, channels: number): Uint8Array {
  const out = new Uint8Array(44);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  const block = channels * (bits / 8);
  tag(0, "RIFF");
  v.setUint32(4, 0xffffffff, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, bits, true);
  tag(36, "data");
  v.setUint32(40, 0xffffffff, true);
  return out;
}
