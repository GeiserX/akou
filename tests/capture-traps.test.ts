/**
 * Capture and call traps against a real child process: `scripts/fake-helper.ts` speaking
 * `akou-capture/1`, spawned, stopped and killed through `AkouCaptureEngine` exactly as the app
 * spawns the Rust helper. The scenarios live in tests/capture-scenarios.ts, which
 * tests/capture-rust.e2e.test.ts runs against the Rust helper too.
 */

import { describe, expect, test } from "bun:test";
import { akouCaptureDialect, ChildCaptureSession } from "../src/main/capture/helper.ts";
import {
  captureTrapScenarios,
  fakeHelper,
  holdBound,
  LONG,
  longestHold,
  rig,
  type StopTimes,
  useRigCleanups,
} from "./capture-scenarios.ts";

useRigCleanups();
captureTrapScenarios(fakeHelper);

describe("[T0.9] the hang check can fail", () => {
  test("longestHold: turns every 10 ms score 10 ms; no turn at all scores the whole window", () => {
    const turns = Array.from({ length: 29 }, (_, i) => 1_000 + (i + 1) * 10);
    expect(longestHold(turns, 1_000, 1_300)).toBe(10);
    expect(longestHold([], 1_000, 1_300)).toBe(300);
    // Turns outside the window do not count.
    expect(longestHold([900, 1_400], 1_000, 1_300)).toBe(300);
    expect(longestHold([1_010, 1_290], 1_000, 1_300)).toBe(280);
  });

  test(
    "positive control: a stop that holds the event loop until the kill scores the whole budget",
    async () => {
      const budget = 300;
      const r = rig(fakeHelper, () => ({ hangOnStop: true }), { stopMs: budget });
      expect((await r.mgr.start({ workspace: "work" })).ok).toBe(true);
      // The kill blocks the loop for the budget first, as a stop that waited on the helper
      // synchronously would.
      const s = r.sessions[0];
      if (!s) throw new Error("no session");
      const kill = s.kill.bind(s);
      s.kill = () => {
        Bun.sleepSync(budget);
        kill();
      };
      const turns: number[] = [];
      const timer = setInterval(() => turns.push(performance.now()), 10);
      await r.mgr.stop("live");
      clearInterval(timer);
      const at = r.stops[0] as StopTimes;
      expect(longestHold(turns, at.asked as number, at.kill as number)).toBeGreaterThanOrEqual(
        holdBound(budget),
      );
    },
    LONG,
  );

  test(
    "positive control: a stop that holds the loop for more than half the budget, not all of it, fails too",
    async () => {
      const budget = 1_000;
      const r = rig(fakeHelper, () => ({ hangOnStop: true }), { stopMs: budget });
      expect((await r.mgr.start({ workspace: "work" })).ok).toBe(true);
      // Just after the ask, the loop is held for six tenths of the budget, then let go, so turns
      // come again before the kill. The hold alone is past the bound whatever the runner does.
      // The 400 ms left before the kill is the room a slow runner has to start the hold late
      // and turn late after it: a macOS runner took 130 ms more than asked, which a hold of
      // nine tenths of 300 ms, 25 ms from the kill, did not survive.
      const s = r.sessions[0];
      if (!s) throw new Error("no session");
      const stop = s.stop.bind(s);
      s.stop = (b) => {
        setTimeout(() => Bun.sleepSync(budget * 0.6), 5);
        return stop(b);
      };
      const turns: number[] = [];
      const timer = setInterval(() => turns.push(performance.now()), 10);
      await r.mgr.stop("live");
      clearInterval(timer);
      const at = r.stops[0] as StopTimes;
      const held = longestHold(turns, at.asked as number, at.kill as number);
      expect(held).toBeLessThan(budget);
      expect(held).toBeGreaterThanOrEqual(holdBound(budget));
    },
    LONG,
  );
});

describe("a helper that is not a helper", () => {
  test(
    "a helper that writes garbage on stdout is killed; the start fails, nothing is trusted",
    async () => {
      const script =
        "process.stdout.write('not a packet stream at all, just text'); await Bun.sleep(30000);";
      const r = rig(fakeHelper, () => ({}), { coldStartMs: 1_500 }, [
        process.execPath,
        "-e",
        script,
      ]);
      const res = await r.mgr.start({ workspace: "work" });
      expect(res).toMatchObject({ ok: false, status: 503, stage: "open" });
      if (res.ok) throw new Error("unreachable");
      expect(res.error).toContain("protocol error");
    },
    LONG,
  );
});

describe("a helper's last stderr line", () => {
  /**
   * A helper that exits at once while a process it started still holds its stderr and writes the
   * `stopped` line `delayMs` later: the exit is noticed before the pipe has drained.
   */
  function lateStopped(delayMs: number) {
    const line = JSON.stringify({ type: "stopped", file_seconds: 7.5, reason: "stop" });
    const grandchild = `setTimeout(() => process.stderr.write(${JSON.stringify(`${line}\n`)}), ${delayMs})`;
    const child = [
      'const { spawn } = require("node:child_process");',
      `const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "ignore", "inherit"], detached: true });`,
      "g.unref();",
      "process.exit(0);",
    ].join("\n");
    const session = new ChildCaptureSession(
      { argv: [process.execPath, "-e", child] },
      { packet: () => {}, message: () => {}, exit: () => {} },
      akouCaptureDialect,
    );
    const t0 = performance.now();
    return session.exited.then((exit) => ({ exit, ms: performance.now() - t0 }));
  }

  test(
    "a `stopped` line written just after the helper exits is still read",
    async () => {
      const { exit } = await lateStopped(100);
      expect(exit.code).toBe(0);
      expect(exit.stopped).toEqual({ fileSeconds: 7.5, reason: "stop" });
    },
    LONG,
  );

  test(
    "positive control: a pipe held open for long never delays the exit past the drain grace",
    async () => {
      const { exit, ms } = await lateStopped(5_000);
      expect(exit.stopped).toBeUndefined();
      expect(ms).toBeLessThan(3_000);
    },
    LONG,
  );
});
