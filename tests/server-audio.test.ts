/**
 * A job's upload read as 16 kHz mono (docs/ux/SERVER.md SV-P6). A 16 kHz PCM WAV is read without
 * ffmpeg, and a streaming writer (ffmpeg or sox to a pipe, arecord) cannot seek back to fill in the
 * `data` chunk's size: it leaves 0xFFFFFFFF or 0 there. Those files are read to their end, so a
 * piped WAV neither fails the job nor comes back as an empty transcript.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DecodeError, decodeAudio } from "../src/main/asr/decode.ts";
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

/** A stand-in for ffmpeg: writes `bytes` of float zeros to stdout (forever for -1), then exits 0. */
function fakeFfmpeg(bytes: number): string[] {
  const script = `
    const chunk = new Uint8Array(65536);
    let left = ${bytes};
    const out = Bun.stdout.writer();
    while (left !== 0) {
      const n = left < 0 ? chunk.length : Math.min(chunk.length, left);
      out.write(chunk.subarray(0, n));
      await out.flush();
      if (left > 0) left -= n;
    }
    await out.end();
  `;
  return [process.execPath, "-e", script, "--"];
}

async function refusal(p: Promise<unknown>): Promise<DecodeError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DecodeError) return err;
    throw err;
  }
  throw new Error("the decode did not fail");
}

describe("SV-E3: a job's audio has a length cap, checked before it is held in memory", () => {
  test("a WAV longer than the cap fails as too_long", async () => {
    const err = await refusal(
      readUploadAudio(wavWithDataSize(null), { ...NO_FFMPEG, maxSamples: RATE }),
    );
    expect(err.code).toBe("too_long");
  });

  test("positive control: a WAV exactly at the cap is read", async () => {
    const got = await readUploadAudio(wavWithDataSize(null), {
      ...NO_FFMPEG,
      maxSamples: 2 * RATE,
    });
    expect(got.length).toBe(2 * RATE);
  });

  test("ffmpeg's output past the cap stops the decode as too_long", async () => {
    const path = join(tempDirFor(), "in.ogg");
    writeFileSync(path, "not read by the fake");
    // The fake never stops writing: only the cap ends it.
    const err = await refusal(decodeAudio(path, { ffmpeg: fakeFfmpeg(-1), maxSamples: RATE }));
    expect(err.code).toBe("too_long");
  });

  test("positive control: ffmpeg's output at the cap is every sample", async () => {
    const path = join(tempDirFor(), "in.ogg");
    writeFileSync(path, "not read by the fake");
    const got = await decodeAudio(path, { ffmpeg: fakeFfmpeg(RATE * 4), maxSamples: RATE });
    expect(got.length).toBe(RATE);
  });

  test("a machine with no ffmpeg is a decode_failed error that says so", async () => {
    const path = join(tempDirFor(), "in.ogg");
    writeFileSync(path, "x");
    const err = await refusal(decodeAudio(path, NO_FFMPEG));
    expect(err.code).toBe("decode_failed");
    expect(err.message).toContain("ffmpeg is not installed");
  });
});

function tempDirFor(): string {
  const t = tempDir("akou-audio-");
  cleanups.push(t.cleanup);
  return t.dir;
}
