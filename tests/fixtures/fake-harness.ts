/**
 * A stand-in for `claude` or `codex` in tests: it never calls a model. It reads its prompt from
 * stdin, then replays a recorded JSON-lines fixture on stdout, a line at a time.
 *
 *   bun fake-harness.ts FIXTURE [harness arguments...]
 *
 * Environment: `FAKE_EXIT` (exit code, default 0), `FAKE_STDERR` (a file copied to stderr),
 * `FAKE_DELAY_MS` (a pause before the first line, to test deadlines and cancelling),
 * `FAKE_RECORD` (a file that receives `{argv, cwd, cwdEntries, stdin}` as JSON),
 * `FAKE_GRANDCHILD` (`group` or `escape`: start a long-lived child that inherits stdout, in the
 * harness's process group or in a session of its own, and write its pid to `FAKE_GRANDCHILD_PID`).
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const [fixture, ...args] = process.argv.slice(2);
const stdin = await new Response(Bun.stdin.stream()).text();
if (process.env.FAKE_RECORD) {
  writeFileSync(
    process.env.FAKE_RECORD,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      cwdEntries: readdirSync(process.cwd()),
      stdin,
    }),
  );
}
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
for (const line of readFileSync(fixture as string, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  process.stdout.write(`${line}\n`);
  await Bun.sleep(1);
}
process.exit(Number(process.env.FAKE_EXIT ?? 0));
