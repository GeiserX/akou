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
