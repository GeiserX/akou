import { describe, expect, test } from "bun:test";
import {
  formatElapsed,
  formatLocalDate,
  formatWall,
  formatZone,
  isBareOffset,
  nsToMs,
  PartClock,
} from "../src/core/log/clock.ts";
import { fold } from "../src/core/log/fold.ts";
import { LogBuilder, T0, TZ } from "./helpers.ts";

const M0 = 5_000_000; // host clock at part start, ms
const MIN = 60_000;

describe("capture_ns alignment (DESIGN 4.4)", () => {
  test("nsToMs keeps sub-millisecond precision for large u64 host timestamps", () => {
    expect(nsToMs(1_500_000n)).toBe(1.5);
    // 200 days of uptime in ns is past 2^53; the bigint path must not lose the milliseconds.
    const ns = 200n * 86_400n * 1_000_000_000n + 123_456_789n;
    expect(nsToMs(ns)).toBe(200 * 86_400_000 + 123.456789);
    expect(nsToMs(2_000_000)).toBe(2);
  });

  test("a packet's wall time comes from the part's anchor pair", () => {
    const c = new PartClock({ part: 1, wallStart: T0, monoStart: M0 });
    expect(c.wallFromMono(M0)).toBe(T0);
    expect(c.wallFromMono(M0 + 12_345)).toBe(T0 + 12_345);
    expect(c.wallFromCapture(BigInt(M0 + 2_000) * 1_000_000n)).toBe(T0 + 2_000);
  });

  test("[T2.52] Clock drifts by paused time: a line after a 5-minute pause carries the correct wall time", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0, M0);
    // 60 s of audio, then a 5-minute pause.
    b.add({ type: "pause", part: 1, a: 60, wall: T0 + MIN, mono: M0 + MIN });
    b.add({ type: "resume", part: 1, a: 60, wall: T0 + 6 * MIN, mono: M0 + 6 * MIN });
    const clock = PartClock.fromEvents(b.events, 1) as PartClock;

    // A line spoken 10 s after the resume: 70 s into the file, 6 min 10 s after the start.
    const expected = T0 + 6 * MIN + 10_000;
    expect(clock.wallFromMono(M0 + 6 * MIN + 10_000)).toBe(expected);
    expect(clock.wallFromAudio(70)).toBe(expected);
    expect(clock.audioFromWall(expected)).toBe(70);

    // Positive control: the offset-only mapping this trap is about gets it wrong by exactly the
    // pause, so the assertions above can fail.
    const naive = T0 + 70 * 1000;
    expect(expected - naive).toBe(5 * MIN);
  });

  test("a time inside a pause seeks to where the audio resumed", () => {
    const c = new PartClock({ part: 1, wallStart: T0, monoStart: M0 });
    c.resume({ a: 60, wall: T0 + 6 * MIN, mono: M0 + 6 * MIN });
    expect(c.audioFromWall(T0 + 3 * MIN)).toBe(60);
    expect(c.audioFromWall(T0 - 5000)).toBe(0);
    expect(c.audioFromWall(T0 + 30_000)).toBe(30);
  });

  test("a system-clock change during a pause cannot bend earlier timestamps", () => {
    const c = new PartClock({ part: 1, wallStart: T0, monoStart: M0 });
    const before = c.wallFromMono(M0 + 30_000);
    // The wall clock jumped forward 2 s while paused; the resume carries the new reading.
    c.resume({ a: 60, wall: T0 + 6 * MIN + 2_000, mono: M0 + 6 * MIN });
    expect(c.wallFromMono(M0 + 30_000)).toBe(before);
    expect(c.wallFromMono(M0 + 6 * MIN + 1_000)).toBe(T0 + 6 * MIN + 3_000);
  });

  test("[spike, ElectroBun #550] Wake from sleep: after a gap, wall times stay correct", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0, M0);
    // Asleep for 30 minutes after 100 s of audio. The host clock kept running through sleep.
    b.add({
      type: "gap",
      part: 1,
      a: 100,
      wallFrom: T0 + 100_000,
      wallTo: T0 + 100_000 + 30 * MIN,
      reason: "sleep",
    });
    const view = fold(b.events);
    const clock = view.part(1)?.clock as PartClock;
    const expected = T0 + 100_000 + 30 * MIN + 10_000;
    expect(clock.wallFromAudio(110)).toBe(expected);
    expect(clock.wallFromMono(M0 + 100_000 + 30 * MIN + 10_000)).toBe(expected);
    expect(clock.wallFromAudio(50)).toBe(T0 + 50_000);
    expect(view.part(1)?.gaps).toHaveLength(1);
  });

  test("each part has its own anchors on one call clock", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0, M0);
    b.partEnded(1, "restart", 120);
    b.partStarted(2, T0 + 125_000, M0 + 125_000);
    const view = fold(b.events);
    expect(view.part(2)?.clock.wallFromAudio(0)).toBe(T0 + 125_000);
    expect(view.part(1)?.clock.wallFromAudio(120)).toBe(T0 + 120_000);
  });
});

describe("rendering: every time is wall clock (DESIGN 4.4)", () => {
  test("wall time renders as local HH:MM:SS in the call's zone", () => {
    expect(formatWall(T0, TZ)).toBe("15:36:12");
    expect(formatWall(T0, "UTC")).toBe("20:36:12");
    expect(formatWall(T0, TZ, { seconds: false })).toBe("15:36");
    expect(formatWall(Date.UTC(2026, 8, 24, 5, 0, 0), TZ)).toBe("00:00:00");
  });

  test("the zone is stated with its offset", () => {
    expect(formatZone(TZ, T0)).toBe("America/Chicago (GMT-5)");
  });

  test("a late-night call is filed under its local day", () => {
    // 23:30 in Chicago is already the next day in UTC.
    const lateNight = Date.UTC(2026, 8, 24, 4, 30, 0);
    expect(formatLocalDate(lateNight, TZ)).toBe("2026-09-23");
    expect(formatLocalDate(lateNight, "UTC")).toBe("2026-09-24");
  });

  test("elapsed time always carries its label", () => {
    expect(formatElapsed(750_000)).toBe("12:30 into the call");
    expect(formatElapsed(3_723_000)).toBe("1:02:03 into the call");
    expect(formatElapsed(-5)).toBe("0:00 into the call");
  });

  test("[T3.9] Offsets shown as times of day: no rendered row time is a bare mm:ss", () => {
    for (let w = T0; w < T0 + 26 * 3600_000; w += 7 * MIN + 13_000) {
      expect(isBareOffset(formatWall(w, TZ))).toBe(false);
    }
    for (const ms of [0, 20_000, 750_000, 3_599_000, 3_600_000, 9_000_000]) {
      expect(isBareOffset(formatElapsed(ms))).toBe(false);
    }
    // Positive control: the detector flags exactly the shape that was once read as a time of day.
    for (const bad of ["00:20", "12:30", " 5:07 ", "59:59"]) expect(isBareOffset(bad)).toBe(true);
    // A citation renders the wall time without seconds, beside a speaker, never alone.
    expect(isBareOffset(`[${formatWall(T0, TZ, { seconds: false })} Ben]`)).toBe(false);
    for (const ok of ["15:41:07", "12:30 into the call", "[15:41 Ben]"]) {
      expect(isBareOffset(ok)).toBe(false);
    }
  });
});
