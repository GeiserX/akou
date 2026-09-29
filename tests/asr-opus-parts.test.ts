/**
 * SV-P10, the app's side: the final pass reads a part's Ogg Opus file through the capture helper's
 * `decode` (OpusParts), and `partsAudio` picks it when no WAV sits beside the parts. The helper is
 * the fake decoder here; tests/asr-opus-final.e2e.test.ts runs the real one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpusParts } from "../src/main/asr/finalize-worker.ts";
import { partsAudio } from "../src/main/index.ts";
import { tempDir } from "./helpers.ts";

const FAKE_DECODE = [process.execPath, join(import.meta.dir, "fixtures", "fake-decode.ts")];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function folder(): string {
  const t = tempDir("akou-opus-parts-");
  cleanups.push(t.cleanup);
  mkdirSync(join(t.dir, "audio"));
  return t.dir;
}

describe("OpusParts over the helper's decode", () => {
  test("the length comes from --info, a range from --from and --frames, the mic left and the call right", () => {
    const dir = folder();
    const file = join(dir, "part-001.opus");
    writeFileSync(file, "50000");
    const audio = new OpusParts(FAKE_DECODE, { 1: file });
    expect(audio.length(1)).toBe(50_000);
    expect(audio.length(2)).toBe(0);
    const mic = audio.read(1, "mic", 16_000, 16_000);
    expect(mic.length).toBe(16_000);
    expect(mic[0]).toBeCloseTo(0.016, 6);
    expect(mic[15_999]).toBeCloseTo(0.031999, 6);
    const call = audio.read(1, "call", 16_000, 16_000);
    expect(call[0]).toBeCloseTo(-0.016, 6);
    // Past the end: cut to the part, and nothing asked of the helper beyond it.
    expect(audio.read(1, "mic", 48_000, 16_000).length).toBe(2_000);
    expect(audio.read(1, "call", 50_000, 16_000).length).toBe(0);
    const calls = readFileSync(`${file}.calls`, "utf8").trim().split("\n");
    expect(calls).toEqual([
      `--in ${file} --info`,
      `--in ${file} --from 16000 --frames 16000`,
      `--in ${file} --from 48000 --frames 2000`,
    ]);
    audio.close();
  });

  test("a read hands out a copy, so a caller that writes into it never changes the next read", () => {
    const dir = folder();
    const file = join(dir, "part-001.opus");
    writeFileSync(file, "1000");
    const audio = new OpusParts(FAKE_DECODE, { 1: file });
    audio.read(1, "mic", 0, 1000).fill(9);
    expect(audio.read(1, "mic", 0, 1000)[500]).toBeCloseTo(0.0005, 6);
  });

  test("a part the helper cannot decode fails with the helper's reason", () => {
    const dir = folder();
    const file = join(dir, "part-001.opus");
    writeFileSync(file, "broken");
    const audio = new OpusParts(FAKE_DECODE, { 1: file });
    expect(() => audio.length(1)).toThrow(
      "the capture helper could not decode part 1: not an Ogg Opus file",
    );
  });
});

describe("partsAudio: where the final pass reads a call", () => {
  const helper = { command: ["akou-capture"], found: "/opt/akou/akou-capture" };

  test("every part's Opus file through the helper when no WAV sits beside them", () => {
    const dir = folder();
    writeFileSync(join(dir, "audio", "part-001.opus"), "OggS");
    writeFileSync(join(dir, "audio", "part-002.opus"), "OggS");
    expect(partsAudio({ dir, parts: [1, 2] }, helper)).toEqual({
      kind: "opus",
      command: ["akou-capture"],
      files: { 1: join(dir, "audio", "part-001.opus"), 2: join(dir, "audio", "part-002.opus") },
    });
    // One part with a WAV and one without: the Opus files, all of them.
    writeFileSync(join(dir, "audio", "part-001.wav"), "RIFF");
    expect(partsAudio({ dir, parts: [1, 2] }, helper)?.kind).toBe("opus");
  });

  test("the WAVs when every part has one", () => {
    const dir = folder();
    writeFileSync(join(dir, "audio", "part-001.opus"), "OggS");
    writeFileSync(join(dir, "audio", "part-001.wav"), "RIFF");
    expect(partsAudio({ dir, parts: [1] }, helper)).toEqual({
      kind: "wav",
      files: { 1: join(dir, "audio", "part-001.wav") },
    });
  });

  test("nothing when a part's file is missing or empty, the helper is not there, or there are no parts", () => {
    const dir = folder();
    writeFileSync(join(dir, "audio", "part-001.opus"), "OggS");
    expect(partsAudio({ dir, parts: [1, 2] }, helper)).toBeNull();
    writeFileSync(join(dir, "audio", "part-002.opus"), "");
    expect(partsAudio({ dir, parts: [1, 2] }, helper)).toBeNull();
    expect(partsAudio({ dir, parts: [1] }, { command: ["akou-capture"], found: null })).toBeNull();
    expect(partsAudio({ dir, parts: [] }, helper)).toBeNull();
  });
});
