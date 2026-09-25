/**
 * The one parity test (docs/TESTING.md TS-13): the table in `parity.ts` against the doors as the
 * code builds them. The CLI door is the command registry, the API door the route table, the MCP
 * door every tool the server registers, and the window door the page's own source. No other
 * parity test exists.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { buildRouter } from "../../src/main/api/server.ts";
import { COMMANDS } from "../../src/main/cli/cli.ts";
import type { ApiClient } from "../../src/main/cli/client.ts";
import { createMcpServer } from "../../src/main/mcp/server.ts";
import { type Doors, PARITY, parityProblems } from "./parity.ts";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The names of every tool `createMcpServer` registers, whether or not it is listed right now
 * (`akou_ask` is hidden until a provider answers). `drop` leaves tools out, as if deleted.
 */
function mcpTools(drop: readonly string[] = []): Set<string> {
  const names = new Set<string>();
  const proto = McpServer.prototype as unknown as { registerTool: (...a: unknown[]) => unknown };
  const original = proto.registerTool;
  proto.registerTool = function (this: unknown, name: unknown, ...rest: unknown[]) {
    const r = original.call(this, name, ...rest);
    if (!drop.includes(name as string)) names.add(name as string);
    return r;
  };
  try {
    // Building the server calls nothing on the client; it is never connected.
    createMcpServer({ client: {} as ApiClient });
  } finally {
    proto.registerTool = original;
  }
  return names;
}

function doors(o: { dropTool?: string[] } = {}): Doors {
  return {
    cli: new Set(COMMANDS.map((c) => c.name)),
    api: new Set(
      buildRouter()
        .list()
        .map((r) => `${r.method} ${r.path}`),
    ),
    mcp: mcpTools(o.dropTool),
    source: (file) => {
      const path = join(ROOT, file);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
  };
}

describe("[TS-13] door parity", () => {
  test("every action reaches every door, or its row says why that door lacks it", () => {
    const d = doors();
    // The doors are really read: a registry, a route table and a tool list, not empty sets.
    expect(d.cli.size).toBeGreaterThan(30);
    expect(d.api.size).toBeGreaterThan(50);
    expect(d.mcp.has("akou_ask")).toBe(true);
    expect(parityProblems(PARITY, d)).toEqual([]);
  });

  test("positive control: deleting one MCP tool fails", () => {
    expect(parityProblems(PARITY, doors({ dropTool: ["akou_stop"] }))).toEqual([
      "Stop: the mcp door has no akou_stop",
    ]);
  });

  test("positive controls: an unmapped route, a gap with no reason and a window action that went away each fail", () => {
    const d = doors();
    const api = new Set([...d.api, "POST /calls/:id/rename"]);
    expect(parityProblems(PARITY, { ...d, api })).toEqual([
      "the api door has POST /calls/:id/rename, which no row maps",
    ]);
    const silent = PARITY.map((r) => (r.action === "Final pass" ? { ...r, mcp: { none: "" } } : r));
    expect(parityProblems(silent, d)).toEqual([
      "Final pass: the mcp door lacks it and gives no reason",
    ]);
    const source = (file: string) =>
      file === "src/ui/app.ts"
        ? (d.source(file) ?? "").replaceAll('this.control("restart"', "this.nothing(")
        : d.source(file);
    expect(parityProblems(PARITY, { ...d, source })).toEqual([
      'Restart: the window no longer does it (src/ui/app.ts lacks this.control("restart")',
    ]);
  });
});
