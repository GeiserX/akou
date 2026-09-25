/**
 * Decoding any container through ffmpeg to 16 kHz mono float (docs/ux/SERVER.md SV-P6). A fake
 * ffmpeg (a Bun script) pins the arguments and the error paths on every OS; the real ffmpeg, where
 * the machine has one, decodes Opus in Ogg, AAC in M4A, MP3 and Opus in WebM made here from a tone.
 * The image always has ffmpeg, and the server CI job transcribes the same four containers in it
 * (`scripts/server-smoke.ts`).
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DecodeError, decodeAudio } from "../src/main/asr/decode.ts";
import { tempDir } from "./helpers.ts";

/** A stand-in ffmpeg: records its arguments, then writes `samples` as f32le or fails. */
function fakeFfmpeg(dir: string, o: { samples?: number[]; fail?: string }): string[] {
  const script = join(dir, "ffmpeg.ts");
  writeFileSync(
    script,
    `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
const fail = ${JSON.stringify(o.fail ?? null)};
if (fail) {
  process.stderr.write("Input #0, something\\n" + fail + "\\n");
  process.exit(1);
}
const out = new Float32Array(${JSON.stringify(o.samples ?? [])});
process.stdout.write(new Uint8Array(out.buffer));
`,
  );
  return [process.execPath, script];
}

describe("[SV-P6] decoding through ffmpeg to 16 kHz mono float", () => {
  test("asks ffmpeg for the first audio stream as one channel at 16000 Hz in f32le, and reads the samples", async () => {
    const t = tempDir();
    const ffmpeg = fakeFfmpeg(t.dir, { samples: [0, 0.5, -0.25, 1] });
    const input = join(t.dir, "note.ogg");
    writeFileSync(input, "x");
    const pcm = await decodeAudio(input, { ffmpeg });
    expect([...pcm]).toEqual([0, 0.5, -0.25, 1]);
    const argv = JSON.parse(await Bun.file(join(t.dir, "argv.json")).text()) as string[];
    const pair = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(pair("-i")).toBe(input);
    expect(pair("-map")).toBe("0:a:0");
    expect(pair("-ac")).toBe("1");
    expect(pair("-ar")).toBe("16000");
    expect(pair("-f")).toBe("f32le");
    expect(argv).toContain("-nostdin");
    t.cleanup();
  });

  test("a file ffmpeg cannot read is a DecodeError carrying ffmpeg's own reason; positive control: the same file through a working ffmpeg decodes", async () => {
    const t = tempDir();
    const input = join(t.dir, "notes.txt");
    writeFileSync(input, "not audio");
    const bad = decodeAudio(input, {
      ffmpeg: fakeFfmpeg(t.dir, { fail: `${input}: Invalid data found when processing input` }),
    });
    await expect(bad).rejects.toBeInstanceOf(DecodeError);
    await expect(bad).rejects.toThrow("Invalid data found when processing input");
    const good = await decodeAudio(input, { ffmpeg: fakeFfmpeg(t.dir, { samples: [0.1] }) });
    expect(good.length).toBe(1);
    t.cleanup();
  });

  test("no ffmpeg on the machine is a DecodeError that says so", async () => {
    const t = tempDir();
    const input = join(t.dir, "note.ogg");
    writeFileSync(input, "x");
    const missing = decodeAudio(input, { ffmpeg: [join(t.dir, "no-such-ffmpeg")] });
    await expect(missing).rejects.toBeInstanceOf(DecodeError);
    await expect(missing).rejects.toThrow("ffmpeg is not installed");
    t.cleanup();
  });

  test("a stream with no samples is a DecodeError, never an empty transcript", async () => {
    const t = tempDir();
    const input = join(t.dir, "empty.ogg");
    writeFileSync(input, "x");
    await expect(
      decodeAudio(input, { ffmpeg: fakeFfmpeg(t.dir, { samples: [] }) }),
    ).rejects.toThrow("no audio");
    t.cleanup();
  });

  const real = Bun.which("ffmpeg");
  test.skipIf(!real)(
    "the real ffmpeg decodes .ogg, .m4a, .mp3 and .webm tones to one second of 440 Hz at 16 kHz mono, and refuses a text file (skipped when ffmpeg is not installed)",
    async () => {
      const t = tempDir();
      const encode = (name: string, codec: string[]) => {
        const out = join(t.dir, name);
        const r = Bun.spawnSync([
          real as string,
          "-nostdin",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=1",
          // Stereo at 48 kHz, so a decode that kept two channels or the source rate is caught.
          "-ac",
          "2",
          ...codec,
          out,
        ]);
        expect(r.exitCode).toBe(0);
        return out;
      };
      const files = [
        encode("note.ogg", ["-c:a", "libopus"]),
        encode("note.m4a", ["-c:a", "aac"]),
        encode("note.mp3", ["-c:a", "libmp3lame"]),
        encode("note.webm", ["-c:a", "libopus"]),
      ];
      for (const f of files) {
        const pcm = await decodeAudio(f);
        // One second, whatever padding the codec adds: two channels or 48 kHz would be 2x or 3x.
        expect(pcm.length / 16000).toBeGreaterThan(0.95);
        expect(pcm.length / 16000).toBeLessThan(1.1);
        // The pitch survives: zero crossings over the middle half second of a 440 Hz tone.
        let crossings = 0;
        for (let i = 4001; i < 12000; i++) {
          if ((pcm[i - 1] as number) < 0 !== (pcm[i] as number) < 0) crossings++;
        }
        expect(crossings).toBeGreaterThan(420);
        expect(crossings).toBeLessThan(460);
      }
      const text = join(t.dir, "notes.txt");
      writeFileSync(text, "this is not audio\n");
      await expect(decodeAudio(text)).rejects.toBeInstanceOf(DecodeError);
      t.cleanup();
    },
    30_000,
  );
});
