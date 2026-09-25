/**
 * A job's upload read as 16 kHz mono (docs/ux/SERVER.md SV-P6). A 16 kHz PCM WAV is read without
 * ffmpeg, and a streaming writer (ffmpeg or sox to a pipe, arecord) cannot seek back to fill in the
 * `data` chunk's size: it leaves 0xFFFFFFFF or 0 there. Those files are read to their end, so a
 * piped WAV neither fails the job nor comes back as an empty transcript.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { monoWav, RATE, tone } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** Two seconds of tone as a mono 16 kHz WAV whose `data` size field reads `size`. */
function wavWithDataSize(size: number | null): string {
  const t = tempDir("akou-audio-");
  cleanups.push(t.cleanup);
  const bytes = monoWav(tone(2, 440));
  if (size !== null) new DataView(bytes.buffer).setUint32(40, size, true);
  const path = join(t.dir, "in.wav");
  writeFileSync(path, bytes);
  return path;
}

/** ffmpeg must never be reached: these WAVs are the no-ffmpeg path. */
const NO_FFMPEG = { ffmpeg: ["/nonexistent/ffmpeg"] };

describe("SV-P6: a 16 kHz PCM WAV is read without ffmpeg", () => {
  test("positive control: a WAV with its real data size gives every sample", async () => {
    const got = await readUploadAudio(wavWithDataSize(null), NO_FFMPEG);
    expect(got.length).toBe(2 * RATE);
  });

  test("a piped WAV whose data size is 0xFFFFFFFF is read to its end", async () => {
    const got = await readUploadAudio(wavWithDataSize(0xffffffff), NO_FFMPEG);
    expect(got.length).toBe(2 * RATE);
  });

  test("a piped WAV whose data size is 0 is read to its end, not as empty audio", async () => {
    const got = await readUploadAudio(wavWithDataSize(0), NO_FFMPEG);
    expect(got.length).toBe(2 * RATE);
  });

  test("a data size past the end of the file reads only what the file holds", async () => {
    const got = await readUploadAudio(wavWithDataSize(10 * RATE * 2), NO_FFMPEG);
    expect(got.length).toBe(2 * RATE);
  });
});
