/**
 * Every TRAPS.md invariant on the query path, named by trap id, each with a positive control that
 * proves the check can fail.
 */

import { describe, expect, test } from "bun:test";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import { formatWall, isBareOffset } from "../src/core/log/clock.ts";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import {
  CallQuery,
  type ContextPack,
  MCP_BUDGET,
  MIN_BUDGET,
  resolveCall,
} from "../src/main/query/context.ts";
import {
  auditTimes,
  checkCitations,
  DRAFT_MARK,
  estimateTokens,
  renderLine,
} from "../src/main/query/render.ts";
import { LogBuilder, T0, TZ } from "./helpers.ts";
import { synthCall } from "./synth.ts";

const S = 1000;
const MIN = 60 * S;

/** Two parts: lines every 6 s, a restart after `firstPart` lines. */
function twoPartCall(lines = 40, firstPart = 20): LogBuilder {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  for (let i = 1; i <= lines; i++) {
    if (i === firstPart + 1) {
      b.partEnded(1, "restart", firstPart * 6);
      b.partStarted(2, T0 + i * 6 * S - 500);
    }
    const spk = i % 2 === 0 ? "c1" : "c2";
    b.seg({
      id: `l${String(i).padStart(6, "0")}`,
      part: i > firstPart ? 2 : 1,
      spk,
      // a0 restarts at 0 in part 2; w0 keeps going.
      a0: ((i > firstPart ? i - firstPart : i) * 6) % 3600,
      a1: ((i > firstPart ? i - firstPart : i) * 6 + 1) % 3600,
      w0: T0 + i * 6 * S,
      text: `line ${i} about topic${i}`,
    });
  }
  return b;
}

/** Every rendered row and every time in a pack passes the wall-clock rules. */
function clockViolations(pack: ContextPack, span: { from: number; to: number }): string[] {
  const bad = pack.text.split("\n").filter((row) => isBareOffset(row));
  return [...bad, ...auditTimes(pack.text, { tz: TZ, ...span })];
}

describe("[T3.9] Offsets shown as times of day", () => {
  test("every pack shows local wall-clock times and never a bare offset", () => {
    const b = twoPartCall();
    const q = new CallQuery(fold(b.events));
    const now = T0 + 5 * MIN;
    const span = { from: T0, to: now };
    for (const question of [
      "catch me up",
      "what about topic3?",
      "first 2 minutes",
      "around 15:37?",
      "action items so far",
    ]) {
      for (const surface of ["mcp", "app"] as const) {
        const pack = q.context(question, { now, surface });
        expect(clockViolations(pack, span)).toEqual([]);
        // The audio offsets of this call (0:06, 0:12, ...) never appear.
        for (const l of pack.lines)
          expect(pack.text).not.toContain(
            ` ${Math.floor(l.a0 / 60)}:${String(Math.floor(l.a0 % 60)).padStart(2, "0")} `,
          );
      }
    }
  });

  test("positive control: a line rendered with its audio offset is caught", () => {
    const b = twoPartCall();
    const q = new CallQuery(fold(b.events));
    const now = T0 + 5 * MIN;
    const pack = q.context("catch me up", { now });
    const line = pack.lines[0];
    if (!line) throw new Error("no line");
    const offset = `${Math.floor(line.a0 / 60)}:${String(Math.floor(line.a0 % 60)).padStart(2, "0")}`;
    const broken = {
      ...pack,
      text: pack.text.replace(
        renderLine(line, { tz: TZ }),
        `${offset} ${line.speaker}: ${line.text}`,
      ),
    };
    expect(clockViolations(broken, { from: T0, to: now })).toContain(offset);
    expect(isBareOffset(offset)).toBe(true);
  });
});

