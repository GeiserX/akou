/**
 * A model registry on loopback for the on-demand download tests (docs/ux/SERVER.md section 12):
 * tiny stand-in files with their own SHA-256, a count of every request per file, and per-file
 * faults: answer 500 for the next N requests, hold the body after its first bytes until released,
 * or serve bytes other than the pinned ones. Nothing here is a model; the engine is the fake one.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSpecEntry } from "../../src/main/asr/models.ts";

export interface ModelRegistry {
  port: number;
  /** Requests per file name. */
  hits: Map<string, number>;
  /** The catalog entry for `id`, one file per name, pinned to this server. */
  entry(id: string, names: readonly string[]): ModelSpecEntry;
  /** The next `n` requests for `name` answer 500 (Infinity: every one). */
  failNext(name: string, n: number): void;
  /** `name` sends its first `bytes` bytes, then waits for the returned release. */
  hold(name: string, bytes: number): () => void;
  /** `name` is served with other bytes than the pinned ones, of the same length. */
  corrupt(name: string): void;
  /** Writes the files of `entry` into `dir` as a finished download would. */
  install(dir: string, entry: ModelSpecEntry): void;
  stop(): void;
}

/** A body per name: `size` bytes derived from the name, so every file differs. */
function bodyOf(name: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const seed = createHash("sha256").update(name).digest();
  for (let i = 0; i < size; i++) out[i] = seed[i % seed.length] as number;
  return out;
}

export function modelRegistry(size = 4096): ModelRegistry {
  const bodies = new Map<string, Uint8Array>();
  const hits = new Map<string, number>();
  const failing = new Map<string, number>();
  const held = new Map<string, { bytes: number; gate: Promise<void> }>();
  const corrupted = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const name = new URL(req.url).pathname.slice(1);
      hits.set(name, (hits.get(name) ?? 0) + 1);
      const fails = failing.get(name) ?? 0;
      if (fails > 0) {
        failing.set(name, fails - 1);
        return new Response("down", { status: 500 });
      }
      let body = bodies.get(name);
      if (!body) return new Response("no", { status: 404 });
      if (corrupted.has(name)) body = body.map((b) => b ^ 0xff);
      const h = held.get(name);
      if (!h) return new Response(body);
      const b = body;
      return new Response(
        new ReadableStream({
          async start(ctl) {
            ctl.enqueue(b.subarray(0, h.bytes));
            await h.gate;
            ctl.enqueue(b.subarray(h.bytes));
            ctl.close();
          },
        }),
      );
    },
  });
  const port = server.port as number;
  return {
    port,
    hits,
    entry(id, names) {
      return {
        id,
        job: "test",
        licence: "MIT",
        source: "test",
        files: names.map((name) => {
          const b = bodies.get(name) ?? bodyOf(name, size);
          bodies.set(name, b);
          return {
            name,
            url: `http://127.0.0.1:${port}/${name}`,
            sha256: createHash("sha256").update(b).digest("hex"),
            size: b.byteLength,
          };
        }),
      };
    },
    failNext(name, n) {
      failing.set(name, n);
    },
    hold(name, bytes) {
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      held.set(name, { bytes, gate });
      return () => {
        held.delete(name);
        release();
      };
    },
    corrupt(name) {
      corrupted.add(name);
    },
    install(dir, entry) {
      mkdirSync(join(dir, entry.id), { recursive: true });
      for (const f of entry.files) {
        writeFileSync(join(dir, entry.id, f.name), bodies.get(f.name) as Uint8Array);
      }
    },
    stop() {
      server.stop(true);
    },
  };
}
