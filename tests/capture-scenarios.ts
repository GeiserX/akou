/**
 * The capture traps against a real child process, written once and run against every helper that
 * speaks `akou-capture/1`: `scripts/fake-helper.ts` (tests/capture-traps.test.ts) and the Rust
 * helper in file mode (tests/capture-rust.e2e.test.ts). Each helper maps the same fault list to its
 * own switches. Budgets are small real durations; every wait has a deadline below the test
 * timeout, so a regression fails instead of hanging (TRAPS T4.31).
 *
 * A budget rule is read from the rig's steps (`Step`), never from how long something took: a
 * shared runner stalls for seconds at a time, and a stall changes durations but not the order in
 * which the app armed, fired and cleared its deadlines and the helper spoke, exited or was killed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { processAlive } from "../src/core/log/writer.ts";
import { CallManager } from "../src/main/call/manager.ts";
import type { CallBudgets } from "../src/main/call/state.ts";
import {
  type CaptureEngine,
  type CaptureSession,
  type CaptureStartOptions,
  type Clock,
  realClock,
  type StopOutcome,
} from "../src/main/capture/engine.ts";
import { AkouCaptureEngine } from "../src/main/capture/helper.ts";
import type { Packet } from "../src/main/capture/protocol.ts";
import { logOf, ofType, until } from "./capture-helpers.ts";
import { writeCallWav } from "./fixtures/audio.ts";
import { TZ, tempDir } from "./helpers.ts";

export const LONG = 20_000;
/** A `capturingDelayMs` no test outlives: a helper that is still opening whenever it is asked. */
export const NEVER = 3_600_000;

/**
 * One thing the app or the helper did, in the order the app saw it, with no time on it.
 *
 * - `spawn`, `said`, `kill`, `exit`: the helper session (`said` is a stderr message by type).
 * - `armed`, `fired`: a timer on the app's clock, the call's and the session's alike. A timer
 *   that is cleared has no `fired`.
 * - `ask`, `stopped`: a session's stop was asked, and answered.
 * - `started`: a start answered, from `Rig.start`.
 *
 * `fired`, `said` and `exit` are what the app can wait on: a timer of its clock, a helper message,
 * the helper's exit. Two steps with none of those between them followed each other without the app
 * waiting on anything recorded here, however loaded the runner was (`oneTurn`).
 */
export type Step =
  | { step: "spawn"; part: number }
  | { step: "armed"; id: number; ms: number }
  | { step: "fired"; id: number; ms: number }
  | { step: "said"; part: number; type: string }
  | { step: "kill"; part: number }
  | { step: "exit"; part: number; code: number | null; killedByUs: boolean }
  | { step: "ask"; part: number }
  | { step: "stopped"; part: number; killed: boolean }
  | { step: "started"; ok: boolean; status: number };

const TURN: readonly Step["step"][] = ["fired", "said", "exit"];

/** The steps as one line for a test's output. */
export function describeSteps(steps: readonly Step[]): string {
  return steps
    .map((s) => {
      switch (s.step) {
        case "armed":
          return `armed #${s.id} ${s.ms} ms`;
        case "fired":
          return `fired #${s.id}`;
        case "said":
          return `said ${s.type}`;
        case "exit":
          return `exit ${s.code ?? "-"}${s.killedByUs ? " (ours)" : ""}`;
        case "stopped":
          return `stop answered${s.killed ? " (killed)" : ""}`;
        case "started":
          return `started ${s.status}`;
        default:
          return s.step;
      }
    })
    .join(", ");
}

/**
 * The real clock, recording every timer armed and fired on it into `steps`. `drop` swallows a
 * timer (it is armed and never fires): the positive controls use it to take a deadline away.
 */
export function recordingClock(
  steps: Step[],
  drop?: (ms: number, before: Step | undefined) => boolean,
): Clock {
  let next = 0;
  return {
    now: () => realClock.now(),
    mono: () => realClock.mono(),
    setTimeout(fn, ms) {
      const id = ++next;
      const before = steps.at(-1);
      steps.push({ step: "armed", id, ms });
      if (drop?.(ms, before)) return undefined;
      return realClock.setTimeout(() => {
        steps.push({ step: "fired", id, ms });
        fn();
      }, ms);
    },
    clearTimeout(h) {
      if (h !== undefined) realClock.clearTimeout(h);
    },
  };
}

/**
 * Wraps `engine.start` so every session it starts adds its steps to `steps`: the spawn, each
 * message, the exit, a kill, and a stop's ask and answer.
 */
export function recordSteps(engine: CaptureEngine, steps: Step[]): void {
  const inner = engine.start.bind(engine);
  engine.start = (o, handlers) => {
    const part = o.part;
    const s = inner(o, {
      ...handlers,
      message(m) {
        steps.push({ step: "said", part, type: m.type });
        handlers.message(m);
      },
      exit(e) {
        steps.push({ step: "exit", part, code: e.code, killedByUs: e.killedByUs });
        handlers.exit(e);
      },
    });
    steps.push({ step: "spawn", part });
    const kill = s.kill.bind(s);
    s.kill = () => {
      steps.push({ step: "kill", part });
      kill();
    };
    const stop = s.stop.bind(s);
    s.stop = async (budget) => {
      steps.push({ step: "ask", part });
      const out = await stop(budget);
      steps.push({ step: "stopped", part, killed: out.killed });
      return out;
    };
    return s;
  };
}

