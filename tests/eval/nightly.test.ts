/**
 * The part of the nightly evaluation (scripts/eval/nightly.ts) that needs no model and no network:
 * reading a WAV into the recognizer's rate. The downloads and the models run in the nightly job
 * itself; the scoring is tested in score.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinned, readWav } from "../../scripts/eval/nightly.ts";
import { ASR_RATE } from "../../src/main/asr/engine.ts";

describe("a WAV at the recognizer's rate", () => {
  /** A 16-bit PCM WAV. */
  function wav(
    rate: number,
    channels: number,
    frames: (i: number, c: number) => number,
    n: number,
  ) {
    const b = new Uint8Array(44 + n * channels * 2);
    const v = new DataView(b.buffer);
    b.set(new TextEncoder().encode("RIFF"), 0);
    v.setUint32(4, 36 + n * channels * 2, true);
    b.set(new TextEncoder().encode("WAVEfmt "), 8);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, channels, true);
    v.setUint32(24, rate, true);
    v.setUint16(34, 16, true);
    b.set(new TextEncoder().encode("data"), 36);
    v.setUint32(40, n * channels * 2, true);
    for (let i = 0; i < n; i++)
      for (let c = 0; c < channels; c++)
        v.setInt16(44 + (i * channels + c) * 2, Math.round(frames(i, c) * 32767), true);
    return b;
  }

  test("16 kHz mono passes through; 48 kHz stereo is mixed down and resampled", () => {
    const mono = readWav(wav(ASR_RATE, 1, (i) => (i % 2 ? 0.5 : -0.5), 1600));
    expect(mono.length).toBe(1600);
    expect(mono[1]).toBeCloseTo(0.5, 3);
    // Left 0.5 and right -0.5 mix to silence; one second stays one second.
    const st = readWav(wav(48_000, 2, (_i, c) => (c === 0 ? 0.5 : -0.5), 48_000));
    expect(st.length).toBe(ASR_RATE);
    expect(Math.max(...st.map(Math.abs))).toBeLessThan(1e-3);
    expect(() => readWav(new Uint8Array(44))).toThrow("not a PCM WAV");
  });

  /** `wav`'s header with its format tag and sample width rewritten, samples left as they are. */
  const retag = (b: Uint8Array, format: number, bits: number) => {
    const v = new DataView(b.buffer);
    v.setUint16(20, format, true);
    v.setUint16(34, bits, true);
    return b;
  };

  test("a sample format it cannot decode is refused, never read as 16-bit", () => {
    const ok = () => wav(ASR_RATE, 1, () => 0.25, 1200);
    // 24-bit PCM and the extensible tag (0xFFFE) would otherwise decode as 16-bit noise.
    expect(() => readWav(retag(ok(), 1, 24))).toThrow("format 1 with 24 bits");
    expect(() => readWav(retag(ok(), 0xfffe, 16))).toThrow("format 65534 with 16 bits");
    expect(() => readWav(retag(ok(), 3, 16))).toThrow("format 3 with 16 bits");
    // Positive control: 32-bit float, the other format it reads, still decodes.
    const f = new Uint8Array(44 + 4 * 400);
    f.set(ok().subarray(0, 44));
    const fv = new DataView(f.buffer);
    retag(f, 3, 32);
    fv.setUint32(40, 4 * 400, true);
    for (let i = 0; i < 400; i++) fv.setFloat32(44 + 4 * i, 0.25, true);
    const x = readWav(f);
    expect(x.length).toBe(400);
    expect(x[399]).toBeCloseTo(0.25, 6);
  });
});

describe("a pinned download", () => {
  test("a fetch that fails its hash leaves nothing at the path, and a good one lands there", async () => {
    const good = new TextEncoder().encode("the pinned bytes");
    let body = good.subarray(0, 5); // a truncated fetch
    const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    const dir = mkdtempSync(join(tmpdir(), "akou-pinned-"));
    try {
      const url = `http://127.0.0.1:${server.port}/f`;
      const path = join(dir, "f");
      const sha = createHash("sha256").update(good).digest("hex");
      await expect(pinned(url, path, sha)).rejects.toThrow("pinned");
      // Nothing half-written stays behind for the next run to trip on.
      expect(readdirSync(dir)).toEqual([]);
      body = good;
      expect(await pinned(url, path, sha)).toEqual(good);
      expect(readdirSync(dir)).toEqual(["f"]);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the committed baselines", () => {
  test("every platform with numbers names the decoder they were measured with", () => {
    const b = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "..", "docs", "gates", "nightly-baselines.json"),
        "utf8",
      ),
    ) as { _measured: Record<string, string>; platforms: Record<string, Record<string, number>> };
    const named = Object.keys(b.platforms).filter((p) =>
      /\b(greedy|beam)\b/.test(b._measured[p] ?? ""),
    );
    expect(named).toEqual(Object.keys(b.platforms));
  });
});
