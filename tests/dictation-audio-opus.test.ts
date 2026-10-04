/**
 * DC-H2: a dictation's kept audio is Opus written and read by the capture helper, here the fake
 * codec (tests/fixtures/fake-codec.ts); `tests/dictation-audio-opus.e2e.test.ts` runs the real one.
 * A WAV kept before stays readable, and a failed encode keeps a WAV rather than nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DictationAudio } from "../src/main/dictation/audio.ts";
import { tempDir } from "./helpers.ts";

const CODEC = join(import.meta.dir, "fixtures", "fake-codec.ts");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function store(switches: string[] | null, logs: string[] = []): DictationAudio {
  const t = tempDir("akou-dict-opus-");
  cleanups.push(t.cleanup);
  return new DictationAudio(t.dir, {
    helper: () => (switches ? [process.execPath, CODEC, ...switches] : null),
    onLog: (_level, msg) => logs.push(msg),
  });
}

const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => (i % 200) / 400 - 0.25);

describe("DC-H2: a dictation's audio is kept as Opus", () => {
  test("the helper encodes it to <id>.opus and decodes it back; no WAV is written", async () => {
    const a = store([]);
    const samples = ramp(16_000);
    a.write("d1", samples);
    // Kept from the moment it is handed over, while the encode still runs.
    expect(a.has("d1")).toBe(true);
    expect(await a.file("d1")).toEqual({ path: join(a.dir, "d1.opus"), type: "audio/ogg" });
    expect(readdirSync(a.dir)).toEqual(["d1.opus"]);
    expect(readFileSync(join(a.dir, "d1.opus")).subarray(0, 8).toString()).toBe("FAKEOPUS");
    expect(await a.read("d1")).toEqual(samples);
    expect(a.ids()).toEqual(["d1"]);
  });

  test("a read asked while the encode runs waits for it", async () => {
    const a = store(["--delay", "300"]);
    const samples = ramp(8_000);
    a.write("d2", samples);
    expect(await a.read("d2")).toEqual(samples);
  });

  test("an encode that fails keeps the audio as WAV and says why", async () => {
    const logs: string[] = [];
    const a = store(["--fail"], logs);
    const samples = ramp(16_000);
    a.write("d3", samples);
    expect((await a.file("d3"))?.type).toBe("audio/wav");
    expect(readdirSync(a.dir)).toEqual(["d3.wav"]);
    expect((await a.read("d3"))?.length).toBe(samples.length);
    expect(logs).toEqual([
      "dictation audio d3 kept as WAV: the capture helper could not encode it: disk full",
    ]);
  });

  test("a delete while the encode runs leaves no file once it ends", async () => {
    const a = store(["--delay", "300"]);
    a.write("d4", ramp(16_000));
    a.remove("d4");
    expect(await a.file("d4")).toBeNull();
    expect(a.has("d4")).toBe(false);
    expect(readdirSync(a.dir)).toEqual([]);
  });

  test("a WAV kept before Opus is still read, served as audio/wav, listed and deleted", async () => {
    const old = store(null);
    const samples = ramp(16_000);
    old.write("d5", samples);
    const a = new DictationAudio(old.dir, { helper: () => [process.execPath, CODEC] });
    expect(await a.file("d5")).toEqual({ path: join(a.dir, "d5.wav"), type: "audio/wav" });
    expect((await a.read("d5"))?.length).toBe(samples.length);
    expect(a.ids()).toEqual(["d5"]);
    a.remove("d5");
    expect(readdirSync(a.dir)).toEqual([]);
  });
});