/** Swallows the deadline armed right after `after` (a `spawn` or an `ask`): a budget ignored. */
export function dropDeadlineAfter(after: "spawn" | "ask") {
  return (_ms: number, before: Step | undefined) => before?.step === after;
}

/** The timer armed right after the first `after` step, and where it fired (-1 if it never did). */
function deadlineAfter(steps: readonly Step[], after: "spawn" | "ask") {
  const at = steps.findIndex((s) => s.step === after);
  const armed = at >= 0 ? steps[at + 1] : undefined;
  if (armed?.step !== "armed") return { at, armed: undefined, fired: -1 };
  const fired = steps.findIndex((s) => s.step === "fired" && s.id === armed.id);
  return { at, armed, fired };
}

/**
 * Whether `b` followed `a` (indexes) with no timer fired, message or exit between them: the step
 * that answers a deadline or an exit came straight from it, not after another wait.
 */
function oneTurn(steps: readonly Step[], a: number, b: number): boolean {
  return a >= 0 && b > a && !steps.slice(a + 1, b).some((s) => TURN.includes(s.step));
}

const indexOf = (steps: readonly Step[], f: (s: Step) => boolean) => steps.findIndex(f);

/**
 * [T1.26] with a helper that never says `capturing`: what is broken, from a start's steps. The
 * start budget is armed right after the spawn (never before it) with exactly `budget` ms; it
 * fires; the helper is killed in that turn, before it says `capturing`; it exits by our kill; the
 * start answers 503 after the budget fired.
 */
export function pastBudgetBroken(steps: readonly Step[], budget: number): string[] {
  const bad: string[] = [];
  const { at, armed, fired } = deadlineAfter(steps, "spawn");
  if (at < 0) return ["no helper was spawned"];
  if (!armed || armed.ms !== budget) bad.push(`no ${budget} ms start budget armed at the spawn`);
  if (armed && fired < 0) bad.push("the start budget never fired");
  const kill = indexOf(steps, (s) => s.step === "kill");
  if (kill < 0) bad.push("the helper was never killed");
  else if (!oneTurn(steps, fired, kill)) bad.push("the kill did not follow the budget in its turn");
  const capturing = indexOf(steps, (s) => s.step === "said" && s.type === "capturing");
  if (capturing >= 0 && (kill < 0 || capturing < kill)) bad.push("the helper said capturing");
  const exit = steps.find((s) => s.step === "exit");
  if (exit?.step !== "exit" || !exit.killedByUs) bad.push("the helper did not exit by our kill");
  const started = indexOf(steps, (s) => s.step === "started");
  const answer = steps[started];
  if (answer?.step !== "started" || answer.status !== 503) bad.push("the start did not answer 503");
  else if (fired < 0 || started < fired) bad.push("the start answered before its budget fired");
  return bad;
}

/**
 * [T3.6]: what is broken in a start that should answer on `capturing` with the `budget` ms start
 * budget (the warm one, when the app has started a call before). The budget is armed right after
 * the spawn; the helper says `capturing`; the start answers 201 after that; the budget never
 * fires. What the app adds in wall time (its own disk writes) is printed, and budgeted on the
 * reference Mac (scripts/gates/g8-start.ts).
 */
export function answeredOnCapturingBroken(steps: readonly Step[], budget: number): string[] {
  const bad: string[] = [];
  const { at, armed, fired } = deadlineAfter(steps, "spawn");
  if (at < 0) return ["no helper was spawned"];
  if (!armed || armed.ms !== budget) bad.push(`no ${budget} ms start budget armed at the spawn`);
  const capturing = indexOf(steps, (s) => s.step === "said" && s.type === "capturing");
  if (capturing < 0) bad.push("the helper never said capturing");
  const started = indexOf(steps, (s) => s.step === "started");
  const answer = steps[started];
  if (answer?.step !== "started" || !answer.ok) bad.push("the start did not answer 201");
  else if (capturing < 0 || started < capturing) bad.push("the start answered before capturing");
  if (fired >= 0 && (started < 0 || fired < started)) bad.push("the start budget fired");
  return bad;
}

/**
 * [T0.9] for a helper that hangs on stop: what is broken, from the stop's steps. The stop budget
 * is armed right after the ask with exactly `budget` ms; it fires; the kill follows in that turn;
 * the helper exits by our kill; the session answers `killed` in the turn it saw the exit.
 */
