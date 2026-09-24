/**
 * Harness session reuse (docs/DESIGN.md section 5.3, ROADMAP M2): off by default; when on, a
 * follow-up in whole-call mode sends only what the kept session has not seen, and Claude Code runs
 * with `--session-id` and then `--resume` in one folder per session. The measurement's rule (at
 * least a 40 % cut per follow-up, or it stays off) is checked here on fixtures; no test runs a real
 * harness (`scripts/measure-resume.ts` does, by hand).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { SETTINGS } from "../src/main/config/schema.ts";
import { claudeParser, HarnessProvider, harnessArgs } from "../src/main/llm/harness.ts";
import type { CompleteRequest, CompleteResult, Provider, Usage } from "../src/main/llm/provider.ts";
import { REUSE_MIN_CUT, reuseVerdict } from "../src/main/llm/reuse.ts";
import { ask, followUpPrompt, MemorySessions } from "../src/main/query/ask.ts";
import { CallQuery } from "../src/main/query/context.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const FIX = join(import.meta.dir, "fixtures", "harness");
const FAKE = join(import.meta.dir, "fixtures", "fake-harness.ts");

describe("the setting", () => {
  test("session reuse is off until measured", () => {
    expect(SETTINGS["provider.harnessResume"].default).toBe(false);
  });
});

describe("Claude Code with a session", () => {
  test("the first run names the session, a follow-up resumes it, no session keeps nothing", () => {
    const first = harnessArgs("claude", "SYS", { id: "s-1", resume: false });
    expect(first).toContain("--session-id");
    expect(first).not.toContain("--no-session-persistence");
    const next = harnessArgs("claude", "SYS", { id: "s-1", resume: true });
    expect(next.slice(next.indexOf("--resume"), next.indexOf("--resume") + 2)).toEqual([
      "--resume",
      "s-1",
    ]);
    expect(harnessArgs("claude", "SYS")).toContain("--no-session-persistence");
    // Codex has no session: its arguments are the same either way.
    expect(harnessArgs("codex", "S", { id: "s-1", resume: true })).toEqual(
      harnessArgs("codex", "S"),
    );
  });

  test("the tokens a run spent are read from the recorded result event", () => {
    const p = claudeParser();
    for (const line of readFileSync(join(FIX, "claude-ok.jsonl"), "utf8").split("\n")) {
      if (line.trim()) p.feed(JSON.parse(line));
    }
    expect(p.report().usage).toEqual({ input: 2, cacheCreation: 2967, cacheRead: 0, output: 4 });
  });

  test("runs of one session share a folder that outlives them; a run without one leaves nothing", async () => {
    const t = tempDir();
    try {
      const record = join(t.dir, "rec.json");
      const p = new HarnessProvider({
        target: () => ({
          kind: "claude",
          command: [process.execPath, FAKE, join(FIX, "claude-ok.jsonl")],
          version: "2.1.281",
        }),
        env: { ...process.env, FAKE_RECORD: record },
      });
      expect(p.sessions()).toBe(true);
      const id = crypto.randomUUID();
      const signal = new AbortController().signal;
      const one = await p.complete(
        { system: "S", prompt: "P1", maxTokens: 10, session: { id, resume: false } },
        () => {},
        signal,
      );
      expect(one.usage).toMatchObject({ cacheCreation: 2967 });
      const a = JSON.parse(readFileSync(record, "utf8"));
      await p.complete(
        { system: "S", prompt: "P2", maxTokens: 10, session: { id, resume: true } },
        () => {},
        signal,
      );
      const b = JSON.parse(readFileSync(record, "utf8"));
      expect(a.argv).toContain("--session-id");
      expect(b.argv).toContain("--resume");
      expect(b.cwd).toBe(a.cwd);
      expect(existsSync(HarnessProvider.sessionDir(id))).toBe(true);
      HarnessProvider.endSession(id);
      expect(existsSync(HarnessProvider.sessionDir(id))).toBe(false);
      await p.complete({ system: "S", prompt: "P3", maxTokens: 10 }, () => {}, signal);
      const c = JSON.parse(readFileSync(record, "utf8"));
      expect(c.argv).toContain("--no-session-persistence");
      expect(existsSync(c.cwd)).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

/** Records every request; keeps sessions when `keeps`. */
class SessionProvider implements Provider {
  readonly id = "harness" as const;
  readonly requests: CompleteRequest[] = [];
  constructor(private readonly keeps = true) {}
  sessions() {
    return this.keeps;
  }
  async available() {
    return { ok: true as const, detail: "fake" };
  }
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.requests.push(req);
    return { text: "ok", model: "fake/1.0" };
  }
}

function liveCall() {
  const b = new LogBuilder();
  b.created({ title: "Planning" });
  b.partStarted(1, T0);
  b.seg({ id: "l000001", text: "the budget review moves to Friday", w0: T0 + 2000 });
  b.seg({ id: "l000002", spk: "c2", text: "Carla owns the vendor contract", w0: T0 + 6000 });
  const view = fold(b.events);
  const q = new CallQuery(view);
  const add = (draft: Parameters<LogBuilder["add"]>[0]) => {
    const e = b.add(draft);
    view.apply(e);
    return e;
  };
  const opts = (provider: Provider, question: string, sessions?: MemorySessions) => ({
    q,
    question,
    now: T0 + 60_000,
    provider,
    by: "user",
    sessions,
    write: async (
      d: Parameters<typeof ask>[0]["write"] extends (x: infer X) => unknown ? X : never,
    ) => add(typeof d === "function" ? d(view) : d) as LogEvent,
  });
  return { b, view, add, opts };
}