describe("[T3.14] `current` points at a finished call", () => {
  const b = twoPartCall();
  b.partEnded(2, "stop", 120);
  b.add({ type: "call.ended", reason: "stop" });
  const ended = new CallQuery(fold(b.events));
  const endedAt = ended.endedAt() as number;

  test("with no live call, `live` answers 404 no_live_call with the last call", () => {
    const calls = [
      { id: "A", title: "Weekly sync", state: ended.view.state, startedAt: T0, endedAt },
    ];
    expect(resolveCall("live", calls)).toEqual({
      ok: false,
      status: 404,
      error: "no_live_call",
      last: { id: "A", title: "Weekly sync", endedAt },
    });
    // `last` is fine for reading and refused on a live control.
    expect(resolveCall("last", calls)).toEqual({ ok: true, id: "A" });
    expect(resolveCall("last", calls, { control: true })).toMatchObject({ ok: false, status: 400 });
  });

  test("a pack for an ended call starts with ENDED at HH:MM and never says LIVE", () => {
    const pack = ended.context("what was decided?", { now: endedAt + 38 * MIN });
    expect(pack.state).toBe("ENDED");
    expect(pack.text.split("\n")[0]).toBe("ENDED at 15:40 (38 min ago)");
    expect(pack.text).not.toContain("LIVE");
    expect(pack.text).toContain("ended 38 min ago");
    // "Recent" means the end of the call, not the minutes since: the last lines are there.
    expect(pack.lines.map((l) => l.id)).toContain("l000040");
  });

  test("an ended call's recent lines are its last minutes, even with a memo covering it all", () => {
    const m = twoPartCall();
    m.add({
      type: "memo",
      rev: 1,
      body: "- all of it",
      coversSeq: m.events.length,
      by: "user",
      model: "none",
    });
    m.partEnded(2, "stop", 120);
    m.add({ type: "call.ended", reason: "stop" });
    const q = new CallQuery(fold(m.events));
    const pack = q.context("catch me up", { now: (q.endedAt() as number) + 38 * MIN });
    expect(pack.lines.map((l) => l.id)).toContain("l000040");
  });

  test("positive control: the same log without its ending is LIVE", () => {
    const live = twoPartCall();
    const pack = new CallQuery(fold(live.events)).context("what was decided?", {
      now: T0 + 5 * MIN,
    });
    expect(pack.text.split("\n")[0]).toBe("LIVE, recording now");
    const calls = [{ id: "A", title: "x", state: "recording" as const, startedAt: T0 }];
    expect(resolveCall("live", calls)).toEqual({ ok: true, id: "A" });
  });

  test("an interrupted call reads INTERRUPTED since HH:MM", () => {
    const i = twoPartCall();
    i.partEnded(2, "crashed", 120);
    i.add({ type: "call.ended", reason: "interrupted" });
    const pack = new CallQuery(fold(i.events)).context("hello?", { now: T0 + 30 * MIN });
    expect(pack.text.split("\n")[0]).toMatch(/^INTERRUPTED since \d\d:\d\d$/);
  });
});

describe("[T3.10] Names lost after the agent's context is compacted", () => {
  test("a name written mid-call is in a fresh client's roster and on its lines", () => {
    const b = twoPartCall();
    b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "agent:claude-code" });
    // A fresh engine over the log stands for a new agent session: nothing carried in memory.
    const pack = new CallQuery(fold(b.events)).context("what did Ben say about topic3?", {
      now: T0 + 5 * MIN,
    });
    expect(pack.text).toContain("c2 = Ben");
    expect(pack.lines.find((l) => l.id === "l000003")?.speaker).toBe("Ben");
    expect(pack.analysis.speakers.map((s) => s.spk)).toEqual(["c2"]);
  });

  test("[T3.43] the call channel is never labelled as one person: clusters keep their own labels", () => {
    const b = twoPartCall();
    b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    const pack = new CallQuery(fold(b.events)).context("catch me up", { now: T0 + 5 * MIN });
    expect(pack.text).toContain("c1 = Speaker 1, c2 = Ben");
  });

  test("positive control: without the event the name is absent", () => {
    const pack = new CallQuery(fold(twoPartCall().events)).context("catch me up", {
      now: T0 + 5 * MIN,
    });
    expect(pack.text).not.toContain("Ben");
  });
});

