/**
 * DC-N4, no clipped ends, from the WAV to the transcript: the app's dictation service over the
 * real Rust helper in its simulate build (`akou-capture dictate --from-wav`), decoded by the fake
 * recognizer, where a word is a tone burst it reads back. The helper's own tests check the samples
 * (native/akou-capture/src/dictate/mic.rs and sim.rs); these check that the word those samples
 * carry reaches the text.
 *
 * - A word spoken at 0 ms with the key going down at 400 ms is in the transcript with
 *   `warmMic: always`, because the session starts at the key-down minus the 500 ms ring. With the
 *   ring off (`--ring-ms 0`, a simulate-only switch) the same press loses it: the positive control.
 * - With `warmMic: off` and a stream that delivers its first sample 300 ms after it opens, the
 *   word spoken once audio flows is still in the transcript (the readiness gate).
 * - A word that ends 100 ms before the release is in the transcript (the post-roll).
 *
 * Nothing here opens a device, reads a key or touches the clipboard. Needs `AKOU_CAPTURE_BIN`, a
 * `--features simulate` build; the `helper` job of ci.yml runs it on the three OSes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LiveAsr } from "../src/main/asr/live-worker.ts";
import { DictationService } from "../src/main/dictation/service.ts";
import type { DictationEngine } from "../src/main/dictation/session.ts";
import { FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const BIN = process.env.AKOU_CAPTURE_BIN;
const RC = "RightCommand";
const NOTES = { app: "com.example.notes", pid: 7, window: "n1", field: "editable" };
/** Past `until`'s 15 s, so its report is what a slow run shows, not bun's bare timeout. */
const SLOW = 30_000;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function fastEngine(): DictationEngine {
  const asr = new LiveAsr(
    {
      models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
      inThread: true,
    },
    () => undefined,
  );
  cleanups.push(() => asr.close());
  return { name: "fast", decode: (s, o) => asr.decode(s, o) };
}

interface Run {
  mic: Float32Array;
  /** `[ms, down]` for the dictation key. */
  keys: [number, boolean][];
  warm: "off" | "auto" | "always";
  /** More helper switches: `--ring-ms`, `--mic-open-delay`. */
  extra?: string[];
}

/** Runs one scripted dictation; returns the text inserted, or null when nothing was heard. */
async function dictate(bin: string, r: Run): Promise<string | null> {
  const t = tempDir("akou-dict-preroll-");
  cleanups.push(t.cleanup);
  const wav = join(t.dir, "mic.wav");
  writeFileSync(wav, monoWav(r.mic));
  const keys = join(t.dir, "keys.txt");
  writeFileSync(keys, r.keys.map(([ms, down]) => `${ms} ${down ? "down" : "up"} ${RC}`).join("\n"));
  const ax = join(t.dir, "ax.txt");
  writeFileSync(ax, `0 ${JSON.stringify(NOTES)}`);
  const said: string[] = [];
  const svc = new DictationService({
    configDir: t.dir,
    engine: fastEngine,
    now: () => Date.now(),
    onLog: (level, msg) => said.push(`${level}: ${msg}`),
  });
  cleanups.push(() => svc.close());
  svc.start(
    [
      bin,
      "dictate",
      "--hotkey",
      RC,
      "--warm",
      r.warm,
      "--from-wav",
      wav,
      "--keys",
      keys,
      "--ax",
      "fake",
      ax,
      "--clipboard",
      "fake",
      "--inserter",
      `fake:${join(t.dir, "inserter.jsonl")}`,
      ...(r.extra ?? []),
    ],
    () => ({ hotkey: RC, draft: "", fixLast: "", pasteLast: "", activation: "hold-or-toggle" }),
  );
  const done = () => ["inserted", "empty", "failed"].includes(svc.log.items()[0]?.state ?? "");
  try {
    await until(done, 15_000, "the dictation's outcome");
  } catch (err) {
    const seen = { status: svc.status(), events: svc.log.events(), said };
    throw new Error(`${(err as Error).message}\n${JSON.stringify(seen, null, 1)}`);
  }
  const item = svc.log.items()[0];
  expect(item?.state).not.toBe("failed");
  return item?.state === "inserted" ? item.text : null;
}

/** "hello" from 0 ms, the key down at 400 ms and up at 1400 ms. */
const firstSyllable = (extra?: string[]): Run => ({
  mic: concat(speak(["hello"]), silence(3)),
  keys: [
    [400, true],
    [1400, false],
  ],
  warm: "always",
  extra,
});

if (!BIN) {
  // Says why nothing below ran; the helper job sets AKOU_CAPTURE_BIN.
  test.skipIf(!BIN)(
    "DC-N4 from the WAV to the transcript (skipped: needs AKOU_CAPTURE_BIN, a `--features simulate` build)",
    () => {},
  );
} else {
  const bin = BIN;

  describe("DC-N4: no clipped ends, from the WAV to the transcript", () => {
    test(
      "a word at 0 ms with the key down at 400 ms and a warm mic is in the transcript",
      async () => {
        expect(await dictate(bin, firstSyllable())).toBe("hello");
      },
      SLOW,
    );

    test(
      "positive control: with the ring off the same press loses the word",
      async () => {
        expect(await dictate(bin, firstSyllable(["--ring-ms", "0"]))).toBeNull();
      },
      SLOW,
    );

    test(
      "warmMic off with a stream 300 ms slow to deliver: the word spoken once audio flows is kept",
      async () => {
        const text = await dictate(bin, {
          // The key goes down at 400 ms, the first sample arrives at 700 ms, the word at 800 ms.
          mic: concat(silence(0.8), speak(["hello"]), silence(3)),
          keys: [
            [400, true],
            [1600, false],
          ],
          warm: "off",
          extra: ["--mic-open-delay", "300"],
        });
        expect(text).toBe("hello");
      },
      SLOW,
    );

    test(
      "a word ending 100 ms before the release is in the transcript",
      async () => {
        // "world" from 1.0 s to 1.25 s; the key goes up at 1.35 s.
        const text = await dictate(bin, {
          mic: concat(silence(1), speak(["world"], { gapSeconds: 0 }), silence(3)),
          keys: [
            [400, true],
            [1350, false],
          ],
          warm: "always",
        });
        expect(text).toBe("world");
      },
      SLOW,
    );
  });
}
