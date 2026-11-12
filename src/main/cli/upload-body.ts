/**
 * An upload's multipart body, read from disk as it is sent (docs/TRAPS.md, "An upload held in
 * memory whole"). `fetch` with a `FormData` body builds the whole body in memory before it sends a
 * byte, even when the file part is a `Bun.file`: a 2 GB recording made the CLI hold 2 GB or more.
 * Here every file part is its own `Blob`'s stream, so the client holds one chunk at a time.
 *
 * The body declares its length, as `fetch` does for a `FormData`, so a server refuses an upload
 * over its `server.max_upload_mb` before a byte of the file is read. A file that changes size
 * while it is sent fails the request instead of sending a body of another length.
 */

import { closeSync, openSync, statSync } from "node:fs";
import { basename } from "node:path";

/** A multipart body to send, with its headers. */
export interface UploadBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  length: number;
}

/** A name or filename inside a quoted header parameter, escaped as browsers do (WHATWG). */
function quoted(s: string): string {
  return s.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}

/**
 * `form` as a streamed `multipart/form-data` body. A fresh call reads every file again. A file
 * part's filename is its `File`'s own name: Bun's `FormData.entries()` drops the filename given to
 * `append`, so name the `File` itself (`mediaFile`).
 */
export function uploadBody(form: FormData): UploadBody {
  const enc = new TextEncoder();
  const boundary = `akou-${crypto.randomUUID()}`;
  // Each file with its size now: the length declared is what the body must hold.
  const parts: (Uint8Array | { blob: Blob; size: number })[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      parts.push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${value}\r\n`,
        ),
      );
      continue;
    }
    const file = value as File;
    // A `Bun.file` appended as it is keeps its whole path as its name, whatever filename
    // `append` was given: only the last segment ever goes out.
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"; filename="${quoted(basename(file.name || "blob"))}"\r\n` +
          `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
      ),
      { blob: file, size: file.size },
      enc.encode("\r\n"),
    );
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const length = parts.reduce((n, p) => n + (p instanceof Uint8Array ? p.byteLength : p.size), 0);

  let next = 0;
  /** The file part being sent: its reader, and the bytes it still owes. */
  let reading: {
    reader: {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(r?: unknown): Promise<void>;
    };
    left: number;
  } | null = null;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      for (;;) {
        if (reading) {
          const r = await reading.reader.read();
          if (r.value) {
            reading.left -= r.value.byteLength;
            if (reading.left < 0) throw new Error("a file grew while it was being uploaded");
            ctl.enqueue(r.value);
            return;
          }
          if (reading.left !== 0) throw new Error("a file shrank while it was being uploaded");
          reading = null;
        }
        const part = parts[next++];
        if (part === undefined) {
          ctl.close();
          return;
        }
        if (part instanceof Uint8Array) {
          ctl.enqueue(part);
          return;
        }
        reading = { reader: part.blob.stream().getReader(), left: part.size };
      }
    },
    async cancel(reason) {
      await reading?.reader.cancel(reason).catch(() => {});
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, length };
}

/**
 * The file at `path` to upload, read only as it is sent, or why it cannot be: it is opened once
 * here, so a missing or unreadable file is a usage error before anything is sent.
 */
export function uploadFile(path: string): File | string {
  try {
    if (!statSync(path).isFile()) return `${path} is not a file`;
    closeSync(openSync(path, "r"));
  } catch (err) {
    return `cannot read ${path}: ${(err as Error).message}`;
  }
  return mediaFile(path);
}

/**
 * `path` as a `File` named by its last segment, still read from disk only as it is sent. A
 * `Bun.file` in a `FormData` keeps its whole path as its name.
 */
export function mediaFile(path: string): File {
  const disk = Bun.file(path);
  return new File([disk], basename(path), { type: disk.type });
}
