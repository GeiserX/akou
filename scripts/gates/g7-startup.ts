/**
 * G7, the harness's start-up (#383): times one spawn of Claude Code or Codex with the command line
 * akou uses, outside the app, so the start can be split from the model's answer.
 *
 *   bun scripts/gates/g7-startup.ts <label> <holdMs> [--stream-json] [--] <harness> [extra args...]
 *
 * The prompt goes on stdin `holdMs` after the spawn: 0 is a question that starts the harness, a
 * few seconds is the ask box starting it early while the user types. `--stream-json` gives Claude
 * Code akou's stream-json input (in text mode it gives up after 3 s with no stdin). Extra args go
 * before the system prompt, for example `--safe-mode` or `--settings '{"disableAllHooks":true}'`;
 * set `CLAUDE_CONFIG_DIR` to time another user context.
 *
 * Prints one JSON line, every time in ms from the spawn: `init` (Claude Code's `system/init`, Codex
 * `thread.started`), `api` (the first event that needed the model's API: a rate-limit event, a
 * message, a stream event or a Codex item), `text` (the first text), `apiAfterWrite` (`api` from the
 * moment the prompt was written, the figure a question waits for), `done`, and the exit code.
 * Spends one small question from the harness's account.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const sj = argv.includes("--stream-json");
const rest = argv.filter((a) => a !== "--stream-json" && a !== "--");
const [label, holdText, harness, ...extra] = rest;
if (!label || holdText === undefined || !harness) {
  throw new Error("usage: g7-startup.ts <label> <holdMs> [--stream-json] <harness> [extra...]");
}
const hold = Number(holdText);
const kind = harness.includes("codex") ? "codex" : "claude";
const SYSTEM =
  "You answer a question about a call from the context pack you are given, and from nothing else.\nAnswer briefly and plainly.";
const question = "[17:30 Speaker 1] The release is on Friday.\n\nQuestion: When is the release?";
const args =
  kind === "claude"
    ? [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        ...(sj ? ["--input-format", "stream-json"] : []),
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        ...extra,
        "--system-prompt",
        SYSTEM,
      ]
    : [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        ...extra,
        "-",
      ];
const prompt =
  kind === "codex"
    ? `${SYSTEM}\n\n${question}`
    : sj
      ? `${JSON.stringify({ type: "user", message: { role: "user", content: question } })}\n`
      : question;

const dir = mkdtempSync(join(tmpdir(), "akou-g7-startup-"));
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const p = Bun.spawn([harness, ...args], {
  cwd: dir,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
let init = -1;
let api = -1;
let text = -1;
let write = -1;
void (async () => {
  await Bun.sleep(hold);
  write = ms();
  p.stdin.write(prompt);
  if (sj) await p.stdin.flush();
  else await p.stdin.end();
})();
const dec = new TextDecoder();
let buf = "";
for await (const chunk of p.stdout) {
  buf += dec.decode(chunk, { stream: true });
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let e: {
      type?: string;
      subtype?: string;
      event?: { delta?: { type?: string } };
      item?: { type?: string };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const type = e.type ?? "";
    if (init < 0 && ((type === "system" && e.subtype === "init") || type === "thread.started"))
      init = ms();
    const usedApi =
      ["rate_limit_event", "assistant", "stream_event", "turn.failed", "error"].includes(type) ||
      type.startsWith("item.");
    if (api < 0 && usedApi) api = ms();
    const isText =
      (type === "stream_event" && e.event?.delta?.type === "text_delta") ||
      (type.startsWith("item.") && e.item?.type === "agent_message");
    if (text < 0 && isText) text = ms();
    if (sj && type === "result") p.stdin.end();
  }
}
const code = await p.exited;
rmSync(dir, { recursive: true, force: true });
const after = (t: number) => (t >= 0 ? t - Math.max(write, 0) : -1);
console.log(
  JSON.stringify({
    label,
    hold,
    write,
    init,
    api,
    text,
    apiAfterWrite: after(api),
    done: ms(),
    code,
  }),
);
