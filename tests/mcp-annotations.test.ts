/**
 * PG-M2 (docs/ux/PROGRAMMABILITY.md section 5): every MCP tool carries a title and the annotations
 * from the one table below. A harness decides from these hints which tools it may run without
 * asking, so a read that says nothing, or a stop that claims to be harmless, is a real bug.
 *
 * The MCP defaults are the unsafe way round for a local tool (`destructiveHint` and `openWorldHint`
 * default to true), so every write states both hints, and every tool states `openWorldHint`.
 */

import { describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/client";
import * as z from "zod";
import { fakeApi, mcpClient, PROVIDER_STATUS } from "./mcp-helpers.ts";

type Hints = {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
};

/** Reads: nothing to confirm. `openWorldHint: false`: akou only talks to its own local app. */
const READ: Hints = { readOnlyHint: true, openWorldHint: false };
/** A write that adds to the call's log or files and can be undone or corrected by a later event. */
const WRITE: Hints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Ends the recording (stop) or rebuilds it (restart): the harness should confirm. */
const DESTRUCTIVE: Hints = { ...WRITE, destructiveHint: true };
/** The same arguments twice leave the same state. */
const IDEMPOTENT: Hints = { ...WRITE, idempotentHint: true };
/** Runs akou's configured provider, which may be a remote API. */
const PROVIDER: Hints = { ...WRITE, openWorldHint: true };

/** The one table: every tool akou lists, and its annotations. */
const ANNOTATIONS: Record<string, Hints> = {
  akou_start: WRITE,
  akou_stop: DESTRUCTIVE,
  akou_pause: WRITE,
  akou_resume: WRITE,
  akou_mute: WRITE,
  akou_unmute: WRITE,
  akou_restart: DESTRUCTIVE,
  akou_status: READ,
  akou_context: READ,
  akou_read: READ,
  akou_search: READ,
  akou_ask: PROVIDER,
  akou_name_speaker: IDEMPOTENT,
  akou_merge_speakers: WRITE,
  akou_unmerge_speaker: WRITE,
  akou_add_note: WRITE,
  akou_get_notes: READ,
  akou_remember: WRITE,
  akou_forget: WRITE,
  akou_memo_get: READ,
  akou_memo_put: IDEMPOTENT,
  akou_vocab_add: WRITE,
  akou_vocab_propose: WRITE,
  akou_vocab_approve: WRITE,
  akou_vocab_reject: WRITE,
  akou_vocab_list: READ,
  akou_vocab_suggest: READ,
  akou_vocab_check: READ,
  akou_enhance_context: READ,
  akou_enhanced_put: WRITE,
  akou_enhance: PROVIDER,
  akou_list_calls: READ,
  akou_get_call: READ,
  akou_export: WRITE,
};

/** What is wrong with a tool list against the table: one line per problem, empty when none. */
function annotationProblems(tools: readonly Tool[], table: Record<string, Hints>): string[] {
  const out: string[] = [];
  const titles = new Map<string, string>();
  for (const t of tools) {
    const want = table[t.name];
    if (!want) {
      out.push(`${t.name}: missing from the table`);
      continue;
    }
    const got = t.annotations ?? {};
    for (const k of Object.keys(want) as (keyof Hints)[]) {
      if (got[k] !== want[k]) out.push(`${t.name}: ${k} is ${got[k]}, the table says ${want[k]}`);
    }
    // A read-only tool states no write hints: the spec gives them no meaning there.
    if (
      want.readOnlyHint &&
      (got.destructiveHint !== undefined || got.idempotentHint !== undefined)
    )
      out.push(`${t.name}: a read-only tool with write hints`);
    const title = t.title ?? "";
    if (title.trim() === "") out.push(`${t.name}: no title`);
    else if (titles.has(title)) out.push(`${t.name}: same title as ${titles.get(title)}`);
    else titles.set(title, t.name);
  }
  const listed = new Set(tools.map((t) => t.name));
  for (const name of Object.keys(table)) {
    if (!listed.has(name)) out.push(`${name}: in the table but not listed`);
  }
  return out;
}

async function listed(): Promise<Tool[]> {
  // A provider that can answer, so akou_ask is listed too.
  const c = await mcpClient(fakeApi((_m, path) => (path === "/status" ? PROVIDER_STATUS : {})));
  try {
    return (await c.client.listTools()).tools;
  } finally {
    await c.close();
  }
}

describe("[PG-M2] every MCP tool carries annotations and a title", () => {
  test("tools/list matches the one table, tool for tool", async () => {
    const tools = await listed();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(ANNOTATIONS).sort());
    expect(annotationProblems(tools, ANNOTATIONS)).toEqual([]);
  });

  test("the reads the design names are read-only; stop and restart are destructive", async () => {
    const tools = await listed();
    const hint = (name: string) => tools.find((t) => t.name === name)?.annotations;
    for (const read of [
      "status",
      "context",
      "read",
      "search",
      "get_notes",
      "list_calls",
      "get_call",
      "memo_get",
      "vocab_list",
      "vocab_suggest",
      "vocab_check",
      "enhance_context",
    ]) {
      expect([read, hint(`akou_${read}`)?.readOnlyHint]).toEqual([read, true]);
    }
    for (const d of ["stop", "restart"])
      expect([d, hint(`akou_${d}`)?.destructiveHint]).toEqual([d, true]);
    for (const i of ["name_speaker", "memo_put"])
      expect([i, hint(`akou_${i}`)?.idempotentHint]).toEqual([i, true]);
  });

  test("positive control: a tool missing from the table, a wrong hint and a missing title all fail", async () => {
    const tools = await listed();
    const stop = tools.find((t) => t.name === "akou_stop") as Tool;
    const extra: Tool = {
      name: "akou_extra",
      title: "Extra",
      inputSchema: z.toJSONSchema(z.object({})) as Tool["inputSchema"],
      annotations: READ,
    };
    expect(annotationProblems([...tools, extra], ANNOTATIONS)).toEqual([
      "akou_extra: missing from the table",
    ]);
    const harmless = { ...stop, annotations: { ...stop.annotations, destructiveHint: false } };
    expect(annotationProblems([...tools.filter((t) => t !== stop), harmless], ANNOTATIONS)).toEqual(
      ["akou_stop: destructiveHint is false, the table says true"],
    );
    const untitled = { ...stop, title: undefined };
    expect(annotationProblems([...tools.filter((t) => t !== stop), untitled], ANNOTATIONS)).toEqual(
      ["akou_stop: no title"],
    );
    const { akou_stop: _gone, ...short } = ANNOTATIONS;
    expect(annotationProblems(tools, short)).toEqual(["akou_stop: missing from the table"]);
    expect(
      annotationProblems(
        tools.filter((t) => t !== stop),
        ANNOTATIONS,
      ),
    ).toEqual(["akou_stop: in the table but not listed"]);
  });
});
