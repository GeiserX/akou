/**
 * PG-M5 (docs/ux/PROGRAMMABILITY.md section 5): no MCP answer exceeds 8,000 tokens, counted with
 * the estimator the pack uses. Claude Code warns at 10,000; 8,000 leaves headroom. A long call is
 * read page by page: `akou_get_call` answers with a `nextCursor`, and following it to the end
 * yields every line once.
 *
 * Both halves of an answer count on their own, because a harness may show the model either one:
 * the text, and the structured result serialized as JSON.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { ApiClient } from "../src/main/cli/client.ts";
import { capAnswer, MAX_ANSWER_TOKENS } from "../src/main/mcp/bound.ts";
import { TOOLS } from "../src/main/mcp/server.ts";
import {
  CALL_TEXT_CLOSE,
  CALL_TEXT_OPEN,
  estimateTokens,
  quoteCallText,
} from "../src/main/query/render.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { jsonl, tempDir } from "./helpers.ts";
import { mcpClient, sampleApi, TOOL_ARGS, type ToolAnswer } from "./mcp-helpers.ts";
import { synthCall } from "./synth.ts";

const LONG = 60_000;

/** The size of an answer as the pack's estimator counts it: the text, and the structured JSON. */
function size(a: ToolAnswer): { text: number; structured: number } {
  return {
    text: estimateTokens(a.text),
    structured: a.structured === undefined ? 0 : estimateTokens(JSON.stringify(a.structured)),
  };
}

/** Answers over the ceiling, by name; empty when every answer fits. */
function overCeiling(answers: Record<string, ToolAnswer>): string[] {
  return Object.entries(answers).flatMap(([name, a]) => {
    const s = size(a);
    return s.text > MAX_ANSWER_TOKENS || s.structured > MAX_ANSWER_TOKENS
      ? [`${name}: text ${s.text}, structured ${s.structured}`]
      : [];
  });
}

