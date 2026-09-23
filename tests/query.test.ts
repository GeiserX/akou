import { describe, expect, test } from "bun:test";
import { formatWall } from "../src/core/log/clock.ts";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { Bm25, indexTerms, STOPWORDS, stopwordsFor } from "../src/main/query/bm25.ts";
import { ChunkIndex, chunkBoundaries } from "../src/main/query/chunks.ts";
import {
  type ClassifyContext,
  classify,
  localClockToEpoch,
  parseNaming,
} from "../src/main/query/classify.ts";
import { CallQuery, MCP_BUDGET, resolveCall, WHOLE_CALL_CAP } from "../src/main/query/context.ts";
import {
  MEMO_MAX_TOKENS,
  type MemoUpdater,
  memoDraft,
  memoStatus,
  refreshMemo,
} from "../src/main/query/memo.ts";
import {
  auditTimes,
  checkCitations,
  estimateTokens,
  formatAgo,
  formatCitation,
  renderLine,
  statusLine,
} from "../src/main/query/render.ts";
import { LogBuilder, T0, TZ } from "./helpers.ts";
import { synthCall } from "./synth.ts";

const S = 1000;
const MIN = 60 * S;

/** A call with `n` lines alternating between two call speakers and the mic, one every 6 s. */
function call(n: number, opts: { words?: number } = {}): LogBuilder {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  const spks = ["c1", "c2", "you"];
  for (let i = 1; i <= n; i++) {
    const spk = spks[i % 3] as string;
    const words = Array.from({ length: opts.words ?? 8 }, (_, k) => `w${(i * 7 + k) % 50}`);
    b.seg({
      id: `l${String(i).padStart(6, "0")}`,
      ch: spk === "you" ? "mic" : "call",
      spk,
      w0: T0 + i * 6 * S,
      text: words.join(" "),
    });
  }
  return b;
}

function ctx(extra: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    tz: TZ,
    start: T0,
    now: T0 + 60 * MIN,
    roster: [
      { spk: "c1", label: "Speaker 1" },
      { spk: "c2", label: "Ben", name: "Ben Ortiz" },
    ],
    stopwords: stopwordsFor(["en"]),
    ...extra,
  };
}

