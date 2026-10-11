/**
 * The Wyoming protocol's framing (docs/ux/SERVER.md SV-C2), as the `wyoming` 1.10.2 package reads
 * and writes it (event.py:82-136): one UTF-8 JSON header line ending in `\n` with `type` and,
 * optionally, `data`, `data_length` and `payload_length`; then exactly `data_length` bytes of JSON,
 * merged over the header's `data` (the block wins); then exactly `payload_length` bytes of payload.
 *
 * Pure: no sockets. The reader takes inline `data` and the block; the writer moves `data` into the
 * block as the Python writer does, so a header stays small, and both lengths are byte counts of the
 * UTF-8, never string lengths. A header line longer than 65536 bytes, or one that is not a JSON
 * object with a `type`, is a `FrameError`: the Python reader's StreamReader limit is 65536 bytes,
 * and it treats either as a disconnect. A header whose data and payload together pass the reader's
 * `maxBody` is refused before any of that body is held (`FrameTooLarge`).
 */

/**
 * The longest header line a reader takes, its newline not counted: asyncio's default limit, which
 * `readline` applies to the bytes before the newline (StreamReader.readuntil, `isep > limit`).
 */
export const MAX_HEADER_BYTES = 65536;

export interface WyomingEvent {
  type: string;
  data: Record<string, unknown>;
  payload: Uint8Array | null;
}

export class FrameError extends Error {
  override name = "FrameError";
}

/** A header announcing more data and payload than the reader may hold. */
export class FrameTooLarge extends FrameError {
  override name = "FrameTooLarge";
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

/**
 * One socket's reader: bytes in as they arrive, whole events out. What has not made an event yet is
 * kept as the chunks it came in, so a big payload is copied once when its event is cut, not once
 * per push. `maxBody` bounds one event's data plus payload, in bytes.
 */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private size = 0;
  /** Bytes at the front already searched for a newline. */
  private scanned = 0;
  /** The header of the event whose data and payload have not all arrived yet. */
  private pending: { type: string; data: Record<string, unknown>; dl: number; pl: number } | null =
    null;

  constructor(private readonly maxBody = Number.POSITIVE_INFINITY) {}

  push(bytes: Uint8Array): WyomingEvent[] {
    // A copy (a Buffer's `slice` is a view): the caller may reuse its buffer once this returns.
    if (bytes.byteLength > 0) {
      this.chunks.push(new Uint8Array(bytes));
      this.size += bytes.byteLength;
    }
    const out: WyomingEvent[] = [];
    for (;;) {
      if (!this.pending) {
        const nl = this.newline();
        if (nl < 0) {
          if (this.size > MAX_HEADER_BYTES) {
            throw new FrameError(`a header line passed ${MAX_HEADER_BYTES} bytes with no newline`);
          }
          break;
        }
        if (nl > MAX_HEADER_BYTES) {
          throw new FrameError(`a header line passed ${MAX_HEADER_BYTES} bytes`);
        }
        const header = parseObject(this.take(nl + 1).subarray(0, nl), "header line");
        if (typeof header.type !== "string" || header.type === "") {
          throw new FrameError("the header has no type");
        }
        const inline = header.data;
        const data =
          typeof inline === "object" && inline !== null && !Array.isArray(inline)
            ? { ...(inline as Record<string, unknown>) }
            : {};
        const dl = lengthOf(header, "data_length");
        const pl = lengthOf(header, "payload_length");
        // Refused on the header, before a byte of the body is held.
        if (dl + pl > this.maxBody) {
          throw new FrameTooLarge(
            `an event announced ${dl + pl} bytes of data and payload, past ${this.maxBody}`,
          );
        }
        this.pending = { type: header.type, data, dl, pl };
      }
      const p = this.pending;
      if (this.size < p.dl + p.pl) break;
      if (p.dl > 0) Object.assign(p.data, parseObject(this.take(p.dl), "data"));
      const payload = p.pl > 0 ? this.take(p.pl) : null;
      out.push({ type: p.type, data: p.data, payload });
      this.pending = null;
    }
    return out;
  }

  /** The offset of the first newline in what is held, or -1. */
  private newline(): number {
    let base = 0;
    for (const c of this.chunks) {
      if (base + c.byteLength > this.scanned) {
        const i = c.indexOf(0x0a, Math.max(0, this.scanned - base));
        if (i >= 0) return base + i;
      }
      base += c.byteLength;
    }
    this.scanned = this.size;
    return -1;
  }

  /** The first `n` held bytes, removed: a view when one chunk holds them, else one joined copy. */
  private take(n: number): Uint8Array {
    this.size -= n;
    this.scanned = 0;
    const first = this.chunks[0] as Uint8Array;
    if (first.byteLength >= n) {
      if (first.byteLength === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0] as Uint8Array;
      const k = Math.min(c.byteLength, n - at);
      out.set(c.subarray(0, k), at);
      at += k;
      if (k === c.byteLength) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    return out;
  }
}