/** The segment ids of the lines inside an answer's call-text block (`#l000031 15:41:07 Ben: …`). */
function idsIn(text: string): string[] {
  const lines = text.split("\n");
  const block = lines.slice(lines.indexOf(CALL_TEXT_OPEN) + 1, lines.indexOf(CALL_TEXT_CLOSE));
  return block.flatMap((l) => /^#(\S+) \d\d:\d\d:\d\d /.exec(l)?.[1] ?? []);
}

describe("[PG-M5] a three-hour call through the MCP tools", () => {
  const CALL_ID = "01J8Z6Q4M2VX0K7B3D4E5F6G7H";
  let rig: AppRig;
  let home: { dir: string; cleanup: () => void };
  let api: ApiClient;

  beforeAll(async () => {
    // A generated three-hour call, ended, in the recordings folder before the app starts.
    const syn = synthCall({ hours: 3, seed: 42, facts: 20 });
    const events: LogEvent[] = [...syn.events];
    const add = (d: Record<string, unknown>) =>
      events.push({ seq: events.length + 1, t: syn.end + events.length, ...d } as LogEvent);
    const last = [...events].reverse().find((e) => e.type === "part.started") as { part: number };
    add({ type: "part.ended", part: last.part, reason: "stop", fileSeconds: 3600 });
    add({ type: "call.ended", reason: "stop" });
    home = tempDir("akou-app-");
    const dir = join(home.dir, "Recordings", "akou", "work", "2026-09-23_153612_long");
    mkdirSync(join(dir, "audio"), { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), jsonl(events));
    rig = await appRig({ home: home.dir });
    api = new ApiClient({ env: { ...process.env, ...rig.env }, client: "mcp", launch: null });
  });

  afterAll(async () => {
    await rig?.close();
    home?.cleanup();
  });

  test(
    "akou_get_call answers under 8,000 tokens with a nextCursor, and following it yields every line once",
    async () => {
      const all = await rig.api("GET", `/calls/${CALL_ID}/transcript?layer=best`);
      expect(all.status).toBe(200);
      const every: string[] = all.body.lines.map((l: { id: string }) => l.id);
      expect(every.length).toBeGreaterThan(1200);
      const c = await mcpClient(api);
      try {
        const seen: string[] = [];
        const pages: Record<string, ToolAnswer> = {};
        let cursor: string | undefined;
        for (let page = 1; page <= 100; page++) {
          const r = await c.call("akou_get_call", {
            call: CALL_ID,
            ...(cursor !== undefined ? { cursor } : {}),
          });
          expect(r.isError).toBe(false);
          pages[`page ${page}`] = r;
          seen.push(...idsIn(r.text));
          const next = r.structured.nextCursor;
          if (page === 1) expect(typeof next).toBe("string");
          if (next === null) break;
          // The text names the same cursor for a harness that shows only the text.
          expect(r.text).toContain(`nextCursor: ${next}`);
          cursor = next;
        }
        expect(Object.keys(pages).length).toBeGreaterThan(2);
        expect(overCeiling(pages)).toEqual([]);
        expect(seen).toEqual(every);
      } finally {
        await c.close();
      }
    },
    LONG,
  );

  test(
    "akou_read from the start keeps the newest lines under the ceiling and says how many it left out",
    async () => {
      const c = await mcpClient(api);
      try {
        const r = await c.call("akou_read", { call: CALL_ID, since: 0 });
        expect(overCeiling({ akou_read: r })).toEqual([]);
        expect(r.structured.omitted).toBeGreaterThan(1000);
        expect(r.text).toContain(`${r.structured.omitted} earlier lines left out`);
        // The newest line is there, and the cursor still covers the whole log.
        const all = await rig.api("GET", `/calls/${CALL_ID}/transcript?layer=best`);
        const newest = all.body.lines.at(-1);
        expect(r.text).toContain(`${newest.speaker}] ${newest.annotated ?? newest.text}`);
        expect(r.structured.cursor).toBe(all.body.cursor);
      } finally {
        await c.close();
      }
    },
    LONG,
  );

  test(
    "akou_read following from a cursor after a long gap loses no line: oldest first, a cursor per page",
    async () => {
      const since = 5;
      const all = await rig.api("GET", `/calls/${CALL_ID}/transcript?layer=best&since=${since}`);
      // akou_read shows lines as `[15:41:07 Ben] text`, without ids.
      const every: string[] = all.body.lines.map(
        (l: { time: string; speaker: string; text: string; annotated?: string }) =>
          `[${l.time} ${l.speaker}] ${l.annotated ?? l.text}`,
      );
      expect(every.length).toBeGreaterThan(1200);
      const c = await mcpClient(api);
      try {
        const seen: string[] = [];
        const pages: Record<string, ToolAnswer> = {};
        let cursor = since;
        for (let page = 1; page <= 100; page++) {
          const r = await c.call("akou_read", { call: CALL_ID, since: cursor });
          expect(r.isError).toBe(false);
          pages[`page ${page}`] = r;
          const text = r.text.split("\n");
          seen.push(...text.slice(text.indexOf(CALL_TEXT_OPEN) + 1, text.indexOf(CALL_TEXT_CLOSE)));
          expect(r.structured.cursor).toBeGreaterThan(cursor);
          cursor = r.structured.cursor;
          if (r.structured.more === 0) break;
          expect(r.text).toContain(`since: ${cursor}`);
        }
        expect(Object.keys(pages).length).toBeGreaterThan(2);
        expect(overCeiling(pages)).toEqual([]);
        expect(seen.length).toBe(every.length);
        expect([...seen].sort()).toEqual([...every].sort());
        expect(cursor).toBe(all.body.cursor);
      } finally {
        await c.close();
      }
    },
    LONG,
  );

  test(
    "the other tools that read a finished call stay under the ceiling on it",
    async () => {
      const c = await mcpClient(api);
      try {
        const answers: Record<string, ToolAnswer> = {
          akou_search: await c.call("akou_search", { call: CALL_ID, query: "budget", k: 50 }),
          akou_list_calls: await c.call("akou_list_calls", { limit: 1000 }),
          akou_vocab_list: await c.call("akou_vocab_list", { call: CALL_ID }),
          akou_vocab_suggest: await c.call("akou_vocab_suggest", { call: CALL_ID, k: 200 }),
          akou_enhance_context: await c.call("akou_enhance_context", {}),
        };
        for (const [n, a] of Object.entries(answers)) expect([n, a.isError]).toEqual([n, false]);
        expect(overCeiling(answers)).toEqual([]);
      } finally {
        await c.close();
      }
    },
    LONG,
  );

  test(
    "akou_context at its largest budget, and a bad cursor, stay inside the ceiling",
    async () => {
      const c = await mcpClient(api);
      try {
        const schema = (await c.client.listTools()).tools.find((t) => t.name === "akou_context")
          ?.inputSchema.properties?.budget as { maximum: number };
        const big = await c.call("akou_context", {
          call: CALL_ID,
          question: "summarize the whole call",
          budget: schema.maximum,
        });
        expect(big.isError).toBe(false);
        expect(overCeiling({ akou_context: big })).toEqual([]);
        const bad = await c.call("akou_get_call", { call: CALL_ID, cursor: "not-a-cursor" });
        expect(bad.isError).toBe(true);
        expect(bad.text).toStartWith("bad_cursor");
      } finally {
        await c.close();
      }
    },
    LONG,
  );
});

describe("[PG-M5] every tool stays under the ceiling", () => {
  test("against an app with 2,000 of everything, no tool answers over 8,000 tokens", async () => {
    const c = await mcpClient(sampleApi(2000));
    try {
      const answers: Record<string, ToolAnswer> = {};
      for (const name of Object.keys(TOOL_ARGS)) {
        answers[name] = await c.call(name, { ...TOOL_ARGS[name] });
      }
      expect(overCeiling(answers)).toEqual([]);
      // The line tools page or trim; they do not fail.
      for (const name of ["akou_get_call", "akou_read", "akou_list_calls", "akou_search"]) {
        expect([name, answers[name]?.isError]).toEqual([name, false]);
      }
      expect(answers.akou_list_calls?.text).toMatch(/\d+ more calls not shown/);
    } finally {
      await c.close();
    }
  });

  test("at a realistic size (300 notes, words and lines) every read tool answers, none refuses", async () => {
    const c = await mcpClient(sampleApi(300));
    try {
      const read = Object.keys(TOOL_ARGS).filter((n) => TOOLS[n]?.hints.readOnlyHint);
      expect(read).toContain("akou_get_notes");
      expect(read).toContain("akou_enhance_context");
      const answers: Record<string, ToolAnswer> = {};
      for (const name of read) answers[name] = await c.call(name, { ...TOOL_ARGS[name] });
      expect(overCeiling(answers)).toEqual([]);
      const refused = read.filter((n) => answers[n]?.isError);
      expect(refused).toEqual([]);
    } finally {
      await c.close();
    }
  });

  test("akou_enhance_context cuts a long input on a line and says how to read the rest", async () => {
    const c = await mcpClient(sampleApi(2000));
    try {
      const r = await c.call("akou_enhance_context", {});
      expect(r.isError).toBe(false);
      expect(size(r).text).toBeLessThanOrEqual(MAX_ANSWER_TOKENS);
      expect(r.text).toContain("[15:36:20 Ben]");
      expect(r.text).toContain("page by page with akou_get_call");
    } finally {
      await c.close();
    }
  });

  test("akou_get_notes pages a long notepad: following nextOffset reads every note once", async () => {
    const c = await mcpClient(sampleApi(300));
    try {
      const seen: string[] = [];
      let offset: number | undefined = 0;
      let pages = 0;
      while (offset !== undefined) {
        const r = await c.call("akou_get_notes", { offset });
        expect(r.isError).toBe(false);
        expect(size(r).text).toBeLessThanOrEqual(MAX_ANSWER_TOKENS);
        expect(r.structured.notes).toBe(300);
        seen.push(...[...r.text.matchAll(/"id":"(n\d+)"/g)].map((m) => m[1] as string));
        offset = r.structured.nextOffset;
        pages++;
      }
      expect(pages).toBeGreaterThan(1);
      expect(seen).toEqual(Array.from({ length: 300 }, (_, i) => `n${i}`));
    } finally {
      await c.close();
    }
  });

  test("positive control: the same app with 20 of everything is not cut, and the check flags a big answer", async () => {
    const c = await mcpClient(sampleApi(20));
    try {
      const r = await c.call("akou_get_notes", {});
      expect(r.text).not.toContain("cut here");
      expect(r.structured.notes).toBe(20);
      const huge = { ...r, text: "x ".repeat(50_000) };
      expect(overCeiling({ huge })).toEqual([`huge: text 25000, structured ${size(r).structured}`]);
    } finally {
      await c.close();
    }
  });
});

describe("capAnswer, the last guard every tool answer passes", () => {
  const block = (n: number) =>
    quoteCallText(Array.from({ length: n }, (_, i) => `line ${i} of what was said`).join("\n"));

  test("an answer under the ceiling passes unchanged", () => {
    const r = {
      content: [{ type: "text" as const, text: block(10) }],
      structuredContent: { callText: block(10) },
    };
    expect(capAnswer(r)).toBe(r);
  });

  test("a long quoted answer is cut on a line, the block closed, and the cut said outside it", () => {
    const t = `Header line\n${block(5000)}\nfooter: 1`;
    const out = capAnswer({
      content: [{ type: "text", text: t }],
      structuredContent: { call: "c1", callText: block(5000) },
    });
    const text = out.content[0]?.text as string;
    expect(estimateTokens(text)).toBeLessThanOrEqual(MAX_ANSWER_TOKENS);
    const lines = text.split("\n");
    expect(lines.filter((l) => l === CALL_TEXT_OPEN)).toHaveLength(1);
    expect(lines.filter((l) => l === CALL_TEXT_CLOSE)).toHaveLength(1);
    const note = lines.at(-1) as string;
    expect(note).toMatch(/^\[cut here: .*8,000-token ceiling; \d+ lines left out/);
    expect(lines.indexOf(CALL_TEXT_CLOSE)).toBe(lines.length - 2);
    expect(lines[0]).toBe("Header line");
    const sc = out.structuredContent as { call: string; callText: string };
    expect(sc.call).toBe("c1");
    expect(estimateTokens(JSON.stringify(sc))).toBeLessThanOrEqual(MAX_ANSWER_TOKENS);
    expect(sc.callText.split("\n").filter((l) => l === CALL_TEXT_CLOSE)).toHaveLength(1);
    expect(out.isError).toBeUndefined();
  });

  test("an answer that cannot be cut on a line becomes an error that says what to narrow", () => {
    const out = capAnswer({
      content: [{ type: "text", text: JSON.stringify({ entries: "y".repeat(100_000) }) }],
      structuredContent: { entries: ["y".repeat(100_000)] },
    });
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toBeUndefined();
    expect(out.content[0]?.text).toMatch(/^answer_too_large: /);
  });
});
