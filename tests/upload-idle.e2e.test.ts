/**
 * An upload that stops arriving is cut at the server's idle timeout (docs/TRAPS.md, "A stalled
 * upload holds its socket"). Bun resets the idle timeout on every chunk, so an upload that keeps
 * sending, however slowly, is never cut; one that goes silent mid-body, or a peer that vanishes
 * without closing, must not hold its socket and its spool file for the life of the process.
 *
 * A real Bun server with a 2 s idle timeout reads the body through the routes' own `formOf`, with
 * the same `timeout` hook the API server hands every route.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { connect } from "node:net";
import { formOf } from "../src/main/api/routes/jobs.ts";
import type { ApiApp } from "../src/main/api/server.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const BOUNDARY = "akouIdleBoundary";

/** A server whose one route reads a multipart upload into `dir` through `formOf`. */
function serve(dir: string): { port: number; answered: number[] } {
  const answered: number[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 2,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      try {
        const form = await formOf(
          {
            req,
            url,
            params: {},
            app: {} as ApiApp,
            by: "agent:test",
            timeout: (seconds) => srv.timeout(req, seconds),
          },
          dir,
        );
        const size = form.files()[0]?.size ?? -1;
        await form.discard();
        answered.push(size);
        return Response.json({ size });
      } catch {
        answered.push(-1);
        return new Response("bad", { status: 400 });
      }
    },
  });
  cleanups.push(() => server.stop(true));
  return { port: server.port as number, answered };
}

/** The request line, headers and the part's own header, for a file of `bytes` bytes. */
function head(port: number, bytes: number): string {
  const part = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  const tail = `\r\n--${BOUNDARY}--\r\n`;
  const length = part.length + bytes + tail.length;
  return (
    `POST /v1/jobs HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
    `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\nContent-Length: ${length}\r\n\r\n${part}`
  );
}

const uploads = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".upload"));

describe("[SV-D3] A stalled upload holds its socket", () => {
  test("an upload that goes silent mid-body is closed at the idle timeout, and its spool file is deleted", async () => {
    const t = tempDir("akou-upload-idle-");
    cleanups.push(t.cleanup);
    const { port } = serve(t.dir);
    const socket = connect(port, "127.0.0.1");
    cleanups.push(() => socket.destroy());
    let closed = false;
    socket.on("close", () => {
      closed = true;
    });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    // The headers and 1 KB of a 1 MB file, then nothing more.
    socket.write(head(port, 1024 * 1024));
    socket.write(Buffer.alloc(1024, 1));
    await until(() => uploads(t.dir).length === 1, 5000, "the upload to be spooled");
    await until(() => closed, 8000, "the stalled socket to be closed");
    await until(() => uploads(t.dir).length === 0, 5000, "the spool file to be deleted");
  }, 20_000);

  test("positive control: an upload that trickles a chunk a second for longer than the idle timeout completes", async () => {
    const t = tempDir("akou-upload-trickle-");
    cleanups.push(t.cleanup);
    const { port, answered } = serve(t.dir);
    const socket = connect(port, "127.0.0.1");
    cleanups.push(() => socket.destroy());
    let reply = "";
    socket.on("data", (d) => {
      reply += d.toString();
    });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const chunks = 5;
    socket.write(head(port, chunks * 1024));
    for (let i = 0; i < chunks; i++) {
      socket.write(Buffer.alloc(1024, 1));
      await Bun.sleep(1000);
    }
    socket.write(`\r\n--${BOUNDARY}--\r\n`);
    await until(() => answered.length === 1, 5000, "the upload to be answered");
    expect(answered).toEqual([chunks * 1024]);
    await until(() => reply.startsWith("HTTP/1.1 200"), 5000, "the 200");
  }, 20_000);
});