export function killedAtBudgetBroken(steps: readonly Step[], budget: number): string[] {
  const bad: string[] = [];
  const { at, armed, fired } = deadlineAfter(steps, "ask");
  if (at < 0) return ["no stop was asked"];
  if (!armed || armed.ms !== budget) bad.push(`no ${budget} ms stop budget armed at the ask`);
  if (armed && fired < 0) bad.push("the stop budget never fired");
  const kill = indexOf(steps, (s) => s.step === "kill");
  if (kill < 0) bad.push("the helper was never killed");
  else if (!oneTurn(steps, fired, kill)) bad.push("the kill did not follow the budget in its turn");
  const exit = indexOf(steps, (s) => s.step === "exit");
  const e = steps[exit];
  if (e?.step !== "exit" || !e.killedByUs) bad.push("the helper did not exit by our kill");
  const stopped = indexOf(steps, (s) => s.step === "stopped");
  const answer = steps[stopped];
  if (answer?.step !== "stopped" || !answer.killed) bad.push("the stop did not answer killed");
  else if (!oneTurn(steps, exit, stopped)) bad.push("the stop did not answer in the exit's turn");
  return bad;
}

/**
 * [T2.51]: what is broken in a stop the helper should finish by itself within `budget` ms. The
 * stop budget is armed right after the ask; the helper says `stopped` and exits 0; the stop
 * answers not killed; the budget never fires and nothing is killed.
 */
export function stoppedWithinBudgetBroken(steps: readonly Step[], budget: number): string[] {
  const bad: string[] = [];
  const { at, armed, fired } = deadlineAfter(steps, "ask");
  if (at < 0) return ["no stop was asked"];
  if (!armed || armed.ms !== budget) bad.push(`no ${budget} ms stop budget armed at the ask`);
  if (fired >= 0) bad.push("the stop budget fired");
  if (indexOf(steps, (s) => s.step === "said" && s.type === "stopped") < 0)
    bad.push("the helper never said stopped");
  const e = steps.find((s) => s.step === "exit");
  if (e?.step !== "exit" || e.code !== 0 || e.killedByUs) bad.push("the helper did not exit 0");
  if (steps.some((s) => s.step === "kill")) bad.push("the helper was killed");
  const answer = steps.find((s) => s.step === "stopped");
  if (answer?.step !== "stopped" || answer.killed) bad.push("the stop did not answer unkilled");
  return bad;
}

/** The traps' fault list; times are seconds of audio on the file timeline. */
export interface Faults {
  /** Source audio (16-bit stereo WAV at 16 kHz, left mic, right call). */
  wav?: string;
  /** 1 = real time (the default), 20 = twenty times faster. */
  speed?: number;
  capturingDelayMs?: number;
  exitBeforeCapturing?: number;
  callSilent?: boolean;
  callOmit?: boolean;
  /** The call side stops delivering buffers at this time, output still running. */
  callDeadAt?: number;
  /** The call side delivers buffers of zeros from this time, output still running. */
  callZerosAt?: number;
  hangOnStop?: boolean;
  crashAt?: number;
  stallAt?: number;
  sleepAt?: number;
  sleepFor?: number;
}

export interface HelperUnderTest {
  /** Names the describe blocks. */
  name: string;
  /** Program and leading arguments, before `run …`. */
  command: string[];
  env?: Record<string, string>;
  /** Extra arguments after `run --out … --mic … --call …` for these faults. */
  args(f: Faults): string[];
}

const FAKE = join(import.meta.dir, "..", "scripts", "fake-helper.ts");

/** `scripts/fake-helper.ts`, whose switches are the fault names. */
export const fakeHelper: HelperUnderTest = {
  name: "real child process",
  command: [process.execPath, FAKE],
  args(f) {
    const a: string[] = [];
    if (f.wav) a.push("--wav", f.wav);
    if (f.speed !== undefined) a.push("--speed", String(f.speed));
    if (f.capturingDelayMs !== undefined) a.push("--capturing-delay", String(f.capturingDelayMs));
    if (f.exitBeforeCapturing !== undefined)
      a.push("--exit-before-capturing", String(f.exitBeforeCapturing));
    if (f.callSilent) a.push("--call-silent");
    if (f.callOmit) a.push("--call-omit");
    if (f.callDeadAt !== undefined) a.push("--call-dead-at", String(f.callDeadAt));
    if (f.callZerosAt !== undefined) a.push("--call-zeros-at", String(f.callZerosAt));
    if (f.hangOnStop) a.push("--hang-on-stop");
    if (f.crashAt !== undefined) a.push("--crash-at", String(f.crashAt));
    if (f.stallAt !== undefined) a.push("--stall-at", String(f.stallAt));
    if (f.sleepAt !== undefined) a.push("--sleep-at", String(f.sleepAt));
    if (f.sleepFor !== undefined) a.push("--sleep-for", String(f.sleepFor));
    return a;
  },
};

/**
 * The Rust helper in file mode: `--from-wav` (never a device), looped, paced like the fake, and the
 * faults as `--simulate` switches, which only a build with the `simulate` feature accepts.
 * `AKOU_CAPTURE_FILE_ONLY=1` makes it refuse device capture outright, so a mistake here can never
 * open a device or ask for a permission.
 */
