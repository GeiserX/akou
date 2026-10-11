/**
 * A stand-in for `claude` or `codex` in tests: it never calls a model. It reads its prompt from
 * stdin, then replays a recorded JSON-lines fixture on stdout, a line at a time.
 *
 *   bun fake-harness.ts FIXTURE [harness arguments...]
 *
 * With `--input-format stream-json` among the arguments it reads as Claude Code does then: one
 * JSON user message per line, with stdin left open. It replays the fixture after the first
 * message and, when the fixture held a `result`, waits for stdin to close before it exits. Stdin
 * closing before any message ends it with exit 1, as both real harnesses do with no prompt.
 *
 * Environment: `FAKE_EXIT` (exit code, default 0), `FAKE_STDERR` (a file copied to stderr),
 * `FAKE_START_MS` (start-up work before stdin is read, as the real harnesses do theirs while
 * waiting for it), `FAKE_DELAY_MS` (a pause after the prompt, before the first line, to test
 * deadlines and cancelling), `FAKE_RECORD` (a file that receives `{argv, cwd, cwdEntries, stdin,
 * prompt, startedAt, promptAt}` as JSON: `stdin` as read, `prompt` the message's text in
 * stream-json mode, the two times in epoch ms), `FAKE_PIDFILE` (a file that receives this
 * process's pid as soon as it starts), `FAKE_ARGVFILE` (a file that receives its arguments as JSON
 * as soon as it starts), `FAKE_EXIT_FIRST` (a file: the first run, finding it absent, creates it and
 * exits 1 after `FAKE_EXIT_FIRST_MS` without reading stdin or writing a line; later runs go on as
 * usual), `FAKE_READYFILE` (a file written once its start-up is done
 * and it waits for stdin), `FAKE_GRANDCHILD` (`group` or `escape`: start a
 * long-lived child that inherits stdout, in the harness's process group or in a session of its
 * own, and write its pid to `FAKE_GRANDCHILD_PID`).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const startedAt = Date.now();
if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
if (process.env.FAKE_ARGVFILE) {
  writeFileSync(process.env.FAKE_ARGVFILE, JSON.stringify(process.argv.slice(3)));
}
const [fixture, ...args] = process.argv.slice(2);
const streamJson = args.some((a, i) => a === "--input-format" && args[i + 1] === "stream-json");
const exitFirst = process.env.FAKE_EXIT_FIRST;
if (exitFirst && !existsSync(exitFirst)) {
  writeFileSync(exitFirst, String(process.pid));
  await Bun.sleep(Number(process.env.FAKE_EXIT_FIRST_MS ?? 0));
  process.exit(1);
}
const start = Number(process.env.FAKE_START_MS ?? 0);
if (start > 0) await Bun.sleep(start);
if (process.env.FAKE_READYFILE) writeFileSync(process.env.FAKE_READYFILE, String(Date.now()));

const reader = Bun.stdin.stream().getReader();
const dec = new TextDecoder();
let pending = "";
/** Stdin up to the first newline (stream-json), or all of it; null when it closed with nothing. */
async function readPrompt(): Promise<string | null> {
  for (;;) {
    const nl = pending.indexOf("\n");
    if (streamJson && nl >= 0) {
      const line = pending.slice(0, nl + 1);
      pending = pending.slice(nl + 1);
      return line;
    }
    const { done, value } = await reader.read();
    if (done) {
      const all = pending;
      pending = "";
      return all === "" ? null : all;
    }
    pending += dec.decode(value, { stream: true });
  }
}
const stdin = await readPrompt();
const promptAt = Date.now();
let prompt = stdin ?? "";
if (streamJson && stdin !== null) {
  prompt = (JSON.parse(stdin) as { message: { content: string } }).message.content;
}
if (process.env.FAKE_RECORD) {
  writeFileSync(
    process.env.FAKE_RECORD,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      cwdEntries: readdirSync(process.cwd()),
      stdin: stdin ?? "",
      prompt,
      startedAt,
      promptAt,
    }),
  );
}
if (stdin === null) process.exit(1);
const grandchild = process.env.FAKE_GRANDCHILD;
if (grandchild === "group" || grandchild === "escape") {
  const g = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: grandchild === "escape",
  });
  g.unref();
  writeFileSync(process.env.FAKE_GRANDCHILD_PID as string, String(g.pid));
}
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
if (delay > 0) await Bun.sleep(delay);
if (process.env.FAKE_STDERR) process.stderr.write(readFileSync(process.env.FAKE_STDERR));
let sawResult = false;
for (const line of readFileSync(fixture as string, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  process.stdout.write(`${line}\n`);
  if (line.includes('"type":"result"')) sawResult = true;
  await Bun.sleep(1);
}
// Claude Code with stream-json input waits for more messages until stdin closes.
if (streamJson && sawResult) while (!(await reader.read()).done) {}
process.exit(Number(process.env.FAKE_EXIT ?? 0));