describe("[T3.12] Whole transcript re-read per question", () => {
  const syn = synthCall({ hours: 3, seed: 11, facts: 12 });

  test("an MCP pack stays within the budget and flat as the call grows", () => {
    const sizes: number[] = [];
    for (const hours of [1, 2, 3]) {
      const cut = syn.start + hours * 3600 * S;
      const events = syn.events.filter((e) => e.type !== "seg" || (e.w0 as number) < cut);
      const q = new CallQuery(fold(events));
      const pack = q.context("what did we agree about the budget?", { now: cut });
      expect(pack.mode).toBe("retrieval");
      expect(pack.tokens).toBeLessThanOrEqual(MCP_BUDGET);
      sizes.push(pack.tokens);
    }
    // Flat: the 3-hour pack is no more than 10 % larger than the 1-hour one.
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.1);
    // A smaller budget is honoured too.
    const small = new CallQuery(fold(syn.events)).context("catch me up", {
      now: syn.end,
      budget: 3000,
    });
    expect(small.tokens).toBeLessThanOrEqual(3000);
  });

  test("a small budget is honoured even when the memo, earlier Q&A and notes alone would fill it", () => {
    const b = twoPartCall(200, 100);
    const memo = Array.from(
      { length: 40 },
      (_, i) =>
        `- [15:${String(37 + (i % 20)).padStart(2, "0")}] decision ${i} about the rollout plan`,
    ).join("\n");
    b.add({ type: "memo", rev: 1, body: memo, coversSeq: 60, by: "user", model: "none" });
    for (let i = 1; i <= 3; i++) {
      b.add({ type: "ask", id: `a${i}`, q: `question ${i} about the plan?`, by: "user" });
      b.add({
        type: "answer",
        ask: `a${i}`,
        text: "a long answer ".repeat(60),
        cites: [],
        model: "m",
        pack: { mode: "recall", tokens: 900 },
      });
    }
    b.add({ type: "remember", id: "r1", rev: 1, text: "the customer is Acme", by: "user" });
    const q = new CallQuery(fold(b.events));
    const now = T0 + 21 * MIN;
    for (const budget of [MIN_BUDGET, 1000, 1500, 2000, 3000]) {
      const pack = q.context("what about topic150?", { now, budget });
      expect(pack.budget).toBe(budget);
      expect(pack.tokens).toBeLessThanOrEqual(budget);
      expect(pack.text.split("\n")[0]).toBe("LIVE, recording now");
      expect(pack.text).toContain("Rules:");
      // Transcript lines are not starved to zero by the fixed blocks.
      if (budget >= 1000) expect(pack.lines.length).toBeGreaterThan(0);
    }
    // A budget below the floor is raised to it, and the pack says so in `budget`.
    const tiny = q.context("what about topic150?", { now, budget: 100 });
    expect(tiny.budget).toBe(MIN_BUDGET);
    expect(tiny.tokens).toBeLessThanOrEqual(MIN_BUDGET);
  });

  /** A 3-hour call of plain English lines, every 6 s: the realistic case for the estimate. */
  const ENGLISH = [
    "we should move the build to the new box next week",
    "okay so the budget for the launch is 450 dollars",
    "I think Ben owns the migration and Carla reviews it",
    "can you send me the ticket after the meeting",
    "the customer wants the contract signed by Friday",
    "right, let's ship the fix and test it tomorrow",
    "what did the vendor quote for the license again",
    "yeah the deadline moved to the twenty third",
  ];
  function englishCall(): LogBuilder {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    for (let i = 1; i <= 1800; i++) {
      b.seg({
        id: `l${String(i).padStart(6, "0")}`,
        spk: `c${1 + (i % 3)}`,
        w0: T0 + i * 6 * S,
        text: ENGLISH[i % ENGLISH.length] as string,
      });
    }
    return b;
  }

  test("at the smallest budget a long header squeezes the memo out instead of breaking the budget", () => {
    const b = twoPartCall(40, 20);
    // Many pauses make a long "Recording:" line in the header, which every pack carries.
    for (let i = 0; i < 12; i++) {
      b.add({ type: "pause", part: 2, a: 200 + i, wall: T0 + (5 + i) * MIN, mono: 1 });
      b.add({ type: "resume", part: 2, a: 200 + i, wall: T0 + (5 + i) * MIN + 20 * S, mono: 2 });
    }
    b.add({
      type: "memo",
      rev: 1,
      body: "- [15:37] the plan",
      coversSeq: 30,
      by: "user",
      model: "none",
    });
    const pack = new CallQuery(fold(b.events)).context("catch me up", {
      now: T0 + 20 * MIN,
      budget: MIN_BUDGET,
    });
    expect(pack.tokens).toBeLessThanOrEqual(MIN_BUDGET);
    expect(pack.text).toContain("paused");
    expect(pack.blocks.find((x) => x.name === "memo")?.tokens ?? 0).toBeLessThan(20);
  });

  test("the budget holds under an independent tokenizer, not only under our estimate", () => {
    // cl100k is not the tokenizer of every model a pack goes to, but it is a real BPE count that
    // `estimateTokens` shares no code with.
    const english = new CallQuery(fold(englishCall().events));
    const now = T0 + 1801 * 6 * S;
    for (const question of ["what did the vendor quote?", "catch me up", "action items so far"]) {
      const pack = english.context(question, { now });
      expect(pack.tokens).toBeGreaterThan(MCP_BUDGET * 0.9);
      // On English the estimate errs high, so the real count is inside the budget with room.
      expect(estimateTokens(pack.text)).toBeGreaterThanOrEqual(encode(pack.text).length);
      expect(encode(pack.text).length).toBeLessThanOrEqual(MCP_BUDGET);
    }
    // Made-up words are the worst case for a character estimate; the pack still fits.
    const q = new CallQuery(fold(syn.events));
    for (const question of ["what did we agree about the budget?", "catch me up"]) {
      expect(encode(q.context(question, { now: syn.end }).text).length).toBeLessThanOrEqual(
        MCP_BUDGET,
      );
    }
  });

  test("positive control: a four-characters-per-token estimate under-counts the same lines", () => {
    const quarter = (s: string) => Math.ceil(s.length / 4);
    const lines = fold(englishCall().events)
      .lines()
      .slice(0, 300)
      .map((l) => renderLine(l, { tz: TZ }))
      .join("\n");
    expect(quarter(lines)).toBeLessThan(encode(lines).length);
    expect(estimateTokens(lines)).toBeGreaterThanOrEqual(encode(lines).length);
  });

  test("positive control: the whole transcript is far over the budget, so the check would catch a re-read", () => {
    const view = fold(syn.events);
    const whole = view
      .lines()
      .map((l) => renderLine(l, { tz: TZ }))
      .join("\n");
    expect(estimateTokens(whole)).toBeGreaterThan(MCP_BUDGET * 5);
  });
});