export function rustHelper(bin: string, defaultWav: string): HelperUnderTest {
  return {
    name: "akou-capture (Rust)",
    command: [bin],
    env: { AKOU_CAPTURE_FILE_ONLY: "1" },
    args(f) {
      const a = ["--from-wav", f.wav ?? defaultWav, "--loop", "--speed", String(f.speed ?? 1)];
      const sim = (s: string) => a.push("--simulate", s);
      if (f.capturingDelayMs !== undefined) sim(`capturing-delay=${f.capturingDelayMs}`);
      if (f.exitBeforeCapturing !== undefined)
        sim(`exit-before-capturing=${f.exitBeforeCapturing}`);
      if (f.callSilent) sim("call-silent");
      if (f.callOmit) sim("call-omit");
      if (f.callDeadAt !== undefined) sim(`call-dead-at=${f.callDeadAt}`);
      if (f.callZerosAt !== undefined) sim(`call-zeros-at=${f.callZerosAt}`);
      if (f.hangOnStop) sim("hang-on-stop");
      if (f.crashAt !== undefined) sim(`crash-at=${f.crashAt}`);
      if (f.stallAt !== undefined) sim(`stall-at=${f.stallAt}`);
      if (f.sleepAt !== undefined) sim(`sleep-at=${f.sleepAt}`);
      if (f.sleepFor !== undefined) sim(`sleep-for=${f.sleepFor}`);
      return a;
    },
  };
}

const cleanups: (() => void | Promise<void>)[] = [];

/**
 * Runs the rigs' cleanups (quit the manager, kill every helper it spawned, remove the folder) after
 * each test. Every test file that uses `rig` calls this once at its top level: a hook registered
 * here, in a module several test files share, would belong to whichever file loaded it first.
 */
export function useRigCleanups(): void {
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
}

/** Registers a cleanup that runs after the current test. */
export function onCleanup(c: () => void | Promise<void>): void {
  cleanups.push(c);
}

export interface Rig {
  root: string;
  mgr: CallManager;
  events: LogEvent[];
  packets: { part: number; p: Packet; at: number }[];
  pids: number[];
  /** Every helper session the engine started, in order. */
  sessions: CaptureSession[];
  /** What each session's stop did and when (`performance.now()`), in the same order. */
  stops: StopTimes[];
  /** What the app and the helpers did, in order (`Step`). */
  steps: Step[];
  /** `mgr.start`, adding its answer to `steps`. */
  start(req: Parameters<CallManager["start"]>[0]): ReturnType<CallManager["start"]>;
}

export interface RigOptions {
  /** Swallows a timer on the app's clock (`recordingClock`). */
  drop?: (ms: number, before: Step | undefined) => boolean;
  /** Runs on every new session, after the rig has wrapped it, before the app sees it. */
  session?: (s: CaptureSession) => void;
}

/**
 * The helper's side of a stop, apart from the call's own work around it: when the session was
 * asked to stop, when the helper said `stopped`, when the session killed it, when it saw the exit
 * and when its stop answered, and what it answered.
 */
export interface StopTimes {
  asked?: number;
  said?: number;
  kill?: number;
  exit?: number;
  answered?: number;
  outcome?: StopOutcome;
}

/** One line for a test's output, in ms after the stop was asked. */
export function describeStop(t: StopTimes, took: number): string {
  const at = (x?: number) =>
    x === undefined || t.asked === undefined ? "-" : `${Math.round(x - t.asked)}`;
  return `stop took ${Math.round(took)} ms; helper said stopped at ${at(t.said)}, killed at ${at(t.kill)}, exit seen at ${at(t.exit)}, session answered at ${at(t.answered)}`;
}

/**
 * [T0.9]'s rule: between the ask and the kill the event loop never goes half the stop budget
 * without a turn. The budget itself would pass a stop that held the loop for all but one turn of
 * it; a free loop holds for one timer period (12 ms measured on a laptop).
 */
export function holdBound(budget: number): number {
  return budget / 2;
}

/**
 * The longest the event loop went without a turn between `from` and `to`, from the times a timer
 * ran (`turns`). With no turn in between it is the whole window: a stop that held the loop from
 * the ask to the kill scores the budget itself.
 */
export function longestHold(turns: readonly number[], from: number, to: number): number {
  let last = from;
  let most = 0;
  for (const t of turns) {
    if (t <= from || t >= to) continue;
    most = Math.max(most, t - last);
    last = t;
  }
  return Math.max(most, to - last);
}

