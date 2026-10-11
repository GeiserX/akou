/**
 * The harness provider (docs/DESIGN.md section 5.3): the stream parsers on sanitized recordings of
 * the real `claude` and `codex` programs, failure classification, discovery through the login
 * shell, and the provider end to end against a fake harness. No test runs a real harness.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_SAFE_MODE,
  CODEX_MIN_JSON,
  classifyRun,
  claudeParser,
  claudeSafeMode,
  codexParser,
  compareVersions,
  discoverHarnesses,
  HarnessProvider,
  HarnessSpare,
  type HarnessTarget,
  harnessArgs,
  harnessStdin,
  kindOfPath,
  parseVersion,
  pickHarness,
  type StreamParser,
} from "../src/main/llm/harness.ts";
import { ProviderError, runProvider } from "../src/main/llm/provider.ts";
import { tempDir } from "./helpers.ts";

const FIX = join(import.meta.dir, "fixtures", "harness");
const FAKE = join(import.meta.dir, "fixtures", "fake-harness.ts");

function replay(parser: StreamParser, file: string): { tokens: string[] } {
  const tokens: string[] = [];
  for (const line of readFileSync(join(FIX, file), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    tokens.push(...parser.feed(JSON.parse(line)));
  }
  return { tokens };
}

describe("Claude Code stream-json (recorded from claude 2.1.281)", () => {
  test("the recording streams one text_delta and ends with a result", () => {
    const p = claudeParser();
    const { tokens } = replay(p, "claude-ok.jsonl");
    expect(tokens).toEqual(["ok"]);
    const r = p.report();
    expect(r).toMatchObject({ text: "ok", version: "2.1.281", finished: true });
    expect(r.errorText).toBeUndefined();
    expect(classifyRun("claude", 0, r, "")).toBeNull();
  });

  test("the fixture carries no session id, path or account detail", () => {
    for (const f of ["claude-ok.jsonl", "codex-auth-error.jsonl", "codex-auth-error.stderr.txt"]) {
      const text = readFileSync(join(FIX, f), "utf8");
      expect(text).not.toMatch(/\/Users\/|\/home\/|\/private\/|C:\\\\/);
      expect(text).not.toMatch(/"session_id":"(?!00000000-0000-4000-8000-000000000000)/);
      expect(text).not.toMatch(/"(utilization|memory_paths|messaging_socket_path)"/);
      expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
      // Request ids, Cloudflare rays (whose suffix names the edge) and real timestamps.
      expect(text).not.toMatch(/req_(?!fixture\b)[A-Za-z0-9]+|cf-ray: (?!0{16}-XXX\b)/);
      expect(text).not.toMatch(/"timestamp":"(?!2026-01-01T00:00:00\.000Z")/);
    }
  });

  test("tokens stream as they arrive; the final result fills in anything the stream missed", () => {
    const p = claudeParser();
    const delta = (t: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
      parent_tool_use_id: null,
    });
    expect(p.feed(delta("The build "))).toEqual(["The build "]);
    expect(p.feed(delta("moves"))).toEqual(["moves"]);
    // The whole message after its deltas adds nothing.
    expect(
      p.feed({
        type: "assistant",
        message: { content: [{ type: "text", text: "The build moves" }] },
        parent_tool_use_id: null,
      }),
    ).toEqual([]);
    expect(
      p.feed({ type: "result", is_error: false, result: "The build moves to the new box." }),
    ).toEqual([" to the new box."]);
    expect(p.report().text).toBe("The build moves to the new box.");
  });

  test("without partial messages, the assistant message is the token", () => {
    const p = claudeParser();
    expect(
      p.feed({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
        parent_tool_use_id: null,
      }),
    ).toEqual(["ok"]);
  });

  test("a subagent's events are not the answer", () => {
    const p = claudeParser();
    expect(
      p.feed({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
        parent_tool_use_id: "toolu_1",
      }),
    ).toEqual([]);
  });

  test("a usage limit: rejected rate-limit event, status 429, the reset time kept", () => {
    const p = claudeParser();
    const { tokens } = replay(p, "claude-usage-limit.synthetic.jsonl");
    expect(tokens).toEqual([]);
    const err = classifyRun("claude", 1, p.report(), "") as ProviderError;
    expect(err.kind).toBe("exhausted");
    expect(err.resetsAt).toBe(1790236800 * 1000);
    expect(err.message).toContain("Claude Code reported its usage limit is reached");
  });

  test("not logged in is auth, not a usage limit", () => {
    const p = claudeParser();
    replay(p, "claude-auth.synthetic.jsonl");
    const err = classifyRun("claude", 1, p.report(), "") as ProviderError;
    expect(err.kind).toBe("auth");
    expect(err.message).toContain("Not logged in");
  });
});

describe("Codex exec --json", () => {
  test("an agent message grows over item events; the tokens are the growth", () => {
    const p = codexParser();
    const { tokens } = replay(p, "codex-ok.synthetic.jsonl");
    expect(tokens.join("")).toBe("ok");
    expect(p.report()).toMatchObject({ text: "ok", finished: true });
    expect(classifyRun("codex", 0, p.report(), "")).toBeNull();
  });

  test("a Codex reconnect `error` followed by `turn.completed` is a success", () => {
    const p = codexParser();
    p.feed({ type: "thread.started", thread_id: "t" });
    p.feed({ type: "turn.started" });
    p.feed({
      type: "error",
      message: "Reconnecting... 1/5 (stream disconnected before completion)",
    });
    p.feed({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "ok" } });
    p.feed({ type: "turn.completed", usage: {} });
    expect(p.report().text).toBe("ok");
    expect(classifyRun("codex", 0, p.report(), "")).toBeNull();
    // Positive control: an `error` the turn never recovered from is still a failure.
    const q = codexParser();
    q.feed({ type: "error", message: "stream disconnected" });
    expect(classifyRun("codex", 1, q.report(), "")?.kind).toBe("other");
  });

  test("the recorded refresh-token failure (codex 0.151.0) is auth, from the JSON and stderr", () => {
    const p = codexParser();
    replay(p, "codex-auth-error.jsonl");
    const stderr = readFileSync(join(FIX, "codex-auth-error.stderr.txt"), "utf8");
    const err = classifyRun("codex", 1, p.report(), stderr) as ProviderError;
    expect(err.kind).toBe("auth");
    expect(err.message).toContain("Codex is not logged in");
    // From stderr alone, too.
    expect(classifyRun("codex", 1, { text: "", finished: false }, stderr)?.kind).toBe("auth");
  });

  test("a usage limit is exhausted", () => {
    const p = codexParser();
    replay(p, "codex-usage-limit.synthetic.jsonl");
    expect(classifyRun("codex", 1, p.report(), "")?.kind).toBe("exhausted");
  });

  test("a failure with no known wording is other, with the first line of what was said", () => {
    const err = classifyRun("codex", 2, { text: "", finished: false }, "\n  boom: disk full\n");
    expect(err?.kind).toBe("other");
    expect(err?.message).toBe("Codex exited 2: boom: disk full");
  });
});

describe("invocation and discovery", () => {
  test("the design's command lines, prompt on stdin, system prompt for Claude Code only", () => {
    expect(harnessArgs("claude", "SYS")).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--input-format",
      "stream-json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt",
      "SYS",
    ]);
    expect(harnessArgs("codex", "SYS")).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "-",
    ]);
    const req = { system: "SYS", prompt: "PACK", maxTokens: 10 };
    expect(harnessStdin("claude", req)).toBe(
      '{"type":"user","message":{"role":"user","content":"PACK"}}\n',
    );
    expect(harnessStdin("codex", req)).toBe("SYS\n\nPACK");
  });

  test("--safe-mode only for a Claude Code known to have it (2.1.169 and later)", () => {
    expect(CLAUDE_SAFE_MODE).toBe("2.1.169");
    expect(claudeSafeMode("2.1.169")).toBe(true);
    expect(claudeSafeMode("2.1.296")).toBe(true);
    // An older one refuses the flag and exits; an unknown version is not guessed at.
    expect(claudeSafeMode("2.1.168")).toBe(false);
    expect(claudeSafeMode(null)).toBe(false);
    expect(claudeSafeMode(undefined)).toBe(false);
    const args = harnessArgs("claude", "SYS", undefined, "2.1.296");
    expect(args).toContain("--safe-mode");
    // Before the session flags and the system prompt, never between a flag and its value.
    expect(args.indexOf("--safe-mode")).toBe(args.indexOf("--strict-mcp-config") + 1);
    expect(harnessArgs("claude", "SYS", undefined, "2.1.168")).not.toContain("--safe-mode");
    expect(harnessArgs("codex", "SYS", undefined, "2.1.296")).not.toContain("--safe-mode");
  });

  test("versions", () => {
    expect(parseVersion("2.1.281 (Claude Code)")).toBe("2.1.281");
    expect(parseVersion("codex-cli 0.151.0")).toBe("0.151.0");
    expect(parseVersion("nothing")).toBeNull();
    expect(compareVersions("0.151.0", CODEX_MIN_JSON)).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(kindOfPath("/opt/bin/codex")).toBe("codex");
    expect(kindOfPath("/opt/bin/claude")).toBe("claude");
  });

  test("picking: a pinned path first, then the chosen kind, then Claude Code before Codex", () => {
    const found = {
      claude: { kind: "claude" as const, path: "/a/claude", version: "2.1.0" },
      codex: { kind: "codex" as const, path: "/a/codex", version: "0.151.0" },
    };
    expect(pickHarness("auto", "", found)).toEqual({
      kind: "claude",
      command: ["/a/claude"],
      version: "2.1.0",
    });
    expect(pickHarness("codex", "", found)).toMatchObject({ kind: "codex" });
    expect(pickHarness("auto", "/pin/codex", null)).toMatchObject({
      kind: "codex",
      command: ["/pin/codex"],
    });
    expect(pickHarness("auto", "", null)).toEqual({
      none: "still looking for Claude Code and Codex",
    });
    const none = pickHarness("claude", "", { claude: null, codex: found.codex });
    expect("none" in none && none.none).toContain("no harness found (claude-code)");
  });

  test.skipIf(process.platform === "win32")(
    "[decision] Harness not found from an app bundle: found through the login shell, PATH minimal (POSIX login shell; skipped on Windows)",
    async () => {
      const t = tempDir();
      try {
        const bin = join(t.dir, "bin");
        mkdirSync(bin);
        // Fakes that only answer --version, for both names, so no real harness on the host's
        // system PATH (restored by /etc/profile) is ever run.
        const fake = join(bin, "claude");
        writeFileSync(fake, '#!/bin/sh\necho "9.8.7 (Claude Code)"\n');
        chmodSync(fake, 0o755);
        const fakeCodex = join(bin, "codex");
        writeFileSync(fakeCodex, '#!/bin/sh\necho "codex-cli 0.200.0"\n');
        chmodSync(fakeCodex, 0o755);
        // The login shell's profile is the only place that puts it on PATH.
        writeFileSync(join(t.dir, ".profile"), `PATH="${bin}:$PATH"; export PATH\n`);
        const env = { HOME: t.dir, SHELL: "/bin/sh", PATH: "/nonexistent" };
        const d = await discoverHarnesses(env, process.platform);
        expect(d.claude).toEqual({ kind: "claude", path: fake, version: "9.8.7" });
        expect(d.codex).toEqual({ kind: "codex", path: fakeCodex, version: "0.200.0" });
        // Positive control: with no login shell to ask, a minimal PATH finds nothing.
        const bare = await discoverHarnesses({ HOME: t.dir, PATH: "/nonexistent" });
        expect(bare.claude).toBeNull();
        expect(bare.codex).toBeNull();
      } finally {
        t.cleanup();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "discovery ends when the login shell leaves a background process holding its stdout (POSIX login shell; skipped on Windows)",
    async () => {
      const t = tempDir();
      const pidFile = join(t.dir, "sleeper.pid");
      try {
        const bin = join(t.dir, "bin");
        mkdirSync(bin);
        const fake = join(bin, "claude");
        writeFileSync(fake, '#!/bin/sh\necho "9.8.7 (Claude Code)"\n');
        chmodSync(fake, 0o755);
        // A profile that starts something long-lived with the shell's stdout inherited.
        writeFileSync(
          join(t.dir, ".profile"),
          `PATH="${bin}:$PATH"; export PATH\n/bin/sleep 60 & echo $! > "${pidFile}"\n`,
        );
        const t0 = performance.now();
        const d = await discoverHarnesses({ HOME: t.dir, SHELL: "/bin/sh", PATH: "/nonexistent" });
        expect(performance.now() - t0).toBeLessThan(8000);
        expect(d.claude).toEqual({ kind: "claude", path: fake, version: "9.8.7" });
        // Positive control: the background process really was still holding the pipe.
        expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).not.toThrow();
      } finally {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {}
        t.cleanup();
      }
    },
    20_000,
  );
});

describe("the provider against a fake harness", () => {
  function provider(fixture: string, env: Record<string, string> = {}, kind = "claude" as const) {
    return new HarnessProvider({
      target: () => ({
        kind,
        command: [process.execPath, FAKE, join(FIX, fixture)],
        version: "2.1.281",
      }),
      env: { ...process.env, ...env },
    });
  }

  test("streams the answer, in an empty scratch folder, with the prompt on stdin", async () => {
    const t = tempDir();
    try {
      const record = join(t.dir, "record.json");
      const tokens: string[] = [];
      const r = await runProvider(
        provider("claude-ok.jsonl", { FAKE_RECORD: record }),
        { system: "SYS", prompt: "Reply with the word ok", maxTokens: 10 },
        (tok) => tokens.push(tok),
      );
      expect(r).toEqual({
        text: "ok",
        model: "claude-code/2.1.281",
        usage: { input: 2, cacheCreation: 2967, cacheRead: 0, output: 4 },
      });
      expect(tokens).toEqual(["ok"]);
      const rec = JSON.parse(readFileSync(record, "utf8"));
      expect(rec.prompt).toBe("Reply with the word ok");
      expect(rec.stdin).toBe(
        harnessStdin("claude", { system: "SYS", prompt: "Reply with the word ok", maxTokens: 10 }),
      );
      expect(rec.argv).toEqual(harnessArgs("claude", "SYS", undefined, "2.1.281"));
      expect(rec.cwdEntries).toEqual([]);
      // The scratch folder is gone afterwards.
      expect(existsSync(rec.cwd)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("a usage-limit exit is `exhausted` with its reset time", async () => {
    const err = await runProvider(
      provider("claude-usage-limit.synthetic.jsonl", { FAKE_EXIT: "1" }),
      { system: "S", prompt: "P", maxTokens: 10 },
      () => {},
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("exhausted");
    expect(err.resetsAt).toBe(1790236800 * 1000);
  });

  test("no answer within the deadline is `other`, and the harness is stopped", async () => {
    const t0 = performance.now();
    const err = await runProvider(
      provider("claude-ok.jsonl", { FAKE_DELAY_MS: "5000" }),
      { system: "S", prompt: "P", maxTokens: 10 },
      () => {},
      { timeoutMs: 300 },
    ).catch((e) => e);
    expect(err.kind).toBe("other");
    expect(err.message).toBe("no answer within 300 ms");
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  test("the caller's abort is `cancelled`", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const err = await runProvider(
      provider("claude-ok.jsonl", { FAKE_DELAY_MS: "5000" }),
      { system: "S", prompt: "P", maxTokens: 10 },
      () => {},
      { signal: ac.signal },
    ).catch((e) => e);
    expect(err.kind).toBe("cancelled");
  });

  describe.skipIf(process.platform === "win32")("a descendant holding its stdout (POSIX)", () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    async function withGrandchild(
      mode: "group" | "escape",
      env: Record<string, string>,
      run: (p: HarnessProvider, pidFile: string) => Promise<void>,
    ) {
      const t = tempDir();
      const pidFile = join(t.dir, "grandchild.pid");
      try {
        await run(
          provider("claude-ok.jsonl", {
            ...env,
            FAKE_GRANDCHILD: mode,
            FAKE_GRANDCHILD_PID: pidFile,
          }),
          pidFile,
        );
      } finally {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {}
        t.cleanup();
      }
    }

    test("cancel stops the harness's whole process group and answers `cancelled`", async () => {
      await withGrandchild("group", { FAKE_DELAY_MS: "5000" }, async (p, pidFile) => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 300);
        const t0 = performance.now();
        const err = await runProvider(p, { system: "S", prompt: "P", maxTokens: 10 }, () => {}, {
          signal: ac.signal,
        }).catch((e) => e);
        expect(err.kind).toBe("cancelled");
        expect(performance.now() - t0).toBeLessThan(4000);
        const pid = Number(readFileSync(pidFile, "utf8"));
        await Bun.sleep(200);
        expect(alive(pid)).toBe(false);
      });
    }, 10_000);

    test("the deadline still fires when an escaped descendant keeps the pipe open", async () => {
      await withGrandchild("escape", { FAKE_DELAY_MS: "5000" }, async (p) => {
        const t0 = performance.now();
        const err = await runProvider(p, { system: "S", prompt: "P", maxTokens: 10 }, () => {}, {
          timeoutMs: 300,
        }).catch((e) => e);
        expect(err.message).toBe("no answer within 300 ms");
        expect(performance.now() - t0).toBeLessThan(5000);
      });
    }, 10_000);

    test("a harness that answered and exited is done, even with the pipe still held", async () => {
      await withGrandchild("escape", {}, async (p, pidFile) => {
        const t0 = performance.now();
        const r = await runProvider(p, { system: "S", prompt: "P", maxTokens: 10 }, () => {});
        expect(r.text).toBe("ok");
        expect(performance.now() - t0).toBeLessThan(5000);
        // The escaped descendant is not ours to kill; it is still running.
        expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(true);
      });
    }, 10_000);
  });

  test("a program that is not there is `missing`", async () => {
    const p = new HarnessProvider({
      target: () => ({ kind: "claude", command: ["/nonexistent/claude"], version: null }),
    });
    const err = await p
      .complete({ system: "S", prompt: "P", maxTokens: 1 }, () => {}, new AbortController().signal)
      .catch((e) => e);
    expect(err.kind).toBe("missing");
  });

  test("an old Codex is refused before it runs", async () => {
    const p = new HarnessProvider({
      target: () => ({ kind: "codex", command: ["/x/codex"], version: "0.20.0" }),
    });
    const a = await p.available();
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toContain(`older than ${CODEX_MIN_JSON}`);
  });
});

describe("starting the harness before the question (#383)", () => {
  /** The fake's start-up: long enough that waiting for it shows, short enough for a test. */
  const START_MS = 1500;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (ok: () => boolean, ms = 5000) => {
    const end = performance.now() + ms;
    while (!ok() && performance.now() < end) await Bun.sleep(20);
    return ok();
  };
  function target(fixture: string, kind: "claude" | "codex" = "claude"): HarnessTarget {
    return {
      kind,
      command: [process.execPath, FAKE, join(FIX, fixture)],
      version: kind === "claude" ? "2.1.281" : "0.162.0",
    };
  }
  function rig(
    env: Record<string, string>,
    o: { idleMs?: number; kind?: "claude" | "codex" } = {},
  ) {
    const kind = o.kind ?? "claude";
    const fixture = kind === "claude" ? "claude-ok.jsonl" : "codex-ok.synthetic.jsonl";
    const spare = new HarnessSpare({ idleMs: o.idleMs ?? 30_000 });
    const t = target(fixture, kind);
    const provider = new HarnessProvider({
      target: () => t,
      env: { ...process.env, FAKE_START_MS: String(START_MS), ...env },
      spare,
    });
    return { spare, provider, t };
  }
  /** Asks one question and answers how long the first token took, from the request. */
  async function firstToken(
    p: HarnessProvider,
    system = "SYS",
    session?: { id: string; resume: boolean },
  ) {
    const t0 = performance.now();
    let first = -1;
    const r = await runProvider(
      p,
      { system, prompt: "When is the release?", maxTokens: 10, ...(session ? { session } : {}) },
      () => {
        if (first < 0) first = performance.now() - t0;
      },
    );
    return { first, text: r.text, askedAt: Date.now() - (performance.now() - t0) };
  }

  test("control: with no harness started early, the first token waits for the start-up", async () => {
    const { provider, spare } = rig({});
    const r = await firstToken(provider);
    expect(r.text).toBe("ok");
    expect(r.first).toBeGreaterThanOrEqual(START_MS);
    expect(spare.pid()).toBeNull();
  }, 15_000);

  test("started when the box asked, the question finds it up and the first token comes at once", async () => {
    const t = tempDir();
    try {
      const record = join(t.dir, "record.json");
      const { provider, spare } = rig({ FAKE_RECORD: record });
      expect(await provider.warm("SYS")).toEqual({ warming: true });
      const pid = spare.pid() as number;
      expect(alive(pid)).toBe(true);
      // The user types while the harness starts.
      await Bun.sleep(START_MS + 300);
      // Nothing was sent to it yet.
      expect(existsSync(record)).toBe(false);
      const r = await firstToken(provider);
      expect(r.text).toBe("ok");
      expect(r.first).toBeLessThan(START_MS / 2);
      const rec = JSON.parse(readFileSync(record, "utf8"));
      // The process that answered is the one started early, before the question...
      expect(rec.startedAt).toBeLessThan(r.askedAt - START_MS);
      // ...and it got the question only when it was asked.
      expect(rec.promptAt).toBeGreaterThanOrEqual(r.askedAt - 5);
      expect(rec.prompt).toBe("When is the release?");
      // Taken, it is no longer kept, and its scratch folder went with the answer.
      expect(spare.pid()).toBeNull();
      expect(existsSync(rec.cwd)).toBe(false);
      expect(await until(() => !alive(pid))).toBe(true);
    } finally {
      t.cleanup();
    }
  }, 15_000);

  test("Codex too: its start-up overlaps the wait for stdin", async () => {
    const { provider } = rig({}, { kind: "codex" });
    await provider.warm("SYS");
    await Bun.sleep(START_MS + 300);
    const r = await firstToken(provider);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.first).toBeLessThan(START_MS / 2);
  }, 15_000);

  test("asking again while one waits keeps that one; it is never sent anything and stops when idle", async () => {
    const t = tempDir();
    try {
      const record = join(t.dir, "record.json");
      const { provider, spare } = rig({ FAKE_RECORD: record, FAKE_START_MS: "0" }, { idleMs: 400 });
      await provider.warm("SYS");
      const pid = spare.pid() as number;
      await Bun.sleep(250);
      await provider.warm("SYS");
      expect(spare.pid()).toBe(pid);
      // 250 ms after the second warm, the first one's 400 ms have passed: still kept.
      await Bun.sleep(250);
      expect(spare.pid()).toBe(pid);
      expect(await until(() => spare.pid() === null, 2000)).toBe(true);
      expect(await until(() => !alive(pid))).toBe(true);
      // It ended with nothing on its stdin: no question reached it.
      const rec = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : { stdin: "" };
      expect(rec.stdin).toBe("");
      if (rec.cwd) expect(await until(() => !existsSync(rec.cwd))).toBe(true);
    } finally {
      t.cleanup();
    }
  }, 10_000);

  test("quit (clear) stops a waiting harness", async () => {
    const { provider, spare } = rig({ FAKE_START_MS: "0" });
    await provider.warm("SYS");
    const pid = spare.pid() as number;
    spare.clear();
    expect(spare.pid()).toBeNull();
    expect(await until(() => !alive(pid))).toBe(true);
  }, 10_000);

  test("a question with another system prompt, or a session, never takes it", async () => {
    const { provider, spare } = rig({});
    await provider.warm("SYS");
    const pid = spare.pid() as number;
    await Bun.sleep(START_MS + 300);
    // Enhance's system prompt is not the ask box's: a fresh harness answers, and the spare stops.
    const other = await firstToken(provider, "ANOTHER");
    expect(other.first).toBeGreaterThanOrEqual(START_MS);
    expect(spare.pid()).toBeNull();
    expect(await until(() => !alive(pid))).toBe(true);
    await provider.warm("SYS");
    const kept = spare.pid() as number;
    const withSession = await firstToken(provider, "SYS", {
      id: crypto.randomUUID(),
      resume: false,
    });
    expect(withSession.first).toBeGreaterThanOrEqual(START_MS);
    expect(spare.pid()).toBe(kept);
    spare.clear();
  }, 20_000);

  test("a harness that died while waiting is not used: the question starts a fresh one", async () => {
    const { provider, spare } = rig({ FAKE_START_MS: "0" });
    await provider.warm("SYS");
    const pid = spare.pid() as number;
    process.kill(pid, "SIGKILL");
    expect(await until(() => !alive(pid))).toBe(true);
    const r = await firstToken(provider);
    expect(r.text).toBe("ok");
    expect(spare.pid()).toBeNull();
  }, 10_000);

  test("no harness, no start: warm says why and starts nothing", async () => {
    const spare = new HarnessSpare();
    const p = new HarnessProvider({ target: () => ({ none: "no harness found" }), spare });
    expect(await p.warm("SYS")).toEqual({ warming: false, reason: "no harness found" });
    expect(spare.pid()).toBeNull();
  });

  test.skipIf(process.platform === "win32")(
    "when akou dies, the waiting harness exits on its own (its stdin closes)",
    async () => {
      const t = tempDir();
      try {
        const pidFile = join(t.dir, "spare.pid");
        const harness = join(import.meta.dir, "..", "src", "main", "llm", "harness.ts");
        const script = [
          `import { HarnessSpare } from ${JSON.stringify(harness)};`,
          "const s = new HarnessSpare();",
          `s.warm({ kind: "claude", command: [process.execPath, ${JSON.stringify(FAKE)}, ${JSON.stringify(join(FIX, "claude-ok.jsonl"))}], version: "2.1.281" }, "SYS", process.env);`,
          `await Bun.write(${JSON.stringify(pidFile)}, String(s.pid()));`,
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const owner = Bun.spawn([process.execPath, "-e", script], {
          stdio: ["ignore", "ignore", "inherit"],
        });
        expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "")).toBe(
          true,
        );
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(alive(pid)).toBe(true);
        owner.kill("SIGKILL");
        await owner.exited;
        expect(await until(() => !alive(pid))).toBe(true);
      } finally {
        t.cleanup();
      }
    },
    15_000,
  );
});
