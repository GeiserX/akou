/**
 * The MCP protocol eras over stdio, against the real `akou mcp`: one binary serves a client on
 * the 2026-07-28 revision (`server/discover`, then requests that carry their own envelope) and a
 * client on the 2025 revisions (`initialize`), which Claude Code, Claude Desktop, Cursor and
 * VS Code still are. Positive control: the same exchange against a server wired with
 * `server.connect(new StdioServerTransport())`, the entry before `serveStdio`, answers
 * `server/discover` with -32601 and fails the modern half.
 *
 * In process, a 2026-07-28 client's tool calls work too, and a cancelled call stops its API request.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { ApiClient, ApiResponse, RequestOptions } from "../src/main/cli/client.ts";
import { CLI } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";
import { mcpClient, modernClient, PROVIDER_STATUS } from "./mcp-helpers.ts";

const MODERN = "2026-07-28";
const box = tempDir("akou-mcp-protocol-");
afterAll(() => box.cleanup());

/** The per-request `_meta` a 2026-07-28 client sends with every request. */
const envelope = (version = MODERN) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "protocol-test", version: "1" },
});

/**
 * Runs `akou mcp` with no app and no `AKOU_URL`, writes `messages` to it, and returns the answers
 * by id once every id in `ids` has one (or the bound runs out).
 */
// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC answers are inspected field by field.
async function exchange(messages: object[], ids: number[]): Promise<Map<number, any>> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("AKOU_")) env[k] = v;
  }
  env.AKOU_HOME = box.dir;
  const proc = Bun.spawn([process.execPath, CLI, "mcp"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  const got = new Map<number, any>();
  try {
    for (const m of messages) proc.stdin.write(`${JSON.stringify(m)}\n`);
    await proc.stdin.flush();
    const reader = proc.stdout.getReader();
    let out = "";
    // clock: a bound on reading the child's answers, not a wait for an event.
    const deadline = Date.now() + 20_000;
    while (ids.some((i) => !got.has(i)) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const l of lines) {
        if (l.trim() === "") continue;
        const msg = JSON.parse(l);
        if (typeof msg.id === "number") got.set(msg.id, msg);
      }
    }
  } finally {
    proc.kill();
    await proc.exited;
  }
  return got;
}

describe("akou mcp speaks the 2026-07-28 revision and the 2025 ones on the same binary", () => {
  test("2026-07-28: server/discover, then tools/list with the envelope, cache hints and resultType", async () => {
    const got = await exchange(
      [
        { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope() } },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: envelope() } },
      ],
      [1, 2],
    );
    const discover = got.get(1);
    expect(discover?.error).toBeUndefined();
    expect(discover.result.supportedVersions).toContain(MODERN);
    expect(discover.result.ttlMs).toBe(60_000);
    expect(discover.result.cacheScope).toBe("private");
    expect(discover.result.instructions).toContain("akou_context");
    expect(discover.result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: "akou",
      title: "akou",
      websiteUrl: "https://geiserx.github.io/akou/",
    });
    const list = got.get(2);
    expect(list?.error).toBeUndefined();
    expect(list.result.resultType).toBe("complete");
    expect(list.result.ttlMs).toBe(30_000);
    expect(list.result.cacheScope).toBe("private");
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("akou_context");
    expect(names).toContain("akou_start");
  }, 30_000);

  test("2026-07-28: a revision akou does not speak answers -32022 with the ones it does", async () => {
    const got = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: envelope("2099-01-01") },
        },
      ],
      [1],
    );
    expect(got.get(1)?.error?.code).toBe(-32022);
    expect(got.get(1)?.error?.data?.supported).toContain(MODERN);
  }, 30_000);

  test("2025: initialize still negotiates, and tools/list answers in the 2025 shape", async () => {
    const got = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "claude-code", version: "2.1" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      [1, 2],
    );
    expect(got.get(1)?.result?.protocolVersion).toBe("2025-11-25");
    expect(got.get(1)?.result?.serverInfo).toMatchObject({ name: "akou", title: "akou" });
    const list = got.get(2)?.result;
    expect(list.tools.map((t: { name: string }) => t.name)).toContain("akou_context");
    // The 2025 wire carries none of the 2026-07-28 fields.
    expect(list.resultType).toBeUndefined();
    expect(list.ttlMs).toBeUndefined();
  }, 30_000);
});

/**
 * An app whose `/ask` answers only when `release()` is called, and that records every request's
 * signal: whether the tool call's cancel reached the API request.
 */
function slowAskApi() {
  const aborted: string[] = [];
  let release = () => {};
  const api = {
    request: async (method: string, path: string, o: RequestOptions = {}): Promise<ApiResponse> => {
      if (path === "/status") {
        return { status: 200, body: PROVIDER_STATUS, text: "", contentType: "application/json" };
      }
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        o.signal?.addEventListener("abort", () => {
          aborted.push(`${method} ${path}`);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      const body = { answered: true, text: "Friday" };
      return { status: 200, body, text: JSON.stringify(body), contentType: "application/json" };
    },
  } as unknown as ApiClient;
  return { api, aborted, release: () => release() };
}

describe("a tool call through akou mcp", () => {
  test("2026-07-28: a client on the new revision calls a tool and reads its structured result", async () => {
    const { api, release } = slowAskApi();
    const c = await modernClient(api, "my-agent");
    try {
      expect(c.client.getProtocolEra()).toBe("modern");
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("akou_ask");
      const pending = c.call("akou_ask", { question: "when?" });
      // clock: lets the request reach the stand-in before it is answered.
      await new Promise((r) => setTimeout(r, 50));
      release();
      const r = await pending;
      expect(r.isError).toBe(false);
      expect(r.structured.answered).toBe(true);
    } finally {
      await c.close();
    }
  });

  for (const era of ["2025", "2026-07-28"] as const) {
    test(`${era}: cancelling akou_ask aborts its API request`, async () => {
      const { api, aborted } = slowAskApi();
      const c =
        era === "2025" ? await mcpClient(api, "my-agent") : await modernClient(api, "my-agent");
      try {
        const stop = new AbortController();
        const pending = c.client.callTool(
          { name: "akou_ask", arguments: { question: "when?" } },
          { signal: stop.signal },
        );
        // clock: lets the request reach the stand-in before the cancel.
        await new Promise((r) => setTimeout(r, 50));
        stop.abort();
        await expect(pending).rejects.toThrow();
        // clock: a bound for the cancel notification to cross the pipe.
        for (let i = 0; i < 40 && aborted.length === 0; i++)
          await new Promise((r) => setTimeout(r, 25));
        expect(aborted).toEqual(["POST /calls/live/ask"]);
      } finally {
        await c.close();
      }
    });
  }

  test("2026-07-28: akou_ask refuses when akou's provider is the harness asking", async () => {
    const api = {
      request: async (_m: string, path: string): Promise<ApiResponse> => {
        const body =
          path === "/status"
            ? { provider: { state: "available", id: "harness", harness: "claude" } }
            : { answered: true, text: "x" };
        return { status: 200, body, text: JSON.stringify(body), contentType: "application/json" };
      },
    } as unknown as ApiClient;
    const c = await modernClient(api, "claude-code");
    try {
      const r = await c.call("akou_ask", { question: "when?" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("same_harness");
    } finally {
      await c.close();
    }
  });
});
