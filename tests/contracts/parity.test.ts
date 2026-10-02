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
import { type Doors, PARITY, parityProblems, rpcMethods, WINDOW_RPC } from "./parity.ts";

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

const PROTOCOL = readFileSync(join(ROOT, "src", "ui", "protocol.ts"), "utf8");

function doors(o: { dropTool?: string[] } = {}): Doors {
  return {
    rpc: new Set(rpcMethods(PROTOCOL)),
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
    expect([...d.rpc]).toEqual(expect.arrayContaining(["api", "follow", "status", "zoomWindow"]));
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
    const silent = PARITY.map((r) =>
      r.action === "Run the hooks again" ? { ...r, mcp: { none: "" } } : r,
    );
    expect(parityProblems(silent, d)).toEqual([
      "Run the hooks again: the mcp door lacks it and gives no reason",
    ]);
    const source = (file: string) =>
      file === "src/ui/app.ts"
        ? (d.source(file) ?? "").replaceAll('this.control("restart"', "this.nothing(")
        : d.source(file);
    expect(parityProblems(PARITY, { ...d, source })).toEqual([
      'Restart: the window no longer does it (src/ui/app.ts lacks this.control("restart")',
    ]);
  });

  test("[PG-A1] every method of the window's RPC has a route or a written reason", () => {
    const d = doors();
    // Read from the type: every request the page can make of the main side, none missed.
    expect([...d.rpc].sort()).toEqual(Object.keys(WINDOW_RPC).sort());
    expect(d.rpc.size).toBeGreaterThan(10);
  });

  test("[PG-A1] positive controls: an RPC method with no row, one with no reason, and a route gone each fail", () => {
    const d = doors();
    // A method added to AkouRpc, as the window would gain one, read from the edited source.
    const added = PROTOCOL.replace(
      "      zoomWindow: {",
      "      renameCall: { params: { call: string; title: string }; response: boolean };\n      zoomWindow: {",
    );
    expect(added).not.toBe(PROTOCOL);
    const rpc = new Set(rpcMethods(added));
    expect(parityProblems(PARITY, { ...d, rpc })).toEqual([
      "the window's RPC has renameCall, which neither names a route nor says why none",
    ]);
    expect(parityProblems(PARITY, d, { ...WINDOW_RPC, zoomWindow: { none: "" } })).toEqual([
      "the window's RPC zoomWindow has no route and gives no reason",
    ]);
    const api = new Set([...d.api].filter((r) => r !== "POST /quit"));
    expect(parityProblems(PARITY, { ...d, api })).toEqual([
      "the window's RPC answerQuit: the api door has no POST /quit",
      "Quit: the api door has no POST /quit",
    ]);
  });
});