/** A call manager whose engine spawns `h` (or `command`, for a helper that is not one of them). */
export function rig(
  h: HelperUnderTest,
  faults: (o: CaptureStartOptions) => Faults,
  budgets: Partial<CallBudgets> = {},
  command?: string[],
  opts: RigOptions = {},
): Rig {
  const { dir: root, cleanup } = tempDir();
  const events: LogEvent[] = [];
  const packets: Rig["packets"] = [];
  const pids: number[] = [];
  const sessions: CaptureSession[] = [];
  const stops: StopTimes[] = [];
  const steps: Step[] = [];
  const clock = recordingClock(steps, opts.drop);
  const engine = new AkouCaptureEngine({
    command: command ?? h.command,
    extraArgs: (o) => h.args(faults(o)),
    env: h.env,
    clock,
  });
  recordSteps(engine, steps);
  const inner = engine.start.bind(engine);
  engine.start = (o, handlers) => {
    const t: StopTimes = {};
    const s = inner(o, {
      ...handlers,
      message(m) {
        if (m.type === "stopped") t.said ??= performance.now();
        handlers.message(m);
      },
      exit(e) {
        t.exit ??= performance.now();
        handlers.exit(e);
      },
    });
    const kill = s.kill.bind(s);
    s.kill = () => {
      t.kill ??= performance.now();
      kill();
    };
    const stop = s.stop.bind(s);
    s.stop = async (budget) => {
      t.asked ??= performance.now();
      const out = await stop(budget);
      t.answered = performance.now();
      t.outcome = out;
      return out;
    };
    if (s.pid) pids.push(s.pid);
    sessions.push(s);
    stops.push(t);
    opts.session?.(s);
    return s;
  };
  const mgr = new CallManager({
    root,
    engine,
    clock,
    tz: TZ,
    budgets: { coldStartMs: 5_000, warmStartMs: 3_000, stopMs: 2_000, ...budgets },
    ingest: { queueSeconds: 10 },
    onEvent: (_, e) => events.push(e),
    onPacket: (_, part, p) => packets.push({ part, p, at: performance.now() }),
  });
  cleanups.push(async () => {
    await mgr.quit();
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    cleanup();
  });
  const start: Rig["start"] = async (req) => {
    const res = await mgr.start(req);
    steps.push({ step: "started", ok: res.ok, status: res.ok ? 201 : res.status });
    return res;
  };
  return { root, mgr, events, packets, pids, sessions, stops, steps, start };
}

const has = (events: LogEvent[], f: (e: LogEvent) => boolean) => () => events.some(f);

