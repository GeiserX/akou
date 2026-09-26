/**
 * PG-M3 (docs/ux/PROGRAMMABILITY.md section 5): every MCP tool returns `structuredContent` that
 * validates against the `outputSchema` it lists, with the text block kept beside it. The follow
 * loop reads `cursor` from the typed field, never out of the text, where call text can hold a
 * number that looks like one (the e2e half is in `mcp.e2e.test.ts`).
 *
 * Call text stays data (PG-Z1) in the structured result too: a string field that carries it holds
 * the same `<call-text>` block as the text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/client";
import * as z from "zod";
import { fold } from "../src/core/log/fold.ts";
import { CallQuery } from "../src/main/query/context.ts";
import { CALL_TEXT_CLOSE, CALL_TEXT_OPEN } from "../src/main/query/render.ts";
import { mcpClient, sampleApi, TOOL_ARGS } from "./mcp-helpers.ts";
import { synthCall } from "./synth.ts";

/** Whether `data` validates against the JSON Schema a tool lists as its `outputSchema`. */
function validates(schema: Tool["outputSchema"], data: unknown): string | null {
  const r = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(data);
  return r.success ? null : r.error.message;
}

describe("[PG-M3] MCP tools return typed structured results", () => {
  test("every tool lists an object outputSchema, and its answer validates against it", async () => {
    const c = await mcpClient(sampleApi());
    try {
      const tools = (await c.client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_ARGS).sort());
      for (const t of tools) {
        expect([t.name, t.outputSchema?.type]).toEqual([t.name, "object"]);
        const r = await c.call(t.name, TOOL_ARGS[t.name]);
        expect([t.name, r.isError, r.text.length > 0]).toEqual([t.name, false, true]);
        expect([t.name, typeof r.structured]).toEqual([t.name, "object"]);
        expect([t.name, validates(t.outputSchema, r.structured)]).toEqual([t.name, null]);
      }
    } finally {
      await c.close();
    }
  });

  test("akou_context and akou_read carry cursor, state, memoStale and provisional as typed fields", async () => {
    const c = await mcpClient(sampleApi());
    try {
      const tools = (await c.client.listTools()).tools;
      for (const name of ["akou_context", "akou_read"]) {
        const schema = tools.find((t) => t.name === name)?.outputSchema;
        const props = (schema?.properties ?? {}) as Record<string, { type?: unknown }>;
        expect([name, props.cursor?.type]).toEqual([name, "integer"]);
        expect([name, props.state?.type]).toEqual([name, "string"]);
        expect([name, props.memoStale?.type]).toEqual([name, "boolean"]);
        expect([name, props.provisional?.type]).toEqual([name, "boolean"]);
        expect([name, [...((schema?.required as string[] | undefined) ?? [])].sort()]).toEqual([
          name,
          expect.arrayContaining(["cursor", "memoStale", "provisional", "state"]),
        ]);
      }
      const ctx = await c.call("akou_context", TOOL_ARGS.akou_context);
      expect(ctx.structured).toMatchObject({
        cursor: 4,
        state: "LIVE",
        memoStale: true,
        provisional: false,
      });
      const read = await c.call("akou_read", {});
      expect(read.structured).toMatchObject({
        cursor: 4,
        state: "LIVE",
        memoStale: false,
        provisional: false,
        lines: 3,
      });
    } finally {
      await c.close();
    }
  });

  test("the memoStale akou_read reports (GET /transcript) is the one the pack reports", () => {
    // Half an hour of speech with no memo: stale. The same call once a memo covers it: not stale.
    const syn = synthCall({ hours: 0.5, seed: 5, facts: 0 });
    const view = fold(syn.events);
    const q = new CallQuery(view);
    const now = syn.end;
    expect(q.memoStale(now)).toBe(true);
    expect(q.context("what was decided?", { now }).memoStale).toBe(true);
    view.apply({
      seq: view.lastSeq + 1,
      t: now,
      type: "memo",
      rev: 1,
      body: "Topics: the budget [15:36]",
      coversSeq: view.lastSeq,
      by: "agent:claude-code",
      model: "claude-code",
    } as never);
    expect(q.memoStale(now)).toBe(false);
    expect(q.context("what was decided?", { now }).memoStale).toBe(false);
  });

  test("positive control: a result missing a typed field, or with the wrong type, fails its schema", async () => {
    const c = await mcpClient(sampleApi());
    try {
      const tools = (await c.client.listTools()).tools;
      const schema = tools.find((t) => t.name === "akou_read")?.outputSchema;
      const good = (await c.call("akou_read", {})).structured;
      expect(validates(schema, good)).toBeNull();
      const { cursor: _gone, ...noCursor } = good;
      expect(validates(schema, noCursor)).not.toBeNull();
      expect(validates(schema, { ...good, cursor: "4" })).not.toBeNull();
      expect(validates(schema, { ...good, memoStale: "no" })).not.toBeNull();
    } finally {
      await c.close();
    }
  });

  test("[PG-Z1] call text in a structured result is the same quoted block as in the text", async () => {
    const c = await mcpClient(sampleApi());
    const carriers = new Set<string>();
    try {
      for (const name of Object.keys(TOOL_ARGS)) {
        const r = await c.call(name, TOOL_ARGS[name]);
        const strings: string[] = [];
        const walk = (v: unknown): void => {
          if (typeof v === "string") strings.push(v);
          else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") Object.values(v).forEach(walk);
        };
        walk(r.structured);
        for (const s of strings.filter((x) => x.includes("moves to Friday"))) {
          carriers.add(name);
          const lines = s.split("\n");
          expect([name, lines.filter((l) => l === CALL_TEXT_OPEN).length]).toEqual([name, 1]);
          expect([name, lines.filter((l) => l === CALL_TEXT_CLOSE).length]).toEqual([name, 1]);
          expect([name, r.text.includes(s)]).toEqual([name, true]);
        }
      }
      // Not a vacuous pass: the tools that answer with call text did put it in the structured result.
      expect([...carriers].sort()).toEqual(
        expect.arrayContaining(["akou_context", "akou_get_call", "akou_get_notes", "akou_read"]),
      );
    } finally {
      await c.close();
    }
  });

  test("the akou skill follows the call with the typed cursor, never a number read out of the text", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "skills", "akou", "SKILL.md"), "utf8");
    const line = skill.split("\n").find((l) => l.includes("akou_read {since")) ?? "";
    expect(line).toContain("`cursor` field");
    expect(line).toMatch(/never take a number from inside a `<call-text>` block/i);
  });
});
