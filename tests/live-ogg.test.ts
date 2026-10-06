/**
 * The live door's audio in (`src/main/server/ogg.ts`, `OggOpusIn` in `src/main/server/live.ts`):
 * one Ogg page per frame, checked whole, decoded at 16 kHz page by page, and placed on the
 * recording's timeline by the first page's granule.
 *
 * The fixture `fixtures/live-hello-world.opus` is the fake recognizer's "hello world" clip
 * (0.4 s of silence, the two words, 1.6 s of silence), encoded as a phone would send it:
 * `ffmpeg -i clip.wav -c:a libopus -b:a 24k -ac 1 -ar 16000 -frame_duration 20
 * -page_duration 200000 -application voip -map_metadata -1 -fflags +bitexact clip.opus`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LiveRefused, OggOpusIn } from "../src/main/server/live.ts";
import {
  OggError,
  oggCrc,
  oggPages,
  opusHead,
  opusSamples48k,
  readOggPage,
} from "../src/main/server/ogg.ts";
import { bursts, concat, silence, speak } from "./fixtures/asr-fake.ts";

const FILE = new Uint8Array(
  readFileSync(join(import.meta.dir, "fixtures", "live-hello-world.opus")),
);
const PAGES = oggPages(FILE);
const CLIP = concat(silence(0.4), speak(["hello", "world"]), silence(1.6));

/** A copy of a page with one byte changed, its CRC left as it was. */
function flipped(page: Uint8Array, at: number): Uint8Array {
  const out = page.slice();
  out[at] = (out[at] as number) ^ 0x5a;
  return out;
}

/** A copy of a page with its serial (or sequence) rewritten and its CRC made right again. */
function rewritten(page: Uint8Array, field: "serial" | "seq", value: number): Uint8Array {
  const out = page.slice();
  const v = new DataView(out.buffer);
  v.setUint32(field === "serial" ? 14 : 18, value, true);
  v.setUint32(22, oggCrc(out), true);
  return out;
}

async function decodeAll(pages: Uint8Array[]): Promise<{ samples: Float32Array; inp: OggOpusIn }> {
  const inp = new OggOpusIn();
  const parts: Float32Array[] = [];
  for (const p of pages) parts.push(await inp.push(p));
  inp.close();
  return { samples: concat(...parts), inp };
}

describe("Ogg pages, one per frame", () => {
  test("the fixture is OpusHead, OpusTags, then 200 ms pages of ten 20 ms packets", () => {
    const pages = PAGES.map(readOggPage);
    expect(pages.length).toBe(16);
    expect(pages[0]?.bos).toBe(true);
    expect(opusHead(pages[0]?.packets[0] as Uint8Array)).toEqual({ channels: 1, preSkip: 312 });
    expect(new TextDecoder().decode(pages[1]?.packets[0]?.subarray(0, 8))).toBe("OpusTags");
    for (const p of pages.slice(2, -1)) {
      expect(p.packets.length).toBe(10);
      expect(p.packets.map(opusSamples48k)).toEqual(Array(10).fill(960));
    }
    expect(pages.map((p) => p.seq)).toEqual([...Array(16).keys()]);
    expect(pages.at(-1)?.eos).toBe(true);
  });

  test("a page with a changed byte, a missing byte or one too many is refused", () => {
    const page = PAGES[5] as Uint8Array;
    expect(() => readOggPage(page)).not.toThrow();
    // Positive controls: each of these is the same page, broken one way.
    expect(() => readOggPage(flipped(page, page.length - 3))).toThrow("CRC");
    expect(() => readOggPage(page.subarray(0, page.length - 1))).toThrow(OggError);
    expect(() => readOggPage(concat8(page, Uint8Array.of(0)))).toThrow(OggError);
    expect(() => readOggPage(flipped(page, 0))).toThrow("OggS");
    expect(() => readOggPage(page.subarray(0, 20))).toThrow(OggError);
  });

  test("a packet's length comes from its TOC byte: SILK, hybrid and CELT frames, and code 3", () => {
    // SILK 20 ms, one frame; hybrid 10 ms, two frames; CELT 2.5 ms, code 3 with 4 frames.
    expect(opusSamples48k(Uint8Array.of((1 << 3) | 0))).toBe(960);
    expect(opusSamples48k(Uint8Array.of((12 << 3) | 1))).toBe(960);
    expect(opusSamples48k(Uint8Array.of((16 << 3) | 3, 4))).toBe(480);
    expect(opusSamples48k(new Uint8Array(0))).toBe(0);
  });
});

