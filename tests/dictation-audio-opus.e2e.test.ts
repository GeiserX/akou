/**
 * DC-H2 on the real capture helper: a dictation's kept audio goes through `akou-capture encode`
 * and back through `decode`, in time with what was spoken and at about a tenth of the 16-bit WAV
 * kept before. Needs `AKOU_CAPTURE_BIN`, a build of the helper:
 *
 *   cargo build --release --manifest-path native/akou-capture/Cargo.toml
 *   AKOU_CAPTURE_BIN=native/akou-capture/target/release/akou-capture bun test tests/dictation-audio-opus.e2e.test.ts
 */

import { afterEach, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DictationAudio } from "../src/main/dictation/audio.ts";
import { tempDir } from "./helpers.ts";

const BIN = process.env.AKOU_CAPTURE_BIN;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

test.skipIf(!BIN)(
  "[DC-H2] a dictation's audio is kept as Opus by the helper and decodes back in time (skipped: needs AKOU_CAPTURE_BIN, a helper build)",
  async () => {
    const t = tempDir("akou-dict-opus-e2e-");
    cleanups.push(t.cleanup);
    const logs: string[] = [];
    const a = new DictationAudio(t.dir, {
      helper: () => [BIN as string],
      onLog: (_level, msg) => logs.push(msg),
    });
    // 4 s of a chirp from 200 Hz to 2 kHz, a little over a whole 20 ms frame.
    const rate = 16_000;
    const input = Float32Array.from({ length: 4 * rate + 77 }, (_, i) => {
      const s = i / rate;
      return 0.3 * Math.sin(2 * Math.PI * (200 * s + 225 * s * s));
    });
    a.write("d1", input);
    expect((await a.file("d1"))?.type).toBe("audio/ogg");
    expect(logs).toEqual([]);
    expect(readdirSync(t.dir)).toEqual(["d1.opus"]);

    const opus = statSync(join(t.dir, "d1.opus")).size;
    const wav = 44 + 2 * input.length;
    expect(opus * 8).toBeLessThan(wav);

    const out = (await a.read("d1")) as Float32Array;
    expect(out.length).toBe(input.length);
    // In time: the decoded middle second lines up with the input at no lag, and matches it.
    const corr = (lag: number) => {
      let xy = 0;
      let xx = 0;
      let yy = 0;
      for (let i = rate; i < 2 * rate; i++) {
        const x = input[i] as number;
        const y = out[i + lag] as number;
        xy += x * y;
        xx += x * x;
        yy += y * y;
      }
      return xy / Math.sqrt(xx * yy);
    };
    const lags = Array.from({ length: 161 }, (_, i) => i - 80);
    const best = lags.reduce((b, l) => (corr(l) > corr(b) ? l : b), 0);
    expect(Math.abs(best)).toBeLessThanOrEqual(2);
    expect(corr(0)).toBeGreaterThan(0.9);
  },
);
