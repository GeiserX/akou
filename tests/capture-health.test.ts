import { describe, expect, test } from "bun:test";
import { type DeadCallAction, DeadCallMonitor, MAX_REBUILDS } from "../src/main/capture/health.ts";

/** Runs the monitor once a second from `from` to `to`; the probe answers `probeHears`. */
function run(
  m: DeadCallMonitor,
  from: number,
  to: number,
  o: {
    outputRunning: boolean;
    heard: (t: number) => boolean;
    probeHears?: boolean;
    paused?: (t: number) => boolean;
  },
): { t: number; a: DeadCallAction }[] {
  const out: { t: number; a: DeadCallAction }[] = [];
  for (let t = from; t <= to; t++) {
    for (const a of m.tick({
      t,
      outputRunning: o.outputRunning,
      heard: o.heard(t),
      paused: o.paused?.(t),
    })) {
      out.push({ t, a });
      if (a.kind === "probe")
        for (const r of m.probeResult(t, o.probeHears ?? true)) out.push({ t, a: r });
    }
  }
  return out;
}

const rebuildTimes = (log: { t: number; a: DeadCallAction }[]) =>
  log.filter((x) => x.a.kind === "rebuild").map((x) => x.t);

describe("[T0.2] [T1.29] dead call side hidden behind a live mic", () => {
  test("output running and the call silent for 10 s: probe, rebuild, report dead", () => {
    const m = new DeadCallMonitor(0);
    const log = run(m, 0, 30, { outputRunning: true, heard: (t) => t < 20 });
    const first = log.find((x) => x.a.kind === "probe");
    expect(first?.t).toBe(30);
    const health = log.find((x) => x.a.kind === "health");
    expect(health?.a).toMatchObject({ kind: "health", state: "dead", rebuilds: 1 });
  });

  test("backs off 10, 30, 60 s, then every minute, and stops after 5 rebuilds per part", () => {
    const m = new DeadCallMonitor(0);
    const log = run(m, 0, 1000, { outputRunning: true, heard: () => false });
    const times = rebuildTimes(log);
    expect(times).toEqual([10, 20, 50, 110, 170]);
    expect(times.length).toBe(MAX_REBUILDS);
    const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
    expect(gaps).toEqual([10, 30, 60, 60]);
  });

  test("positive control: the same zeros with the output NOT running never rebuild", () => {
    const m = new DeadCallMonitor(0);
    const log = run(m, 0, 600, { outputRunning: false, heard: () => false });
    expect(log).toEqual([]);
    // The identical input with output running does trigger it, so the check above can fail.
    const control = run(new DeadCallMonitor(0), 0, 600, {
      outputRunning: true,
      heard: () => false,
    });
    expect(rebuildTimes(control).length).toBeGreaterThan(0);
  });

  test("a probe that hears nothing is a quiet call, not a dead tap", () => {
    const m = new DeadCallMonitor(0);
    const log = run(m, 0, 120, { outputRunning: true, heard: () => false, probeHears: false });
    expect(log.filter((x) => x.a.kind === "probe").length).toBeGreaterThan(0);
    expect(rebuildTimes(log)).toEqual([]);
  });

  test("audio coming back after dead reports ok once", () => {
    const m = new DeadCallMonitor(0);
    const log = run(m, 0, 40, { outputRunning: true, heard: (t) => t > 25 });
    const states = log
      .filter((x) => x.a.kind === "health")
      .map((x) => (x.a as { state: string }).state);
    expect(states).toEqual(["dead", "dead", "ok"]);
  });

  test("health monitors do nothing while paused", () => {
    const m = new DeadCallMonitor(0);
    const log = run(m, 0, 300, { outputRunning: true, heard: () => false, paused: () => true });
    expect(log).toEqual([]);
  });

  test("one tick never asks for two rebuilds", () => {
    const m = new DeadCallMonitor(50);
    expect(m.tick({ t: 55, outputRunning: true, heard: false })).toEqual([]);
    expect(m.tick({ t: 60, outputRunning: true, heard: false })).toEqual([{ kind: "probe" }]);
    // A second tick while the probe is open asks for nothing.
    expect(m.tick({ t: 61, outputRunning: true, heard: false })).toEqual([]);
    const r = m.probeResult(61, true);
    expect(r.filter((a) => a.kind === "rebuild").length).toBe(1);
    expect(m.probeResult(61, true)).toEqual([]);
  });
});
