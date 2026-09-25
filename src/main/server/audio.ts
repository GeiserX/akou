/**
 * A job's upload as the recognizer's input: 16 kHz mono float. A 16-bit PCM WAV at 16 kHz is read
 * here, with its channels averaged, so a desktop with no ffmpeg can still transcribe what akou
 * itself writes and what `akou transcribe` sends most often. Every other container, and a WAV at
 * any other rate or depth, goes through ffmpeg (`decodeAudio`, SV-P6).
 */

import { closeSync, openSync, readSync } from "node:fs";
import { decodeAudio } from "../asr/decode.ts";
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
        return { data: o + 8, bytes: size, channels: fmt.channels };
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
  o: { signal?: AbortSignal; ffmpeg?: readonly string[] } = {},
): Promise<Float32Array> {
  const wav = pcm16k(path);
  if (wav) return readPcm(path, wav);
  return decodeAudio(path, o);
}
