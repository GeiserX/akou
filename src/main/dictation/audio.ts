/**
 * A dictation's kept audio (docs/ux/DICTATION.md DC-H2): `dictation/audio/<id>.wav` under the
 * config folder, beside the dictation log, so Retry (DC-G1) and the learning check (DC-L3) can
 * decode the same audio again.
 *
 * The spec names an Opus file. The app has no Opus encoder or decoder of its own (the helper
 * encodes a call's Opus, and only ffmpeg in server mode reads it back), so the audio is kept as the
 * 16 kHz 16-bit mono WAV the app already reads without ffmpeg: about 32 KB a second.
 *
 * Only a spoken dictation is kept. A clip sent to `POST /v1/dictations` is the caller's own file and
 * akou keeps no copy of it, and a password field's audio is never written (DC-N8).
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wavBytes } from "../asr/qwen.ts";
import { readUploadAudio } from "../server/audio.ts";

export const DICTATION_AUDIO = "audio";

const EXT = ".wav";

export class DictationAudio {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  path(id: string): string {
    return join(this.dir, `${id}${EXT}`);
  }

  has(id: string): boolean {
    return existsSync(this.path(id));
  }

  /** Writes a dictation's audio; a failure is the caller's to log, never the dictation's end. */
  write(id: string, samples: Float32Array): void {
    writeFileSync(this.path(id), wavBytes(samples), { mode: 0o600 });
  }

  /** The dictation's audio as 16 kHz mono samples, or null when none is kept. */
  async read(id: string): Promise<Float32Array | null> {
    if (!this.has(id)) return null;
    return readUploadAudio(this.path(id));
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }

  /** The ids of every kept file. */
  ids(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(EXT))
      .map((f) => f.slice(0, -EXT.length));
  }
}
