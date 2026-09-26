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
  /** A job's error code: `too_long` for audio past the length cap, else `decode_failed`. */
  constructor(
    message: string,
    readonly code: "decode_failed" | "too_long" = "decode_failed",
  ) {
    super(message);
  }
}

export interface DecodeOptions {
  /** The ffmpeg program and any leading arguments. Default: `ffmpeg` on PATH. */
  ffmpeg?: readonly string[];
  /** Stops the decode (a cancelled job): ffmpeg is killed and the promise rejects. */
  signal?: AbortSignal;
  /**
   * The most samples a decode may give. Past it ffmpeg is killed and the decode fails `too_long`,
   * so a long file is refused before it is held in memory.
   */
  maxSamples?: number;
}

/** The refusal for audio longer than `maxSamples`. */
export function tooLong(name: string, maxSamples: number): DecodeError {
  const minutes = Math.round((maxSamples / ASR_RATE / 60) * 10) / 10;
  return new DecodeError(`${name} is longer than the ${minutes} minute limit`, "too_long");
}

const EMPTY = Buffer.alloc(0);

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
    let bytes = 0;
    let over = false;
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      if (over) return;
      bytes += b.length;
      if (o.maxSamples !== undefined && bytes > o.maxSamples * 4) {
        over = true;
        chunks.length = 0;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(b);
    });
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
      if (over) {
        reject(tooLong(basename(path), o.maxSamples as number));
        return;
      }
      if (code !== 0) {
        const why = stderr.trim().split("\n").at(-1) ?? `exit ${code}`;
        reject(new DecodeError(`ffmpeg could not decode ${basename(path)}: ${why}`));
        return;
      }
      const n = Math.floor(bytes / 4);
      if (n === 0) {
        reject(new DecodeError(`${basename(path)} has no audio to transcribe`));
        return;
      }
      // Each chunk copied once into a fresh, aligned buffer (a Node Buffer's offset need not be a
      // multiple of 4), and dropped as it goes: no concatenated copy on top.
      const out = new Float32Array(n);
      const view = new Uint8Array(out.buffer);
      let at = 0;
      for (let i = 0; i < chunks.length && at < view.length; i++) {
        const c = chunks[i] as Buffer;
        view.set(c.subarray(0, view.length - at), at);
        at += c.length;
        chunks[i] = EMPTY;
      }
      resolve(out);
    });
  });
}
