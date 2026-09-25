/**
 * Test support for the MCP server: an in-process client over a linked pair of transports, against
 * any `ApiClient`, real (a rig's app) or a stand-in that answers from a function.
 */

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { ApiClient, ApiResponse, RequestOptions } from "../src/main/cli/client.ts";
import { createMcpServer } from "../src/main/mcp/server.ts";

/** An `ApiClient` whose every request is answered by `body`: 200 with that JSON. */
export function fakeApi(
  body: (method: string, path: string, o: RequestOptions) => unknown,
  text?: (method: string, path: string, o: RequestOptions) => string | null,
): ApiClient {
  return {
    request: async (method: string, path: string, o: RequestOptions = {}): Promise<ApiResponse> => {
      const b = body(method, path, o) ?? {};
      return {
        status: 200,
        body: b,
        text: text?.(method, path, o) ?? JSON.stringify(b),
        contentType: "application/json",
      };
    },
  } as unknown as ApiClient;
}

/** The status of an app whose provider can answer, so `akou_ask` is listed. */
export const PROVIDER_STATUS = { provider: { state: "available", id: "anthropic" } };

export interface ToolAnswer {
  text: string;
  isError: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: structured results are inspected field by field.
  structured: any;
}

/** An MCP client named `name`, connected in process to a fresh akou MCP server over `api`. */
export async function mcpClient(api: ApiClient, name = "claude-code") {
  const server = createMcpServer({ client: api });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(a);
  // The provider is read from the app's status right after initialize (akou_ask may appear).
  await new Promise((r) => setTimeout(r, 50));
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    return { text, isError: r.isError === true, structured: r.structuredContent };
  };
  return { client, server, call, close: () => client.close() };
}
