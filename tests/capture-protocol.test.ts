import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARK_LIVE_ARGS, harkArgs, StereoS16Decoder } from "../src/main/capture/hark.ts";
import { helperArgs } from "../src/main/capture/helper.ts";
import {
  encodePacket,
  LineSplitter,
  nsFromWire,
  PACKET_HEADER_BYTES,
  type Packet,
  PacketDecoder,
  ProtocolError,
  parseStderrLine,
} from "../src/main/capture/protocol.ts";

function pkt(ch: "mic" | "call", i: number, frames = 320): Packet {
  const samples = new Float32Array(frames);
  for (let k = 0; k < frames; k++) samples[k] = Math.sin(i + k / 7) * 0.5;
  return {
    ch,
    zeroFilled: i % 3 === 0,
    captureNs: 9_007_199_254_740_993n + BigInt(i) * 20_000_000n,
    fileSeconds: i * 0.02,
    samples,
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Splits bytes at pseudo-random points, including single bytes and splits inside headers. */
function chop(bytes: Uint8Array, seed: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let s = seed;
  let i = 0;
  while (i < bytes.length) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const n = 1 + (s % 97);
    out.push(bytes.subarray(i, i + n));
    i += n;
  }
  return out;
}

describe("akou-capture/1 packets", () => {
  test("the header is 28 bytes, little-endian, as DESIGN 2.4 lays it out", () => {
    const bytes = encodePacket({
      ch: "call",
      zeroFilled: true,
      captureNs: 258n,
      fileSeconds: 1.5,
      samples: new Float32Array([0.25]),
    });
    expect(PACKET_HEADER_BYTES).toBe(28);
    expect(bytes.length).toBe(32);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("AKP1");
    const v = new DataView(bytes.buffer);
    expect(v.getUint8(4)).toBe(1);
    expect(v.getUint8(5)).toBe(1);
    expect(v.getUint16(6, true)).toBe(0);
    expect(v.getBigUint64(8, true)).toBe(258n);
    expect(v.getFloat64(16, true)).toBe(1.5);
    expect(v.getUint32(24, true)).toBe(1);
    expect(v.getFloat32(28, true)).toBe(0.25);
  });

  test("[T1.11] every packet and every frame is decoded exactly once however reads split", () => {
    const sent = Array.from({ length: 60 }, (_, i) => pkt(i % 2 === 0 ? "mic" : "call", i));
    const bytes = concat(sent.map(encodePacket));
    for (const seed of [1, 2, 3, 99]) {
      const d = new PacketDecoder();
      const got = chop(bytes, seed).flatMap((c) => d.push(c));
      expect(got.length).toBe(sent.length);
      expect(d.pending).toBe(0);
      for (let i = 0; i < sent.length; i++) {
        const a = sent[i] as Packet;
        const b = got[i] as Packet;
        expect(b.ch).toBe(a.ch);
        expect(b.zeroFilled).toBe(a.zeroFilled);
        expect(b.captureNs).toBe(a.captureNs);
        expect(b.fileSeconds).toBe(a.fileSeconds);
        expect(b.samples).toEqual(a.samples);
      }
    }
  });

  test("capture_ns keeps full u64 precision beyond 2^53", () => {
    const d = new PacketDecoder();
    const [p] = d.push(encodePacket({ ...pkt("mic", 1), captureNs: 18_000_000_000_000_000_001n }));
    expect(p?.captureNs).toBe(18_000_000_000_000_000_001n);
  });

  test("a packet split before its samples waits for them", () => {
    const bytes = encodePacket(pkt("mic", 1));
    const d = new PacketDecoder();
    expect(d.push(bytes.subarray(0, 40))).toEqual([]);
    expect(d.pending).toBe(40);
    expect(d.push(bytes.subarray(40)).length).toBe(1);
  });

  test("bad framing is a protocol error, never audio", () => {
    const bytes = encodePacket(pkt("mic", 1));
    bytes[0] = 0x42;
    expect(() => new PacketDecoder().push(bytes)).toThrow(ProtocolError);
    const huge = encodePacket(pkt("mic", 1, 1));
    new DataView(huge.buffer).setUint32(24, 16000 * 11, true);
    expect(() => new PacketDecoder().push(huge)).toThrow(/frames/);
    const badCh = encodePacket(pkt("mic", 1, 1));
    badCh[4] = 7;
    expect(() => new PacketDecoder().push(badCh)).toThrow(/channel/);
  });
});

describe("akou-capture/1 stderr and stdin", () => {
  test("every message type of DESIGN 2.4 parses", () => {
    const lines = [
      { type: "hello", protocol: "akou-capture/1", version: "0.1.0", caps: ["tap"] },
      {
        type: "capturing",
        mic: { id: "default", name: "Mic", rate: 48000 },
        call: { mode: "system", rate: 48000 },
        exclude: ["akou Graphics and Media"],
        capture_ns: "123456789012345678",
      },
      { type: "first_audio", ch: "mic", capture_ns: 5 },
      { type: "level", mic_dbfs: -20, call_dbfs: -30 },
      { type: "health", ch: "call", state: "dead", silent_for: 12, rebuilds: 1, detail: "x" },
      { type: "device", ch: "mic", event: "changed", name: "USB" },
      { type: "warn", code: "permission-suspect", msg: "open System Settings" },
      { type: "stopped", file_seconds: 12.5, reason: "stop" },
    ];
    for (const l of lines) {
      const r = parseStderrLine(JSON.stringify(l));
      expect(r.kind).toBe("msg");
    }
  });

  test("the example lines printed in DESIGN 2.4 parse exactly as written", () => {
    const design = readFileSync(join(import.meta.dir, "..", "docs", "DESIGN.md"), "utf8");
    const section = design.slice(design.indexOf("### 2.4"), design.indexOf("### 2.5"));
    const block = /```jsonl\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const parsed = lines.map((l) => parseStderrLine(l));
    expect(parsed.map((p) => (p.kind === "msg" ? p.msg.type : p.line))).toEqual([
      "hello",
      "capturing",
      "first_audio",
      "level",
      "health",
      "device",
      "warn",
      "stopped",
    ]);
    // Positive control: the design's `capturing` without its anchor is not a capturing message.
    const capturing = JSON.parse(lines[1] as string) as Record<string, unknown>;
    delete capturing.capture_ns;
    expect(parseStderrLine(JSON.stringify(capturing)).kind).toBe("text");
  });

  test("text, malformed JSON and unknown types go to the log only", () => {
    expect(parseStderrLine("CoreAudio: something happened").kind).toBe("text");
    expect(parseStderrLine("{not json").kind).toBe("text");
    expect(parseStderrLine(JSON.stringify({ type: "surprise" })).kind).toBe("text");
    expect(
      parseStderrLine(
        JSON.stringify({ type: "health", ch: "left", state: "x", silent_for: 1, rebuilds: 0 }),
      ).kind,
    ).toBe("text");
    expect(
      parseStderrLine(JSON.stringify({ type: "capturing", mic: null, call: null, exclude: [] }))
        .kind,
    ).toBe("text");
  });

  test("capture_ns on the wire may be a decimal string or a safe integer", () => {
    expect(nsFromWire("18446744073709551615")).toBe(18446744073709551615n);
    expect(nsFromWire(42)).toBe(42n);
  });

  test("lines split across reads are reassembled; CRLF is stripped", () => {
    const s = new LineSplitter();
    const enc = new TextEncoder();
    expect(s.push(enc.encode('{"type":"he'))).toEqual([]);
    expect(s.push(enc.encode('llo"}\r\nsecond\nthi'))).toEqual(['{"type":"hello"}', "second"]);
    expect(s.flush()).toEqual(["thi"]);
  });

  test("launch arguments are exactly the DESIGN 2.4 command line", () => {
    expect(
      helperArgs({
        part: 2,
        out: "/c/audio/part-002.opus",
        mic: "default",
        call: "system",
        excludeResponsible: "com.example.akou",
      }),
    ).toEqual([
      "run",
      "--out",
      "/c/audio/part-002.opus",
      "--mic",
      "default",
      "--call",
      "system",
      "--exclude-responsible",
      "com.example.akou",
    ]);
  });
});

describe("hark dialect (stereo-s16le)", () => {
  test("live flags are the spike's flags, in order", () => {
    expect(harkArgs({}, { part: 1, out: "x", mic: "default", call: "system" })).toEqual([
      ...HARK_LIVE_ARGS,
    ]);
    expect([...HARK_LIVE_ARGS].join(" ")).toBe(
      "--system --mix --tracks stereo --capture-backend coreaudio -a - --raw -r 16000 -b 16",
    );
    expect(
      harkArgs({ inputFile: "in.wav" }, { part: 1, out: "x", mic: "default", call: "system" }),
    ).toEqual(["-i", "in.wav", "-a", "-", "--raw", "-r", "16000", "-b", "16", "-c", "2"]);
  });

  function interleaved(frames: number): Uint8Array {
    const b = new Uint8Array(frames * 4);
    const v = new DataView(b.buffer);
    for (let i = 0; i < frames; i++) {
      v.setInt16(i * 4, (i % 30000) + 1, true); // left: mic
      v.setInt16(i * 4 + 2, -((i % 30000) + 1), true); // right: call
    }
    return b;
  }

  test("[T1.11] a read ending inside a frame or a sample never feeds a frame twice or drops one", () => {
    const frames = 16000 * 3 + 7;
    const bytes = interleaved(frames);
    for (const seed of [5, 6, 7]) {
      const d = new StereoS16Decoder(() => 1_000_000n);
      const mic: number[] = [];
      const call: number[] = [];
      let expectedFile = 0;
      for (const c of chop(bytes, seed)) {
        for (const p of d.push(c)) {
          if (p.ch === "mic") {
            expect(p.fileSeconds).toBeCloseTo(expectedFile, 9);
            expectedFile += p.samples.length / 16000;
            for (const s of p.samples) mic.push(Math.round(s * 32768));
          } else {
            for (const s of p.samples) call.push(Math.round(s * 32768));
          }
        }
      }
      expect(d.frames).toBe(frames);
      expect(d.pending).toBe(0);
      expect(mic.length).toBe(frames);
      expect(call.length).toBe(frames);
      for (let i = 0; i < frames; i += 997) {
        expect(mic[i]).toBe((i % 30000) + 1);
        expect(call[i]).toBe(-((i % 30000) + 1));
      }
    }
  });

  test("positive control: a decoder that drops the partial frame of each read loses frames", () => {
    const frames = 16000;
    const bytes = interleaved(frames);
    let naive = 0;
    for (const c of chop(bytes, 5)) naive += Math.floor(c.length / 4);
    expect(naive).toBeLessThan(frames);
  });

  test("time is derived from the byte count on one shared clock", () => {
    const d = new StereoS16Decoder(() => 1_000_000_000n);
    d.push(interleaved(8000));
    const [mic, call] = d.push(interleaved(8000));
    expect(mic?.fileSeconds).toBe(0.5);
    expect(mic?.captureNs).toBe(1_500_000_000n);
    expect(call?.captureNs).toBe(mic?.captureNs as bigint);
  });
});
