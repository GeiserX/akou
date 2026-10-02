/**
 * TS-12 (docs/TESTING.md section 4.3): the MCP tool reference, `docs/reference/mcp.md`, is exactly
 * what the server's `tools/list` generates. CI runs this file, so a tool added, removed or changed
 * (its description, parameters or annotations) without regenerating the page fails the build.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/client";
import {
  listMcpTools,
  MCP_REFERENCE_FILE,
  mcpReferenceDrifted,
  renderMcpReference,
} from "../scripts/mcp-reference.ts";

const committed = () => readFileSync(MCP_REFERENCE_FILE, "utf8");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("[TS-12] the MCP tool reference is generated from tools/list", () => {
  test("docs/reference/mcp.md is exactly what the server generates (run `bun run mcp-reference`)", async () => {
    expect(mcpReferenceDrifted(committed(), renderMcpReference(await listMcpTools()))).toBe(false);
  });

  test("the page has one section per listed tool, akou_ask included, each with its annotations", async () => {
    const tools = await listMcpTools();
    expect(tools.map((t) => t.name)).toContain("akou_ask");
    const sections = committed().split(/^## /m).slice(1);
    expect(sections.map((s) => s.split("\n")[0])).toEqual(tools.map((t) => t.name));
    for (const s of sections) expect(s).toContain("Annotations: `readOnlyHint: ");
  });

  test("positive control: a tool dropped, a parameter added, a hint or a description changed each fail the check", async () => {
    const tools = await listMcpTools();
    const page = committed();
    const drifted = (ts: Tool[]) => mcpReferenceDrifted(page, renderMcpReference(ts));
    expect(drifted(tools)).toBe(false);
    expect(drifted(tools.filter((t) => t.name !== "akou_stop"))).toBe(true);
    const added = clone(tools);
    (added[0]?.inputSchema.properties as Record<string, unknown>).extra = { type: "string" };
    expect(drifted(added)).toBe(true);
    const hinted = clone(tools);
    if (hinted[0]) hinted[0].annotations = { ...hinted[0].annotations, readOnlyHint: true };
    expect(drifted(hinted)).toBe(true);
    const described = clone(tools);
    if (described[0]) described[0].description = "x";
    expect(drifted(described)).toBe(true);
  });

  test("line endings aside: a CRLF checkout of the same page is not a diff", async () => {
    const generated = renderMcpReference(await listMcpTools());
    expect(mcpReferenceDrifted(committed().replace(/\n/g, "\r\n"), generated)).toBe(false);
  });

  test("an angle-bracket tag in a description shows as text, and stays as is inside code", () => {
    const tool = {
      name: "akou_x",
      description: "Quoted as one <call-text> block; `<call-text>` in code.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "string", description: "a <b> | c" } },
      },
    } as Tool;
    const page = renderMcpReference([tool]);
    expect(page).toContain("Quoted as one &lt;call-text&gt; block; `<call-text>` in code.");
    expect(page).toContain("| a &lt;b&gt; \\| c |");
  });
});
