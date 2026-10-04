/**
 * ROADMAP G7, harness provider: Claude Code and Codex run by the app itself, answering a question
 * about a call over the streaming ask route (`POST /calls/{id}/ask` with `stream`, the route the
 * window's ask box uses), with the time to the first token measured from the request.
 *
 *   AKOU_HOME=<scratch home> bun scripts/gates/g7-harness.ts --cli <cli.ts | akou>
 *     (--fake | --real --yes) [--harness claude,codex] [--out result.json]
 *
 * `--cli` is `src/main/cli/cli.ts` (run with Bun, the app from source) or a compiled `akou`, which
 * starts the installed `akou.app`: the packaged app G7 asks for. Every case quits the app, writes
 * the provider settings into `config.json` under `AKOU_HOME` (`provider.harnessPath` can only be
 * set there), and lets the next command start the app again. The first case imports a fixture call
 * (tests/fixtures/hark-viewer.ts: made-up lines, "the release is on friday" among them).
 *
 * - **Control, every run.** `provider.harnessPath` pinned to a file that does not exist: the answer
 *   must be the excerpts with `errorKind: "missing"`. A runner that never reached the harness would
 *   fail it.
 * - **`--fake`** spends nothing. Per harness, a stand-in program (tests/fixtures/fake-harness.ts)
 *   named after it replays a recorded stream: the `ok` recording must stream tokens and answer;
 *   the usage-limit recording, exiting 1, must give the excerpts only, `errorKind: "exhausted"`,
 *   and no token.
 * - **`--real --yes`** asks each real harness one question, on the owner's subscription, with the
 *   harness's own global context (user-level instructions, memory, skills) loaded as on any run.
 *   `provider.harnessPath` is empty, and the CLI and so the app run with `PATH` cut to the system
 *   folders, so the app can only find the harness through the login shell. It must stream tokens
 *   and answer.
 *
 * Prints one JSON object with a verdict per case and exits 1 when any case fails.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_FILE } from "../../src/main/api/guard.ts";
import { writeHarkViewerCall } from "../../tests/fixtures/hark-viewer.ts";

type Kind = "claude" | "codex";
type Expect = "answer" | "exhausted" | "missing";

const ROOT = join(import.meta.dir, "..", "..");
const FIX = join(ROOT, "tests", "fixtures", "harness");
const FAKE_HARNESS = join(ROOT, "tests", "fixtures", "fake-harness.ts");
const QUESTION = "When is the release?";
/** The folders an app opened from Finder gets on its PATH; a harness is not in any of them. */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cliPath = opt("--cli");
const home = process.env.AKOU_HOME;
const fake = argv.includes("--fake");
const real = argv.includes("--real");
if (!cliPath || !home || fake === real) {
  throw new Error("AKOU_HOME, --cli and one of --fake or --real are required");
}
if (real && !argv.includes("--yes")) {
  throw new Error("--real asks each harness a question on your subscription; add --yes");
}
const kinds = (opt("--harness") ?? "claude,codex").split(",") as Kind[];
for (const k of kinds) if (k !== "claude" && k !== "codex") throw new Error(`no harness ${k}`);

const configDir = join(home, ".config", "akou");
const configFile = join(configDir, "config.json");
const cliCommand = cliPath.endsWith(".ts") ? [process.execPath, cliPath] : [cliPath];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), "akou-g7-"));

