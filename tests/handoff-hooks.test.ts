/**
 * Post-call hooks and the webhook (docs/DESIGN.md section 8.2, items 2 and 3): the JSON a hook
 * reads on stdin, its environment, its log, its timeout, and the signed webhook with its retries.
 * The hooks are small Bun scripts run through the same `bun`, so the suite runs on every OS.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fold } from "../src/core/log/fold.ts";
import { validateHooks, validateSetting } from "../src/main/config/schema.ts";
import {
  buildPayload,
  EXIT_TIMEOUT,
  HOOK_LOG,
  HOOK_OUTPUT_CAP,
  hookName,
  hooksFor,
  runHook,
} from "../src/main/handoff/hooks.ts";
import {
  redactUrl,
  sendWebhook,
  signBody,
  webhookDoneDraft,
  webhookProblem,
} from "../src/main/handoff/webhook.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const S = 1000;
const BUN = process.execPath;

function call() {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.add({
    type: "vocab.add",
    id: "v0001",
    rev: 1,
    term: "Kubernetes",
    heard: ["kubernetis"],
    by: "user",
  });
  b.seg({ id: "l000001", ch: "mic", spk: "you", w0: T0 + S, text: "hi" });
  b.seg({ id: "l000002", spk: "c1", w0: T0 + 2 * S, text: "on kubernetis" });
  b.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
  b.add({
    type: "note",
    id: "n0001",
    rev: 1,
    text: "ship it",
    w: T0 + 3 * S,
    afterSeq: 4,
    by: "user",
  });
  b.add({ type: "remember", id: "r0001", rev: 1, text: "Ben owns the build", by: "agent:codex" });
  b.partEnded(1, "stop", 60);
  b.add({ type: "call.ended", reason: "stop" });
  return fold(b.events);
}

let dir: string;
let cleanup: () => void;
let scripts: string;

beforeAll(() => {
  const t = tempDir("akou-hooks-");
  dir = join(t.dir, "call");
  mkdirSync(join(dir, "logs"), { recursive: true });
  cleanup = t.cleanup;
  scripts = join(t.dir, "scripts");
  mkdirSync(scripts);
  // Writes what it was given (stdin and the akou variables) next to itself, then prints and exits.
  writeFileSync(
    join(scripts, "record.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      "const input = await Bun.stdin.text();",
      "const env = { id: process.env.AKOU_CALL_ID, dir: process.env.AKOU_CALL_DIR, stage: process.env.AKOU_STAGE, cwd: process.cwd() };",
      "writeFileSync(process.argv[2], JSON.stringify({ input, env }));",
      'console.log("recorded");',
      'console.error("a warning");',
      "process.exit(Number(process.argv[3] ?? 0));",
    ].join("\n"),
  );
  writeFileSync(join(scripts, "sleep.ts"), "await Bun.sleep(30_000);\n");
  writeFileSync(join(scripts, "deaf.ts"), 'console.log("never read stdin");\n');
  // Writes its pid to argv[2], then sleeps; with argv[3] = "stubborn" it ignores SIGTERM.
  writeFileSync(
    join(scripts, "pidsleep.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      'if (process.argv[3] === "stubborn") process.on("SIGTERM", () => {});',
      "writeFileSync(process.argv[2], String(process.pid));",
      "await Bun.sleep(30_000);",
    ].join("\n"),
  );
  writeFileSync(join(scripts, "loud.ts"), 'process.stdout.write("x".repeat(600 * 1024));\n');
});

afterAll(() => cleanup());

describe("hooks (DESIGN 8.2)", () => {
  test("the payload has the design's shape: corrected text, heard kept, names, wall clocks", () => {
    const p = buildPayload({
      stage: "final.done",
      view: call(),
      dir,
      version: "0.1.0",
      exportMd: "/x.md",
    });
    expect(Object.keys(p)).toEqual([
      "version",
      "stage",
      "call",
      "paths",
      "transcript",
      "notes",
      "remember",
      "enhancedMd",
    ]);
    expect(p.version).toBe(1);
    expect(p.call).toMatchObject({
      akou_id: "01J8Z6Q4M2VX0K7B3D4E5F6G7H",
      title: "Weekly sync",
      start: "2026-09-23T15:36:12-05:00",
      participants: ["Ana (you)", "Ben"],
      dir,
    });
    expect(p.paths).toEqual({ events: join(dir, "events.jsonl"), audio: [], exportMd: "/x.md" });
    expect(p.transcript[1]).toEqual({
      id: "l000002",
      w0: T0 + 2 * S,
      w1: T0 + 3 * S,
      clock: "15:36:14",
      speaker: "c1",
      name: "Ben",
      ch: "call",
      text: "on Kubernetes",
      heard: "on kubernetis",
    });
    expect(p.transcript[0]).not.toHaveProperty("heard");
    expect(p.notes).toEqual([
      { id: "n0001", text: "ship it", w: T0 + 3 * S, clock: "15:36:15", by: "user" },
    ]);
    expect(p.remember).toEqual([{ id: "r0001", text: "Ben owns the build", by: "agent:codex" }]);
    expect(p.enhancedMd).toBeNull();
  });

  test("a hook gets the JSON on stdin and the call in its environment; output goes to the log", async () => {
    const out = join(scripts, "got-1.json");
    const payload = JSON.stringify({ hello: "world" });
    const run = await runHook({
      hook: { stage: "call.ended", command: [BUN, join(scripts, "record.ts"), out] },
      stage: "call.ended",
      payload,
      callId: "01TESTCALL",
      callDir: dir,
    });
    expect(run).toMatchObject({ name: basename(BUN), exit: 0, timedOut: false });
    const got = JSON.parse(readFileSync(out, "utf8"));
    expect(got.input).toBe(payload);
    expect(got.env).toMatchObject({ id: "01TESTCALL", dir, stage: "call.ended" });
    const log = readFileSync(join(dir, HOOK_LOG), "utf8");
    expect(log).toContain(`stage=call.ended hook=${basename(BUN)}`);
    expect(log).toContain("recorded");
    expect(log).toContain("a warning");
    expect(log).toContain("=== exit=0");
  });

  test("a string command runs through the shell, and a failing hook's exit code is kept", async () => {
    const out = join(scripts, "got-2.json");
    const q = (s: string) => JSON.stringify(s);
    const run = await runHook({
      hook: {
        stage: "enhanced",
        command: `${q(BUN)} ${q(join(scripts, "record.ts"))} ${q(out)} 3`,
        name: "fails",
      },
      stage: "enhanced",
      payload: "{}",
      callId: "c",
      callDir: dir,
    });
    expect(run).toMatchObject({ name: "fails", exit: 3, timedOut: false });
    expect(JSON.parse(readFileSync(out, "utf8")).env.stage).toBe("enhanced");
  });

  test("a hook past its timeout is killed and recorded as exit 124, without waiting it out", async () => {
    const t0 = performance.now();
    const run = await runHook({
      hook: { stage: "final.done", command: [BUN, join(scripts, "sleep.ts")], timeoutSec: 1 },
      stage: "final.done",
      payload: "{}",
      callId: "c",
      callDir: dir,
    });
    expect(run).toMatchObject({ exit: EXIT_TIMEOUT, timedOut: true });
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(readFileSync(join(dir, HOOK_LOG), "utf8")).toContain("(timed out)");
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  for (const mode of ["", "stubborn"]) {
    test.skipIf(process.platform === "win32")(
      `past its timeout the whole group is killed, not just the shell${mode ? " (SIGTERM ignored)" : ""}`,
      async () => {
        const pidFile = join(scripts, `pid-${mode || "plain"}.txt`);
        const q = (x: string) => JSON.stringify(x);
        const run = await runHook({
          hook: {
            stage: "call.ended",
            // A string hook: the work is a grandchild of the shell.
            command: `${q(BUN)} ${q(join(scripts, "pidsleep.ts"))} ${q(pidFile)} ${mode}; echo done`,
            timeoutSec: 1,
          },
          stage: "call.ended",
          payload: "{}",
          callId: "c",
          callDir: dir,
        });
        expect(run).toMatchObject({ exit: EXIT_TIMEOUT, timedOut: true });
        const pid = Number(readFileSync(pidFile, "utf8"));
        const t0 = performance.now();
        while (alive(pid) && performance.now() - t0 < 5000) await Bun.sleep(100);
        const survived = alive(pid);
        if (survived) process.kill(pid, "SIGKILL");
        expect(survived).toBe(false);
      },
      15_000,
    );
  }

  test("a hook's output past the cap is dropped, and the log says so", async () => {
    const logPath = join(dir, HOOK_LOG);
    const before = readFileSync(logPath, "utf8").length;
    const run = await runHook({
      hook: { stage: "call.ended", command: [BUN, join(scripts, "loud.ts")], name: "loud" },
      stage: "call.ended",
      payload: "{}",
      callId: "c",
      callDir: dir,
    });
    expect(run.exit).toBe(0);
    const added = readFileSync(logPath, "utf8").slice(before);
    expect(added).toContain(`[output past ${HOOK_OUTPUT_CAP} bytes dropped]`);
    expect(added.length).toBeLessThan(HOOK_OUTPUT_CAP + 4096);
    // Positive control: the hook did print more than the cap.
    expect(600 * 1024).toBeGreaterThan(HOOK_OUTPUT_CAP);
  });

  test("a hook that never reads stdin, or cannot start, is a result, never a crash", async () => {
    const deaf = await runHook({
      hook: { stage: "call.ended", command: [BUN, join(scripts, "deaf.ts")] },
      stage: "call.ended",
      payload: "x".repeat(1_000_000),
      callId: "c",
      callDir: dir,
    });
    expect(deaf.exit).toBe(0);
    const missing = await runHook({
      hook: { stage: "call.ended", command: [join(scripts, "no-such-program")] },
      stage: "call.ended",
      payload: "{}",
      callId: "c",
      callDir: dir,
    });
    expect(missing.exit).toBe(127);
  });

  test("hooks run for their stage and workspace only", () => {
    const all = [
      { stage: "call.ended" as const, command: "a" },
      { stage: "call.ended" as const, command: "b", workspace: "personal" },
      { stage: "final.done" as const, command: "c" },
    ];
    expect(hooksFor(all, "call.ended", "work").map((h) => h.command)).toEqual(["a"]);
    expect(hooksFor(all, "call.ended", "personal").map((h) => h.command)).toEqual(["a", "b"]);
    expect(hookName({ stage: "enhanced", command: "/usr/local/bin/commit.sh --all" })).toBe(
      "commit.sh",
    );
  });

  test("the hooks setting is validated: stages, commands and nothing unknown", () => {
    expect(validateHooks([{ stage: "final.done", command: ["x", "y"], timeoutSec: 30 }])).toEqual({
      ok: true,
      value: [{ stage: "final.done", command: ["x", "y"], timeoutSec: 30 }],
    });
    expect(validateHooks([{ stage: "done", command: "x" }]).ok).toBe(false);
    expect(validateHooks([{ stage: "enhanced", command: "" }]).ok).toBe(false);
    expect(validateHooks([{ stage: "enhanced", command: "x", shell: true }]).ok).toBe(false);
    expect(validateHooks([{ stage: "enhanced", command: "x", timeoutSec: 0 }]).ok).toBe(false);
    expect(validateSetting("hooks", "x").ok).toBe(false);
  });
});

describe("the webhook (DESIGN 8.2)", () => {
  let server: ReturnType<typeof Bun.serve>;
  const got: { event: string | null; sig: string | null; delivery: string | null; body: string }[] =
    [];
  let answers: number[] = [];

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        got.push({
          event: req.headers.get("x-akou-event"),
          sig: req.headers.get("x-akou-signature"),
          delivery: req.headers.get("x-akou-delivery"),
          body: await req.text(),
        });
        const status = answers.shift() ?? 200;
        const headers: Record<string, string> =
          status >= 300 && status < 400
            ? { location: `http://127.0.0.1:${server.port}/moved` }
            : {};
        return new Response("ok", { status, headers });
      },
    });
  });
  afterAll(() => server.stop(true));

  const url = () => `http://127.0.0.1:${server.port}/hooks/secret-path?token=abc`;
  const noWait = { backoffMs: [0, 0, 0], version: "0.1.0" };

  test("signed with HMAC-SHA256 over the exact body, with the stage as the event name", async () => {
    got.length = 0;
    const body = JSON.stringify({ version: 1, stage: "final.done" });
    const r = await sendWebhook({
      url: url(),
      secret: "s3cret",
      stage: "final.done",
      body,
      ...noWait,
    });
    expect(r).toEqual({ status: 200, attempts: 1 });
    const want = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(got[0]).toMatchObject({ event: "final.done", sig: want, body });
    expect(signBody("s3cret", body)).toBe(want);
    // Positive control: another secret gives another signature.
    expect(signBody("other", body)).not.toBe(want);
  });

  test("retries a 5xx with the same delivery id; a 4xx is final", async () => {
    got.length = 0;
    answers = [503, 500, 200];
    const r = await sendWebhook({
      url: url(),
      secret: "s",
      stage: "enhanced",
      body: "{}",
      ...noWait,
    });
    expect(r).toEqual({ status: 200, attempts: 3 });
    expect(new Set(got.map((g) => g.delivery)).size).toBe(1);
    got.length = 0;
    answers = [400];
    expect(
      await sendWebhook({ url: url(), secret: "s", stage: "enhanced", body: "{}", ...noWait }),
    ).toEqual({
      status: 400,
      attempts: 1,
    });
  });

  test("a redirect is final: the signed body is never posted on to where it points", async () => {
    got.length = 0;
    answers = [307];
    const r = await sendWebhook({
      url: url(),
      secret: "s",
      stage: "enhanced",
      body: "{}",
      ...noWait,
    });
    expect(r).toEqual({ status: 307, attempts: 1 });
    expect(got).toHaveLength(1);
  });

  test("three retries, then status 0 when nothing answers", async () => {
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = dead.port;
    dead.stop(true);
    const r = await sendWebhook({
      url: `http://127.0.0.1:${port}/`,
      secret: "s",
      stage: "call.ended",
      body: "{}",
      ...noWait,
    });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(4);
    expect(r.error).toBeString();
  });

  test("the log keeps the address without its path or query; an unsigned webhook is never sent", () => {
    const d = webhookDoneDraft(url(), { status: 200, attempts: 1 });
    expect(d).toEqual({
      type: "webhook.done",
      url: `http://127.0.0.1:${server.port}/…`,
      status: 200,
      attempts: 1,
    });
    expect(JSON.stringify(d)).not.toContain("secret-path");
    expect(redactUrl("https://example.com")).toBe("https://example.com");
    expect(webhookProblem(url(), "")).toContain("never sends an unsigned webhook");
    expect(webhookProblem("ftp://x", "s")).toContain("http or https");
    expect(webhookProblem(url(), "s")).toBeNull();
  });
});
