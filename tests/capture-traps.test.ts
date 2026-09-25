/**
 * Capture and call traps against a real child process: `scripts/fake-helper.ts` speaking
 * `akou-capture/1`, spawned, stopped and killed through `AkouCaptureEngine` exactly as the app
 * spawns the Rust helper. The scenarios live in tests/capture-scenarios.ts, which
 * tests/capture-rust.e2e.test.ts runs against the Rust helper too.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  akouCaptureDialect,
  ChildCaptureSession,
  DRAIN_GRACE_MS,
} from "../src/main/capture/helper.ts";
import {
  answeredOnCapturingBroken,
  captureTrapScenarios,
  describeSteps,
  dropDeadlineAfter,
  fakeHelper,
  holdBound,
  killedAtBudgetBroken,
  LONG,
  longestHold,
  NEVER,
  pastBudgetBroken,
  recordingClock,
  rig,
  type Step,
  type StopTimes,
  stoppedWithinBudgetBroken,
  useRigCleanups,
} from "./capture-scenarios.ts";

const LATE_STOPPED = join(import.meta.dir, "fixtures", "late-stopped.ts");

useRigCleanups();
captureTrapScenarios(fakeHelper);

describe("[T1.26] the start budget check reads steps, not the clock", () => {
  test(
    "a runner that stalls 2 s right after the spawn changes nothing: the budget counts from the spawn",
    async () => {
      // The stall a Windows runner had (3.2 s for a start whose budget is 500 ms), put where it
      // hurt a wall-clock bound most: after the spawn, before the budget is armed.
      const budget = 500;
      const r = rig(
        fakeHelper,
        () => ({ capturingDelayMs: NEVER }),
        { coldStartMs: budget },
        undefined,
        {
          session: () => Bun.sleepSync(2_000),
        },
      );
      const res = await r.start({ workspace: "work" });
      expect(res).toMatchObject({ ok: false, status: 503, stage: "open" });
      await r.sessions[0]?.exited;
      expect(pastBudgetBroken(r.steps, budget)).toEqual([]);
    },
    LONG,
  );

  test(
    "positive control: a start budget that is ignored fails the check",
    async () => {
      // The deadline armed at the spawn never fires, so only the helper's `capturing` (after
      // 1 s) can end the start: it answers 201, and nothing was killed.
      const budget = 500;
      const r = rig(
        fakeHelper,
        () => ({ capturingDelayMs: 1_000 }),
        { coldStartMs: budget },
        undefined,
        {
          drop: dropDeadlineAfter("spawn"),
        },
      );
      expect((await r.start({ workspace: "work" })).ok).toBe(true);
      expect(pastBudgetBroken(r.steps, budget)).toEqual([
        "the start budget never fired",
        "the helper was never killed",
        "the helper said capturing",
        "the helper did not exit by our kill",
        "the start did not answer 503",
      ]);
    },
    LONG,
  );

  test(
    "positive control: a kill that is never sent fails the check",
    async () => {
      const budget = 500;
      const r = rig(
        fakeHelper,
        () => ({ capturingDelayMs: NEVER }),
        { coldStartMs: budget },
        undefined,
        {
          session: (s) => {
            s.kill = () => {};
          },
        },
      );
      expect(await r.start({ workspace: "work" })).toMatchObject({ ok: false, status: 503 });
      expect(pastBudgetBroken(r.steps, budget)).toEqual([
        "the helper was never killed",
        "the helper did not exit by our kill",
      ]);
    },
    LONG,
  );

  test(
    "positive control: a budget other than the one given fails the check",
    async () => {
      const r = rig(fakeHelper, () => ({ capturingDelayMs: NEVER }), { coldStartMs: 500 });
      await r.start({ workspace: "work" });
      await r.sessions[0]?.exited;
      expect(pastBudgetBroken(r.steps, 400)).toEqual(["no 400 ms start budget armed at the spawn"]);
    },
    LONG,
  );
});

describe("[T3.6] the warm start check can fail", () => {
  test(
    "positive control: a start under the cold budget, or one its budget ended, fails the warm check",
    async () => {
      // The rig's first start is cold (5 s budget): the warm check (3 s) refuses it.
      const r = rig(fakeHelper, () => ({}), { coldStartMs: 5_000, warmStartMs: 3_000 });
      expect((await r.start({ workspace: "work" })).ok).toBe(true);
      expect(answeredOnCapturingBroken(r.steps, 3_000)).toEqual([
        "no 3000 ms start budget armed at the spawn",
      ]);
      expect(answeredOnCapturingBroken(r.steps, 5_000)).toEqual([]);
      // A start that ended on its budget, not on `capturing`.
      const late = rig(fakeHelper, () => ({ capturingDelayMs: NEVER }), { coldStartMs: 300 });
      await late.start({ workspace: "work" });
      expect(answeredOnCapturingBroken(late.steps, 300)).toEqual([
        "the helper never said capturing",
        "the start did not answer 201",
        "the start budget fired",
      ]);
    },
    LONG,
  );
});

describe("[T0.9] [T2.51] the stop budget checks can fail", () => {
  async function stopped(
    faults: Parameters<typeof rig>[1],
    budget: number,
    opts: Parameters<typeof rig>[4],
  ): Promise<Step[]> {
    const r = rig(fakeHelper, faults, { stopMs: budget }, undefined, opts);
    expect((await r.start({ workspace: "work" })).ok).toBe(true);
    const from = r.steps.length;
    await r.mgr.stop("live");
    return r.steps.slice(from);
  }

  test(
    "positive control: a stop budget that is ignored fails the kill check",
    async () => {
      // The deadline armed at the ask never fires. The hung helper is then ended from outside,
      // 100 ms after the ask, as nothing in the app would end it.
      const steps = await stopped(() => ({ hangOnStop: true }), 300, {
        drop: dropDeadlineAfter("ask"),
        session: (s) => {
          const stop = s.stop.bind(s);
          s.stop = (b) => {
            setTimeout(() => process.kill(s.pid as number, "SIGKILL"), 100);
            return stop(b);
          };
        },
      });
      expect(killedAtBudgetBroken(steps, 300)).toEqual([
        "the stop budget never fired",
        "the helper was never killed",
        "the helper did not exit by our kill",
        "the stop did not answer killed",
      ]);
    },
    LONG,
  );

  test(
    "positive control: a kill that is never sent fails the kill check",
    async () => {
      const steps = await stopped(() => ({ hangOnStop: true }), 300, {
        session: (s) => {
          s.kill = () => {};
        },
      });
      console.log(`[T0.9] no kill: ${describeSteps(steps)}`);
      expect(killedAtBudgetBroken(steps, 300)).toEqual([
        "the helper was never killed",
        "the helper did not exit by our kill",
        "the stop did not answer in the exit's turn",
      ]);
    },
    LONG,
  );

  test(
    "positive control: a helper that hangs on stop fails the stopped-within-budget check",
    async () => {
      const steps = await stopped(() => ({ hangOnStop: true }), 300, {});
      expect(stoppedWithinBudgetBroken(steps, 300)).toEqual([
        "the stop budget fired",
        "the helper never said stopped",
        "the helper did not exit 0",
        "the helper was killed",
        "the stop did not answer unkilled",
      ]);
      expect(killedAtBudgetBroken(steps, 300)).toEqual([]);
    },
    LONG,
  );
});

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
  function lateStopped(delayMs: number, drop?: Parameters<typeof recordingClock>[1]) {
    const steps: Step[] = [];
    const session = new ChildCaptureSession(
      {
        argv: [process.execPath, LATE_STOPPED, String(delayMs)],
        clock: recordingClock(steps, drop),
      },
      {
        packet: () => {},
        message: () => {},
        exit: (e) => steps.push({ step: "exit", part: 1, code: e.code, killedByUs: e.killedByUs }),
      },
      akouCaptureDialect,
    );
    return session.exited.then((exit) => ({ exit, steps }));
  }

  /**
   * The drain rule, from the steps: the one timer armed is the drain grace; it fired; the exit
   * was reported in that turn, without the line the held pipe wrote later.
   */
  function drainBroken(steps: readonly Step[]): string[] {
    const bad: string[] = [];
    const armed = steps[0];
    if (armed?.step !== "armed" || armed.ms !== DRAIN_GRACE_MS) bad.push("no drain grace armed");
    const fired = steps.findIndex((s) => s.step === "fired");
    const exit = steps.findIndex((s) => s.step === "exit");
    if (fired < 0) bad.push("the drain grace never fired");
    else if (exit !== fired + 1) bad.push("the exit was not reported in the grace's turn");
    return bad;
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
      // Not how long the exit took: the grace's own deadline fired and the exit came in that
      // turn, while the grandchild still held the pipe.
      const { exit, steps } = await lateStopped(5_000);
      expect(exit.stopped).toBeUndefined();
      expect(drainBroken(steps)).toEqual([]);
    },
    LONG,
  );

  test(
    "positive control: a drain grace that is ignored waits for the held pipe and fails the drain check",
    async () => {
      const { exit, steps } = await lateStopped(1_500, () => true);
      expect(exit.stopped).toEqual({ fileSeconds: 7.5, reason: "stop" });
      expect(drainBroken(steps)).toEqual(["the drain grace never fired"]);
    },
    LONG,
  );
});
