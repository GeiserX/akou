/**
 * A synthetic Ogg Opus file: an `OpusHead` page and a last page whose granule gives the duration.
 * It carries no audio; it is only enough for `opusDurationSeconds` and for copying and linking.
 */

function oggPage(granule: bigint, payload: Uint8Array): Uint8Array {
  const page = new Uint8Array(27 + 1 + payload.length);
  const v = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"), 0);
  v.setBigInt64(6, granule, true);
  v.setUint8(26, 1);
  v.setUint8(27, payload.length);
  page.set(payload, 28);
  return page;
}

export function fakeOpus(seconds: number, preSkip = 312): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = 2;
  head[10] = preSkip & 0xff;
  head[11] = preSkip >> 8;
  const pages = [
    oggPage(0n, head),
    oggPage(-1n, new Uint8Array(10)),
    oggPage(BigInt(Math.round(seconds * 48000) + preSkip), new Uint8Array(20)),
  ];
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pages) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The Ogg page checksum: CRC-32 with polynomial 0x04C11DB7, not reflected, over the whole page. */
function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (const b of page) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

/** One complete Ogg page of whole packets of under 255 bytes each, its checksum filled in. */
function fullPage(seq: number, flags: number, granule: bigint, packets: Uint8Array[]): Uint8Array {
  const size = packets.reduce((n, p) => n + p.length, 0);
  const page = new Uint8Array(27 + packets.length + size);
  const v = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"), 0);
  v.setUint8(5, flags);
  v.setBigInt64(6, granule, true);
  v.setUint32(14, 1, true);
  v.setUint32(18, seq, true);
  v.setUint8(26, packets.length);
  let o = 27 + packets.length;
  packets.forEach((p, i) => {
    page[27 + i] = p.length;
    page.set(p, o);
    o += p.length;
  });
  v.setUint32(22, oggCrc(page), true);
  return page;
}

/**
 * A playable Ogg Opus file of `seconds` of stereo silence, as a call's part is on disk. Each
 * 20 ms packet is its table-of-contents byte alone, a frame with no data, which a decoder plays
 * as silence. A browser takes it as the `audio/ogg` the audio route says it serves. No pre-skip by
 * default, so the length a browser reads is `seconds` exactly.
 */
export function silentOpus(seconds: number, preSkip = 0): Uint8Array {
  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = 2;
  hv.setUint16(10, preSkip, true);
  hv.setUint32(12, 48000, true);
  const tags = new Uint8Array(16);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  const pages = [fullPage(0, 2, 0n, [head]), fullPage(1, 0, 0n, [tags])];
  // CELT-only, fullband, 20 ms, stereo, one frame.
  const frame = Uint8Array.of((31 << 3) | 0x04);
  const total = Math.round(seconds * 50);
  for (let done = 0, seq = 2; done < total; seq++) {
    const n = Math.min(255, total - done);
    done += n;
    const last = done === total;
    const granule = BigInt(preSkip + done * 960);
    pages.push(
      fullPage(
        seq,
        last ? 4 : 0,
        granule,
        Array.from({ length: n }, () => frame),
      ),
    );
  }
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pages) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