describe("classify (DESIGN 5.4 step 2)", () => {
  test("each class from its triggers", () => {
    const c = ctx();
    expect(classify("what is he saying right now?", c).intent).toBe("now");
    expect(classify("catch me up", c).intent).toBe("now");
    expect(classify("did I miss anything?", c).intent).toBe("now");
    expect(classify("what are the action items so far?", c).intent).toBe("summary");
    expect(classify("which decisions were made?", c).intent).toBe("summary");
    // "did we decide" asks for one thing: recall, per the design's table.
    expect(classify("what did we decide about the build box?", c).intent).toBe("recall");
    expect(classify("what was said in the first 10 minutes?", c).intent).toBe("time");
    expect(classify("anything around 15:40?", c).intent).toBe("time");
    expect(classify("Speaker 2 is Ben", c).intent).toBe("naming");
    expect(classify("and after that?", c).intent).toBe("follow-up");
    expect(classify("what did the vendor quote for the license?", c).intent).toBe("recall");
  });

  test("naming: both word orders, ids and a sentence that is not a name", () => {
    expect(parseNaming("Speaker 2 is Ben")).toEqual({ spk: "c2", name: "Ben" });
    expect(parseNaming("c3 = Ana Ruiz")).toEqual({ spk: "c3", name: "Ana Ruiz" });
    expect(parseNaming("Carla is speaker 4.")).toEqual({ spk: "c4", name: "Carla" });
    expect(parseNaming("speaker 2 is talking about the budget and the plan today?")).toBeNull();
    expect(parseNaming("what did speaker 2 say?")).toBeNull();
  });

  test("time windows resolve to wall-clock spans in the call's zone", () => {
    const c = ctx();
    const first = classify("what was said in the first 10 minutes?", c).window;
    expect(first).toMatchObject({ from: T0, to: T0 + 10 * MIN });
    const last = classify("summarize the last 5 minutes", c).window;
    expect(last).toMatchObject({ from: c.now - 5 * MIN, to: c.now });
    // T0 is 15:36:12 in America/Chicago.
    const around = classify("what happened around 15:40?", c).window;
    expect(around && formatWall(around.anchor as number, TZ)).toBe("15:40:00");
    // Five minutes either side, cut to the call: it started at 15:36:12.
    expect(around && [around.from, formatWall(around.to, TZ)]).toEqual([T0, "15:45:00"]);
    const since = classify("anything since 3:50 pm?", c).window;
    expect(since && formatWall(since.from, TZ)).toBe("15:50:00");
    expect(since?.to).toBe(c.now);
    const between = classify("between 15:40 and 15:55", c).window;
    expect(between && [formatWall(between.from, TZ), formatWall(between.to, TZ)]).toEqual([
      "15:40:00",
      "15:55:00",
    ]);
    // A bare small number is not a clock time.
    expect(classify("what were the 3 options?", c).window).toBeUndefined();
  });

  test("a local time on a call that crossed midnight lands on the right day", () => {
    const start = Date.UTC(2026, 8, 24, 4, 30); // 23:30 in Chicago
    const w = localClockToEpoch(0, 10, TZ, { from: start, to: start + 2 * 60 * MIN });
    expect(w - start).toBe(40 * MIN);
  });

  test("a speaker named in the question boosts and never filters", () => {
    const r = classify("what did Ben say about the deploy?", ctx());
    expect(r.speakers.map((s) => s.spk)).toEqual(["c2"]);
    expect(r.terms).toEqual(["say", "deploy"]);
    expect(classify("what did speaker 1 say?", ctx()).speakers.map((s) => s.spk)).toEqual(["c1"]);
  });
});

describe("BM25 (DESIGN 5.4)", () => {
  test("rarer terms score higher, removal forgets a document, stopwords are dropped", () => {
    const bm = new Bm25();
    bm.add(1, ["build", "box", "moved"]);
    bm.add(2, ["build", "server"]);
    bm.add(3, ["lunch", "plans"]);
    const hits = bm.search([
      { term: "build", weight: 1 },
      { term: "box", weight: 1 },
    ]);
    expect(hits.map((h) => h.doc)).toEqual([1, 2]);
    bm.remove(1);
    expect(bm.search([{ term: "box", weight: 1 }])).toEqual([]);
    expect(bm.size).toBe(2);
    expect(indexTerms("The build is on the new box", stopwordsFor(["en"]))).toEqual([
      "build",
      "new",
      "box",
    ]);
    // Stopword lists are folded like the tokens they are compared with.
    expect(STOPWORDS.es?.has("mas")).toBe(true);
    expect(STOPWORDS.fr?.has("etait")).toBe(true);
  });

  test("a boost multiplies a document's score", () => {
    const bm = new Bm25();
    bm.add(1, ["deploy", "today"]);
    bm.add(2, ["deploy", "today"]);
    const hits = bm.search([{ term: "deploy", weight: 1 }], { boost: (d) => (d === 2 ? 1.5 : 1) });
    expect(hits[0]?.doc).toBe(2);
    expect((hits[0]?.score ?? 0) / (hits[1]?.score ?? 1)).toBeCloseTo(1.5);
  });
});

