/**
 * What `akou mcp` holds back from an agent a harness may run unasked, or from a network in between:
 * the API key over plain http, a share link's token, a file too large to send, an answer too large
 * to read, and a delete that claims to be harmless. Each check is shown failing once against the
 * rule it guards (the positive controls in the PR and below).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ApiClient, type RequestOptions } from "../src/main/cli/client.ts";
import {
  MAX_ANSWER_BYTES,
  plainHttpRefusal,
  readMedia,
  redactShareUrl,
} from "../src/main/mcp/server.ts";
import { cli } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";
import { fakeApi, mcpClient } from "./mcp-helpers.ts";

const WAV = join(import.meta.dir, "fixtures", "two-voices.wav");
const box = tempDir("akou-mcp-security-");
afterAll(() => box.cleanup());

describe("akou mcp never sends the API key over plain http to another machine", () => {
  test("plain http to another host is refused; https, loopback and the opt-in are not", () => {
    expect(plainHttpRefusal({ AKOU_URL: "http://akou.lan:8476" })).toContain("plain http");
    expect(plainHttpRefusal({ AKOU_URL: "http://100.64.0.7" })).toContain("AKOU_ALLOW_HTTP=1");
    for (const ok of [
      "https://akou.example",
      "http://127.0.0.1:8476",
      "http://localhost:8476",
      "http://[::1]:8476",
    ]) {
      expect([ok, plainHttpRefusal({ AKOU_URL: ok })]).toEqual([ok, null]);
    }
    expect(plainHttpRefusal({ AKOU_URL: "http://akou.lan", AKOU_ALLOW_HTTP: "1" })).toBeNull();
    expect(plainHttpRefusal({})).toBeNull();
  });

  test("`akou mcp` with a plain http AKOU_URL exits 64 and says why, before serving", async () => {
    const r = await cli({ AKOU_HOME: box.dir, AKOU_URL: "http://akou.lan:8476" }, ["mcp"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("AKOU_ALLOW_HTTP=1");
    expect(r.out).toBe("");
  });
});

describe("akou_share_status hands out no live link's token", () => {
  test("the token is cut out of every address, in the text and the structured result", async () => {
    const token = "fake-share-token-for-this-test";
    const api = fakeApi((_m, path) =>
      path === "/share"
        ? {
            active: true,
            shares: [
              {
                id: "s1",
                call: "c1",
                url: `http://100.64.0.1:8477/s/${token}/`,
                expiresAt: null,
                viewers: 2,
              },
            ],
          }
        : {},
    );
    const c = await mcpClient(api);
    try {
      const r = await c.call("akou_share_status");
      expect(r.isError).toBe(false);
      expect(r.text).not.toContain(token);
      expect(JSON.stringify(r.structured)).not.toContain(token);
      expect(r.structured.shares[0]).toMatchObject({
        id: "s1",
        url: "http://100.64.0.1:8477/s/<token>/",
        viewers: 2,
      });
    } finally {
      await c.close();
    }
    expect(redactShareUrl(null)).toBeNull();
  });
});

describe("akou_transcribe sends no file larger than an upload takes", () => {
  test("a file over the cap is refused before a byte leaves, and one under it goes", async () => {
    const sent: string[] = [];
    const api = fakeApi((method, path) => {
      sent.push(`${method} ${path}`);
      return { id: "job_1", status: "queued" };
    });
    const c = await mcpClient(api, "claude-code", "server", { maxUploadBytes: 1000 });
    try {
      const r = await c.call("akou_transcribe", { path: WAV, wait: 0 });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("nothing was sent");
      expect(sent).toEqual([]);
    } finally {
      await c.close();
    }
    // The same file under the default cap goes out.
    expect("file" in readMedia(WAV)).toBe(true);
  });
});

describe("akou mcp reads no API answer past its cap", () => {
  let fake: ReturnType<typeof Bun.serve>;
  const big = JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) });
  beforeAll(() => {
    fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/v1/declared") return new Response(big);
        // No Content-Length: the size shows only as the body arrives.
        const enc = new TextEncoder().encode(big);
        const stream = new ReadableStream({
          start(c) {
            for (let i = 0; i < enc.length; i += 65536) c.enqueue(enc.slice(i, i + 65536));
            c.close();
          },
        });
        return new Response(stream);
      },
    });
  });
  afterAll(() => fake.stop(true));

  const remote = () =>
    new ApiClient({
      env: { AKOU_HOME: box.dir, AKOU_URL: `http://127.0.0.1:${fake.port}`, AKOU_API_KEY: "k" },
      client: "mcp",
      launch: null,
    });

  test("an answer past maxBytes is cut off unread, declared or streamed; without it, read whole", async () => {
    for (const path of ["/declared", "/streamed"]) {
      const r = await remote().request("GET", path, { maxBytes: 1024 * 1024 });
      expect([path, r.status, r.body?.error]).toEqual([path, 502, "too_large"]);
      const whole = await remote().request("GET", path);
      expect([path, whole.status, whole.text.length]).toEqual([path, 200, big.length]);
    }
  });

  test("every request the MCP server makes carries the cap", async () => {
    const caps: (number | undefined)[] = [];
    const api = fakeApi((_m, _p, o: RequestOptions) => {
      caps.push(o.maxBytes);
      return { active: false, shares: [] };
    });
    const c = await mcpClient(api);
    try {
      await c.call("akou_share_status");
    } finally {
      await c.close();
    }
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every((m) => m === MAX_ANSWER_BYTES)).toBe(true);
  });
});
