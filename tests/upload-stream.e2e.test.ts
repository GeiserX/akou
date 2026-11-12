/**
 * An upload is read from disk as it is sent (docs/TRAPS.md, "An upload held in memory whole").
 * `fetch` with a `FormData` builds the whole multipart body in memory first, even for a
 * `Bun.file` part, so `akou transcribe` of a long recording held the whole file, and more, before
 * a byte went out.
 *
 * The memory cases run the real `akou` entry point as a child against a fake `AKOU_URL` server and
 * compare the child's peak memory sending a 256 MiB file with sending a 1 KiB one. The parser
 * cases send the streamed body to the server's own multipart reader, with and without a
 * Content-Length.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMultipart } from "../src/main/api/multipart.ts";
import { uploadBody, uploadFile } from "../src/main/cli/upload-body.ts";
import { CLI } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

// Each memory case sends 256 MiB over loopback twice; a loaded CI box is slow.
setDefaultTimeout(120_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const MiB = 1024 * 1024;
const BIG = 256 * MiB;

interface Seen {
  path: string;
  length: string | null;
  received: number;
}

/** A fake akou server that takes jobs and dictations, reads every body to its end and refuses it. */
function fakeServer(): { base: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 2 * BIG,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/v1/server") {
        return Response.json({ mode: "server", capabilities: { jobs: true } });
      }
      let received = 0;
      if (req.body) for await (const chunk of req.body) received += chunk.byteLength;
      seen.push({ path, length: req.headers.get("content-length"), received });
      return Response.json({ error: "test_refused", message: "read and refused" }, { status: 422 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

/** A file of `bytes` zero bytes, sparse where the file system allows it. */
function zeros(dir: string, name: string, bytes: number): string {
  const path = join(dir, name);
  writeFileSync(path, "");
  truncateSync(path, bytes);
  return path;
}

/** Peak memory in bytes: `maxRSS` is bytes on some systems and KiB on others. */
const asBytes = (maxRSS: number) => (maxRSS > 4 * MiB ? maxRSS : maxRSS * 1024);

/** The child's peak memory, in bytes, once it has exited. */
async function peak(argv: string[], env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn([process.execPath, ...argv], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  const usage = proc.resourceUsage();
  if (!usage) throw new Error("no resource usage for the child");
  return asBytes(usage.maxRSS);
}

function env(home: string, base: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  for (const k of ["AKOU_API_KEY_FILE", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"])
    delete e[k];
  return { ...e, AKOU_HOME: home, AKOU_URL: base, AKOU_API_KEY: "ak_test" };
}

/**
 * Peak growth allowed for a 256 MiB upload: a body built whole grows by more than the file (about
 * 535 MB measured on Bun 1.4.2), a streamed one by a few MB of buffers.
 */
const MAX_GROWTH = 96 * MiB;

describe("[UPL-1] An upload held in memory whole", () => {
  for (const [command, route] of [
    ["transcribe", "/v1/jobs"],
    ["dictate", "/v1/dictations"],
  ] as const) {
    test(`akou ${command} of a 256 MiB file sends it whole without holding it in memory`, async () => {
      const t = tempDir("akou-upl-");
      cleanups.push(t.cleanup);
      const { base, seen } = fakeServer();
      const e = env(t.dir, base);
      const small = await peak([CLI, command, zeros(t.dir, "small.wav", 1024)], e);
      const big = await peak([CLI, command, zeros(t.dir, "big.wav", BIG)], e);
      const uploads = seen.filter((s) => s.path === route);
      expect(uploads).toHaveLength(2);
      // The whole file went out, with the length the body declared.
      expect(uploads[1]?.received).toBeGreaterThan(BIG);
      expect(Number(uploads[1]?.length)).toBe(uploads[1]?.received as number);
      expect(big - small).toBeLessThan(MAX_GROWTH);
    });
  }

  test("positive control: fetch with the FormData as it is grows past the limit", async () => {
    const t = tempDir("akou-upl-");
    cleanups.push(t.cleanup);
    const { base, seen } = fakeServer();
    const e = env(t.dir, base);
    const send = (path: string) => [
      "-e",
      `const f = new FormData(); f.append("file", Bun.file(${JSON.stringify(path)}), "a.wav");` +
        `await fetch(${JSON.stringify(`${base}/v1/jobs`)}, { method: "POST", body: f });`,
    ];
    const small = await peak(send(zeros(t.dir, "small.wav", 1024)), e);
    const big = await peak(send(zeros(t.dir, "big.wav", BIG)), e);
    expect(seen.filter((s) => s.path === "/v1/jobs")).toHaveLength(2);
    expect(big - small).toBeGreaterThan(MAX_GROWTH);
  });
});

describe("[UPL-1] The streamed body through the server's multipart reader", () => {
  /** A server whose one route reads the body with `readMultipart`, as the upload routes do. */
  function parser(dir: string): string {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const form = await readMultipart(req.body, req.headers.get("content-type"), dir);
        const out = {
          length: req.headers.get("content-length"),
          fields: Object.fromEntries(
            form.keys().map((k) => [k, form.getAll(k).filter((v) => typeof v === "string")]),
          ),
          files: form.files().map((f) => ({
            name: f.name,
            type: f.type,
            size: f.size,
            sha256: f.sha256,
          })),
        };
        await form.discard();
        return Response.json(out);
      },
    });
    cleanups.push(() => server.stop(true));
    return `http://127.0.0.1:${server.port}/`;
  }

  // Three MiB of varied bytes, so the file crosses many chunks and holds the delimiter's bytes.
  const bytes = new Uint8Array(3 * MiB + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + (i >> 9)) & 0xff;
  const sha = createHash("sha256").update(bytes).digest("hex");

  for (const declared of [true, false]) {
    test(`fields and file arrive intact ${declared ? "with" : "without"} a Content-Length`, async () => {
      const t = tempDir("akou-upl-");
      cleanups.push(t.cleanup);
      const path = join(t.dir, "note.wav");
      writeFileSync(path, bytes);
      const disk = Bun.file(path);
      const form = new FormData();
      // The part's filename is the File's own: Bun's `FormData.entries()` drops the one `append`
      // is given, so every caller names its File (`mediaFile`).
      form.append("file", new File([disk], 'ñote "1".wav', { type: disk.type }));
      form.append("preset", "fast");
      form.append("keywords[]", "Ñandú");
      form.append("keywords[]", "akou");
      const up = uploadBody(form);
      const res = await fetch(parser(t.dir), {
        method: "POST",
        headers: {
          "content-type": up.contentType,
          ...(declared ? { "content-length": String(up.length) } : {}),
        },
        body: up.body,
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as {
        length: string | null;
        fields: Record<string, string[]>;
        files: { name: string; type: string; size: number; sha256: string }[];
      };
      if (declared) expect(Number(out.length)).toBe(up.length);
      else expect(out.length).toBeNull();
      expect(out.fields.preset).toEqual(["fast"]);
      expect(out.fields["keywords[]"]).toEqual(["Ñandú", "akou"]);
      expect(out.files).toHaveLength(1);
      expect(out.files[0]).toMatchObject({ name: "ñote %221%22.wav", size: bytes.length, sha256: sha });
      expect(out.files[0]?.type).toStartWith("audio/");
    });
  }

  test("a file that shrinks while it is sent fails the body instead of sending a short one", async () => {
    const t = tempDir("akou-upl-");
    cleanups.push(t.cleanup);
    const path = join(t.dir, "note.wav");
    writeFileSync(path, bytes);
    const form = new FormData();
    form.append("file", Bun.file(path), "note.wav");
    const up = uploadBody(form);
    truncateSync(path, 1024);
    await expect(new Response(up.body).arrayBuffer()).rejects.toThrow("shrank");
  });

  test("a Bun.file appended as it is sends its file name, never its folder", async () => {
    const t = tempDir("akou-upl-");
    cleanups.push(t.cleanup);
    const path = join(t.dir, "note.wav");
    writeFileSync(path, "RIFF");
    const form = new FormData();
    form.append("file", Bun.file(path), "note.wav");
    const sent = await new Response(uploadBody(form).body).text();
    expect(sent).toContain('filename="note.wav"');
    expect(sent).not.toContain(t.dir);
  });

  test("a missing or unreadable file is refused before anything is sent", () => {
    const t = tempDir("akou-upl-");
    cleanups.push(t.cleanup);
    expect(uploadFile(join(t.dir, "none.wav"))).toStartWith("cannot read ");
    expect(uploadFile(t.dir)).toBe(`${t.dir} is not a file`);
  });
});
