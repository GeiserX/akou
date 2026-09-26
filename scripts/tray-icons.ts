/**
 * Draws the tray icon (docs/ux/DESKTOP.md DK-T1) and writes it per OS into `src/main/window/tray/`:
 *
 *   bun scripts/tray-icons.ts
 *
 * - `akou-template.png`: macOS, a template image. Only its alpha counts: the menu bar recolours it
 *   for a dark or a light bar. 32 px, shown at 16 pt, so it is sharp on a Retina display.
 * - `akou.ico`: Windows, 16 and 32 px PNG frames in one ICO.
 * - `akou.png`: the Linux AppIndicator, 32 px.
 *
 * The glyph is akou's mark (`assets/brand/akou-mark-mono.svg`): a lowercase a whose counter holds a
 * dot, one shape for the idle state, drawn on the mark's 32-unit grid so every edge of the ring and
 * the stem lands on a whole pixel at 16 px. The dot is the glyph's own colour, never red, so the
 * idle icon never reads as recording. Windows and Linux get a mid blue that reads on a dark and a
 * light panel; neither recolours a tray image. The files are committed; a test checks they equal
 * what this script draws, so the two never drift.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The mark on a 32-unit square: a ring and the stem of the a, both 4 units wide, and the dot. */
const RING = { cx: 16, cy: 16, r: 8 } as const;
const STEM = { x: 24, top: 8, bottom: 24 } as const;
const STROKE = 4;
const DOT_R = 2.5;
const UNITS = 32;
/** Samples per pixel side for the antialiased edge. */
const SS = 4;

type Rgb = readonly [number, number, number];
const BLACK: Rgb = [0, 0, 0];
const BLUE: Rgb = [0x2f, 0x7c, 0xf6];

/** Is a point (in units) inside the mark? */
function inside(px: number, py: number): boolean {
  const h = STROKE / 2;
  const d = Math.hypot(px - RING.cx, py - RING.cy);
  if (Math.abs(d - RING.r) <= h || d <= DOT_R) return true;
  // The stem, with round ends.
  const cy = Math.min(Math.max(py, STEM.top), STEM.bottom);
  return (px - STEM.x) ** 2 + (py - cy) ** 2 <= h * h;
}

/** The glyph at `size` pixels, RGBA, straight alpha. */
function draw(size: number, rgb: Rgb): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const unit = UNITS / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inside((x + (sx + 0.5) / SS) * unit, (y + (sy + 0.5) / SS) * unit)) hit++;
        }
      }
      const i = (y * size + x) * 4;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = Math.round((255 * hit) / (SS * SS));
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A zlib stream of stored (uncompressed) blocks. A compressor's output differs between zlib
 * builds, so the committed files could not be compared byte for byte on every OS; stored blocks
 * are the same everywhere, and a tray icon is a few kilobytes either way.
 */
function zlibStored(data: Uint8Array): Buffer {
  const parts: Buffer[] = [Buffer.from([0x78, 0x01])];
  const MAX = 0xffff;
  for (let at = 0; at < data.length; at += MAX) {
    const block = data.subarray(at, at + MAX);
    const head = Buffer.alloc(5);
    head[0] = at + MAX >= data.length ? 1 : 0;
    head.writeUInt16LE(block.length, 1);
    head.writeUInt16LE(~block.length & 0xffff, 3);
    parts.push(head, Buffer.from(block));
  }
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0, 0);
  parts.push(adler);
  return Buffer.concat(parts);
}

/** An 8-bit RGBA PNG, every row unfiltered. */
export function png(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)).copy(rows, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(rows)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** An ICO whose frames are PNGs (Windows Vista and later read them). */
export function ico(frames: { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach((f, i) => {
    const e = 6 + 16 * i;
    head[e] = f.size % 256;
    head[e + 1] = f.size % 256;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(f.png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += f.png.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.png)]);
}

/** Every tray file, by name. */
export function trayIconFiles(): Record<string, Uint8Array> {
  return {
    "akou-template.png": png(32, draw(32, BLACK)),
    "akou.ico": ico([16, 32].map((size) => ({ size, png: png(size, draw(size, BLUE)) }))),
    "akou.png": png(32, draw(32, BLUE)),
  };
}

if (import.meta.main) {
  const dir = join(import.meta.dir, "..", "src", "main", "window", "tray");
  for (const [name, bytes] of Object.entries(trayIconFiles())) {
    writeFileSync(join(dir, name), bytes);
    console.log(`${name}: ${bytes.byteLength} bytes`);
  }
}
