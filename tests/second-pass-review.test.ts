/**
 * [ASR-7] The second-pass benchmark's own rules (tests/second-pass-review.ts), with a small fake
 * instead of the real models, so CI checks what the benchmark it skips relies on: a review whose
 * answer would land after the call has ended is given up, as the app gives it up, and the memory a
 * synchronous decode takes is seen even though the decode holds the thread.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpgradeOut } from "../src/main/asr/live-worker.ts";
import { tempDir } from "./helpers.ts";
import { type Line, type Req, review, type Utt } from "./second-pass-review.ts";

function utt(key: number, text: string): Utt {
  const u: UpgradeOut = {
    type: "upgrade",
    keys: [key],
    lines: [text],
    samples: new Float32Array(1),
  };
  return { at: 0, u, samples: u.samples };
}

function line(a0: number, text: string): Line {
  return { a0, a1: a0 + 1, stream: text, reviewed: text, control: text };
}

describe("[ASR-7] the second-pass benchmark's rules", () => {
  test("a review whose decode ends after the call has ended is given up, and not counted", async () => {
    const end = 10;
    const segs = new Map([
      [1, line(1, "helo world")],
      [2, line(8, "goodby now")],
    ]);
    // The first request is answered long before the end; the second is due just before it, and
    // its decode (at least 20 ms) ends after it.
    const reqs: Req[] = [
      { ready: 5, utts: [utt(1, "helo world")] },
      { ready: end - 0.001, utts: [utt(2, "goodby now")] },
    ];
    const fixed: Record<string, string[]> = {
      "helo world": ["hello", "world"],
      "goodby now": ["goodbye", "now"],
    };
    let call = 0;
    const r = await review(reqs, segs, "hello world goodbye now", 10, end, "en", async () => {
      const k = call++ === 0 ? "helo world" : "goodby now";
      await Bun.sleep(20);
      return fixed[k] as string[];
    });
    expect(r.reviewedUtts).toBe(1);
    // Only the first line is reviewed: "goodby" stays as the stream had it, 1 word in 4.
    expect(r.wer).toBeCloseTo(25, 5);
    // The decode did run, so it is counted as work, but its words were never applied.
    expect(r.requests).toBe(2);
  });

  test.skipIf(process.platform === "win32")(
    "a synchronous decode's memory is seen from outside the process; a timer inside sees none (POSIX ps; skipped on Windows)",
    () => {
      // In a process of its own: this one reuses memory earlier tests freed, which hides growth.
      const t = tempDir("akou-rss-");
      try {
        const script = join(t.dir, "decode.ts");
        writeFileSync(
          script,
          `import { peakRss } from ${JSON.stringify(join(import.meta.dir, "second-pass-review.ts"))};
const base = process.memoryUsage().rss;
// The benchmark's old sampler: a timer in this process, cleared as soon as the pass returns.
let inside = base;
const timer = setInterval(() => {
  inside = Math.max(inside, process.memoryUsage().rss);
}, 50);
const { peak } = await peakRss(async () => {
  // A decode that holds the thread: 256 MB touched and kept for 800 ms.
  const held = Buffer.alloc(256 * 1024 * 1024, 1);
  const until = performance.now() + 800;
  while (performance.now() < until) held[0] ^= 1;
  clearInterval(timer);
});
console.log(JSON.stringify({ added: peak - base, inside: inside - base }));
`,
        );
        const r = Bun.spawnSync([process.execPath, script], { stderr: "pipe" });
        expect(r.exitCode).toBe(0);
        const m = JSON.parse(r.stdout.toString().trim()) as { added: number; inside: number };
        expect(m.added).toBeGreaterThan(200 * 1024 * 1024);
        // Positive control: the old sampler never ran during the decode, so it read nothing.
        expect(m.inside).toBeLessThan(100 * 1024 * 1024);
      } finally {
        t.cleanup();
      }
    },
  );
});
