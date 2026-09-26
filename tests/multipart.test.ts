/**
 * SV-D3: the multipart reader that writes file parts to disk as they arrive
 * (src/main/api/multipart.ts). The body is fed in every chunking, down to one byte at a time, so a
 * boundary split across two reads is found; file bytes that look like a boundary stay file bytes;
 * and every refusal deletes what it spooled.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { HttpError } from "../src/main/api/http.ts";
import {
  boundaryOf,
  MAX_TEXT_BYTES,
  readMultipart,
  type SpooledFile,
} from "../src/main/api/multipart.ts";
import { tempDir } from "./helpers.ts";

const enc = (t: string) => new TextEncoder().encode(t);

/** A body served in chunks of `size` bytes, and optionally cut off after `cutAt` bytes. */
function chunked(bytes: Uint8Array, size: number, cutAt?: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(ctl) {
      if (cutAt !== undefined && at >= cutAt) {
        ctl.error(new Error("the client went away"));
        return;
      }
      if (at >= bytes.length) {
        ctl.close();
        return;
      }
      const end = Math.min(bytes.length, at + size, cutAt ?? Number.POSITIVE_INFINITY);
      ctl.enqueue(bytes.slice(at, end));
      at = end;
    },
  });
}

/** Encodes a FormData the way `fetch` and `akou transcribe` send it. */
async function encoded(form: FormData): Promise<{ bytes: Uint8Array; type: string }> {
  const r = new Response(form);
  // Read before the body: once a body with a file part is read, Bun's header is gone.
  const type = r.headers.get("content-type") as string;
  return { bytes: new Uint8Array(await r.arrayBuffer()), type };
}

/**
 * File bytes that look like a boundary without being one: CRLF and dashes, `boundary` with no
 * CRLF before it, and after a CRLF `boundary` minus its last byte, at the very end.
 */