describe("[T3.2] Restart splits one call into several folders: a restarted call is read across all parts", () => {
  test("the pack covers every part on one clock and names the restarts", () => {
    const b = twoPartCall(60, 20);
    const q = new CallQuery(fold(b.events));
    const pack = q.context("what about topic4?", { now: T0 + 7 * MIN });
    expect(pack.text).toContain("2 parts, restarted at");
    // topic4 was said in part 1; the recency window is in part 2.
    const parts = new Set(pack.lines.map((l) => l.part));
    expect(parts).toEqual(new Set([1, 2]));
    expect(pack.lines.map((l) => l.id)).toContain("l000004");
    expect(q.search("topic4")[0]?.lines.map((l) => l.id)).toContain("l000004");
  });

  test("positive control: a reader of the last part only cannot find it", () => {
    const b = twoPartCall(60, 20);
    const partTwoOnly = b.events.filter((e) => e.type !== "seg" || e.part === 2);
    const q = new CallQuery(fold(partTwoOnly));
    expect(q.search("topic4")).toEqual([]);
  });
});

describe("[T3.11] Answers from uncorrected recognition: vocabulary applied when the pack is read", () => {
  function withVocab(add: boolean): LogBuilder {
    const b = twoPartCall();
    b.seg({ id: "l000500", spk: "c1", w0: T0 + 2 * MIN + 1, text: "we deploy on kubernetis now" });
    if (add) {
      b.add({
        type: "vocab.add",
        id: "v1",
        rev: 1,
        term: "Kubernetes",
        heard: ["kubernetis", "cubernetes"],
        by: "user",
      });
    }
    return b;
  }

  test("a vocab.add after the line corrects it in the pack, keeps the log raw, and search finds both spellings", () => {
    const b = withVocab(true);
    const before = JSON.stringify(b.events);
    const q = new CallQuery(fold(b.events));
    const pack = q.context("where do we deploy on Kubernetes?", { now: T0 + 5 * MIN });
    expect(pack.text).toContain('Kubernetes (heard: "kubernetis")');
    expect(pack.text).toContain('- Kubernetes (heard as "kubernetis", "cubernetes")');
    expect(JSON.stringify(b.events)).toBe(before);
    const seg = b.events.find((e) => e.type === "seg" && e.id === "l000500") as LogEvent & {
      text: string;
    };
    expect(seg.text).toBe("we deploy on kubernetis now");
    expect(q.search("Kubernetes")[0]?.lines.map((l) => l.id)).toContain("l000500");
    expect(q.search("kubernetis")[0]?.lines.map((l) => l.id)).toContain("l000500");
  });

  test("positive control: without the entry the line is uncorrected", () => {
    const q = new CallQuery(fold(withVocab(false).events));
    const pack = q.context("where do we deploy on kubernetis?", { now: T0 + 5 * MIN });
    expect(pack.text).toContain("we deploy on kubernetis now");
    expect(pack.text).not.toContain('(heard: "kubernetis")');
  });
});

