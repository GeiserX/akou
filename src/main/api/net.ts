/**
 * Addresses for server mode (docs/ux/SERVER.md SV-D2, SV-P5): is a bind address loopback, does an
 * address fall in a CIDR block, and which address a request came from.
 *
 * The source address is the TCP peer, unless the peer is one of `server.trusted_proxies`: then
 * `X-Forwarded-For` is read from the right, past every trusted hop, and the first address that is
 * not a trusted proxy is the client. A direct client can write any `X-Forwarded-For` it likes, so
 * from any other peer the header is ignored.
 */

import { isIP } from "node:net";

/** 127.0.0.0/8, `::1`, their IPv4-mapped form, and the name `localhost`. */
export function isLoopback(addr: string): boolean {
  const a = unbracket(addr.trim().toLowerCase());
  if (a === "localhost" || a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

function unbracket(a: string): string {
  return a.startsWith("[") && a.endsWith("]") ? a.slice(1, -1) : a;
}

/** An address as 16 bytes (IPv4 as IPv4-mapped IPv6), or null when it is not an address. */
export function addressBytes(addr: string): Uint8Array | null {
  const a = unbracket(addr.trim().toLowerCase());
  const kind = isIP(a);
  if (kind === 4) return mapped(a);
  if (kind !== 6) return null;
  // An IPv4 tail (`::ffff:1.2.3.4`) becomes two groups.
  let text = a;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = tail[1] as string;
    const b = mapped(v4).subarray(12);
    const hi = (((b[0] as number) << 8) | (b[1] as number)).toString(16);
    const lo = (((b[2] as number) << 8) | (b[3] as number)).toString(16);
    text = `${text.slice(0, -v4.length)}${hi}:${lo}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(fill).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = Number.parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

function mapped(v4: string): Uint8Array {
  const out = new Uint8Array(16);
  out[10] = 0xff;
  out[11] = 0xff;
  v4.split(".").forEach((p, i) => {
    out[12 + i] = Number(p);
  });
  return out;
}

export interface Cidr {
  bytes: Uint8Array;
  /** Prefix length over the 16-byte form. */
  bits: number;
}

/** `10.0.0.0/8`, `fd00::/8`, or a bare address (all its bits). Null when it is not one. */
export function parseCidr(text: string): Cidr | null {
  const [addr = "", len, extra] = text.trim().split("/");
  if (extra !== undefined) return null;
  const bytes = addressBytes(addr);
  if (!bytes) return null;
  const v4 = isIP(unbracket(addr.trim())) === 4;
  const max = v4 ? 32 : 128;
  if (len !== undefined && !/^\d{1,3}$/.test(len)) return null;
  const n = len === undefined ? max : Number(len);
  if (n > max) return null;
  return { bytes, bits: v4 ? 96 + n : n };
}

export function inCidr(addr: string, cidr: Cidr): boolean {
  const b = addressBytes(addr);
  if (!b) return false;
  let bits = cidr.bits;
  for (let i = 0; i < 16 && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((b[i] as number) & mask) !== ((cidr.bytes[i] as number) & mask)) return false;
  }
  return true;
}

/**
 * The address a request came from: `peer` itself unless `peer` is a trusted proxy; then the
 * rightmost `X-Forwarded-For` entry that is not a trusted proxy (or the leftmost, when every one
 * is). Unparseable entries end the walk at the last good address.
 */
export function sourceAddress(
  peer: string,
  forwardedFor: string | null,
  trusted: readonly Cidr[],
): string {
  const isTrusted = (a: string) => trusted.some((c) => inCidr(a, c));
  if (!isTrusted(peer) || !forwardedFor) return peer;
  let source = peer;
  const hops = forwardedFor
    .split(",")
    .map((h) => h.trim())
    .reverse();
  for (const hop of hops) {
    if (!addressBytes(hop)) break;
    source = hop;
    if (!isTrusted(hop)) break;
  }
  return source;
}