describe("speaker-turn chunks (DESIGN 5.4)", () => {
  const L = (spk: string, words: number) => ({ words, line: { spk } });

  test("a turn closes at a speaker change once it has 60 words, splits past 200, overlaps one line", () => {
    const lines = [L("a", 30), L("a", 40), L("b", 10), L("b", 100), L("b", 100), L("a", 5)];
    expect(chunkBoundaries(lines, 0)).toEqual([
      [0, 2],
      [1, 4],
      [3, 5],
      [4, 6],
    ]);
    // The carried-over line does not count toward the 60 words, so no chunk is a lone repeat.
    expect(chunkBoundaries([L("b", 100), L("a", 5)], 0, true)).toEqual([[0, 2]]);
  });

  test("the index follows the view incrementally and matches a rebuild", () => {
    const syn = synthCall({ hours: 0.5, seed: 3, facts: 5, tailLines: 120 });
    const view = fold(syn.events);
    const idx = new ChunkIndex(view);
    idx.sync();
    const rebuilds = idx.stats.rebuilds;
    let edits = 0;
    for (const [i, e] of syn.tail.entries()) {
      view.apply(e);
      // Revise an earlier line now and then, and retract one.
      if (i % 25 === 5) {
        const target = idx.allLines()[Math.floor(idx.allLines().length / 2)]?.line;
        if (target) {
          view.apply({
            seq: view.lastSeq + 1,
            t: T0,
            type: "seg",
            id: target.id,
            rev: target.rev + 1,
            // Long enough to move chunk boundaries, not just the text.
            text: i % 50 === 5 ? null : `${target.raw} ${"extra ".repeat(120).trim()}`,
            by: "user",
          } as LogEvent);
          edits++;
        }
      }
      idx.sync();
    }
    expect(edits).toBeGreaterThan(2);
    expect(idx.stats.rebuilds).toBe(rebuilds);
    const fresh = new ChunkIndex(view);
    fresh.sync();
    const shape = (x: ChunkIndex) => x.allChunks().map((c) => [c.start, c.end, c.ids.join(",")]);
    expect(shape(idx)).toEqual(shape(fresh));
    const q = [{ term: syn.facts[0]?.codename as string, weight: 1 }];
    expect(idx.search(q).map((h) => h.chunk.ids)).toEqual(fresh.search(q).map((h) => h.chunk.ids));
  });

  test("a new line at the end re-indexes only the tail", () => {
    const b = call(400);
    const view = fold(b.events);
    const idx = new ChunkIndex(view);
    idx.sync();
    const before = idx.stats.chunksIndexed;
    view.apply(b.seg({ id: "l000401", spk: "c1", w0: T0 + 401 * 6 * S, text: "late words" }));
    idx.sync();
    expect(idx.stats.chunksIndexed - before).toBeLessThanOrEqual(3);
  });

  test("a vocabulary add re-indexes only the chunks holding the corrected lines", () => {
    const b = call(300);
    b.seg({ id: "l000900", spk: "c1", w0: T0 + 150 * 6 * S + 1, text: "we run it on kubernetis" });
    const view = fold(b.events);
    const idx = new ChunkIndex(view);
    idx.sync();
    const before = idx.stats.chunksIndexed;
    view.apply(
      b.add({
        type: "vocab.add",
        id: "v1",
        rev: 1,
        term: "Kubernetes",
        heard: ["kubernetis"],
        by: "user",
      }),
    );
    idx.sync();
    expect(idx.stats.chunksIndexed - before).toBeLessThanOrEqual(2);
    expect(idx.search([{ term: "kubernetes", weight: 1 }])).toHaveLength(1);
    expect(idx.search([{ term: "kubernetis", weight: 1 }])).toHaveLength(1);
  });
});