describe("[design] Provisional text quoted as fact", () => {
  function withDraft(ageMs: number) {
    const b = twoPartCall();
    const view = fold(b.events);
    const now = T0 + 5 * MIN;
    view.provisional.update({
      ch: "call",
      part: 2,
      pseq: 1,
      text: "we will ship on friday",
      w0: now - 2 * S,
      at: now - ageMs,
      spk: "c1",
    });
    return { q: new CallQuery(view), now };
  }

  test("a fresh draft shows for a `now` question, marked, with no id, never among citable lines", () => {
    const { q, now } = withDraft(1000);
    const pack = q.context("what is he saying right now?", { now });
    const drafts = pack.text.split("\n").filter((r) => r.startsWith(DRAFT_MARK));
    expect(drafts).toEqual([
      `${DRAFT_MARK} 15:41:10 Speaker 1: we will ship on friday (still being spoken, may change)`,
    ]);
    expect(pack.provisional?.text).toBe("we will ship on friday");
    expect(pack.lines.some((l) => l.text.includes("ship on friday"))).toBe(false);
    const checks = checkCitations("He said [15:41 Speaker 1] they ship Friday.", pack);
    expect(checks[0]).toMatchObject({ ok: false, draftOnly: true });
  });

  test("a draft older than 3 s, or a question that is not about now, shows no draft", () => {
    const stale = withDraft(3500);
    const draftRows = (p: ContextPack) =>
      p.text.split("\n").filter((r) => r.startsWith(DRAFT_MARK));
    expect(draftRows(stale.q.context("what is he saying right now?", { now: stale.now }))).toEqual(
      [],
    );
    const fresh = withDraft(500);
    const recall = fresh.q.context("what did we say about topic3?", { now: fresh.now });
    expect(draftRows(recall)).toEqual([]);
    expect(recall.provisional).toBeNull();
  });

  test("positive control: a citation of a committed line passes the same check", () => {
    const { q, now } = withDraft(1000);
    const pack = q.context("what is he saying right now?", { now });
    const committed = pack.lines.at(-1);
    if (!committed) throw new Error("no line");
    const cite = `[${new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(committed.w0))} ${committed.speaker}]`;
    expect(checkCitations(`As ${cite} said.`, pack)[0]?.ok).toBe(true);
  });
});

