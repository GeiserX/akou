/**
 * Any audio container to the recognizer's input (docs/ux/SERVER.md SV-P6): ffmpeg decodes the
 * first audio stream of a file (Opus in Ogg or WebM, AAC in M4A, MP3, WAV, the audio of a video)
 * and resamples it to 16 kHz mono float, which is what a job hands the final pass. The image
 * installs ffmpeg with one apt line; the desktop app does not use this (SV-P10).
 *
 * A file ffmpeg cannot read, a file with no audio stream and a machine with no ffmpeg are each a
 * `DecodeError` with the reason, never an empty transcript.
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";
import { ASR_RATE } from "./engine.ts";

export class DecodeError extends Error {
  override name = "DecodeError";
}

export interface DecodeOptions {
  /** The ffmpeg program and any leading arguments. Default: `ffmpeg` on PATH. */
  ffmpeg?: readonly string[];
  /** Stops the decode (a cancelled job): ffmpeg is killed and the promise rejects. */
  signal?: AbortSignal;
}

/**
 * The containers a job may send (SV-P6), by ffmpeg's demuxer names: `mov` is M4A and MP4,
 * `matroska` is WebM and MKV. A playlist or a concat list is none of them, so a file that names
 * another file (another job's audio, beside it) is refused instead of read.
 */
export const AUDIO_FORMATS = ["ogg", "matroska", "mov", "mp3", "wav", "flac", "aac"] as const;

/** The arguments after the program: first audio stream, one channel, 16 kHz, f32le to stdout. */
export function decodeArgs(path: string): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    // Input options: the input is read from a local file, never a URL, and only as audio.
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    AUDIO_FORMATS.join(","),
    "-i",
    path,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(ASR_RATE),
    "-f",
    "f32le",
    "pipe:1",
  ];
}

/** Decodes `path` to 16 kHz mono samples in [-1, 1]. */
export function decodeAudio(path: string, o: DecodeOptions = {}): Promise<Float32Array> {
  const [program, ...lead] = o.ffmpeg ?? ["ffmpeg"];
  return new Promise((resolve, reject) => {
    const child = spawn(program as string, [...lead, ...decodeArgs(path)], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: o.signal,
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => {
      stderr = (stderr + String(b)).slice(-4000);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new DecodeError(`ffmpeg is not installed, so ${basename(path)} cannot be decoded`));
      } else reject(err);
    });
    child.on("close", (code) => {
      if (o.signal?.aborted) return;
      if (code !== 0) {
        const why = stderr.trim().split("\n").at(-1) ?? `exit ${code}`;
        reject(new DecodeError(`ffmpeg could not decode ${basename(path)}: ${why}`));
        return;
      }
      const bytes = Buffer.concat(chunks);
      const n = Math.floor(bytes.length / 4);
      if (n === 0) {
        reject(new DecodeError(`${basename(path)} has no audio to transcribe`));
        return;
      }
      // Copied into a fresh, aligned buffer: a Node Buffer's offset need not be a multiple of 4.
      const out = new Float32Array(n);
      new Uint8Array(out.buffer).set(bytes.subarray(0, n * 4));
      resolve(out);
    });
  });
}
