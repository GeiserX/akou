#!/usr/bin/env bun
/**
 * Stands in for a capture helper that records (`run --out FILE`): it appends to FILE every 100 ms
 * until it is killed, and ends when its parent is gone. It opens no audio device.
 */

import { appendFileSync } from "node:fs";

const out = process.argv[process.argv.indexOf("--out") + 1] as string;
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
  appendFileSync(out, Buffer.alloc(320));
}, 100);
