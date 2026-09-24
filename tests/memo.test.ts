/**
 * The rolling memo driven by the provider (docs/DESIGN.md section 5.4, ROADMAP M2): refreshed
 * after enough new speech, incrementally, through an OpenAI-compatible local model (a stand-in
 * server here, never a real one), stored only after every item's `[HH:MM]` anchor is checked
 * against the call and the memo is cut to its 1,000-token cap. With the harness it is opt-in.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { realClock } from "../src/main/capture/engine.ts";
import { SETTINGS } from "../src/main/config/schema.ts";
import { OpenAiCompatibleProvider } from "../src/main/llm/openai-compatible.ts";
import type { CompleteRequest, CompleteResult, Provider } from "../src/main/llm/provider.ts";
import {
  anchorMinutes,
  capMemo,
  checkMemoAnchors,
  MEMO_ANCHOR,
  MEMO_MAX_TOKENS,
  MEMO_SYSTEM,
  memoByProvider,
  ProviderMemoUpdater,
  refreshMemo,
} from "../src/main/query/memo.ts";
import { estimateTokens, renderLine } from "../src/main/query/render.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { LogBuilder, T0, TZ } from "./helpers.ts";
import { SYNTH_TZ, synthCall } from "./synth.ts";

process.env.NO_PROXY = "127.0.0.1,localhost";

const MIN = 60_000;

/**
 * A stand-in local model. It follows the memo format loosely, the way a small model does: it keeps
 * the old items and adds one per few new lines, anchored at a line's minute, and it also invents a
 * time, writes an item with no time, and every fourth call dumps far more than the cap.
 */
let server: ReturnType<typeof Bun.serve>;
let base: string;
let calls = 0;
let lastAnswer = "";
const systems: string[] = [];

function fakeMemo(prompt: string): string {
  calls++;
  const prev = /Memo so far:\n([\s\S]*?)\n\nNew lines:/.exec(prompt)?.[1] ?? "";
  const items = prev === "(none yet)" ? [] : prev.split("\n").filter((l) => l.startsWith("- "));
  const fresh = /New lines:\n([\s\S]*)$/.exec(prompt)?.[1]?.split("\n") ?? [];
  fresh.forEach((l, i) => {
    const m = /^#\S+ (\d\d:\d\d):\d\d ([^:]+): (\S+ \S+)/.exec(l);
    if (m && i % 6 === 0) items.push(`- ${m[3]} [${m[1]} ${m[2]}]`);
  });
  const anchor = /\[\d\d:\d\d [^\]]+\]/.exec(items.at(-1) ?? "")?.[0] ?? "[00:00]";
  if (calls % 4 === 0) {
    for (let i = 0; i < 200; i++) items.unshift(`- an old point said again, number ${i} ${anchor}`);
  }
  items.push("- a time the call never had [03:12]", "- an item with no time");
  return ["Topics:", ...items].join("\n");
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { messages: { role: string; content: string }[] };
      systems.push(body.messages[0]?.content ?? "");
      const text = fakeMemo(body.messages.at(-1)?.content ?? "");
      lastAnswer = text;
      const sse = [
        `data: ${JSON.stringify({ model: "local-8b", choices: [{ delta: { content: text } }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  base = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

describe("[decision] Unattended harness use", () => {
  test("the memo is off for the harness unless the user turns it on; on for API and local providers", () => {
    expect(SETTINGS["memo.provider"].default).toBe("auto");
    expect(memoByProvider("harness", "auto")).toBe(false);
    expect(memoByProvider("openai-compatible", "auto")).toBe(true);
    expect(memoByProvider("anthropic", "auto")).toBe(true);
    expect(memoByProvider("none", "on")).toBe(false);
    expect(memoByProvider("harness", "on")).toBe(true);
    expect(memoByProvider("openai-compatible", "off")).toBe(false);
  });
});

describe("the memo check", () => {
  test("an item whose anchor is not a minute of the call is dropped, and so is one with none (positive control)", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.seg({ id: "l000001", text: "we move the build", w0: T0 + 30_000 });
    const minutes = anchorMinutes(fold(b.events).lines("best"), TZ);
    expect([...minutes]).toEqual(["15:36"]);
    const r = checkMemoAnchors(
      ["Decisions:", "- move the build [15:36 Ben]", "- invented [15:52]", "- no time"].join("\n"),
      minutes,
    );
    expect(r.body).toBe("Decisions:\n- move the build [15:36 Ben]");
    expect(r.dropped.map((d) => d.reason)).toEqual([
      "[15:52] is not a minute of the call with a line in it",
      "no [HH:MM] anchor",
    ]);
  });

  test("the cap cuts on a line boundary and never leaves a heading alone at the end", () => {
    const long = [
      "Topics:",
      ...Array.from({ length: 400 }, (_, i) => `- item ${i} [15:36]`),
      "People:",
    ];
    const cut = capMemo(long.join("\n"));
    expect(estimateTokens(cut)).toBeLessThanOrEqual(MEMO_MAX_TOKENS);
    expect(cut.split("\n").at(-1)).toMatch(/^- item \d+ \[15:36\]$/);
    expect(capMemo("Topics:\n- one [15:36]")).toBe("Topics:\n- one [15:36]");
  });
});

describe("the rolling memo through an OpenAI-compatible local model", () => {
  test("over a 2-hour call it stays under 1,000 tokens with every anchor valid", async () => {
    const syn = synthCall({ hours: 2, seed: 11, facts: 0 });
    const provider = new OpenAiCompatibleProvider({ baseUrl: base, model: "local-8b" });
    const updater = new ProviderMemoUpdater(provider, 10_000);
    const render = (l: Parameters<typeof renderLine>[0]) => renderLine(l, { tz: SYNTH_TZ });
    const signal = new AbortController().signal;
    // The call replayed in order; a memo event goes into the log the moment it is written.
    let seq = 0;
    const first = { ...(syn.events[0] as LogEvent), seq: ++seq };
    const view = fold([first]);
    const memos: string[] = [];
    const raw: number[] = [];
    let tried = 0;
    let lastTry = 0;
    for (const e of [...syn.events.slice(1), ...syn.tail]) {
      view.apply({ ...e, seq: ++seq } as LogEvent);
      if (e.type !== "seg") continue;
      const now = e.w1 as number;
      if (now - lastTry < MIN) continue;
      lastTry = now;
      tried++;
      const r = await refreshMemo(view, view.lines("best"), now, updater, render, signal);
      if (!r) continue;
      expect(r.ok ? "" : r.error).toBe("");
      raw.push(estimateTokens(lastAnswer));
      if (!r.ok) continue;
      view.apply({ ...r.draft, seq: ++seq, t: now } as LogEvent);
      memos.push((r.draft as { body: string }).body);
    }
    expect(tried).toBeGreaterThan(100);
    // Refreshed only when stale: at most one per 3 minutes, and more than a handful in 2 hours.
    expect(memos.length).toBeGreaterThan(8);
    expect(memos.length).toBeLessThanOrEqual(40);
    expect(systems.every((s) => s === MEMO_SYSTEM)).toBe(true);
    // The stand-in wrote more than the cap at least once, so the cap was exercised.
    expect(Math.max(...raw)).toBeGreaterThan(MEMO_MAX_TOKENS);
    const minutes = anchorMinutes(
      view.lines("best", { includeEcho: true, includeRetracted: true }),
      SYNTH_TZ,
    );
    for (const body of memos) {
      expect(estimateTokens(body)).toBeLessThanOrEqual(MEMO_MAX_TOKENS);
      expect(body).not.toContain("[03:12]");
      expect(body).not.toContain("an item with no time");
      for (const line of body.split("\n").filter((l) => l.startsWith("- "))) {
        const anchors = [...line.matchAll(MEMO_ANCHOR)].map((m) => m[1] as string);
        expect(anchors.length).toBeGreaterThan(0);
        for (const a of anchors) expect(minutes.has(a)).toBe(true);
      }
    }
    // Incremental: each run was given the memo in force, not the whole call again.
    expect(view.memo?.rev).toBe(memos.length);
  }, 60_000);
});

/** A stand-in for the user's harness: it records every run and answers with an anchored memo. */
class FakeHarness implements Provider {
  readonly id = "harness" as const;
  readonly runs: CompleteRequest[] = [];
  async available() {
    return { ok: true as const, detail: "fake harness" };
  }
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.runs.push(req);
    const at = /(\d\d:\d\d):\d\d/.exec(req.prompt)?.[1] ?? "00:00";
    return { text: `## Topics\n- the build moves to the new box [${at}]`, model: "fake-harness/1" };
  }
}

