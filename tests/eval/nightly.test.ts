/**
 * The parts of the nightly evaluation (scripts/eval/nightly.ts) that need no model and no network:
 * reading one file out of a remote zip with range requests, and reading a WAV into the
 * recognizer's rate. The downloads and the models run in the nightly job itself.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { readWav, zipDirectory, zipFile } from "../../scripts/eval/nightly.ts";
import { ASR_RATE } from "../../src/main/asr/engine.ts";

/** A zip holding `files`, each stored or deflated, the way `zip` writes one (no ZIP64). */
function makeZip(files: { name: string; data: Uint8Array; deflate: boolean }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const body = f.deflate ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const name = new TextEncoder().encode(f.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, f.deflate ? 8 : 0, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, f.deflate ? 8 : 0, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A server that answers byte ranges of `body`, and counts the bytes it sent. */
function rangeServer(body: Uint8Array) {
  const sent = { bytes: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
      if (!m) return new Response("range only", { status: 416 });
      const from = Math.max(0, Number(m[1]));
      const part = body.subarray(from, Number(m[2]) + 1);
      sent.bytes += part.length;
      return new Response(part, { status: 206 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/set.zip`, sent, stop: () => server.stop(true) };
}

describe("[TS-20] one file out of a remote zip", () => {
  const big = new Uint8Array(200_000).map((_, i) => (i * 7) % 251);
  const wanted = new TextEncoder().encode("SPEAKER x 1 0 1 <NA> <NA> a <NA> <NA>\n".repeat(50));
  const zip = makeZip([
    { name: "voxconverse_dev_wav/audio/aaaaa.wav", data: big, deflate: false },
    { name: "voxconverse_dev_wav/audio/bbbbb.wav", data: wanted, deflate: true },
  ]);
  const srv = rangeServer(zip);
  afterAll(() => srv.stop());

  test("the directory, then only the wanted file's bytes, stored or deflated", async () => {
    const entries = await zipDirectory(srv.url, zip.length);
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      ["voxconverse_dev_wav/audio/aaaaa.wav", 0, 200_000],
      ["voxconverse_dev_wav/audio/bbbbb.wav", 8, wanted.length],
    ]);
    srv.sent.bytes = 0;
    const got = await zipFile(srv.url, entries[1] as (typeof entries)[number]);
    expect(got).toEqual(wanted);
    // The 200 kB file next to it was never downloaded.
    expect(srv.sent.bytes).toBeLessThan(2_000);
    expect(await zipFile(srv.url, entries[0] as (typeof entries)[number])).toEqual(big);
  });

  test("positive control: a size that does not match the directory fails", async () => {
    const [e] = await zipDirectory(srv.url, zip.length);
    await expect(
      zipFile(srv.url, { ...(e as NonNullable<typeof e>), size: 199_999 }),
    ).rejects.toThrow("200000 bytes, want 199999");
  });
});

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