function concat8(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

describe("OggOpusIn: libopus at 16 kHz, page by page", () => {
  test("the decoded clip lines up with the clip: the pre-skip dropped, the words in place", async () => {
    const { samples, inp } = await decodeAll(PAGES);
    expect(inp.offset).toBe(0);
    // The encoder pads the end to whole packets; the start is exact once the pre-skip is gone.
    expect(samples.length).toBeGreaterThanOrEqual(CLIP.length);
    expect(samples.length - CLIP.length).toBeLessThan(16_000 * 0.03);
    const said = bursts(CLIP);
    const heard = bursts(samples);
    expect(heard.length).toBe(said.length);
    heard.forEach(([a, b], i) => {
      const [x, y] = said[i] as [number, number];
      expect(Math.abs(a - x)).toBeLessThan(16_000 * 0.03);
      expect(Math.abs(b - y)).toBeLessThan(16_000 * 0.03);
    });
    // Correlation with the clip over its length: a decode at the wrong rate or offset is near 0.
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i < CLIP.length; i++) {
      const x = CLIP[i] as number;
      const y = samples[i] as number;
      xy += x * y;
      xx += x * x;
      yy += y * y;
    }
    expect(xy / Math.sqrt(xx * yy)).toBeGreaterThan(0.9);
  });

  test("a session that starts mid-file (a reconnect) is placed by its first page's granule", async () => {
    const whole = await decodeAll(PAGES);
    const later = await decodeAll([...PAGES.slice(0, 2), ...PAGES.slice(5)]);
    // Page 5 starts 3 pages in: 3 x 9600 samples at 48 kHz, less the pre-skip, which only the
    // recording's first page carries.
    expect(later.inp.offset).toBeCloseTo((3 * 9600 - 312) / 48_000, 6);
    expect(whole.samples.length - later.samples.length).toBe((3 * 9600 - 312) / 3);
  });

  test("a page out of order, from another stream, or before the headers ends the session", async () => {
    const run = async (pages: Uint8Array[]) => {
      const inp = new OggOpusIn();
      try {
        for (const p of pages) await inp.push(p);
        return null;
      } catch (err) {
        return err instanceof LiveRefused ? `${err.code}: ${err.message}` : String(err);
      } finally {
        inp.close();
      }
    };
    expect(await run(PAGES.slice(0, 6))).toBeNull();
    expect(await run([...PAGES.slice(0, 4), PAGES[5] as Uint8Array])).toBe(
      "bad_page: page 5 follows page 3",
    );
    expect(await run([...PAGES.slice(0, 3), rewritten(PAGES[3] as Uint8Array, "serial", 7)])).toBe(
      "bad_page: the page belongs to another Ogg stream (its serial)",
    );
    expect(await run([PAGES[2] as Uint8Array])).toBe(
      "bad_page: the first page must be the OpusHead page",
    );
    expect(await run([PAGES[0] as Uint8Array, PAGES[2] as Uint8Array])).toBe(
      "bad_page: the second page must be the OpusTags page",
    );
    expect(await run([...PAGES.slice(0, 3), flipped(PAGES[3] as Uint8Array, 40)])).toBe(
      "bad_page: the page's CRC is wrong",
    );
  });

  test("a second OpusHead page, or a granule that goes back, is refused even on a reconnect", async () => {
    const run = async (pages: Uint8Array[]) => {
      const inp = new OggOpusIn();
      try {
        for (const p of pages) await inp.push(p);
        return null;
      } catch (err) {
        return err instanceof LiveRefused ? err.message : String(err);
      } finally {
        inp.close();
      }
    };
    // A reconnect's first audio page is any page; the control goes through.
    expect(await run([...PAGES.slice(0, 2), PAGES[6] as Uint8Array])).toBeNull();
    expect(await run([...PAGES.slice(0, 2), PAGES[0] as Uint8Array])).toBe(
      "an OpusHead page after the stream began: open a new socket",
    );
    // Page 7 renumbered to follow page 6 but carrying page 5's granule: the clock went back.
    const back = (PAGES[5] as Uint8Array).slice();
    const v = new DataView(back.buffer);
    v.setUint32(18, 7, true);
    v.setUint32(22, oggCrc(back), true);
    expect(await run([...PAGES.slice(0, 2), PAGES[6] as Uint8Array, back])).toBe(
      "page 7's granule 38400 is before the last page's 48000",
    );
  });

  test("a stereo stream is refused: the live words are mono", async () => {
    const head = PAGES[0]?.slice() as Uint8Array;
    // The OpusHead's channel count is byte 9 of the packet, after the 28-byte page header.
    head[28 + 9] = 2;
    new DataView(head.buffer).setUint32(22, oggCrc(head), true);
    const inp = new OggOpusIn();
    await expect(inp.push(head)).rejects.toThrow("2 channels");
  });
});
