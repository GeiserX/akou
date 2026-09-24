import { describe, expect, test } from "bun:test";
import { type GapSignal, PartIngest, PcmQueue } from "../src/main/capture/ingest.ts";
import type { Packet } from "../src/main/capture/protocol.ts";

const RATE = 16000;
const PKT = 320; // 20 ms

function packet(
  ch: "mic" | "call",
  i: number,
  o: { zero?: boolean; nsOffset?: bigint; value?: number } = {},
): Packet {
  return {
    ch,
    zeroFilled: !!o.zero,
    captureNs: 1_000_000_000n + BigInt(i) * 20_000_000n + (o.nsOffset ?? 0n),
    fileSeconds: (i * PKT) / RATE,
    samples: new Float32Array(PKT).fill(o.zero ? 0 : (o.value ?? 0.2)),
  };
}

describe("[T0.15] unbounded queue when one source stops", () => {
  const TEN_MINUTES = (10 * 60 * RATE) / PKT;

  test("mic for 10 minutes, call never delivers: channels stay frame-aligned and memory is bounded", () => {
    const ing = new PartIngest({ queueSeconds: 60 });
    for (let i = 0; i < TEN_MINUTES; i++) ing.push(packet("mic", i));
    const cap = 60 * RATE;
    expect(ing.pos.mic).toBe(10 * 60 * RATE);
    // The silent side is written as zeros and trails by at most the lag bound.
    expect(ing.pos.mic - ing.pos.call).toBeLessThanOrEqual(RATE);
    expect(ing.zeroFilled.call).toBe(ing.pos.call);
    expect(ing.queues.mic.peak).toBeLessThanOrEqual(cap);
    expect(ing.queues.call.peak).toBeLessThanOrEqual(cap);
    expect(ing.queues.mic.dropped).toBe(ing.pos.mic - cap);
  });

  test("positive control: without the lag rule the silent side never advances", () => {
    const ing = new PartIngest({ queueSeconds: 60, maxLagSeconds: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 1000; i++) ing.push(packet("mic", i));
    expect(ing.pos.mic - ing.pos.call).toBeGreaterThan(RATE);
  });

  test("positive control: an uncapped queue grows with the call", () => {
    const q = new PcmQueue(Number.POSITIVE_INFINITY);
    for (let i = 0; i < 10_000; i++) q.push(i * PKT, new Float32Array(PKT));
    expect(q.peak).toBe(10_000 * PKT);
    const capped = new PcmQueue(1000);
    for (let i = 0; i < 10_000; i++) capped.push(i * PKT, new Float32Array(PKT));
    expect(capped.peak).toBeLessThanOrEqual(1000);
  });

  test("a late call packet for time already filled is trimmed, never fed twice", () => {
    const ing = new PartIngest();
    for (let i = 0; i < 200; i++) ing.push(packet("mic", i)); // 4 s of mic
    const filled = ing.pos.call;
    ing.push(packet("call", 10)); // 0.2 s: long since zero-filled
    expect(ing.pos.call).toBe(filled);
    ing.push(packet("call", 199)); // current
    expect(ing.pos.call).toBe(ing.pos.mic);
  });

  test("a gap in one channel's packets is zero-filled on the file timeline", () => {
    const ing = new PartIngest();
    ing.push(packet("call", 0));
    ing.push(packet("call", 5));
    expect(ing.pos.call).toBe(6 * PKT);
    expect(ing.zeroFilled.call).toBe(4 * PKT);
    const chunks = ing.queues.call.drain();
    expect(chunks.map((c) => c.start)).toEqual([0, PKT, 5 * PKT]);
  });
});

describe("[T0.16] a tap silent from the start never blocks the mic", () => {
  test("mic audio flows from the first packet while the call side is zero-filled", () => {
    const first: string[] = [];
    const ing = new PartIngest({ onFirstAudio: (ch) => first.push(ch) });
    for (let i = 0; i < 50; i++) {
      ing.push(packet("mic", i));
      ing.push(packet("call", i, { zero: true }));
    }
    expect(first).toEqual(["mic"]);
    expect(ing.firstAudio).toEqual({ mic: true, call: false });
    const mic = ing.queues.mic.drain();
    expect(mic[0]?.start).toBe(0);
    expect(mic[0]?.samples[0]).toBeCloseTo(0.2);
  });
});

describe("pause and mute", () => {
  test("pause drops packets; mute zeroes the mic copy only", () => {
    const ing = new PartIngest();
    ing.push(packet("mic", 0));
    ing.pause();
    ing.push(packet("mic", 1));
    expect(ing.droppedWhilePaused).toBe(PKT);
    ing.resume();
    ing.muted = true;
    ing.push(packet("mic", 1));
    ing.push(packet("call", 1));
    const mic = ing.queues.mic.drain();
    const call = ing.queues.call.drain();
    expect(mic[1]?.samples.every((s) => s === 0)).toBe(true);
    expect(call.at(-1)?.samples[0]).toBeCloseTo(0.2);
  });
});

describe("[spike] wake from sleep", () => {
  test("a host-clock jump the file does not show is one gap, reported once for both channels", () => {
    const gaps: GapSignal[] = [];
    const ing = new PartIngest({ onGap: (g) => gaps.push(g) });
    for (let i = 0; i < 10; i++) {
      ing.push(packet("mic", i));
      ing.push(packet("call", i));
    }
    const slept = 3_600_000_000_000n;
    ing.push(packet("mic", 10, { nsOffset: slept }));
    ing.push(packet("call", 10, { nsOffset: slept }));
    expect(gaps.length).toBe(1);
    expect(gaps[0]?.a).toBeCloseTo(0.2);
    expect(gaps[0]?.toNs && gaps[0].toNs - gaps[0].fromNs).toBe(slept);
  });

  test("positive control: the same jump across a pause is not a sleep", () => {
    const gaps: GapSignal[] = [];
    const ing = new PartIngest({ onGap: (g) => gaps.push(g) });
    ing.push(packet("mic", 0));
    ing.pause();
    ing.resume();
    ing.push(packet("mic", 1, { nsOffset: 3_600_000_000_000n }));
    expect(gaps).toEqual([]);
  });
});