function tricky(boundary: string): Uint8Array {
  const parts = [
    enc("\r\n--\r\n"),
    new Uint8Array(3000).map((_, i) => (i * 31) % 256),
    enc("\r\n\r\n--"),
    enc(`--${boundary}`),
    enc(`\r\n--${boundary.slice(0, -1)}`),
  ];
  return new Uint8Array(parts.flatMap((p) => [...p]));
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A body built by hand, so the file can hold near-copies of its own boundary. */
function handBuilt(boundary: string, file: Uint8Array, fieldsFirst: boolean): Uint8Array {
  const field = (name: string, value: string) =>
    enc(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const fields = [
    field("preset", "fast"),
    field("metadata", '{"é": "ü\\r\\n"}'),
    field("keywords[]", "Hetzner"),
    field("keywords[]", "Kubernetes"),
  ];
  const filePart = [
    enc(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
    ),
    file,
    enc("\r\n"),
  ];
  const parts = fieldsFirst ? [...fields, ...filePart] : [...filePart, ...fields];
  return new Uint8Array([...parts, enc(`--${boundary}--\r\n`)].flatMap((p) => [...p]));
}

/** A fresh folder for the spooled files; `files()` lists what is left in it. */
function folder() {
  const t = tempDir("multipart-");
  return { dir: t.dir, files: () => readdirSync(t.dir), cleanup: t.cleanup };
}

describe("SV-D3: a multipart body read as it arrives", () => {
  test("fields and a file in either order, in every chunking, byte for byte", async () => {
    const boundary = "----akouTestBoundary7MA4YWxk";
    const file = tricky(boundary);
    for (const fieldsFirst of [true, false]) {
      const body = handBuilt(boundary, file, fieldsFirst);
      for (const size of [1, 2, 7, 64, 4096, body.length]) {
        const f = folder();
        const got = await readMultipart(
          chunked(body, size),
          `multipart/form-data; boundary=${boundary}`,
          f.dir,
        );
        expect(got.keys().sort()).toEqual(["file", "keywords[]", "metadata", "preset"]);
        expect(got.getAll("preset")).toEqual(["fast"]);
        expect(got.getAll("metadata")).toEqual(['{"é": "ü\\r\\n"}']);
        expect(got.getAll("keywords[]")).toEqual(["Hetzner", "Kubernetes"]);
        const [spooled] = got.getAll("file") as SpooledFile[];
        expect(spooled?.name).toBe("note.ogg");
        expect(spooled?.type).toBe("audio/ogg");
        expect(spooled?.size).toBe(file.length);
        expect(spooled?.sha256).toBe(sha(file));
        expect(sha(readFileSync(spooled?.path as string))).toBe(sha(file));
        await got.discard();
        expect(f.files()).toEqual([]);
        f.cleanup();
      }
    }
  });

  test("a body as fetch encodes a FormData reads back the same", async () => {
    const form = new FormData();
    const file = new Uint8Array(200_000).map((_, i) => (i * 7) % 256);
    form.append("file", new Blob([file], { type: "audio/wav" }), "a.wav");
    form.append("language", "es");
    const body = await encoded(form);
    const f = folder();
    const got = await readMultipart(chunked(body.bytes, 65_536), body.type, f.dir);
    expect(got.getAll("language")).toEqual(["es"]);
    const [spooled] = got.files();
    expect(spooled?.sha256).toBe(sha(file));
    expect(spooled?.type).toBe("audio/wav");
    f.cleanup();
  });

  test("a quoted boundary, a preamble and an epilogue are read as RFC 7578 allows", async () => {
    const { dir } = tempDir("multipart-");
    const body = enc(
      'ignored preamble\r\n--q b\r\nContent-Disposition: form-data; name="a\\"b"\r\n\r\nv\r\n--q b--\r\nepilogue',
    );
    const got = await readMultipart(chunked(body, 5), 'multipart/form-data; boundary="q b"', dir);
    expect(got.getAll('a"b')).toEqual(["v"]);
    expect(got.files()).toEqual([]);
  });

  test("a body cut off mid-file is 400 and leaves no file", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(100_000)]), "a.wav");
    const body = await encoded(form);
    for (const [label, stream] of [
      ["the client went away", chunked(body.bytes, 4096, 50_000)],
      ["the body ends early", chunked(body.bytes.slice(0, 50_000), 4096)],
    ] as const) {
      const { dir } = tempDir("multipart-");
      const err = await readMultipart(stream, body.type, dir).catch((e) => e);
      expect(`${label}: ${err instanceof Error}`).toBe(`${label}: true`);
      if (label === "the body ends early") expect((err as HttpError).status).toBe(400);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test(`text fields over ${MAX_TEXT_BYTES} bytes together are 413, and the file already spooled is deleted`, async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(10_000)]), "a.wav");
    form.append("metadata", "x".repeat(MAX_TEXT_BYTES / 2));
    form.append("prompt", "y".repeat(MAX_TEXT_BYTES / 2 + 1));
    const body = await encoded(form);
    const { dir } = tempDir("multipart-");
    const err = (await readMultipart(chunked(body.bytes, 1024), body.type, dir).catch(
      (e) => e,
    )) as HttpError;
    expect(err.status).toBe(413);
    expect(err.code).toBe("body_too_large");
    expect(readdirSync(dir)).toEqual([]);
    // Positive control: one byte less is taken.
    const fits = new FormData();
    fits.append("metadata", "x".repeat(MAX_TEXT_BYTES / 2));
    fits.append("prompt", "y".repeat(MAX_TEXT_BYTES / 2));
    const ok = await encoded(fits);
    const got = await readMultipart(chunked(ok.bytes, 1024), ok.type, dir);
    expect((got.getAll("prompt")[0] as string).length).toBe(MAX_TEXT_BYTES / 2);
  });

  test("a body that is not multipart, or a part with no name, is 400", async () => {
    const { dir } = tempDir("multipart-");
    const bad = async (type: string | null, body: string) =>
      ((await readMultipart(chunked(enc(body), 16), type, dir).catch((e) => e)) as HttpError)
        .status;
    expect(boundaryOf('multipart/form-data; charset=utf-8; boundary="a b"')).toBe("a b");
    expect(boundaryOf("multipart/form-data; boundary=x; charset=utf-8")).toBe("x");
    expect(boundaryOf("text/plain; boundary=x")).toBeNull();
    expect(await bad("application/json", "{}")).toBe(400);
    expect(await bad("multipart/form-data", "--x--")).toBe(400);
    expect(
      await bad(
        "multipart/form-data; boundary=x",
        "--x\r\nContent-Disposition: form-data\r\n\r\nv\r\n--x--",
      ),
    ).toBe(400);
    expect(await bad("multipart/form-data; boundary=x", "no boundary at all")).toBe(400);
    expect(readdirSync(dir)).toEqual([]);
  });
});
