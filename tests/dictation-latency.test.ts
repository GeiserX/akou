/**
 * DC-T3: dictation's release-to-text table. The nightly's `dictation` stage builds it
 * (`scripts/eval/dictation-latency.ts`); the committed one in `docs/gates/dictation-latency.json`
 * is what the Dictation page shows, measured on this platform or estimated
 * (`src/main/dictation/latency.ts`; the page's words are tested in `tests/ui/dictation.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atPeak,
  DICTATION_LENGTHS,
  DICTATIONS_PER_LENGTH,
  engineLatency,
  type LatencyTable,
  utterances,
  withPlatform,
} from "../scripts/eval/dictation-latency.ts";
import { dictationLatency, ESTIMATED_MS } from "../src/main/dictation/latency.ts";

const GATE = join(import.meta.dir, "..", "docs", "gates", "dictation-latency.json");

const ramp = (from: number, n: number) => Float32Array.from({ length: n }, (_, i) => from + i);

describe("DC-T3: the utterances and the table", () => {
  test("utterances are the clips joined end to end and cut to the length, never padded", () => {
    const clips = [ramp(0, 5), ramp(100, 3), ramp(200, 9)];
    // 4 samples at 16 kHz is 0.25 ms; three of them.
    const got = utterances(clips, 4 / 16_000, 3);
    expect(got.map((u) => [...u])).toEqual([
      [0, 1, 2, 3],
      [4, 100, 101, 102],
      [200, 201, 202, 203],
    ]);
    expect(() => utterances(clips, 4 / 16_000, 5)).toThrow("the clips hold 4 utterances");
  });

  test("a quiet clip is brought to the peak, as a microphone's gain would; a silent one is dropped", () => {
    expect([...(atPeak(Float32Array.from([0.0625, -0.25, 0.125]), 0.5) ?? [])]).toEqual([
      0.125, -0.5, 0.25,
    ]);
    expect(atPeak(new Float32Array(4), 0.5)).toBeNull();
  });

  test("an engine's row is its p50 and p95 per length, rounded to the ms", () => {
    const times = new Map([[10, [100.4, 300.6, 200, 900, 150, 120, 180, 210, 250, 130]]]);
    expect(engineLatency("m", times)).toEqual({
      model: "m",
      seconds: { "10": { p50: 180, p95: 900, n: 10 } },
    });
  });

  test("writing one platform keeps the others", () => {
    const entry = { measured: "today", engines: {} };
    const old: LatencyTable = { _about: "x", platforms: { "linux-x64": entry } };
    const t = withPlatform(old, "darwin-arm64", { measured: "now", engines: {} });
    expect(Object.keys(t.platforms).sort()).toEqual(["darwin-arm64", "linux-x64"]);
    expect(t.platforms["linux-x64"]).toBe(entry);
    expect(withPlatform(null, "win32-x64", entry)._about).toContain("DC-T3");
  });
});

describe("DC-T3: what the Dictation page shows", () => {
  const table = {
    platforms: {
      "darwin-arm64": {
        engines: {
          live: { seconds: { "3": { p50: 90 }, "10": { p50: 210 } } },
          qwen: { seconds: { "10": { p50: 640 } } },
          remote: { seconds: { "10": { p50: 330 } } },
        },
      },
    },
  };

  test("a time measured on this platform is measured; the others are the estimates", () => {
    expect(dictationLatency("darwin-arm64", table)).toEqual({
      live: { ms: 210, measured: true },
      parakeet: { ms: ESTIMATED_MS.parakeet as number, measured: false },
      qwen: { ms: 640, measured: true },
      remote: { ms: 330, measured: true },
    });
    // Another platform: nothing measured, so every time is an estimate, and the remote has none.
    expect(dictationLatency("linux-x64", table)).toEqual({
      live: { ms: ESTIMATED_MS.live as number, measured: false },
      parakeet: { ms: ESTIMATED_MS.parakeet as number, measured: false },
      qwen: { ms: ESTIMATED_MS.qwen as number, measured: false },
    });
  });

  test("the committed table holds a measured Apple silicon Mac, every engine and length", () => {
    const t = JSON.parse(readFileSync(GATE, "utf8")) as LatencyTable;
    const mac = t.platforms["darwin-arm64"];
    expect(mac?.measured).toMatch(/^\d{4}-\d{2}-\d{2}, /);
    for (const engine of ["live", "qwen", "remote"] as const) {
      const e = mac?.engines[engine];
      expect(e?.model.length).toBeGreaterThan(0);
      for (const s of DICTATION_LENGTHS) {
        const row = e?.seconds[String(s)];
        expect(row?.n).toBe(DICTATIONS_PER_LENGTH);
        expect(row?.p50).toBeGreaterThan(0);
        expect(row?.p95).toBeGreaterThanOrEqual(row?.p50 as number);
      }
    }
    // What the page reads is that table.
    const shown = dictationLatency("darwin-arm64");
    expect(shown.live).toEqual({
      ms: mac?.engines.live?.seconds["10"]?.p50 as number,
      measured: true,
    });
    expect(shown.qwen).toEqual({
      ms: mac?.engines.qwen?.seconds["10"]?.p50 as number,
      measured: true,
    });
  });
});