/** Registers every capture trap scenario against `h`. */
export function captureTrapScenarios(h: HelperUnderTest): void {
  describe(`${h.name}: start and stop`, () => {
    test(
      "[T1.26] stop 200 ms after start while the helper is still opening: cancelled, never failed",
      async () => {
        // The helper is still opening when the stop comes, however late the runner makes it: it
        // never says `capturing` by itself, so only the stop can end its open.
        const r = rig(h, () => ({ capturingDelayMs: NEVER }), { coldStartMs: 10_000 });
        const start = r.mgr.start({ workspace: "work" });
        await Bun.sleep(200);
        const stop = r.mgr.stop("live");
        expect(await start).toMatchObject({ ok: false, code: "cancelled" });
        expect((await stop).ok).toBe(true);
        expect(ofType(r.events, "part.ended")[0]?.reason).toBe("cancelled");
        expect(ofType(r.events, "call.failed")).toEqual([]);
        expect(ofType(r.events, "part.started")).toEqual([]);
      },
      LONG,
    );

    test(
      "[T1.26] capturing past the budget: 503 capture_failed {stage: open}, call.failed, helper killed",
      async () => {
        // The helper never says `capturing`, so only the budget can end the start. The rule is read
        // from the steps (`pastBudgetBroken`), not from how long the start took: a runner that
        // stalls for seconds (3.2 s once on Windows) moves every time and none of the order.
        const budget = 500;
        const r = rig(h, () => ({ capturingDelayMs: NEVER }), { coldStartMs: budget });
        const res = await r.start({ workspace: "work" });
        expect(res).toMatchObject({
          ok: false,
          status: 503,
          code: "capture_failed",
          stage: "open",
        });
        expect(ofType(r.events, "call.failed")[0]?.stage).toBe("open");
        // A helper we killed exits; waiting for that exit is the test's only wait.
        if (r.steps.some((s) => s.step === "kill")) await r.sessions[0]?.exited;
        console.log(`[T1.26] ${describeSteps(r.steps)}`);
        expect(pastBudgetBroken(r.steps, budget)).toEqual([]);
        expect(processAlive(r.pids[0] as number)).toBe(false);
      },
      LONG,
    );

    test(
      "[T2.49] a helper exiting 77 before capturing answers 403 and writes call.failed",
      async () => {
        const r = rig(h, () => ({ exitBeforeCapturing: 77 }));
        const res = await r.mgr.start({ workspace: "work" });
        expect(res).toMatchObject({ ok: false, status: 403, code: "permission" });
        if (res.ok) throw new Error("unreachable");
        expect(res.error).toContain("permission");
        expect(ofType(r.events, "call.failed").length).toBe(1);
        expect(r.mgr.live()).toBeNull();
      },
      LONG,
    );

    test(
      "[T0.9] a hung teardown is killed within the stop budget, the app stays responsive, the next start is fast",
      async () => {
        const budget = 300;
        const r = rig(h, (o) => (o.part === 1 ? { hangOnStop: true } : {}), { stopMs: budget });
        const a = await r.mgr.start({ workspace: "work", title: "Hangs" });
        expect(a.ok).toBe(true);
        await until(() => r.packets.length > 10, 3_000, "packets");
        // The event loop keeps turning while the helper hangs: a timer's turns, in order with the
        // stop's own steps.
        const turns: number[] = [];
        const timer = setInterval(() => turns.push(performance.now()), 10);
        const from = r.steps.length;
        const t0 = performance.now();
        const stop = await r.mgr.stop("live");
        const took = performance.now() - t0;
        clearInterval(timer);
        const at = r.stops[0] as StopTimes;
        const held = longestHold(turns, at.asked as number, at.kill as number);
        console.log(
          `[T0.9] ${describeStop(at, took)}; longest the loop was held while the helper hung ${Math.round(held)} ms`,
        );
        expect(stop.ok).toBe(true);
        // The helper had the whole budget, then was killed.
        expect(at.kill).toBeDefined();
        expect((at.kill as number) - (at.asked as number)).toBeGreaterThanOrEqual(budget - 20);
        // Between the ask and the kill the loop turned, and never went half the budget without a
        // turn while the helper hung. Only this window is the rule: after the kill the call syncs part.ended and
        // call.ended to disk, which takes what the runner's disk takes.
        expect(held).toBeLessThan(holdBound(budget));
        // The kill worked: the session saw the helper exit within the kill grace (past it, the
        // session gives up on the exit and answers with none).
        expect(at.outcome).toMatchObject({ killed: true, exit: { killedByUs: true } });
        // Killed at the budget, from the steps: the stop budget armed at the ask is `budget` ms,
        // the kill came in the turn it fired, and the session answered in the turn it saw the
        // exit. What the stop took after that (syncing part.ended and call.ended) is the runner's
        // disk, printed above. The same budget on a manual clock: call-machine.test.ts.
        const stopSteps = r.steps.slice(from);
        console.log(`[T0.9] ${describeSteps(stopSteps)}`);
        expect(killedAtBudgetBroken(stopSteps, budget)).toEqual([]);
        expect(ofType(r.events, "part.ended")[0]).toMatchObject({ reason: "killed" });
        expect(processAlive(r.pids[0] as number)).toBe(false);
        // The next start is a fresh helper, answered on its `capturing` under the warm budget.
        const next = r.steps.length;
        const b = await r.start({ workspace: "work", title: "Next" });
        expect(b.ok).toBe(true);
        expect(answeredOnCapturingBroken(r.steps.slice(next), 3_000)).toEqual([]);
      },
      LONG,
    );

    test(
      "the helper's stderr is kept in the part's capture log",
      async () => {
        const r = rig(h, () => ({}));
        const a = await r.mgr.start({ workspace: "work" });
        if (!a.ok) throw new Error(a.error);
        await r.mgr.stop("live");
        const log = readFileSync(join(a.folder, "logs/capture-part-001.log"), "utf8");
        expect(log).toContain('"type":"hello"');
        expect(log).toContain('"type":"stopped"');
        expect(existsSync(join(a.folder, "audio/part-001.opus"))).toBe(true);
      },
      LONG,
    );

    test(
      "[T3.6] with the app running, a warm start answers 201 on capturing, under the warm budget",
      async () => {
        const r = rig(h, () => ({}), { coldStartMs: 5_000, warmStartMs: 3_000 });
        const warm = await r.mgr.start({ workspace: "work" });
        expect(warm.ok).toBe(true);
        await r.mgr.stop("live");
        const from = r.steps.length;
        const t0 = performance.now();
        const res = await r.start({ workspace: "work" });
        const took = performance.now() - t0;
        expect(res.ok).toBe(true);
        // The rule, from the steps: the warm budget (not the cold one) is armed at the spawn, and
        // the start answers on the helper's `capturing` with that budget never firing. The 1 s
        // itself is a wall-clock budget, measured on the reference Mac (scripts/gates/g8-start.ts);
        // a shared runner only prints it.
        const steps = r.steps.slice(from);
        console.log(
          `[T3.6] warm start answered in ${Math.round(took)} ms: ${describeSteps(steps)}`,
        );
        expect(answeredOnCapturingBroken(steps, 3_000)).toEqual([]);
      },
      LONG,
    );

    test(
      "[T2.51] quit stops the live helper within the stop budget and leaves the log ended",
      async () => {
        // The helper's own stop (finish the file, say stopped, exit) takes 10 to 50 ms on every
        // runner; the budget leaves room for a runner that stalls for a second or so.
        const budget = 2_000;
        const r = rig(h, () => ({}), { stopMs: budget });
        const a = await r.mgr.start({ workspace: "work" });
        if (!a.ok) throw new Error(a.error);
        await until(() => r.packets.length > 10, 3_000, "packets");
        const from = r.steps.length;
        const t0 = performance.now();
        await r.mgr.quit();
        const took = performance.now() - t0;
        const at = r.stops[0] as StopTimes;
        console.log(`[T2.51] ${describeStop(at, took)}`);
        // The helper stopped by itself: it said `stopped` and exited 0 within the budget, and was
        // never killed. "Within the budget" is the session's own deadline, which never fired, not
        // how long the whole quit took (that includes syncing the log on the runner's disk).
        expect(at.said).toBeDefined();
        expect(at.outcome).toMatchObject({ killed: false, exit: { code: 0, killedByUs: false } });
        expect(stoppedWithinBudgetBroken(r.steps.slice(from), budget)).toEqual([]);
        expect(processAlive(r.pids[0] as number)).toBe(false);
        const log = await logOf(a.folder);
        expect(log.slice(-2).map((e) => e.type)).toEqual(["part.ended", "call.ended"]);
        expect(r.mgr.live()).toBeNull();
      },
      LONG,
    );
  });

  describe(`${h.name}: while recording`, () => {
    test(
      "[T0.16] silent from the start: mic frames arrive from the first second, call side zero-filled",
      async () => {
        const { dir, cleanup } = tempDir();
        onCleanup(cleanup);
        const wav = join(dir, "call.wav");
        writeCallWav(wav, 4);
        const r = rig(h, () => ({ wav, callSilent: true }));
        const t0 = performance.now();
        const a = await r.mgr.start({ workspace: "work" });
        expect(a.ok).toBe(true);
        await until(
          () => r.packets.filter((x) => x.p.ch === "mic").length >= 50,
          3_000,
          "a second of mic",
        );
        const mic = r.packets.filter((x) => x.p.ch === "mic");
        const call = r.packets.filter((x) => x.p.ch === "call");
        expect(mic[0]?.p.fileSeconds).toBe(0);
        expect((mic[0]?.at ?? Number.POSITIVE_INFINITY) - t0).toBeLessThan(
          1_000 + (a.ok ? a.startMs : 0),
        );
        expect(mic.some((x) => x.p.samples.some((v) => v !== 0))).toBe(true);
        expect(call.length).toBeGreaterThan(0);
        expect(call.every((x) => x.p.zeroFilled && x.p.samples.every((v) => v === 0))).toBe(true);
        const ing = r.mgr.live()?.current?.ingest;
        expect(ing?.firstAudio).toEqual({ mic: true, call: false });
      },
      LONG,
    );

    test(
      "[T0.2] dead call side: health {dead} is logged and a long-dead call side restarts as a new part",
      async () => {
        const r = rig(h, (o) => (o.part === 1 ? { callDeadAt: 0.5, speed: 20 } : {}), {
          deadRestartMs: 400,
        });
        const a = await r.mgr.start({ workspace: "work" });
        expect(a.ok).toBe(true);
        await until(
          has(r.events, (e) => e.type === "health" && e.state === "dead"),
          5_000,
          "health dead",
        );
        const dead = ofType(r.events, "health").find((e) => e.state === "dead");
        expect(dead).toMatchObject({ part: 1, ch: "call", rebuilds: 1 });
        await until(
          has(r.events, (e) => e.type === "part.started" && e.part === 2),
          8_000,
          "the automatic restart",
        );
        await r.mgr.live()?.idle();
        expect(ofType(r.events, "part.ended")[0]).toMatchObject({ part: 1, reason: "restart" });
      },
      LONG,
    );

    test(
      "[T0.2] a call side with no buffers at all is rebuilt within a second; one of zeros waits the 10 s probe rule",
      async () => {
        const deadOf = async (f: Faults) => {
          const r = rig(h, (o) => (o.part === 1 ? { ...f, speed: 20 } : {}));
          const a = await r.mgr.start({ workspace: "work" });
          expect(a.ok).toBe(true);
          await until(
            has(r.events, (e) => e.type === "health" && e.state === "dead"),
            5_000,
            "health dead",
          );
          await r.mgr.stop("live");
          return ofType(r.events, "health").find((e) => e.state === "dead");
        };
        const stopped = await deadOf({ callDeadAt: 0.5 });
        expect(stopped?.silentFor).toBeGreaterThanOrEqual(1);
        expect(stopped?.silentFor).toBeLessThan(2);
        const zeros = await deadOf({ callZerosAt: 0.5 });
        expect(zeros?.silentFor).toBeGreaterThanOrEqual(10);
      },
      LONG,
    );

    test(
      "helper crash: part.ended {helper-exit}, automatic restart; after stop the next start answers fast",
      async () => {
        // The helper crashes after 15 packets of 20 ms: every packet it wrote before the crash
        // reaches the app, so the part ends at 0.3 s of audio, whatever the wall clock did.
        const crashAt = 0.3;
        const r = rig(h, (o) => (o.part === 1 ? { crashAt } : {}));
        const a = await r.mgr.start({ workspace: "work" });
        expect(a.ok).toBe(true);
        await until(
          has(r.events, (e) => e.type === "part.started" && e.part === 2),
          5_000,
          "restart after crash",
        );
        const ended = ofType(r.events, "part.ended")[0];
        expect(ended).toMatchObject({ part: 1, reason: "helper-exit" });
        const mic = r.packets.filter((x) => x.part === 1 && x.p.ch === "mic");
        const packet = (mic[0]?.p.samples.length ?? 0) / 16000;
        expect(packet).toBeGreaterThan(0);
        expect(mic.length).toBe(Math.round(crashAt / packet));
        expect(Math.abs((ended?.fileSeconds ?? 0) - crashAt)).toBeLessThanOrEqual(packet);
        expect(r.mgr.live()?.status).toBe("recording");
        await r.mgr.stop("live");
        // The next start answers on its helper's `capturing` under the warm budget.
        const next = r.steps.length;
        const b = await r.start({ workspace: "work" });
        expect(b.ok).toBe(true);
        expect(answeredOnCapturingBroken(r.steps.slice(next), 3_000)).toEqual([]);
      },
      LONG,
    );

    test(
      "[T3.2] a restart continues the same call as a new part in the same folder",
      async () => {
        const r = rig(h, () => ({}));
        const a = await r.mgr.start({ workspace: "work", title: "Planning" });
        if (!a.ok) throw new Error(a.error);
        await until(() => r.packets.length > 10, 3_000, "packets");
        const res = await r.mgr.restart("live");
        expect(res).toMatchObject({ ok: true, part: 2 });
        await r.mgr.live()?.idle();
        const log = await logOf(a.folder);
        const order = log
          .filter((e) => e.type === "part.started" || e.type === "part.ended")
          .map((e) => `${e.type}:${(e as { part: number }).part}`);
        expect(order).toEqual(["part.started:1", "part.started:2", "part.ended:1"]);
        expect(ofType(log, "part.ended")[0]?.reason).toBe("restart");
        for (const f of [
          "audio/part-001.opus",
          "audio/part-002.opus",
          "logs/capture-part-002.log",
        ]) {
          expect(existsSync(join(a.folder, f))).toBe(true);
        }
        expect(new Set(ofType(log, "call.created").map((e) => e.id)).size).toBe(1);
      },
      LONG,
    );

    test(
      "[T0.15] one source never delivers: queues stay bounded and both channels stay aligned",
      async () => {
        const r = rig(h, () => ({ callOmit: true, speed: 20 }));
        const a = await r.mgr.start({ workspace: "work" });
        expect(a.ok).toBe(true);
        const ing = () => r.mgr.live()?.current?.ingest;
        // 10 s queue cap (rig), at least 30 s of audio.
        await until(() => (ing()?.pos.mic ?? 0) > 30 * 16000, 8_000, "30 s of audio");
        const i = ing();
        if (!i) throw new Error("no ingest");
        expect(i.packets.call).toBe(0);
        expect(i.pos.mic - i.pos.call).toBeLessThanOrEqual(16000);
        expect(i.queues.mic.peak).toBeLessThanOrEqual(10 * 16000);
        expect(i.queues.call.peak).toBeLessThanOrEqual(10 * 16000);
        expect(i.queues.mic.dropped).toBeGreaterThan(0);
      },
      LONG,
    );

    test(
      "a helper that stops sending anything is restarted by the watchdog",
      async () => {
        const r = rig(h, (o) => (o.part === 1 ? { stallAt: 0.5 } : {}), { stallMs: 400 });
        const a = await r.mgr.start({ workspace: "work" });
        expect(a.ok).toBe(true);
        await until(
          has(r.events, (e) => e.type === "part.started" && e.part === 2),
          6_000,
          "the watchdog restart",
        );
        expect(ofType(r.events, "health").filter((e) => e.state === "stalled").length).toBe(2);
      },
      LONG,
    );

    test(
      "[spike] wake from sleep: a host-clock jump becomes one gap event with the right wall span",
      async () => {
        const r = rig(h, () => ({ sleepAt: 0.5, sleepFor: 3600, speed: 5 }));
        const a = await r.mgr.start({ workspace: "work" });
        expect(a.ok).toBe(true);
        await until(
          has(r.events, (e) => e.type === "gap"),
          5_000,
          "a gap",
        );
        const gap = ofType(r.events, "gap")[0];
        expect(gap?.a).toBeCloseTo(0.5, 1);
        expect(((gap?.wallTo ?? 0) - (gap?.wallFrom ?? 0)) / 1000).toBeCloseTo(3600, 0);
      },
      LONG,
    );

    test(
      "pause tells the helper to drop audio; the file position does not advance while paused",
      async () => {
        const r = rig(h, () => ({}));
        const a = await r.mgr.start({ workspace: "work" });
        expect(a.ok).toBe(true);
        await until(() => r.packets.length > 20, 3_000, "packets");
        expect((await r.mgr.pause("live")).ok).toBe(true);
        await Bun.sleep(500);
        expect((await r.mgr.resume("live")).ok).toBe(true);
        await until(() => r.packets.length > 60, 3_000, "packets after resume");
        const pause = ofType(r.events, "pause")[0];
        const resume = ofType(r.events, "resume")[0];
        expect(pause && resume).toBeTruthy();
        // Half a second of pause is not in the file: resume continues within a packet or two of the pause.
        expect(Math.abs((resume?.a ?? 0) - (pause?.a ?? 0))).toBeLessThan(0.1);
        expect((resume?.wall ?? 0) - (pause?.wall ?? 0)).toBeGreaterThanOrEqual(450);
      },
      LONG,
    );
  });
}
