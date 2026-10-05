/**
 * Ogg pages and Opus packets for the live door (`GET /v1/live`): one Ogg page per WebSocket
 * message, the same bytes a client appends to its recording, read here with no container library.
 *
 * - `readOggPage` checks one page whole (RFC 3533): the capture pattern, version 0, the segment
 *   table, the length, and the CRC32, so a corrupted or cut message is refused, never decoded.
 * - `opusHead` reads the identification header of RFC 7845 section 5.1: the channels and the
 *   pre-skip, the encoder's lookahead the decoder drops once at the start of a recording.
 * - `opusSamples48k` is a packet's length from its TOC byte (RFC 6716 section 3.1), at 48 kHz, the
 *   rate an Ogg Opus granule position always counts in. The live door uses it to place a session
 *   that starts mid-recording (a reconnect) on the recording's own timeline.
 */

export class OggError extends Error {
  override name = "OggError";
}

export interface OggPage {
  /** The first packet continues one the page before began (header type bit 0x01). */
  continued: boolean;
  /** The first page of the stream (0x02). */
  bos: boolean;
  /** The last page of the stream (0x04). */
  eos: boolean;
  /**
   * 48 kHz samples up to the end of the last packet that ends on this page; -1 when no packet
   * ends on it.
   */
  granule: bigint;
  serial: number;
  /** The page's sequence number. */
  seq: number;
  /**
   * The packet data on this page, in order. With `continued`, the first is the end of a packet the
   * page before began; with `open`, the last goes on onto the next page.
   */
  packets: Uint8Array[];
  /** The last packet does not end on this page (its last lacing value is 255). */
  open: boolean;
}

const HEADER = 27;
const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"

/** The Ogg CRC32: polynomial 0x04c11db7, most significant bit first, no reflection, start 0. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** The page's checksum, computed with its own CRC field read as zero. */
export function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const b = i >= 22 && i < 26 ? 0 : (page[i] as number);
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ b) & 0xff] as number)) >>> 0;
  }
  return crc;
}

/** One whole Ogg page, exactly: anything before, after or missing is refused. */
export function readOggPage(bytes: Uint8Array): OggPage {
  if (bytes.length < HEADER) throw new OggError(`a page is at least ${HEADER} bytes`);
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== CAPTURE[i]) throw new OggError("not an Ogg page: no OggS capture pattern");
  }
  if (bytes[4] !== 0) throw new OggError(`Ogg version ${bytes[4]}; only 0 exists`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = bytes[5] as number;
  const segments = bytes[26] as number;
  const bodyAt = HEADER + segments;
  if (bytes.length < bodyAt) throw new OggError("the page ends inside its segment table");
  let body = 0;
  for (let i = 0; i < segments; i++) body += bytes[HEADER + i] as number;
  if (bytes.length !== bodyAt + body) {
    throw new OggError(
      `the page's segment table says ${bodyAt + body} bytes and the message has ${bytes.length}`,
    );
  }
  if (view.getUint32(22, true) !== oggCrc(bytes)) throw new OggError("the page's CRC is wrong");
  const packets: Uint8Array[] = [];
  let start = bodyAt;
  let at = bodyAt;
  let open = false;
  for (let i = 0; i < segments; i++) {
    const lace = bytes[HEADER + i] as number;
    at += lace;
    open = lace === 255;
    if (!open) {
      packets.push(bytes.subarray(start, at));
      start = at;
    }
  }
  if (open) packets.push(bytes.subarray(start, at));
  return {
    continued: (type & 0x01) !== 0,
    bos: (type & 0x02) !== 0,
    eos: (type & 0x04) !== 0,
    granule: view.getBigInt64(6, true),
    serial: view.getUint32(14, true),
    seq: view.getUint32(18, true),
    packets,
    open,
  };
}

/** What the decoder needs from the OpusHead packet. */
export interface OpusHead {
  channels: number;
  /** 48 kHz samples the decoder drops at the start of the recording. */
  preSkip: number;
}

/** The OpusHead packet (RFC 7845 section 5.1), or an error saying what is wrong with it. */
export function opusHead(packet: Uint8Array): OpusHead {
  if (packet.length < 19 || new TextDecoder().decode(packet.subarray(0, 8)) !== "OpusHead") {
    throw new OggError("the first packet is not an OpusHead");
  }
  if ((packet[8] as number) >> 4 !== 0) {
    throw new OggError(`OpusHead version ${packet[8]} is not one this server reads`);
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return { channels: packet[9] as number, preSkip: view.getUint16(10, true) };
}

/** Whether a packet is the OpusTags header (RFC 7845 section 5.2). */
export function isOpusTags(packet: Uint8Array): boolean {
  return packet.length >= 8 && new TextDecoder().decode(packet.subarray(0, 8)) === "OpusTags";
}

/** A frame's length in 48 kHz samples, by the TOC byte's configuration (RFC 6716 table 2). */
function frameSamples(config: number): number {
  if (config < 12) return [480, 960, 1920, 2880][config % 4] as number;
  if (config < 16) return config % 2 === 0 ? 480 : 960;
  return [120, 240, 480, 960][config % 4] as number;
}

/** A packet's audio, 48 kHz samples, from its TOC byte and frame count (RFC 6716 section 3.1). */
export function opusSamples48k(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0] as number;
  const code = toc & 0x03;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frames * frameSamples(toc >> 3);
}

/**
 * A whole Ogg file cut into its pages, each the bytes one live frame carries (the test client,
 * `scripts/live-client.ts`). Only the lengths are read here; `readOggPage` checks each page.
 */
export function oggPages(file: Uint8Array): Uint8Array[] {
  const pages: Uint8Array[] = [];
  let at = 0;
  while (at < file.length) {
    if (file.length - at < HEADER) throw new OggError("the file ends inside a page header");
    const segments = file[at + 26] as number;
    let size = HEADER + segments;
    for (let i = 0; i < segments; i++) size += file[at + HEADER + i] as number;
    if (at + size > file.length) throw new OggError("the file ends inside a page");
    pages.push(file.subarray(at, at + size));
    at += size;
  }
  return pages;
}
