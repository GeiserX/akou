/**
 * Preloaded into a spawned bun (`--preload`): when the process exits, it writes its own peak
 * memory, in bytes, to the file `AKOU_TEST_PEAK_FILE` names (tests/upload-stream.e2e.test.ts).
 *
 * On Linux `maxRSS` is not the child's own: `execve` keeps the larger of the spawning process's
 * resident size and the child's, so a child spawned by a 1 GB test runner reports 1 GB whatever it
 * does. `VmHWM` in `/proc/self/status` is the peak of the child's own memory map. Elsewhere
 * `maxRSS` is the child's, in bytes on macOS and KiB on others.
 */

import { readFileSync, writeFileSync } from "node:fs";

const MiB = 1024 * 1024;

function peakBytes(): number {
  if (process.platform === "linux") {
    const hwm = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync("/proc/self/status", "utf8"));
    if (!hwm?.[1]) throw new Error("no VmHWM in /proc/self/status");
    return Number(hwm[1]) * 1024;
  }
  const maxRSS = process.resourceUsage().maxRSS;
  return maxRSS > 4 * MiB ? maxRSS : maxRSS * 1024;
}

const out = process.env.AKOU_TEST_PEAK_FILE;
if (out) process.on("exit", () => writeFileSync(out, String(peakBytes())));