describe("follow-ups in a kept session", () => {
  test("the first question sends the whole pack; a follow-up only the new lines, the tail and the question", async () => {
    const c = liveCall();
    const p = new SessionProvider();
    const sessions = new MemorySessions();
    await ask(c.opts(p, "what about the budget?", sessions));
    const first = p.requests[0] as CompleteRequest;
    expect(first.session?.resume).toBe(false);
    expect(first.prompt).toContain("the budget review moves to Friday");
    c.add({
      type: "seg",
      rev: 1,
      layer: "live",
      part: 1,
      ch: "call",
      spk: "c1",
      a0: 0,
      a1: 1,
      w0: T0 + 9000,
      w1: T0 + 10_000,
      model: "fake",
      id: "l000009",
      text: "the invoice goes out Monday",
    });
    const r = await ask(c.opts(p, "and the invoice?", sessions));
    const second = p.requests[1] as CompleteRequest;
    expect(second.session).toEqual({ id: first.session?.id as string, resume: true });
    expect(second.prompt).toContain("the invoice goes out Monday");
    expect(second.prompt).toEndWith("Question: and the invoice?");
    // Positive control for the saving: the old lines are not sent again.
    expect(second.prompt).not.toContain("the budget review moves to Friday");
    expect(second.prompt.length).toBeLessThan(first.prompt.length);
    expect(r.resumed).toBe(true);
  });

  test("a changed line starts a new session with the whole pack", async () => {
    const c = liveCall();
    const p = new SessionProvider();
    const sessions = new MemorySessions();
    await ask(c.opts(p, "what about the budget?", sessions));
    c.add({
      type: "seg",
      rev: 2,
      layer: "live",
      part: 1,
      ch: "call",
      spk: "c1",
      a0: 0,
      a1: 1,
      w0: T0 + 2000,
      w1: T0 + 3000,
      model: "fake",
      id: "l000001",
      text: "the budget review moves to Thursday",
      by: "user",
    });
    await ask(c.opts(p, "when is it?", sessions));
    const again = p.requests[1] as CompleteRequest;
    expect(again.session?.resume).toBe(false);
    expect(again.session?.id).not.toBe(p.requests[0]?.session?.id);
    expect(again.prompt).toContain("moves to Thursday");
  });

  test("with reuse off, or a provider that keeps no session, every question is whole", async () => {
    const c = liveCall();
    const off = new SessionProvider();
    await ask(c.opts(off, "one?"));
    await ask(c.opts(off, "two?"));
    expect(off.requests.every((r) => r.session === undefined)).toBe(true);
    const codex = new SessionProvider(false);
    const sessions = new MemorySessions();
    await ask(c.opts(codex, "one?", sessions));
    await ask(c.opts(codex, "two?", sessions));
    expect(codex.requests.every((r) => r.session === undefined)).toBe(true);
  });

  test("a retrieval pack never continues a session", () => {
    const pack = { mode: "retrieval" } as Parameters<typeof followUpPrompt>[0];
    expect(followUpPrompt(pack, { id: "x", head: "", transcript: [], turns: 1 }, "q")).toBeNull();
  });

  test("a session that is replaced or dropped is ended", () => {
    const ended: string[] = [];
    const s = new MemorySessions((id) => ended.push(id));
    s.set("call", { id: "a", head: "", transcript: [], turns: 1 });
    s.set("call", { id: "a", head: "", transcript: ["x"], turns: 2 });
    s.set("call", { id: "b", head: "", transcript: [], turns: 1 });
    s.delete("call");
    expect(ended).toEqual(["a", "b"]);
  });
});

describe("the measurement decides", () => {
  const u = (total: number): Usage => ({ input: 0, cacheCreation: 0, cacheRead: total, output: 0 });

  test("a cut of at least 40 % per follow-up turns it on; the first question is not counted", () => {
    const v = reuseVerdict([u(9000), u(9000), u(9200)], [u(9000), u(4000), u(4400)]);
    expect(v.followUps).toBe(2);
    expect(v.withoutMean).toBe(9100);
    expect(v.withMean).toBe(4200);
    expect(v.cut).toBeGreaterThanOrEqual(REUSE_MIN_CUT);
    expect(v.enable).toBe(true);
  });

  test("positive control: a cut under 40 %, or reuse that costs more, keeps it off", () => {
    expect(reuseVerdict([u(9000), u(9000)], [u(100), u(6000)]).enable).toBe(false);
    const worse = reuseVerdict([u(5000), u(5000)], [u(5000), u(12_000)]);
    expect(worse.cut).toBeLessThan(0);
    expect(worse.enable).toBe(false);
    // Cache reads count in full: a resumed run that reads its whole history is not cheaper.
    const cached = reuseVerdict(
      [u(8000), { input: 8000, cacheCreation: 0, cacheRead: 0, output: 100 }],
      [u(8000), { input: 300, cacheCreation: 0, cacheRead: 8400, output: 100 }],
    );
    expect(cached.enable).toBe(false);
    expect(reuseVerdict([], []).enable).toBe(false);
  });
});
