/**
 * A helper that exits at once while a process it started still holds its stderr and writes the
 * `stopped` line later (tests/capture-traps.test.ts). `late-stopped.ts <delayMs>` is the helper;
 * with `grandchild` after the delay it is the process that writes the line.
 */

import { spawn } from "node:child_process";

const [delay, role] = process.argv.slice(2);
const delayMs = Number(delay);

if (role === "grandchild") {
  const line = JSON.stringify({ type: "stopped", file_seconds: 7.5, reason: "stop" });
  setTimeout(() => process.stderr.write(`${line}\n`), delayMs);
} else {
  const g = spawn(process.execPath, [import.meta.path, String(delayMs), "grandchild"], {
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
  g.unref();
  process.exit(0);
}
