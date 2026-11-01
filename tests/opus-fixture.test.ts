/**
 * The silent Ogg Opus fixture the window's player tests play (docs/TRAPS.md WK-2). It must hold
 * real frames: a packet that is a TOC byte alone is a zero-length frame, which Chromium and
 * Linux WebKit play as silence and macOS WebKit's decoder refuses for the whole file.
 */

import { describe, expect, test } from "bun:test";
import { silentOpus } from "./fixtures/opus.ts";

/** The packets of an Ogg stream, in order, joined across their lacing values. */
function packets(ogg: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let cur: number[] = [];
  for (let at = 0; at < ogg.length; ) {
    expect(new TextDecoder().decode(ogg.subarray(at, at + 4))).toBe("OggS");
    const n = ogg[at + 26] as number;
    let o = at + 27 + n;
    for (let i = 0; i < n; i++) {
      const len = ogg[at + 27 + i] as number;
      cur.push(...ogg.subarray(o, o + len));
      o += len;
      if (len < 255) {
        out.push(Uint8Array.from(cur));
        cur = [];
      }
    }
    at = o;
  }
  return out;
}

describe("the silent Opus fixture", () => {
  test("[WK-2] every audio packet is the silence frame libopus writes, never a TOC byte alone", () => {
    const all = packets(silentOpus(12));
    expect(new TextDecoder().decode(all[0]?.subarray(0, 8))).toBe("OpusHead");
    expect(new TextDecoder().decode(all[1]?.subarray(0, 8))).toBe("OpusTags");
    const audio = all.slice(2);
    // 20 ms frames: 50 a second.
    expect(audio.length).toBe(12 * 50);
    for (const p of audio) expect([...p]).toEqual([0xf8, 0xff, 0xfe]);
  });
});
