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
 * The glyph is five rounded bars of a sound level, one shape for the idle state. Windows and Linux
 * get a mid blue that reads on a dark and a light panel; neither recolours a tray image. The
 * files are committed; a test checks they equal what this script draws, so the two never drift.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The bars on a 32-unit square: left edge, width and height, centred vertically. */
const BARS = [
  { x: 2, h: 12 },
  { x: 8, h: 20 },
  { x: 14, h: 28 },
  { x: 20, h: 20 },
  { x: 26, h: 12 },
] as const;
const BAR_W = 4;
const UNITS = 32;
/** Samples per pixel side for the antialiased edge. */
const SS = 4;

type Rgb = readonly [number, number, number];
const BLACK: Rgb = [0, 0, 0];
const BLUE: Rgb = [0x2f, 0x7c, 0xf6];

/** Is a point (in units) inside a bar with round ends? */
function inside(px: number, py: number): boolean {
  const r = BAR_W / 2;
  for (const b of BARS) {
    if (px < b.x || px > b.x + BAR_W) continue;
    const top = (UNITS - b.h) / 2 + r;
    const bottom = (UNITS + b.h) / 2 - r;
    const cx = b.x + r;
    const cy = Math.min(Math.max(py, top), bottom);
    if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) return true;
  }
  return false;
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
