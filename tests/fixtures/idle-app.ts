/**
 * The desktop app in a process of its own on the real speech models, for
 * `tests/idle-memory.e2e.test.ts` to read the process's memory with `footprint`. It prints
 * `{"port", "token"}` once it listens and quits when its stdin closes; its log goes to stderr.
 *
 * The fake capture helper writes no audio file, so a call's final pass reads the WAV named by
 * `AKOU_IDLE_CALL_WAV`, the one the helper plays.
 */

import { readFileSync } from "node:fs";
import { startApp } from "../../src/main/index.ts";

const wav = process.env.AKOU_IDLE_CALL_WAV as string;
const app = await startApp({
  env: { AKOU_HOME: process.env.AKOU_HOME, AKOU_HEADLESS: "1" },
  finalAudio: ({ parts }) => ({
    kind: "wav",
    files: Object.fromEntries(parts.map((p) => [p, wav])),
  }),
  onLog: (level, msg) => process.stderr.write(`[${level}] ${msg}\n`),
});
const token = readFileSync(app.tokenPath, "utf8").trim();
process.stdout.write(`${JSON.stringify({ port: app.server?.port, token })}\n`);
for await (const _ of process.stdin) {
  // Nothing is read; the end of stdin is the signal to quit.
}
await app.quit();
process.exit(0);
