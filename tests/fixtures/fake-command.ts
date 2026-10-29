/**
 * A stand-in for a user's own `provider.command` in tests: it never calls a model. It reads its
 * prompt from stdin until stdin closes, then prints an answer on stdout.
 *
 *   bun fake-command.ts [arguments...]
 *
 * Environment: `FAKE_RECORD` (a file that receives `{argv, stdin, env}` as JSON, `env` holding the
 * AKOU_* variables), `FAKE_ANSWER` (what to print, default "The answer [15:41 Ben]."),
 * `FAKE_EXIT` (exit code, default 0), `FAKE_STDERR` (text written to stderr before exiting),
 * `FAKE_DELAY_MS` (a pause before answering, for deadlines and cancelling), `FAKE_PIDFILE` (a
 * file that receives this process's pid), `FAKE_ESCAPE_PID` (start a long-lived child in a
 * session of its own that inherits stdout, and write its pid to this file).
 */

import { writeFileSync } from "node:fs";

if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
const stdin = await Bun.stdin.text();
if (process.env.FAKE_RECORD) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith("AKOU_")),
  );
  writeFileSync(
    process.env.FAKE_RECORD,
    JSON.stringify({ argv: process.argv.slice(2), stdin, env }),
  );
}
if (process.env.FAKE_ESCAPE_PID) {
  const g = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });
  g.unref();
  writeFileSync(process.env.FAKE_ESCAPE_PID, String(g.pid));
}
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
if (delay > 0) await Bun.sleep(delay);
if (process.env.FAKE_STDERR) process.stderr.write(`${process.env.FAKE_STDERR}\n`);
const code = Number(process.env.FAKE_EXIT ?? 0);
if (code === 0) process.stdout.write(process.env.FAKE_ANSWER ?? "The answer [15:41 Ben].");
process.exit(code);
