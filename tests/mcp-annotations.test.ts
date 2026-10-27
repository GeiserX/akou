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
import type { ApiClient, RequestOptions } from "../src/main/cli/client.ts";
import { fakeApi, mcpClient, PROVIDER_STATUS, sampleApi, TOOL_ARGS } from "./mcp-helpers.ts";

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
/** Lets people outside this machine read the call. */
const SHARES: Hints = { ...WRITE, openWorldHint: true };
/** Turns off links other people hold, for good; twice is the same as once. */
const REVOKES: Hints = { ...DESTRUCTIVE, idempotentHint: true };
/** Sends a file on this machine to the akou server at AKOU_URL. */
const UPLOADS: Hints = { ...WRITE, openWorldHint: true };

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
  akou_edit_note: IDEMPOTENT,
  akou_delete_note: DESTRUCTIVE,
  akou_get_notes: READ,
  akou_remember: WRITE,
  akou_forget: DESTRUCTIVE,
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
  akou_template_list: READ,
  akou_template_get: READ,
  akou_finalize: WRITE,
  akou_rename_call: IDEMPOTENT,
  akou_list_calls: READ,
  akou_get_call: READ,
  akou_export: WRITE,
  akou_share_status: READ,
  akou_share_on: SHARES,
  akou_share_off: REVOKES,
  akou_open_window: WRITE,
  akou_config_get: READ,
  akou_dictation_list: READ,
  akou_dictation_get: READ,
  akou_transcribe: UPLOADS,
  akou_job_get: READ,
  akou_jobs_list: READ,
  akou_devices: READ,
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

/** Every tool that sends a DELETE and does not say it is destructive. */
function deleteProblems(tools: readonly Tool[], methods: Map<string, Set<string>>): string[] {
  return tools
    .filter((t) => methods.get(t.name)?.has("DELETE") && t.annotations?.destructiveHint !== true)
    .map((t) => `${t.name}: sends DELETE but destructiveHint is ${t.annotations?.destructiveHint}`);
}

/** The HTTP methods each tool sends when called with its usual arguments. */
async function methodsByTool(): Promise<{ tools: Tool[]; methods: Map<string, Set<string>> }> {
  const methods = new Map<string, Set<string>>();
  let current = "";
  const base = sampleApi();
  const api = {
    request: (method: string, path: string, o: RequestOptions = {}) => {
      if (current) methods.get(current)?.add(method);
      return base.request(method, path, o);
    },
  } as unknown as ApiClient;
  const c = await mcpClient(api);
  try {
    const tools = (await c.client.listTools()).tools;
    for (const t of tools) {
      current = t.name;
      methods.set(t.name, new Set());
      await c.call(t.name, TOOL_ARGS[t.name]);
    }
    return { tools, methods };
  } finally {
    await c.close();
  }
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
      "config_get",
    ]) {
      expect([read, hint(`akou_${read}`)?.readOnlyHint]).toEqual([read, true]);
    }
    for (const d of ["stop", "restart"])
      expect([d, hint(`akou_${d}`)?.destructiveHint]).toEqual([d, true]);
    for (const i of ["name_speaker", "memo_put"])
      expect([i, hint(`akou_${i}`)?.idempotentHint]).toEqual([i, true]);
  });

  test("every tool that deletes says it is destructive", async () => {
    const { tools, methods } = await methodsByTool();
    const deleting = [...methods].filter(([, m]) => m.has("DELETE")).map(([n]) => n);
    expect(deleting.sort()).toEqual(["akou_delete_note", "akou_forget", "akou_share_off"]);
    expect(deleteProblems(tools, methods)).toEqual([]);
    // Positive control: akou_forget as it was, a plain write.
    const forget = tools.find((t) => t.name === "akou_forget") as Tool;
    const harmless = { ...forget, annotations: { ...forget.annotations, destructiveHint: false } };
    expect(deleteProblems([harmless], methods)).toEqual([
      "akou_forget: sends DELETE but destructiveHint is false",
    ]);
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