describe("[judging] Memo and recency window leave a gap", () => {
  /** 60 lines over 6 minutes a minute apart... then a memo covering the first `covered` lines. */
  function memoCall(coveredLines: number) {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    for (let i = 1; i <= 30; i++) {
      b.seg({
        id: `l${String(i).padStart(6, "0")}`,
        spk: "c1",
        w0: T0 + i * MIN,
        text: `minute ${i} words`,
      });
    }
    const covered = b.events.find(
      (e) => e.type === "seg" && e.id === `l${String(coveredLines).padStart(6, "0")}`,
    );
    b.add({
      type: "memo",
      rev: 1,
      body: "- [15:40] early topics",
      coversSeq: covered?.seq ?? 0,
      by: "agent:claude-code",
      model: "none",
    });
    const q = new CallQuery(fold(b.events));
    return q.context("catch me up", { now: T0 + 31 * MIN });
  }

  test("a memo covering up to 20 minutes ago makes the window start right after it, not 5 minutes ago", () => {
    const pack = memoCall(10);
    const ids = pack.lines.map((l) => l.id);
    // Lines 11 to 30 (20 minutes) are all present: no gap after the memo.
    for (let i = 11; i <= 30; i++) expect(ids).toContain(`l${String(i).padStart(6, "0")}`);
    expect(pack.text).toContain("- [15:40] early topics");
  });

  test("positive control: a memo covering up to 2 minutes ago leaves the 5-minute window in force", () => {
    const pack = memoCall(28);
    const ids = pack.lines.map((l) => l.id);
    expect(ids).toContain("l000026");
    expect(ids).not.toContain("l000011");
  });
});

