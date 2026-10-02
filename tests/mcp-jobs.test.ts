/**
 * SI-7 (docs/research/service-interface.md section 11): the job tools of `akou mcp` against a fake
 * akou server reached through `AKOU_URL`. `akou_transcribe` uploads a file on this machine once
 * and refuses anything that is not audio or video before a byte leaves; the two readers are
 * read-only; and against a target whose mode is `server`, `tools/list` holds no call tool, while
 * an app's holds no job tool.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClient } from "../src/main/cli/client.ts";
import { isMediaHead, JOB_TOOLS, MAX_TOOL_WAIT, targetMode } from "../src/main/mcp/server.ts";
import { CLI } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";
import { mcpClient } from "./mcp-helpers.ts";

const WAV = join(import.meta.dir, "fixtures", "two-voices.wav");

let fake: ReturnType<typeof Bun.serve>;
let mode = "server";
/** Every upload the fake took: the file's bytes and the query it came with. */
const uploads: { bytes: Uint8Array; wait: string | null; preset: string | null }[] = [];
const box = tempDir("akou-mcp-jobs-");

beforeAll(() => {
  fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/server") return Response.json({ name: "akou", mode });
      if (url.pathname === "/v1/jobs" && req.method === "POST") {
        const form = await req.formData();
        const file = form.get("file") as File;
        uploads.push({
          bytes: new Uint8Array(await file.arrayBuffer()),
          wait: url.searchParams.get("wait"),
          preset: form.get("preset") as string | null,
        });
        return Response.json(
          { id: "job_1", status: "done", result: { job_id: "job_1", text: "hello world" } },
          { status: 200 },
        );
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
});

afterAll(() => {
  fake.stop(true);
  box.cleanup();
});

function remote(): ApiClient {
  const env: Record<string, string | undefined> = { ...process.env, AKOU_HOME: box.dir };
  env.AKOU_URL = `http://127.0.0.1:${fake.port}`;
  env.AKOU_API_KEY = "ak_test";
  return new ApiClient({ env, client: "mcp", launch: null });
}

describe("[SI-7] akou_transcribe", () => {
  test("a fixture file is uploaded once, its bytes unchanged, and the job comes back", async () => {
    uploads.length = 0;
    const c = await mcpClient(remote());
    try {
      const r = await c.call("akou_transcribe", { path: WAV, preset: "fast" });
      expect(r.isError).toBe(false);
      expect(r.structured).toMatchObject({ id: "job_1", status: "done" });
      expect(r.text).toContain("hello world");
      expect(uploads.length).toBe(1);
      expect(Buffer.from(uploads[0]?.bytes ?? []).equals(readFileSync(WAV))).toBe(true);
      expect(uploads[0]).toMatchObject({ wait: String(MAX_TOOL_WAIT), preset: "fast" });
    } finally {
      await c.close();
    }
  });

  test("a path that does not exist and a text file are tool errors, and nothing is uploaded", async () => {
    uploads.length = 0;
    const text = join(box.dir, "notes.ogg");
    writeFileSync(text, "AKOU_API_KEY=ak_secret\n");
    const c = await mcpClient(remote());
    try {
      const missing = await c.call("akou_transcribe", { path: join(box.dir, "nope.wav") });
      expect([missing.isError, missing.text]).toEqual([true, expect.stringContaining("no file")]);
      const notAudio = await c.call("akou_transcribe", { path: text });
      expect([notAudio.isError, notAudio.text]).toEqual([
        true,
        expect.stringContaining("not an audio or video file"),
      ]);
      expect(await c.call("akou_transcribe", { path: box.dir })).toMatchObject({ isError: true });
      expect(uploads.length).toBe(0);
      // Positive control: the same client uploads a real recording.
      expect((await c.call("akou_transcribe", { path: WAV })).isError).toBe(false);
      expect(uploads.length).toBe(1);
    } finally {
      await c.close();
    }
  });

  test("the container check knows the formats a voice note arrives in, and refuses text", () => {
    const head = (...xs: (string | number)[]) =>
      new Uint8Array(
        xs.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])),
      );
    expect(isMediaHead(readFileSync(WAV).subarray(0, 16))).toBe(true);
    for (const ok of [
      head("OggS", 0, 2),
      head("fLaC"),
      head("ID3", 4, 0),
      head(0xff, 0xfb, 0x90),
      head(0, 0, 0, 0x20, "ftypM4A "),
      head(0x1a, 0x45, 0xdf, 0xa3),
      head("#!AMR\n"),
    ])
      expect(isMediaHead(ok)).toBe(true);
    for (const bad of [head("AKOU_API_KEY=x"), head('{"a":1}'), head("%PDF-1.7"), head()])
      expect(isMediaHead(bad)).toBe(false);
  });
});

describe("[SI-7] tools/list follows the target's mode", () => {
  test("the readers are read-only; a server lists the job tools and no call tool", async () => {
    mode = "server";
    const api = remote();
    const c = await mcpClient(api);
    const served = await mcpClient(api, "claude-code", (await targetMode(api)) ?? undefined);
    try {
      const all = (await c.client.listTools()).tools;
      const hint = (n: string) => all.find((t) => t.name === n)?.annotations?.readOnlyHint;
      expect([hint("akou_job_get"), hint("akou_jobs_list"), hint("akou_transcribe")]).toEqual([
        true,
        true,
        false,
      ]);
      // With no mode known every tool is listed: the positive control for the filter below.
      expect(all.some((t) => t.name === "akou_start")).toBe(true);
      const names = (await served.client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...JOB_TOOLS].sort());
    } finally {
      await c.close();
      await served.close();
    }
  });

  test("an app lists the call tools and no job tool", async () => {
    mode = "app";
    const api = remote();
    expect(await targetMode(api)).toBe("app");
    const c = await mcpClient(api, "claude-code", "app");
    try {
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("akou_start");
      expect(names.filter((n) => JOB_TOOLS.has(n))).toEqual([]);
    } finally {
      await c.close();
      mode = "server";
    }
  });

  test("the real `akou mcp` with AKOU_URL at a server lists no call tool", async () => {
    mode = "server";
    const proc = Bun.spawn([process.execPath, CLI, "mcp"], {
      env: {
        ...(process.env as Record<string, string>),
        AKOU_HOME: box.dir,
        AKOU_URL: `http://127.0.0.1:${fake.port}`,
        AKOU_API_KEY: "ak_test",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const send = (m: object) => proc.stdin.write(`${JSON.stringify(m)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await proc.stdin.flush();
      const reader = proc.stdout.getReader();
      let out = "";
      // clock: a bound on reading the child's answer, not a wait for an event.
      const deadline = Date.now() + 20_000;
      while (!out.split("\n").some((l) => l.includes('"id":2')) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      const line = out.split("\n").find((l) => l.includes('"id":2')) ?? "{}";
      const names = (JSON.parse(line).result?.tools ?? []).map((t: { name: string }) => t.name);
      expect(names.sort()).toEqual([...JOB_TOOLS].sort());
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
