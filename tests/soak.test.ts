/**
 * `scripts/soak.ts` (docs/TESTING.md TS-24): its checks fail on the faults they exist for, and a
 * short soak through the real call manager and the fake helper passes them all.
 */

import { describe, expect, test } from "bun:test";
import { judge, SOAK_BOUNDS, type SoakResult, soak } from "../scripts/soak.ts";

function clean(): SoakResult {
  return {
    speed: 10,
    wallSeconds: 3600,
    audioSeconds: 36_000,
    holes: 0,
    fileSeconds: 36_000.02,
    opusSeconds: null,
    samples: [
      { at: 0, heapMb: 20, rssMb: 150 },
      { at: 400, heapMb: 30, rssMb: 180 },
      { at: 3600, heapMb: 31, rssMb: 190 },
    ],
    maxLateMs: 120,
    events: { "call.created": 1, "part.started": 1, "part.ended": 1, "call.ended": 1 },
    log: { bytes: 40_000, torn: false, invalid: 0, seqErrors: 0 },
  };
}

const failing = (r: SoakResult) =>
  judge(r)
    .filter((v) => !v.ok)
    .map((v) => v.key);

describe("the soak's checks", () => {
  test("a clean ten-hour run passes every check", () => {
    expect(failing(clean())).toEqual([]);
  });

  test("positive controls: each fault fails its own check and no other", () => {
    const leak = clean();
    (leak.samples[2] as { heapMb: number }).heapMb = 30 + SOAK_BOUNDS.heapGrowthMb + 1;
    expect(failing(leak)).toEqual(["memory.heap_growth_mb"]);

    const rss = clean();
    (rss.samples[2] as { rssMb: number }).rssMb = 180 + SOAK_BOUNDS.rssGrowthMb + 1;
    expect(failing(rss)).toEqual(["memory.rss_growth_mb"]);

    expect(failing({ ...clean(), holes: 1 })).toEqual(["audio.holes"]);
    expect(failing({ ...clean(), fileSeconds: 35_999.5 })).toEqual(["audio.file_minus_received_s"]);
    expect(failing({ ...clean(), fileSeconds: null })).toEqual(["audio.file_minus_received_s"]);
    expect(failing({ ...clean(), maxLateMs: SOAK_BOUNDS.lateMs + 1 })).toEqual([
      "loop.max_late_ms",
    ]);
    expect(failing({ ...clean(), events: { ...clean().events, "call.failed": 1 } })).toEqual([
      "events.failed_or_gap",
    ]);
    expect(failing({ ...clean(), events: { ...clean().events, gap: 2 } })).toEqual([
      "events.failed_or_gap",
    ]);
    expect(failing({ ...clean(), log: { ...clean().log, torn: true } })).toEqual([
      "log.unreadable_lines",
    ]);
    expect(failing({ ...clean(), log: { ...clean().log, bytes: 30 * 1024 * 1024 } })).toEqual([
      "log.bytes_per_audio_hour",
    ]);
    expect(failing({ ...clean(), opusSeconds: 36_000.02 })).toEqual([]);
    expect(failing({ ...clean(), opusSeconds: 35_990 })).toEqual(["audio.opus_minus_file_s"]);
  });

  test("growth is measured from the end of the warm-up, not from the first sample", () => {
    // Loading at start-up is not a leak: 100 MB before a tenth of the run, flat after it.
    const r = clean();
    (r.samples[0] as { heapMb: number }).heapMb = 1;
    expect(failing(r)).toEqual([]);
  });

  test("the recognizer queue's bounded sawtooth passes, the same sawtooth on a slow leak fails", () => {
    // The queue holds up to twice its cap before it compacts: about 90 MB up, then down, every
    // minute at 10x. Two single samples would read that as growth or shrinkage by chance: here the
    // last one sits near a peak and the first after the warm-up at a trough.
    const saw = (leakMbPerSecond: number): SoakResult => {
      const samples = [];
      for (let at = 0; at < 3600; at += 10)
        samples.push({
          at,
          heapMb: 120 + 90 * ((at % 60) / 60) + leakMbPerSecond * at,
          rssMb: 300 + leakMbPerSecond * at,
        });
      return { ...clean(), samples };
    };
    expect(failing(saw(0))).toEqual([]);
    expect(failing(saw(0.05))).toEqual(["memory.heap_growth_mb"]);
  });
});

describe("a short soak through the call manager and the fake helper", () => {
  test("three seconds at 20x: about a minute of audio, no hole, every check passes", async () => {
    const r = await soak({ speed: 20, seconds: 3 });
    expect(r.audioSeconds).toBeGreaterThan(30);
    expect(r.events["part.started"]).toBe(1);
    expect(r.events["call.ended"]).toBe(1);
    expect(judge(r).filter((v) => !v.ok)).toEqual([]);
  }, 30_000);
});