describe("the rolling memo in the app, with the harness as provider", () => {
  const harness = new FakeHarness();
  let skew = 0;
  let rig: AppRig;
  let id: string;
  let n = 0;
  const say = (text: string) => {
    n++;
    const w0 = Date.now() + skew;
    return rig.app.write(id, {
      type: "seg",
      id: `l${String(900_000 + n)}`,
      rev: 1,
      layer: "live",
      part: 1,
      ch: "call",
      spk: "c2",
      a0: n,
      a1: n + 1,
      w0,
      w1: w0 + 900,
      text,
      model: "fake",
    } as never);
  };
  const memos = async () =>
    ((await rig.api("GET", `/calls/${id}/events`)).body.events as LogEvent[]).filter(
      (e) => e.type === "memo",
    );

  beforeAll(async () => {
    rig = await appRig({
      provider: harness,
      clock: { ...realClock, now: () => Date.now() + skew },
    });
    id = await rig.startCall({ title: "Build sync" });
  });

  afterAll(() => rig?.close());

  test("memo.provider auto never runs the harness on its own; `on` does", async () => {
    expect(rig.app.config().settings["memo.provider"]).toBe("auto");
    // Four minutes and about 2,000 tokens of new speech: a memo is due by every other rule.
    skew = 4 * MIN;
    const long = "we move the build to the new box and check the numbers after ".repeat(32);
    for (let i = 0; i < 4; i++) await say(long);
    await Bun.sleep(400);
    expect(harness.runs).toHaveLength(0);
    expect(await memos()).toHaveLength(0);

    // Positive control: the same call once the user turns the memo on for the harness.
    const set = await rig.api("PATCH", "/config", { "memo.provider": "on" });
    expect(set.status).toBe(200);
    await say(long);
    await until(async () => (await memos()).length > 0, 5000, "a memo");
    expect(harness.runs.length).toBeGreaterThan(0);
    const [memo] = (await memos()) as (LogEvent & { body: string; by: string })[];
    expect(memo?.body).toMatch(MEMO_ANCHOR);
    expect(memo?.by).toBe("app");
  }, 20_000);
});