describe("rendering (DESIGN 4.4, 5.4)", () => {
  test("status lines", () => {
    const now = T0 + 60 * MIN;
    expect(statusLine({ state: "recording", now, tz: TZ })).toBe("LIVE, recording now");
    expect(statusLine({ state: "paused", pausedAt: T0 + 8 * MIN, now, tz: TZ })).toBe(
      "LIVE, paused since 15:44",
    );
    expect(statusLine({ state: "ended", endedAt: now - 38 * MIN, now, tz: TZ })).toBe(
      "ENDED at 15:58 (38 min ago)",
    );
    expect(statusLine({ state: "ended", endedAt: now - 38 * MIN, now, tz: TZ, stable: true })).toBe(
      "ENDED at 15:58",
    );
    expect(statusLine({ state: "interrupted", endedAt: T0 + 8 * MIN, now, tz: TZ })).toBe(
      "INTERRUPTED since 15:44",
    );
    expect(formatAgo(125 * MIN)).toBe("2 h 5 min ago");
  });

  test("a line carries its id, local time with seconds, speaker and the annotated text", () => {
    const b = call(1);
    b.add({ type: "vocab.add", id: "v1", rev: 1, term: "Kubernetes", heard: ["w7"], by: "user" });
    const line = fold(b.events).lines()[0];
    expect(line && renderLine(line, { tz: TZ })).toBe(
      '#l000001 15:36:18 Speaker 2: Kubernetes (heard: "w7") w8 w9 w10 w11 w12 w13 w14',
    );
    expect(line && renderLine(line, { tz: TZ, speakerIds: true })).toContain(" c2: ");
    expect(formatCitation(T0, "Ben", TZ)).toBe("[15:36 Ben]");
  });

  test("estimateTokens errs high on scripts without spaces", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("किताब")).toBe(5);
  });

  test("auditTimes passes wall times and labelled elapsed times, and catches an offset", () => {
    const span = { tz: TZ, from: T0, to: T0 + 30 * MIN };
    expect(auditTimes("15:41:07 Ben said so, 12:30 into the call [15:41 Ben]", span)).toEqual([]);
    expect(auditTimes("at 2:11 he said", span)).toEqual(["2:11"]);
  });

  test("citations resolve to committed lines only", () => {
    const b = call(3);
    const lines = fold(b.events).lines();
    const checks = checkCitations("See [15:36 Speaker 2] and [15:36 c1] and [15:37 Nobody].", {
      tz: TZ,
      lines,
    });
    expect(checks.map((c) => c.ok)).toEqual([true, true, false]);
  });
});

describe("memo slot (DESIGN 5.4, 5.5)", () => {
  test("stale after 1,500 tokens and 3 minutes of uncovered speech; a memo covering it is fresh", () => {
    const b = call(200, { words: 12 });
    const view = fold(b.events);
    const lines = view.lines();
    const now = T0 + 201 * 6 * S;
    const s = memoStatus(view, lines, now);
    expect(s.body).toBeNull();
    expect(s.stale).toBe(true);
    expect(s.uncovered.lines).toBe(200);
    view.apply(
      b.add(
        {
          type: "memo",
          rev: 1,
          body: "- topics",
          coversSeq: view.lastSeq,
          by: "agent:claude-code",
          model: "none",
        },
        now,
      ),
    );
    expect(memoStatus(view, view.lines(), now + MIN).stale).toBe(false);
  });

  test("memoDraft checks coverage, order and the cap", () => {
    const b = call(10);
    const view = fold(b.events);
    expect(memoDraft(view, { text: "x", coversSeq: 999, by: "user" }).ok).toBe(false);
    expect(memoDraft(view, { text: " ", coversSeq: 3, by: "user" }).ok).toBe(false);
    expect(
      memoDraft(view, { text: "a ".repeat(MEMO_MAX_TOKENS * 3), coversSeq: 3, by: "user" }).ok,
    ).toBe(false);
    const ok = memoDraft(view, { text: "- topics", coversSeq: 5, by: "agent:codex" });
    expect(ok.ok && ok.draft).toMatchObject({ type: "memo", rev: 1, coversSeq: 5 });
    view.apply(b.add({ type: "memo", rev: 1, body: "m", coversSeq: 8, by: "user", model: "none" }));
    expect(memoDraft(view, { text: "older", coversSeq: 5, by: "user" }).ok).toBe(false);
  });

  test("a pluggable updater runs only when the memo is stale and its output is checked", async () => {
    const b = call(200, { words: 12 });
    const view = fold(b.events);
    const calls: number[] = [];
    const updater: MemoUpdater = {
      id: "fake",
      async update(input) {
        calls.push(input.newLines.length);
        return { text: "- [15:40] a topic", model: "fake-1" };
      },
    };
    const render = (l: Parameters<typeof renderLine>[0]) => renderLine(l, { tz: TZ });
    const signal = new AbortController().signal;
    const r = await refreshMemo(view, view.lines(), T0 + 30 * MIN, updater, render, signal);
    expect(calls).toEqual([200]);
    expect(r?.ok && r.draft).toMatchObject({ type: "memo", by: "app", model: "fake-1" });
    const early = await refreshMemo(view, view.lines(), T0 + 10 * S, updater, render, signal);
    expect(early).toBeNull();
  });
});

