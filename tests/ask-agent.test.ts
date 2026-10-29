/**
 * The agent following a call answers the ask box (docs/DESIGN.md section 5.5), the parts that need
 * no app: who counts as listening (`listeners.ts`), several answers to one ask in the fold, the
 * `answer` event's `by`, the citations of an agent's answer, and a provider command the user
 * names (`provider.kind` `command`). The routes and the window run in `ask-agent.e2e.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDraft } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { validateSetting } from "../src/main/config/schema.ts";
import { CommandProvider, commandLabel, fillArgs } from "../src/main/llm/command.ts";
import { ProviderError, runProvider } from "../src/main/llm/provider.ts";
import { citesIn, unansweredAsks } from "../src/main/query/agent-answer.ts";
import { LISTEN_GRACE_MS, Listeners } from "../src/main/query/listeners.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const FAKE_COMMAND = join(import.meta.dir, "fixtures", "fake-command.ts");
const S = 1000;

function call(): LogBuilder {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.seg({ id: "l000001", ch: "mic", spk: "you", w0: T0 + 1 * S, text: "hi everyone" });
  b.seg({ id: "l000002", spk: "c2", w0: T0 + 2 * S, text: "we ship on friday" });
  return b;
}

describe("[decision] Waiting for an agent that has left", () => {
  test("a client counts while its poll is open and for the grace after, then not", () => {
    let now = 1_000_000;
    const l = new Listeners(() => now);
    expect(l.listening("c1")).toEqual([]);
    const end = l.open("c1", "claude-code");
    now += 60_000;
    expect(l.listening("c1")).toEqual(["claude-code"]);
    end();
    now += LISTEN_GRACE_MS - 1;
    expect(l.listening("c1")).toEqual(["claude-code"]);
    now += 2;
    expect(l.listening("c1")).toEqual([]);
    // Another call is never listened to by this one's poll.
    l.open("c2", "codex");
    expect(l.listening("c1")).toEqual([]);
  });

  test("a change in who listens is told once, and the expiry too", async () => {
    let now = 0;
    let told = 0;
    const l = new Listeners(
      () => now,
      () => told++,
    );
    const end = l.open("c1", "claude-code");
    expect(told).toBe(1);
    // A second poll of the same client changes nothing the window shows.
    l.open("c1", "claude-code")();
    expect(told).toBe(1);
    end();
    now += LISTEN_GRACE_MS + 1;
    // Once the grace is over the next look tells the change (a timer also does, on its own).
    l.open("c9", "x")();
    expect(told).toBe(2);
  });

  test("the excerpts fallback of an ask is remembered for the agent's answer", () => {
    const l = new Listeners(() => 0);
    expect(l.fallback("c1", "q0001")).toBe(false);
    l.fellBack("c1", "q0001");
    expect(l.fallback("c1", "q0001")).toBe(true);
  });
});

describe("[decision] Two answers to one question: the fold keeps every answer", () => {
  test("an `answer` with and without `by` validates; an odd author does not", () => {
    const base = {
      type: "answer",
      ask: "q0003",
      text: "Friday",
      cites: [],
      model: "m",
      pack: { mode: "agent", tokens: 0 },
    };
    expect(validateDraft(base).ok).toBe(true);
    expect(validateDraft({ ...base, by: "agent:claude-code" }).ok).toBe(true);
    expect(validateDraft({ ...base, by: "someone" }).ok).toBe(false);
  });

  test("qa() returns every answer in seq order; the pack's `answer` is the latest; an old log still folds", () => {
    const b = call();
    b.add({ type: "ask", id: "q0003", q: "when do we ship?", by: "user" });
    b.add({
      type: "answer",
      ask: "q0003",
      text: "Friday [00:00 Speaker 2]",
      cites: ["l000002"],
      model: "claude-code/2",
      pack: { mode: "whole", tokens: 100 },
    });
    b.add({
      type: "answer",
      ask: "q0003",
      text: "On Friday, as said at #l000002.",
      cites: ["l000002"],
      model: "claude-code",
      pack: { mode: "agent", tokens: 0 },
      by: "agent:claude-code",
    });
    const v = fold(b.events);
    const [qa] = v.qa();
    expect(qa?.answers.map((a) => a.by ?? "provider")).toEqual(["provider", "agent:claude-code"]);
    expect(qa?.answer?.by).toBe("agent:claude-code");
    expect(v.issues).toEqual([]);
  });
});

describe("[judging] Hallucinated citation in enhanced notes: an agent's answer", () => {
  test("a citation that names no line of the call is dropped; a real one is kept", () => {
    const v = fold(call().events);
    const tz = v.call?.tz ?? "UTC";
    expect(citesIn("see #l000002 and #l999999", v.lines("best"), tz, v)).toEqual(["l000002"]);
  });
});

describe("akou_status `unanswered`: the user's asks no agent answered", () => {
  test("lists a user's ask without an agent answer, within ten minutes; not an agent's own", () => {
    const b = call();
    b.add({ type: "ask", id: "q0003", q: "when?", by: "user" }, T0 + 10 * S);
    b.add({ type: "ask", id: "q0004", q: "mine", by: "agent:codex" }, T0 + 11 * S);
    b.add({ type: "ask", id: "q0005", q: "answered", by: "user" }, T0 + 12 * S);
    b.add({
      type: "answer",
      ask: "q0005",
      text: "yes",
      cites: [],
      model: "codex",
      pack: { mode: "agent", tokens: 0 },
      by: "agent:codex",
    });
    const v = fold(b.events);
    expect(unansweredAsks(v, T0 + 60 * S).map((x) => x.ask)).toEqual(["q0003"]);
    expect(unansweredAsks(v, T0 + 11 * 60 * S)).toEqual([]);
  });
});

describe("[decision] A provider command set over the API", () => {
  test("provider.command is a list, file only; empty items are allowed in it", () => {
    expect(validateSetting("provider.command", ["claude", "-p", "--tools", ""]).ok).toBe(true);
    expect(validateSetting("provider.command", "claude -p").ok).toBe(false);
    expect(validateSetting("provider.kind", "command").ok).toBe(true);
    expect(validateSetting("ask.agentWaitSeconds", 301).ok).toBe(false);
    expect(validateSetting("ask.agentWaitSeconds", 0).ok).toBe(true);
  });

  test("placeholders are replaced inside one argument each; nothing is split", () => {
    expect(
      fillArgs(["x", "--q={question}", "{task}:{ask}", "{system}", "{nope}"], {
        question: "a b; rm -rf ~",
        task: "ask",
        ask: "q0001",
        system: "S",
      }),
    ).toEqual(["x", "--q=a b; rm -rf ~", "ask:q0001", "S", "{nope}"]);
    expect(commandLabel(["/usr/local/bin/my-wrapper", "x"])).toBe("my-wrapper");
    expect(commandLabel(["x"], " Work account ")).toBe("Work account");
  });

  test("runs as argv with no shell: a `;` in the question reaches the program as text, stdin gets the prompt", async () => {
    const t = tempDir();
    const record = join(t.dir, "record.json");
    const marker = join(t.dir, "pwned");
    try {
      const p = new CommandProvider({
        argv: [process.execPath, FAKE_COMMAND, "--question", "{question}"],
        env: { ...process.env, FAKE_RECORD: record },
        label: "fake",
      });
      const question = `hi; touch ${marker}`;
      const r = await runProvider(
        p,
        {
          system: "SYS",
          prompt: "PACK\n\nQuestion: hi",
          maxTokens: 10,
          meta: { task: "ask", question, call: "01CALL", ask: "q0007" },
        },
        () => {},
      );
      expect(r).toEqual({ text: "The answer [15:41 Ben].", model: "fake" });
      const got = JSON.parse(readFileSync(record, "utf8"));
      expect(got.argv).toEqual(["--question", question]);
      // No `{system}` argument: the system prompt is at the top of stdin.
      expect(got.stdin).toBe("SYS\n\nPACK\n\nQuestion: hi");
      expect(got.env).toMatchObject({
        AKOU_QUESTION: question,
        AKOU_CALL_ID: "01CALL",
        AKOU_ASK_ID: "q0007",
        AKOU_TASK: "ask",
      });
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("with `{system}` in an argument, stdin holds the prompt alone", async () => {
    const t = tempDir();
    const record = join(t.dir, "record.json");
    try {
      const p = new CommandProvider({
        argv: [process.execPath, FAKE_COMMAND, "--system-prompt", "{system}"],
        env: { ...process.env, FAKE_RECORD: record },
        label: "my account",
      });
      const r = await runProvider(p, { system: "SYS", prompt: "P", maxTokens: 10 }, () => {});
      expect(r.model).toBe("my account");
      const got = JSON.parse(readFileSync(record, "utf8"));
      expect(got.argv).toEqual(["--system-prompt", "SYS"]);
      expect(got.stdin).toBe("P");
      expect(got.env.AKOU_TASK).toBe("other");
    } finally {
      t.cleanup();
    }
  });

  test("a non-zero exit with a usage-limit message is `exhausted`; a login message `auth`; else `other` with the last stderr line", async () => {
    const run = async (stderr: string) => {
      const p = new CommandProvider({
        argv: [process.execPath, FAKE_COMMAND],
        env: { ...process.env, FAKE_EXIT: "1", FAKE_STDERR: stderr },
        label: "fake",
      });
      try {
        await runProvider(p, { system: "S", prompt: "P", maxTokens: 10 }, () => {});
        return null;
      } catch (err) {
        return err as ProviderError;
      }
    };
    const limit = await run("Claude AI usage limit reached|1767225600");
    expect(limit).toBeInstanceOf(ProviderError);
    expect(limit?.kind).toBe("exhausted");
    expect(limit?.message).toStartWith("fake reported its usage limit is reached");
    expect((await run("Please run /login: not logged in"))?.kind).toBe("auth");
    const other = await run("first\nboom");
    expect([other?.kind, other?.message]).toEqual(["other", "fake exited 1: boom"]);
  });

  test("a command that does not answer in time is stopped: `no answer within`", async () => {
    const t = tempDir();
    const pidfile = join(t.dir, "pid");
    try {
      const p = new CommandProvider({
        argv: [process.execPath, FAKE_COMMAND],
        env: { ...process.env, FAKE_DELAY_MS: "20000", FAKE_PIDFILE: pidfile },
      });
      const err = await runProvider(p, { system: "S", prompt: "P", maxTokens: 10 }, () => {}, {
        timeoutMs: 500,
      }).then(
        () => null,
        (e: ProviderError) => e,
      );
      expect([err?.kind, err?.message]).toEqual(["other", "no answer within 500 ms"]);
      const pid = Number(readFileSync(pidfile, "utf8"));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(100);
      expect(alive()).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("an empty command is `missing`, with where to set it", async () => {
    const a = await new CommandProvider({ argv: [] }).available();
    expect(a).toMatchObject({ ok: false, kind: "missing" });
  });
});

describe("[decision] Waiting for an agent that has left: a hang-up", () => {
  test("a client that hung up mid-poll stops counting at once; a normal end keeps the grace", () => {
    const now = 0;
    const l = new Listeners(() => now);
    l.open("c1", "a")(true);
    expect(l.listening("c1")).toEqual([]);
    l.open("c1", "b")();
    expect(l.listening("c1")).toEqual(["b"]);
    // Another poll of the same client still open keeps it, whatever the first one did.
    const second = l.open("c1", "c");
    l.open("c1", "c")(true);
    expect(l.listening("c1")).toEqual(["b", "c"]);
    second(true);
    expect(l.listening("c1")).toEqual(["b"]);
  });
});
