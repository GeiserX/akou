/**
 * Preloaded into a spawned bun (`--preload`): when the process exits, it writes its own peak
 * memory (`process.resourceUsage().maxRSS`) to the file `AKOU_TEST_PEAK_FILE` names, so a test reads
 * the child's own peak (tests/upload-stream.e2e.test.ts).
 */

import { writeFileSync } from "node:fs";

const out = process.env.AKOU_TEST_PEAK_FILE;
if (out) process.on("exit", () => writeFileSync(out, String(process.resourceUsage().maxRSS)));