async function cli(args: string[], env: Record<string, string | undefined> = process.env) {
  const p = Bun.spawn([...cliCommand, ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  return { code: await p.exited, out: out.trim(), err: err.trim() };
}

function runtime(): { pid: number; port: number } | null {
  try {
    return JSON.parse(readFileSync(join(configDir, "runtime.json"), "utf8"));
  } catch {
    return null;
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function quit(): Promise<void> {
  const rt = runtime();
  if (!rt || !alive(rt.pid)) return;
  await cli(["quit"]);
  for (let i = 0; alive(rt.pid) && i < 200; i++) await sleep(50);
  if (alive(rt.pid)) throw new Error(`the app (pid ${rt.pid}) did not quit`);
}

/** The app quit, the provider settings written, and the app started again by a command. */
async function restartWith(
  settings: Record<string, string | number>,
  env = process.env,
): Promise<void> {
  await quit();
  let cfg: Record<string, unknown> = {};
  if (existsSync(configFile)) cfg = JSON.parse(readFileSync(configFile, "utf8"));
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // Port 0: a free port, so another akou on this machine never stands in for the app under test.
  writeFileSync(configFile, JSON.stringify({ ...cfg, "api.port": 0, ...settings }, null, 2));
  // `status` never starts the app; any command that reads it does.
  const st = await cli(["workspaces"], env);
  if (st.code !== 0) throw new Error(`akou workspaces after the restart: ${st.err || st.out}`);
}

/** A program named after the harness that replays a recorded stream and exits with `code`. */
function fakeHarness(kind: Kind, recording: string, code: number): string {
  const dir = mkdtempSync(join(work, `${kind}-`));
  const program = join(dir, kind);
  writeFileSync(
    program,
    `#!/bin/sh\nFAKE_EXIT=${code} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_HARNESS)} ${JSON.stringify(join(FIX, recording))} "$@"\n`,
  );
  chmodSync(program, 0o755);
  return program;
}

/** `GET /status`'s provider, once the app has finished looking for a harness (up to 30 s). */
async function providerReady(): Promise<Record<string, unknown>> {
  const rt = runtime();
  if (!rt) throw new Error("the app is not running");
  const token = readFileSync(join(configDir, TOKEN_FILE), "utf8").trim();
  let provider: Record<string, unknown> = {};
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`http://127.0.0.1:${rt.port}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    provider = ((await res.json()) as { provider?: Record<string, unknown> }).provider ?? {};
    if (provider.state !== "checking") break;
    await sleep(100);
  }
  return provider;
}

interface Asked {
  status: number;
  excerptsMs: number | null;
  firstTokenMs: number | null;
  tokens: number;
  answerMs: number | null;
  answer: { answered?: boolean; errorKind?: string; reason?: string; text?: string } | null;
}

/** One question over the streaming ask route, every event timed from the request. */
async function ask(call: string): Promise<Asked> {
  const rt = runtime();
  if (!rt) throw new Error("the app is not running");
  const token = readFileSync(join(configDir, TOKEN_FILE), "utf8").trim();
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${rt.port}/v1/calls/${call}/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ question: QUESTION, stream: true }),
    signal: AbortSignal.timeout(300_000),
  });
  const out: Asked = {
    status: res.status,
    excerptsMs: null,
    firstTokenMs: null,
    tokens: 0,
    answerMs: null,
    answer: null,
  };
  if (!res.body) return out;
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    for (let at = buf.indexOf("\n\n"); at >= 0; at = buf.indexOf("\n\n")) {
      const block = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      const ms = Math.round(performance.now() - t0);
      if (event === "excerpts") out.excerptsMs ??= ms;
      if (event === "token") {
        out.firstTokenMs ??= ms;
        out.tokens++;
      }
      if (event === "answer" && data) {
        out.answerMs = ms;
        out.answer = JSON.parse(data);
      }
    }
  }
  return out;
}

/** What failed against `expect`; empty when the case passed. */
function judge(a: Asked, expect: Expect): string[] {
  const bad: string[] = [];
  if (a.status !== 200) bad.push(`status ${a.status}`);
  if (!a.answer) return [...bad, "no answer event"];
  if (expect === "answer") {
    if (a.answer.answered !== true) bad.push(`not answered: ${a.answer.reason ?? "no reason"}`);
    if (a.tokens === 0) bad.push("no token streamed");
  } else {
    if (a.answer.answered !== false) bad.push("answered, where only excerpts were expected");
    if (a.answer.errorKind !== expect) bad.push(`errorKind ${a.answer.errorKind}, not ${expect}`);
    if (a.tokens > 0) bad.push(`${a.tokens} tokens streamed from a run that failed`);
    if (!/friday/i.test(a.answer.text ?? "")) bad.push("the excerpts lack the fixture's line");
  }
  return bad;
}

const cases: {
  name: string;
  ok: boolean;
  problems: string[];
  provider: Record<string, unknown>;
  asked: Asked;
}[] = [];
async function runCase(
  name: string,
  call: string,
  settings: Record<string, string>,
  expect: Expect,
  env = process.env,
): Promise<void> {
  await restartWith({ "provider.kind": "harness", ...settings }, env);
  const provider = await providerReady();
  const asked = await ask(call);
  const problems = judge(asked, expect);
  cases.push({ name, ok: problems.length === 0, problems, provider, asked });
  console.error(`${problems.length === 0 ? "ok  " : "FAIL"} ${name} ${problems.join("; ")}`);
}

try {
  // The fixture call, imported through the running app.
  await restartWith({ "provider.kind": "harness" });
  const folder = writeHarkViewerCall(join(work, "hark"), "2026-09-21_153038_release-sync", {
    parts: 1,
  });
  const imp = await cli(["import", "hark-viewer", folder]);
  if (imp.code !== 0) throw new Error(`import: ${imp.err || imp.out}`);
  const call: string = JSON.parse(imp.out).imported?.[0]?.call ?? "last";

  await runCase(
    "control: a pinned harness that does not exist",
    call,
    { "provider.harness": "auto", "provider.harnessPath": join(work, "no-such", "claude") },
    "missing",
  );
  for (const kind of kinds) {
    if (fake) {
      const okFile = kind === "claude" ? "claude-ok.jsonl" : "codex-ok.synthetic.jsonl";
      await runCase(
        `${kind}: a recorded answer streams`,
        call,
        { "provider.harness": kind, "provider.harnessPath": fakeHarness(kind, okFile, 0) },
        "answer",
      );
      await runCase(
        `${kind}: a usage limit gives the excerpts only`,
        call,
        {
          "provider.harness": kind,
          "provider.harnessPath": fakeHarness(kind, `${kind}-usage-limit.synthetic.jsonl`, 1),
        },
        "exhausted",
      );
    } else {
      await runCase(
        `${kind}: the real harness, found through the login shell, streams an answer`,
        call,
        { "provider.harness": kind, "provider.harnessPath": "" },
        "answer",
        { ...process.env, PATH: SYSTEM_PATH },
      );
    }
  }
  await quit();
} finally {
  rmSync(work, { recursive: true, force: true });
}

const result = {
  gate: "G7",
  mode: fake ? "fake" : "real",
  cli: cliPath,
  question: QUESTION,
  ok: cases.every((c) => c.ok),
  cases,
};
const text = JSON.stringify(result, null, 2);
const out = opt("--out");
if (out) writeFileSync(out, `${text}\n`);
console.log(text);
process.exit(result.ok ? 0 : 1);
