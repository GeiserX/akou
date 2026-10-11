/**
 * The Wyoming framing (docs/ux/SERVER.md SV-C2) against the `wyoming` 1.10.2 package's reader and
 * writer: lengths are UTF-8 byte counts, a data block wins over inline `data`, a header line past
 * the Python reader's 65536-byte limit ends the connection, and a header announcing a body past the
 * reader's bound is refused before the body is held.
 */

import { describe, expect, test } from "bun:test";
import {
  encode,
  FrameError,
  FrameReader,
  FrameTooLarge,
  MAX_HEADER_BYTES,
  type WyomingEvent,
} from "../src/main/server/wyoming-frame.ts";

const utf8 = new TextEncoder();
const bytes = (...parts: (string | Uint8Array)[]) => {
  const all = parts.map((p) => (typeof p === "string" ? utf8.encode(p) : p));
  const out = new Uint8Array(all.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

describe("[SV-C2] Wyoming framing", () => {
  test("[SV-C2] encode then read gives the events back, payload and all", () => {
    const events: WyomingEvent[] = [
      { type: "describe", data: {}, payload: null },
      { type: "transcript", data: { text: "hello world", language: "en" }, payload: null },
      {
        type: "audio-chunk",
        data: { rate: 16000, width: 2, channels: 1, timestamp: null },
        payload: new Uint8Array([1, 2, 3, 4]),
      },
    ];
    const r = new FrameReader();
    const got = r.push(bytes(...events.map(encode)));
    expect(got).toEqual(events);
  });

  test("[SV-C2] akou writes as the Python writer: data in the block, no inline data", () => {
    const wire = new TextDecoder().decode(
      encode({ type: "transcript", data: { text: "hi" }, payload: null }),
    );
    const [line, rest] = [wire.slice(0, wire.indexOf("\n")), wire.slice(wire.indexOf("\n") + 1)];
    expect(JSON.parse(line)).toEqual({ type: "transcript", data_length: 13 });
    expect(rest).toBe('{"text":"hi"}');
    // An event with no data and no payload is the header alone.
    expect(new TextDecoder().decode(encode({ type: "ping", data: {}, payload: null }))).toBe(
      '{"type":"ping"}\n',
    );
  });

  test("[SV-C2] a header split across three pushes, then its block and payload, is one event", () => {
    const wire = encode({
      type: "audio-chunk",
      data: { rate: 16000, width: 2, channels: 1 },
      payload: new Uint8Array([9, 8, 7]),
    });
    const r = new FrameReader();
    expect(r.push(wire.subarray(0, 5))).toEqual([]);
    expect(r.push(wire.subarray(5, 20))).toEqual([]);
    expect(r.push(wire.subarray(20, wire.byteLength - 1))).toEqual([]);
    const [e] = r.push(wire.subarray(wire.byteLength - 1));
    expect(e?.data).toEqual({ rate: 16000, width: 2, channels: 1 });
    expect([...(e?.payload ?? [])]).toEqual([9, 8, 7]);
  });

  test("[SV-C2] inline data and a data block are merged, the block winning", () => {
    const block = '{"language":"es"}';
    const r = new FrameReader();
    const [e] = r.push(
      bytes(
        `{"type":"transcribe","data":{"language":"en","name":"fast"},"data_length":${block.length}}\n`,
        block,
      ),
    );
    expect(e).toEqual({
      type: "transcribe",
      data: { language: "es", name: "fast" },
      payload: null,
    });
  });

  test("[SV-C2] data_length is the UTF-8 byte count, so accented text frames right", () => {
    const text = "¿Qué tal, Ñandú? Sí, está bien.";
    const wire = encode({ type: "transcript", data: { text }, payload: null });
    const header = JSON.parse(new TextDecoder().decode(wire.subarray(0, wire.indexOf(0x0a))));
    const json = JSON.stringify({ text });
    expect(header.data_length).toBe(Buffer.byteLength(json));
    expect(header.data_length).not.toBe(json.length);
    // Two events back to back: a wrong count would shift the second one.
    const r = new FrameReader();
    const got = r.push(bytes(wire, encode({ type: "ping", data: {}, payload: null })));
    expect(got.map((e) => e.type)).toEqual(["transcript", "ping"]);
    expect(got[0]?.data.text).toBe(text);
  });

  test("[SV-C2] red control: the string length as data_length does not frame", () => {
    const json = JSON.stringify({ text: "¿Qué tal, Ñandú?" });
    const wrong = bytes(
      `{"type":"transcript","data_length":${json.length}}\n`,
      json,
      '{"type":"ping"}\n',
    );
    // The block is cut short inside the JSON, so the reader refuses it rather than mis-reading.
    expect(() => new FrameReader().push(wrong)).toThrow(FrameError);
  });

  test("[SV-C2] a header line of 65536 bytes parses; 65537 is refused, as Python's readline", () => {
    // A line of exactly `n` bytes before its newline.
    const line = (n: number) => {
      const head = '{"type":"describe","data":{"x":"';
      const tail = '"}}';
      return `${head}${"a".repeat(n - head.length - tail.length)}${tail}`;
    };
    expect(Buffer.byteLength(line(MAX_HEADER_BYTES))).toBe(MAX_HEADER_BYTES);
    // The edge: asyncio's limit counts the bytes before the newline, so 65536 of them pass.
    const edge = utf8.encode(`${line(MAX_HEADER_BYTES)}\n`);
    expect(new FrameReader().push(edge).map((e) => e.type)).toEqual(["describe"]);
    // The same 65536 bytes with the newline still to come: held, not refused.
    const r = new FrameReader();
    expect(r.push(edge.subarray(0, MAX_HEADER_BYTES))).toEqual([]);
    expect(r.push(edge.subarray(MAX_HEADER_BYTES)).map((e) => e.type)).toEqual(["describe"]);
    // One byte more is refused, with its newline in the same push or with none yet.
    const over = `${line(MAX_HEADER_BYTES + 1)}\n`;
    expect(() => new FrameReader().push(utf8.encode(over))).toThrow(FrameError);
    expect(() => new FrameReader().push(utf8.encode(over.slice(0, -1)))).toThrow(FrameError);
  });

  test("[SV-C2] a header claiming a body past the bound is refused before it is buffered", () => {
    const bound = 1024 * 1024;
    // One billion bytes announced: refused on the header push, with no byte of the body sent.
    const r = new FrameReader(bound);
    expect(() =>
      r.push(utf8.encode('{"type":"audio-chunk","payload_length":1000000000}\n')),
    ).toThrow(FrameTooLarge);
    // Data and payload count together.
    expect(() =>
      new FrameReader(bound).push(
        utf8.encode(`{"type":"audio-chunk","data_length":2,"payload_length":${bound - 1}}\n`),
      ),
    ).toThrow(FrameTooLarge);
    // Control: exactly the bound is taken, and the event comes out once its bytes arrive.
    const ok = new FrameReader(bound);
    expect(
      ok.push(
        utf8.encode(`{"type":"audio-chunk","data_length":2,"payload_length":${bound - 2}}\n`),
      ),
    ).toEqual([]);
    expect(ok.push(utf8.encode("{}"))).toEqual([]);
    expect(ok.push(new Uint8Array(bound / 2))).toEqual([]);
    const [e] = ok.push(new Uint8Array(bound / 2 - 2).fill(7));
    expect(e?.type).toBe("audio-chunk");
    expect(e?.payload?.byteLength).toBe(bound - 2);
    expect(e?.payload?.[bound - 3]).toBe(7);
  });

  test("[SV-C2] a payload is the bytes as pushed, even when the caller reuses its buffer", () => {
    const r = new FrameReader();
    const buf = Buffer.from('{"type":"audio-chunk","payload_length":4}\n\x01\x02', "latin1");
    expect(r.push(buf)).toEqual([]);
    // The socket's buffer is overwritten before the rest arrives.
    buf.fill(0);
    const [e] = r.push(new Uint8Array([3, 4]));
    expect([...(e?.payload ?? [])]).toEqual([1, 2, 3, 4]);
  });

  test("[SV-C2] a line that is not JSON, or has no type, is refused", () => {
    expect(() => new FrameReader().push(utf8.encode("hello there\n"))).toThrow(FrameError);
    expect(() => new FrameReader().push(utf8.encode('{"data":{}}\n'))).toThrow(FrameError);
    expect(() => new FrameReader().push(utf8.encode('["describe"]\n'))).toThrow(FrameError);
    expect(() => new FrameReader().push(utf8.encode('{"type":"x","payload_length":-1}\n'))).toThrow(
      FrameError,
    );
  });

  test("[SV-T4 shape] the bytes the wyoming 1.10.2 writer sends parse", () => {
    // Captured from wyoming 1.10.2's write_event: `version` in the header, data in the block.
    const wire = bytes(
      '{"type": "audio-chunk", "version": "1.10.2", "data_length": 61, "payload_length": 4}\n',
      '{"rate": 16000, "width": 2, "channels": 1, "timestamp": null}',
      new Uint8Array([1, 2, 3, 4]),
      '{"type": "describe", "version": "1.10.2"}\n',
    );
    const got = new FrameReader().push(wire);
    expect(got).toEqual([
      {
        type: "audio-chunk",
        data: { rate: 16000, width: 2, channels: 1, timestamp: null },
        payload: new Uint8Array([1, 2, 3, 4]),
      },
      { type: "describe", data: {}, payload: null },
    ]);
  });
});