describe("[design] A time window is a hard filter", () => {
  const call = synthCall({ hours: 3, seed: 42 });
  const q = new CallQuery(fold(call.events));
  const now = call.end;
  const inWindow = (pack: ContextPack, w: { from: number; to: number }) =>
    pack.lines.every((l) => l.w0 >= w.from && l.w0 <= w.to);
  /** "what did we say about <codename> before HH:MM?", the window ending just before the fact. */
  const probes = call.facts.map((f) => ({
    f,
    q: `what did we say about ${f.codename} before ${formatWall(f.w0 - 15_000, TZ, { seconds: false })}?`,
  }));

  test("no line of a time pack falls outside the window, even when the matching turn straddles its edge", () => {
    let checked = 0;
    for (const p of probes) {
      const pack = q.context(p.q, { now });
      const w = pack.analysis.window;
      expect(pack.analysis.intent).toBe("time");
      if (!w) throw new Error("no window");
      expect(pack.lines.length).toBeGreaterThan(0);
      expect(inWindow(pack, w)).toBe(true);
      // The fact itself is after the window, so it is never in the pack.
      expect(pack.lines.map((l) => l.id)).not.toContain(p.f.id);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  test("positive control: the same assertion fails on a recall pack for the same term", () => {
    const p = probes[10] as (typeof probes)[number];
    const timed = q.context(p.q, { now });
    const recall = q.context(`what did we say about ${p.f.codename}?`, { now });
    expect(recall.analysis.intent).toBe("recall");
    expect(inWindow(recall, timed.analysis.window as { from: number; to: number })).toBe(false);
  });
});

describe("[judging] Memo and recency window leave a gap: across the switch to the final layer", () => {
  /** A 2-hour call, a memo covering all of it written `memoAge` before the end, then a final layer. */
  function ended(memoAge: number, finalLayer: boolean, coverLines = 600) {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    const n = 600;
    for (let i = 1; i <= n; i++) {
      b.seg({
        id: `l${String(i).padStart(6, "0")}`,
        spk: i % 2 ? "c1" : "c2",
        w0: T0 + i * 12 * S,
        text: `live words ${i} about the plan and the rollout today`,
      });
    }
    const end = T0 + (n * 12 + 1) * S;
    b.add(
      {
        type: "memo",
        rev: 1,
        body: "- [15:40] the plan",
        coversSeq: b.events[coverLines + 1]?.seq ?? 0,
        by: "agent:claude-code",
        model: "none",
      },
      end - memoAge,
    );
    b.partEnded(1, "stop", n * 12 + 1);
    b.add({ type: "call.ended", reason: "stop" }, end);
    if (finalLayer) {
      b.add({ type: "final.started", pid: 1 });
      for (let i = 1; i <= n; i++) {
        b.seg({
          id: `f${String(i).padStart(6, "0")}`,
          layer: "final",
          spk: i % 2 ? "s0" : "s1",
          w0: T0 + i * 12 * S + 200,
          text: `final words ${i} about the plan and the rollout today`,
        });
      }
      b.add({ type: "final.part.done", part: 1 });
      b.add({ type: "final.done", parts: [1], skipped: [] });
    }
    return { q: new CallQuery(fold(b.events)), end };
  }

  test("a memo covering the call still covers it after the final pass: not stale, window at the last 5 minutes", () => {
    const { q, end } = ended(4 * MIN, true);
    const pack = q.context("catch me up", { now: end + 30 * MIN });
    expect(pack.memo.uncovered.lines).toBe(0);
    expect(pack.memoStale).toBe(false);
    expect(pack.text).toMatch(/Memo \(covers the call up to \d\d:\d\d:\d\d\):/);
    expect(pack.text).not.toContain("did not fit");
    const first = pack.lines.find((l) => l.layer === "final" && pack.text.includes(`#${l.id} `));
    expect(first).toBeDefined();
    const recent = pack.lines.filter((l) => l.w0 >= end - 5 * MIN - 12 * S);
    expect(recent.length).toBeGreaterThan(0);
    expect(Math.min(...pack.lines.map((l) => l.w0))).toBeGreaterThanOrEqual(end - 6 * MIN);
  });

  test("positive control: a memo covering only the first hour leaves the second hour uncovered after the pass", () => {
    const { q, end } = ended(4 * MIN, true, 300);
    const pack = q.context("catch me up", { now: end + 30 * MIN });
    expect(pack.memo.uncovered.lines).toBeGreaterThanOrEqual(299);
    expect(pack.memoStale).toBe(true);
  });
});

describe("[design risk] Layer switch confuses a live reader: `read` reports the switch", () => {
  function call(final: boolean) {
    const b = twoPartCall(40, 20);
    b.partEnded(2, "stop", 120);
    b.add({ type: "call.ended", reason: "stop" });
    const view = fold(b.events);
    const q = new CallQuery(view);
    const cursor = q.read(0, T0 + 10 * MIN).cursor;
    view.apply(b.add({ type: "final.started", pid: 1 }));
    for (let i = 1; i <= 20; i++) {
      view.apply(
        b.seg({
          id: `f${String(i).padStart(6, "0")}`,
          layer: "final",
          part: 1,
          spk: "s0",
          w0: T0 + i * 6 * S,
          text: `final line ${i}`,
        }),
      );
    }
    if (final) view.apply(b.add({ type: "final.part.done", part: 1 }));
    return { q, cursor };
  }

  test("a reader across final.part.done is told which live lines the final ones replace", () => {
    const { q, cursor } = call(true);
    const r = q.read(cursor, T0 + 10 * MIN);
    expect(r.lines.map((l) => l.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `f${String(i + 1).padStart(6, "0")}`),
    );
    // Part 1's live lines are superseded; part 2's are still the best view.
    expect(r.superseded).toEqual(
      Array.from({ length: 20 }, (_, i) => `l${String(i + 1).padStart(6, "0")}`),
    );
    expect(r.retracted).toEqual([]);
    // A reader that drops the superseded ids and keeps the rest holds exactly the best view.
    const held = new Set(
      q.view
        .lines("live")
        .map((l) => l.id)
        .filter((id) => !r.superseded.includes(id)),
    );
    for (const l of r.lines) held.add(l.id);
    expect([...held].sort()).toEqual(
      q.view
        .lines()
        .map((l) => l.id)
        .sort(),
    );
    // The next read, from the new cursor, reports nothing again.
    expect(q.read(r.cursor, T0 + 10 * MIN).superseded).toEqual([]);
  });

  test("positive control: before final.part.done nothing is superseded and no final line is read", () => {
    const { q, cursor } = call(false);
    const r = q.read(cursor, T0 + 10 * MIN);
    expect(r.superseded).toEqual([]);
    expect(r.lines).toEqual([]);
  });
});
