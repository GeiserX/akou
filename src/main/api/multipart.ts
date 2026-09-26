/**
 * A multipart body read as it arrives (docs/ux/SERVER.md SV-D3): every file part is written to
 * disk chunk by chunk and hashed on the way, so an upload of `server.max_upload_mb` never sits in
 * memory whole. `Request.formData()` reads the whole body first, which on a 512 MB upload means
 * 512 MB of RAM per request.
 *
 * Text parts stay in memory, together at most `MAX_TEXT_BYTES`, the JSON cap of every other route:
 * the fields of a job are small, and a body of large text parts is refused, not buffered.
 *
 * A file part is one whose `Content-Disposition` names a `filename`, as browsers and `fetch` send
 * it. Each is written to its own `<uuid>.upload` in the folder the caller names, which is the job
 * queue's upload folder, whose orphans are deleted when the server starts. The caller owns every
 * spooled file: it keeps the one it needs and calls `discard` for the rest, on every path.
 */

import { createHash, randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./http.ts";

/** The text fields of one body, together, in bytes: the 64 KB JSON cap. */
export const MAX_TEXT_BYTES = 64 * 1024;
/** One part's header block. */
const MAX_HEADER_BYTES = 16 * 1024;

/** A file part, on disk. */
export interface SpooledFile {
  readonly name: string;
  readonly type: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export type FormValue = string | SpooledFile;

/** The parts of one body, in order, as `FormData` names them. */
export class StreamedForm {
  private readonly entries: [string, FormValue][] = [];

  add(name: string, value: FormValue): void {
    this.entries.push([name, value]);
  }

  getAll(name: string): FormValue[] {
    return this.entries.filter(([n]) => n === name).map(([, v]) => v);
  }

  keys(): string[] {
    return [...new Set(this.entries.map(([n]) => n))];
  }

  files(): SpooledFile[] {
    return this.entries.map(([, v]) => v).filter((v): v is SpooledFile => typeof v !== "string");
  }

  /** Deletes every spooled file but `keep`. */
  async discard(keep?: SpooledFile): Promise<void> {
    await Promise.all(
      this.files()
        .filter((f) => f !== keep)
        .map((f) => rm(f.path, { force: true })),
    );
  }
}

function badBody(message: string): HttpError {
  return new HttpError(400, "bad_multipart", message);
}

/** The boundary of a `multipart/form-data` Content-Type, or null. */
export function boundaryOf(contentType: string | null): string | null {
  if (!contentType || !/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) return null;
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType);
  return m ? ((m[1] ?? m[2]) as string) : null;
}

/** One parameter of a `Content-Disposition` header, quoted or bare, or undefined. */
function param(header: string, key: string): string | undefined {
  const m = new RegExp(`;\\s*${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, "i").exec(header);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2];
}

interface PartHead {
  name: string;
  filename?: string;
  type: string;
}

function parseHead(block: string): PartHead {
  let disposition = "";
  let type = "application/octet-stream";
  for (const line of block.split("\r\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === "content-disposition") disposition = v;
    else if (k === "content-type") type = v;
  }
  if (!/^form-data\s*(;|$)/i.test(disposition)) {
    throw badBody("a part has no Content-Disposition: form-data");
  }
  const name = param(disposition, "name");
  if (name === undefined) throw badBody("a part has no name");
  return { name, filename: param(disposition, "filename"), type };
}

/**
 * Reads a `multipart/form-data` body, writing each file part into `dir` as it arrives. On any
 * error the files spooled so far are deleted before it throws.
 */
export async function readMultipart(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  dir: string,
): Promise<StreamedForm> {
  const boundary = boundaryOf(contentType);
  if (!boundary || !body) throw badBody("the body is not multipart/form-data with a boundary");
  const form = new StreamedForm();
  const reader = body.getReader();
  const first = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const CRLF2 = Buffer.from("\r\n\r\n");
  let buf: Buffer = Buffer.alloc(0);
  let ended = false;
  let text = 0;

  /** Reads more of the body into `buf`; false once the body has ended. */
  const more = async (): Promise<boolean> => {
    if (ended) return false;
    const r = await reader.read();
    if (r.done) {
      ended = true;
      return false;
    }
    const chunk = Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength);
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    return true;
  };
  const early = () => badBody("the multipart body ends before its closing boundary");

  /**
   * Hands the part's bytes to `sink` up to the next delimiter, holding back only what could be
   * the start of one, and leaves `buf` just past the delimiter.
   */
  const partBody = async (sink: (chunk: Buffer) => Promise<void>): Promise<void> => {
    for (;;) {
      const at = buf.indexOf(delimiter);
      if (at >= 0) {
        if (at > 0) await sink(buf.subarray(0, at));
        buf = buf.subarray(at + delimiter.length);
        return;
      }
      const safe = buf.length - (delimiter.length - 1);
      if (safe > 0) {
        await sink(buf.subarray(0, safe));
        buf = buf.subarray(safe);
      }
      if (!(await more())) throw early();
    }
  };

  try {
    // The preamble, up to the first boundary.
    for (;;) {
      const at = buf.indexOf(first);
      if (at >= 0) {
        buf = buf.subarray(at + first.length);
        break;
      }
      if (buf.length > MAX_HEADER_BYTES) throw badBody("no multipart boundary where one belongs");
      if (!(await more())) throw early();
    }
    for (;;) {
      // After a boundary: `--` ends the body, CRLF starts a part.
      while (buf.length < 2) if (!(await more())) throw early();
      if (buf[0] === 0x2d && buf[1] === 0x2d) break;
      if (buf[0] !== 0x0d || buf[1] !== 0x0a) throw badBody("a boundary is not followed by CRLF");
      buf = buf.subarray(2);
      let end = buf.indexOf(CRLF2);
      while (end < 0) {
        if (buf.length > MAX_HEADER_BYTES) throw badBody("a part's headers are too long");
        if (!(await more())) throw early();
        end = buf.indexOf(CRLF2);
      }
      const head = parseHead(buf.subarray(0, end).toString("utf8"));
      buf = buf.subarray(end + CRLF2.length);
      if (head.filename === undefined) {
        const chunks: Buffer[] = [];
        await partBody(async (chunk) => {
          text += chunk.length;
          if (text > MAX_TEXT_BYTES) {
            throw new HttpError(
              413,
              "body_too_large",
              `the text fields are capped at ${MAX_TEXT_BYTES} bytes together`,
            );
          }
          chunks.push(Buffer.from(chunk));
        });
        form.add(head.name, Buffer.concat(chunks).toString("utf8"));
        continue;
      }
      const path = join(dir, `${randomUUID()}.upload`);
      const hash = createHash("sha256");
      let size = 0;
      const file = await open(path, "wx", 0o600);
      // Named before the first byte, so an error mid-part deletes it with the rest.
      const spooled: { -readonly [K in keyof SpooledFile]: SpooledFile[K] } = {
        name: head.filename,
        type: head.type,
        path,
        size: 0,
        sha256: "",
      };
      form.add(head.name, spooled);
      try {
        await partBody(async (chunk) => {
          hash.update(chunk);
          size += chunk.length;
          await file.write(chunk);
        });
      } finally {
        await file.close();
      }
      spooled.size = size;
      spooled.sha256 = hash.digest("hex");
    }
    // The epilogue after the closing boundary is ignored, as RFC 7578 allows; a short one is read
    // to its end so the connection stays usable, a long one is cut.
    let epilogue = buf.length;
    while (epilogue <= MAX_HEADER_BYTES && (await more())) epilogue = buf.length;
    if (!ended) await reader.cancel().catch(() => {});
    return form;
  } catch (err) {
    await reader.cancel().catch(() => {});
    await form.discard();
    throw err;
  }
}
