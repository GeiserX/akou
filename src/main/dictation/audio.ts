/**
 * A dictation's kept audio (docs/ux/DICTATION.md DC-H2): `dictation/audio/<id>.opus` under the
 * config folder, beside the dictation log, so Retry (DC-G1) and the learning check (DC-L3) can
 * decode the same audio again.
 *
 * The app has no Opus codec of its own, so the capture helper that writes a call's Opus does both
 * ends: `akou-capture encode` turns the 16 kHz mono samples into a mono Ogg Opus file at 24 kbps,
 * about 180 KB a minute, and `akou-capture decode` reads it back. A 16-bit WAV, what was kept
 * before, is about 1.9 MB a minute; one already on disk is still read, served and deleted. With no
 * helper to run, or when the encode fails, the audio is kept as that WAV rather than lost.
 *
 * The encode runs off the caller's thread: until it ends the dictation has audio (`has`), a read
 * waits for it, and a removal asked meanwhile deletes what it wrote.
 *
 * Only a spoken dictation is kept. A clip sent to `POST /v1/dictations` is the caller's own file and
 * akou keeps no copy of it, and a password field's audio is never written (DC-N8).
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wavBytes } from "../asr/qwen.ts";
import { readUploadAudio } from "../server/audio.ts";

export const DICTATION_AUDIO = "audio";

const OPUS = ".opus";
const WAV = ".wav";

/** A kept file and the type it is served as. */
export interface KeptAudio {
  path: string;
  type: "audio/ogg" | "audio/wav";
}

export interface DictationAudioOptions {
  /** The capture helper's command (`encode` and `decode` are appended); null keeps WAV. */
  helper?: () => readonly string[] | null;
  /** An encode that failed, so the audio was kept as WAV. */
  onLog?: (level: "warn", msg: string) => void;
}

/** The helper's last stderr line, its `msg` when it is a warn line. */
function why(stderr: string, code: number | null): string {
  const line = stderr.trim().split("\n").at(-1) || `exit ${code}`;
  try {
    return (JSON.parse(line) as { msg?: string }).msg ?? line;
  } catch {
    return line;
  }
}

export class DictationAudio {
  /** Encodes in flight, by id. */
  private readonly pending = new Map<string, Promise<void>>();
  /** Ids removed while their encode ran: what it writes is deleted. */
  private readonly dropped = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly o: DictationAudioOptions = {},
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** The file kept for `id` on disk now, or null. */
  kept(id: string): KeptAudio | null {
    const opus = join(this.dir, `${id}${OPUS}`);
    if (existsSync(opus)) return { path: opus, type: "audio/ogg" };
    const wav = join(this.dir, `${id}${WAV}`);
    if (existsSync(wav)) return { path: wav, type: "audio/wav" };
    return null;
  }

  has(id: string): boolean {
    return this.pending.has(id) || this.kept(id) !== null;
  }

  /** The file kept for `id` once its encode has ended, or null. */
  async file(id: string): Promise<KeptAudio | null> {
    await this.pending.get(id);
    return this.kept(id);
  }

  /**
   * Keeps a dictation's audio: as Opus through the helper, else as WAV. A failure to write either is
   * the caller's to log, never the dictation's end.
   */
  write(id: string, samples: Float32Array): void {
    this.dropped.delete(id);
    const helper = this.o.helper?.() ?? null;
    if (!helper) {
      this.writeWav(id, samples);
      return;
    }
    const done = this.encode(helper, id, samples)
      .catch((err: Error) => {
        if (this.dropped.has(id)) return;
        this.o.onLog?.("warn", `dictation audio ${id} kept as WAV: ${err.message}`);
        this.writeWav(id, samples);
      })
      .catch((err: Error) => {
        this.o.onLog?.("warn", `dictation audio not kept: ${err.message}`);
      })
      .finally(() => {
        this.pending.delete(id);
        if (this.dropped.delete(id)) this.removeFiles(id);
      });
    this.pending.set(id, done);
  }

  private writeWav(id: string, samples: Float32Array): void {
    writeFileSync(join(this.dir, `${id}${WAV}`), wavBytes(samples), { mode: 0o600 });
  }

  private async encode(helper: readonly string[], id: string, samples: Float32Array) {
    const part = join(this.dir, `${id}${OPUS}.part`);
    try {
      const proc = Bun.spawn([...helper, "encode", "--out", part], {
        stdin: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
        stdout: "ignore",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0)
        throw new Error(`the capture helper could not encode it: ${why(stderr, code)}`);
      renameSync(part, join(this.dir, `${id}${OPUS}`));
    } finally {
      rmSync(part, { force: true });
    }
  }

  /** The dictation's audio as 16 kHz mono samples, or null when none is kept. */
  async read(id: string): Promise<Float32Array | null> {
    const kept = await this.file(id);
    if (!kept) return null;
    if (kept.type === "audio/wav") return readUploadAudio(kept.path);
    const helper = this.o.helper?.() ?? null;
    if (!helper) throw new Error(`no capture helper to decode ${kept.path}`);
    const proc = Bun.spawn([...helper, "decode", "--in", kept.path], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, raw, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`the capture helper could not decode it: ${why(stderr, code)}`);
    // Stereo f32 at 16 kHz; a mono file decodes to the same samples on both sides.
    const stereo = new Float32Array(raw, 0, (raw.byteLength >> 3) * 2);
    const out = new Float32Array(stereo.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = stereo[2 * i] as number;
    return out;
  }

  remove(id: string): void {
    if (this.pending.has(id)) this.dropped.add(id);
    this.removeFiles(id);
  }

  private removeFiles(id: string): void {
    for (const ext of [OPUS, WAV]) rmSync(join(this.dir, `${id}${ext}`), { force: true });
  }

  /** The ids of every kept file. */
  ids(): string[] {
    const ids = new Set<string>();
    for (const f of readdirSync(this.dir)) {
      for (const ext of [OPUS, WAV]) if (f.endsWith(ext)) ids.add(f.slice(0, -ext.length));
    }
    return [...ids];
  }
}
