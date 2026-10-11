/**
 * The Wyoming protocol's framing (docs/ux/SERVER.md SV-C2), as the `wyoming` 1.10.2 package reads
 * and writes it (event.py:82-136): one UTF-8 JSON header line ending in `\n` with `type` and,
 * optionally, `data`, `data_length` and `payload_length`; then exactly `data_length` bytes of JSON,
 * merged over the header's `data` (the block wins); then exactly `payload_length` bytes of payload.
 *
 * Pure: no sockets. The reader takes inline `data` and the block; the writer moves `data` into the
 * block as the Python writer does, so a header stays small, and both lengths are byte counts of the
 * UTF-8, never string lengths. A header line past 64 KiB with no newline, or one that is not a JSON
 * object with a `type`, is a `FrameError`: the Python reader's StreamReader limit is 65536 bytes,
 * and it treats either as a disconnect.
 */

/** The longest header line a reader takes, its newline included: asyncio's default limit. */
export const MAX_HEADER_BYTES = 65536;

export interface WyomingEvent {
  type: string;
  data: Record<string, unknown>;
  payload: Uint8Array | null;
}

export class FrameError extends Error {
  override name = "FrameError";
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The event's bytes on the wire: header line, data block, payload. */
export function encode(e: WyomingEvent): Uint8Array {
  const data = Object.keys(e.data).length > 0 ? utf8.encode(JSON.stringify(e.data)) : null;
  const payload = e.payload && e.payload.byteLength > 0 ? e.payload : null;
  const header: Record<string, unknown> = { type: e.type };
  if (data) header.data_length = data.byteLength;
  if (payload) header.payload_length = payload.byteLength;
  const line = utf8.encode(`${JSON.stringify(header)}\n`);
  const dl = data?.byteLength ?? 0;
  const out = new Uint8Array(line.byteLength + dl + (payload?.byteLength ?? 0));
  out.set(line, 0);
  if (data) out.set(data, line.byteLength);
  if (payload) out.set(payload, line.byteLength + dl);
  return out;
}

/** A length field of the header: absent or a whole number of bytes, at least 0. */
function lengthOf(header: Record<string, unknown>, key: string): number {
  const v = header[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new FrameError(`${key} is not a byte count`);
  }
  return v;
}

function parseObject(bytes: Uint8Array, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(fromUtf8.decode(bytes));
  } catch {
    throw new FrameError(`the ${what} is not UTF-8 JSON`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new FrameError(`the ${what} is not a JSON object`);
  }
  return v as Record<string, unknown>;
}

/** One socket's reader: bytes in as they arrive, whole events out. */
export class FrameReader {
  private buf = new Uint8Array(0);
  /** The header of the event whose data and payload have not all arrived yet. */
  private pending: { type: string; data: Record<string, unknown>; dl: number; pl: number } | null =
    null;

  push(bytes: Uint8Array): WyomingEvent[] {
    if (bytes.byteLength > 0) {
      const next = new Uint8Array(this.buf.byteLength + bytes.byteLength);
      next.set(this.buf, 0);
      next.set(bytes, this.buf.byteLength);
      this.buf = next;
    }
    const out: WyomingEvent[] = [];
    let at = 0;
    for (;;) {
      if (!this.pending) {
        const nl = this.buf.indexOf(0x0a, at);
        if (nl < 0) {
          if (this.buf.byteLength - at >= MAX_HEADER_BYTES) {
            throw new FrameError(`a header line passed ${MAX_HEADER_BYTES} bytes with no newline`);
          }
          break;
        }
        if (nl + 1 - at > MAX_HEADER_BYTES) {
          throw new FrameError(`a header line passed ${MAX_HEADER_BYTES} bytes`);
        }
        const header = parseObject(this.buf.subarray(at, nl), "header line");
        if (typeof header.type !== "string" || header.type === "") {
          throw new FrameError("the header has no type");
        }
        const inline = header.data;
        const data =
          typeof inline === "object" && inline !== null && !Array.isArray(inline)
            ? { ...(inline as Record<string, unknown>) }
            : {};
        this.pending = {
          type: header.type,
          data,
          dl: lengthOf(header, "data_length"),
          pl: lengthOf(header, "payload_length"),
        };
        at = nl + 1;
      }
      const p = this.pending;
      if (this.buf.byteLength - at < p.dl + p.pl) break;
      if (p.dl > 0) Object.assign(p.data, parseObject(this.buf.subarray(at, at + p.dl), "data"));
      at += p.dl;
      const payload = p.pl > 0 ? this.buf.slice(at, at + p.pl) : null;
      at += p.pl;
      out.push({ type: p.type, data: p.data, payload });
      this.pending = null;
    }
    this.buf = at > 0 ? this.buf.slice(at) : this.buf;
    return out;
  }
}
