/**
 * MCP-E1: a client that writes its requests and closes stdin (`printf '…' | akou mcp`) still gets
 * an answer to each. The SDK's stdio transport closes the moment stdin ends and drops every answer
 * still being worked out; `akou mcp` holds the end back until those answers are sent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

let fake: ReturnType<typeof Bun.serve>;
const box = tempDir("akou-mcp-eof-");

beforeAll(() => {
  fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/server") return Response.json({ name: "akou", mode: "server" });
      if (url.pathname === "/v1/jobs") {
        // The answer is still being worked out when the client closes stdin.
        await Bun.sleep(1500);
        return Response.json({ jobs: [], cursor: null });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
});

afterAll(() => {
  fake.stop(true);
  box.cleanup();
});

describe("[MCP-E1] Requests sent before stdin closes are answered", () => {
  test("a tool call still in flight at stdin's end gets its answer, then the server exits", async () => {
    const lines = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "akou_jobs_list", arguments: {} },
      },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ];
    const proc = Bun.spawn([process.execPath, CLI, "mcp"], {
      env: {
        ...(process.env as Record<string, string>),
        AKOU_HOME: box.dir,
        AKOU_URL: `http://127.0.0.1:${fake.port}`,
        AKOU_API_KEY: "ak_test",
      },
      // Every request, then end of file at once: the shape of `printf '…' | akou mcp`.
      stdin: new TextEncoder().encode(lines.map((l) => `${JSON.stringify(l)}\n`).join("")),
      stdout: "pipe",
      stderr: "pipe",
    });
    // clock: a bound on the child, far above the fake's 1.5 s, so a hang fails instead of waiting.
    const killer = setTimeout(() => proc.kill(), 30_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killer);
    const answers = out
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { id?: number; result?: { isError?: boolean } });
    const ids = answers.map((a) => a.id).sort();
    // The control: the requests answered at once (initialize, ping) arrive either way.
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    // The rule: the slow tool call's answer arrives too, and it is not an error.
    expect([ids, err]).toEqual([[1, 2, 3], ""]);
    expect(answers.find((a) => a.id === 2)?.result?.isError).not.toBe(true);
    expect(code).toBe(0);
  }, 40_000);
});