describe("the pack (DESIGN 5.4 step 3)", () => {
  test("retrieval mode fits the MCP budget and orders its blocks", () => {
    const syn = synthCall({ hours: 2, seed: 9, facts: 10 });
    const q = new CallQuery(fold(syn.events));
    const fact = syn.facts[4];
    const pack = q.context(`what did we agree about ${fact?.codename}?`, { now: syn.end });
    expect(pack.mode).toBe("retrieval");
    expect(pack.tokens).toBeLessThanOrEqual(MCP_BUDGET);
    expect(pack.lines.map((l) => l.id)).toContain(fact?.id as string);
    const order = ["header", "analysis", "memo", "retrieved", "recency"];
    expect(pack.blocks.map((b) => b.name).filter((n) => order.includes(n))).toEqual(order);
    expect(pack.cursor).toBe(q.view.lastSeq);
    // Lines in the pack are in time order.
    const w = pack.lines.map((l) => l.w0);
    expect(w).toEqual([...w].sort((a, b) => a - b));
  });

  test("whole-call mode in the app for a short call, retrieval for MCP unless it asks for 12k", () => {
    const b = call(60);
    const q = new CallQuery(fold(b.events));
    const now = T0 + 7 * MIN;
    const app = q.context("what was w3 about?", { now, surface: "app" });
    expect(app.mode).toBe("whole");
    expect(app.tokens).toBeLessThanOrEqual(WHOLE_CALL_CAP);
    expect(app.lines).toHaveLength(60);
    expect(q.context("what was w3 about?", { now }).mode).toBe("retrieval");
    expect(q.context("what was w3 about?", { now, budget: 12_000 }).mode).toBe("whole");
  });

  test("whole-call mode keeps speaker ids in a stable prefix: naming a speaker changes only the tail", () => {
    const b = call(30);
    const view = fold(b.events);
    const q = new CallQuery(view);
    const now = T0 + 4 * MIN;
    const before = q.context("what happened?", { now, surface: "app" }).text;
    view.apply(b.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" }));
    const after = q.context("what happened?", { now, surface: "app" }).text;
    const prefix = (t: string) => t.slice(0, t.indexOf("\n\nNow:"));
    expect(prefix(after)).toBe(prefix(before));
    expect(after).toContain("c1 = Ben");
    expect(before).not.toContain("c1 = Ben");
  });

  test("the header carries remembered lines, earlier Q&A, health gaps and pauses from the log", () => {
    const b = call(30);
    b.add({
      type: "remember",
      id: "r1",
      rev: 1,
      text: "Ana owns the rollout",
      by: "agent:claude-code",
    });
    b.add({ type: "remember", id: "r2", rev: 1, text: "retracted soon", by: "agent:claude-code" });
    b.add({ type: "remember", id: "r2", rev: 2, text: null, by: "agent:claude-code" });
    b.add(
      { type: "ask", id: "a1", q: "who owns the rollout?", by: "agent:claude-code" },
      T0 + 2 * MIN,
    );
    b.add({
      type: "answer",
      ask: "a1",
      text: "Ana [15:37 Ana]",
      cites: ["l000003"],
      model: "m",
      pack: { mode: "recall", tokens: 900 },
    });
    b.add(
      {
        type: "health",
        part: 1,
        ch: "call",
        state: "dead",
        silentFor: 12,
        rebuilds: 1,
        detail: "",
      },
      T0 + 3 * MIN,
    );
    b.add(
      { type: "health", part: 1, ch: "call", state: "ok", silentFor: 0, rebuilds: 1, detail: "" },
      T0 + 4 * MIN,
    );
    b.add({ type: "pause", part: 1, a: 200, wall: T0 + 4 * MIN, mono: 1 });
    b.add({ type: "resume", part: 1, a: 200, wall: T0 + 5 * MIN, mono: 2 });
    const pack = new CallQuery(fold(b.events)).context("catch me up", { now: T0 + 6 * MIN });
    expect(pack.text).toContain("Notes from your earlier turns:\n- (r1) Ana owns the rollout");
    expect(pack.text).not.toContain("retracted soon");
    expect(pack.text).toContain("Q 15:38:12: who owns the rollout?\nA: Ana [15:37 Ana]");
    expect(pack.text).toContain("Health: call audio dead 15:39:00 to 15:40:12, nothing heard.");
    expect(pack.text).toContain("paused 15:40:12 to 15:41:12, nothing recorded");
  });

  test("a naming question is reported for the caller to write, with no model", () => {
    const q = new CallQuery(fold(call(5).events));
    const pack = q.context("Speaker 2 is Ben", { now: T0 + MIN });
    expect(pack.analysis.naming).toEqual({ spk: "c2", name: "Ben" });
  });

  test("read(since) returns only new and revised lines, plus the next cursor", () => {
    const b = call(20);
    const view = fold(b.events);
    const q = new CallQuery(view);
    const first = q.context("catch me up", { now: T0 + 3 * MIN });
    view.apply(b.seg({ id: "l000021", spk: "c1", w0: T0 + 21 * 6 * S, text: "new words" }));
    view.apply(b.add({ type: "seg", id: "l000003", rev: 2, text: "revised", by: "user" }));
    view.apply(b.add({ type: "seg", id: "l000004", rev: 2, text: null, by: "user" }));
    const r = q.read(first.cursor, T0 + 3 * MIN);
    expect(r.lines.map((l) => l.id)).toEqual(["l000003", "l000021"]);
    expect(r.retracted).toEqual(["l000004"]);
    expect(r.cursor).toBe(view.lastSeq);
    expect(q.read(r.cursor, T0 + 3 * MIN).lines).toEqual([]);
  });

  test("search returns hits with wall-time citations", () => {
    const b = call(50);
    b.seg({ id: "l000099", spk: "c2", w0: T0 + 51 * 6 * S, text: "the vendor quoted forty two" });
    const q = new CallQuery(fold(b.events));
    const hits = q.search("vendor quote");
    expect(hits[0]?.lines.map((l) => l.id)).toContain("l000099");
    expect(hits[0]?.citation).toMatch(/^\[\d\d:\d\d .+\]$/);
  });
});

describe("resolving the call (DESIGN 5.4 step 0, 6.2)", () => {
  const calls = [
    { id: "A", title: "Old", state: "ended" as const, startedAt: 1, endedAt: 5 },
    { id: "B", title: "Failed", state: "failed" as const, startedAt: 9 },
    { id: "C", title: "Newer", state: "ended" as const, startedAt: 6, endedAt: 8 },
  ];

  test("an id resolves; an unknown one is not found", () => {
    expect(resolveCall("A", calls)).toEqual({ ok: true, id: "A" });
    expect(resolveCall("Z", calls)).toMatchObject({ ok: false, status: 404 });
  });

  test("a live call is `live`; a failed start is never `live` or `last`", () => {
    const withLive = [
      ...calls,
      { id: "D", title: "Now", state: "recording" as const, startedAt: 10 },
    ];
    expect(resolveCall("live", withLive)).toEqual({ ok: true, id: "D" });
    expect(resolveCall("last", calls)).toEqual({ ok: true, id: "C" });
  });
});
