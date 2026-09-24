/**
 * One call: its folder, its log writer, its capture parts, and every transition, each written to
 * the event log (docs/DESIGN.md sections 1.3, 1.5, 2.4, 2.5 and 4.5).
 *
 * The rules this file keeps, each with a named test:
 *
 * - No timeout starts before the helper is spawned. The start budget (3 s warm, 10 s cold) is the
 *   only deadline, and `201` is answered only after `capturing` (T1.26, T3.6).
 * - A stop before `capturing` cancels the part with `part.ended {reason: cancelled}` and never
 *   marks anything failed (T1.26).
 * - A start that never captured writes `call.failed` and nothing else, keeps the folder, and never
 *   looks live (T2.49).
 * - Stop gives the helper the stop budget, then kills it (`part.ended {reason: killed}`). Nothing
 *   waits on the helper without a deadline (T0.9).
 * - Restart is make before break: the new helper captures before the old one is stopped, in the
 *   same folder, on the same clock, as the next part (T3.2, T2.48).
 * - A helper that exits on its own gives `part.ended {reason: helper-exit}` and an automatic
 *   restart; a `dead` call side for 60 s, or no packets at all for 10 s, also restart; five
 *   automatic restarts in ten minutes make the call `interrupted` (DESIGN 2.5, 4.5).
 * - A failed restart that leaves the call without a working helper is retried against the same
 *   limit, whoever asked for it, so a call never says recording while nothing captures.
 * - A restart during a pause keeps the call paused: the new part starts with a `pause` at 0.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nsToMs, PartClock } from "../../core/log/clock.ts";
import type { Channel, EventDraft, LogEvent } from "../../core/log/events.ts";
import { type CallView, fold } from "../../core/log/fold.ts";
import { readLog } from "../../core/log/reader.ts";
import { EVENTS_FILE, LockError, LogWriter, type WriterOptions } from "../../core/log/writer.ts";
import {
  type CaptureEngine,
  type CaptureSession,
  CHANNELS,
  type Clock,
  type ExitInfo,
  withDeadline,
} from "../capture/engine.ts";
import { type IngestOptions, PartIngest } from "../capture/ingest.ts";
import {
  CAPTURE_RATE,
  EXIT,
  type HealthMsg,
  type HelperMessage,
  nsFromWire,
  type Packet,
} from "../capture/protocol.ts";
import { partFile, partLog } from "./folder.ts";
import {
  assertTransition,
  type CallBudgets,
  type CallStatus,
  fail,
  type Outcome,
} from "./state.ts";

type StartSignal = { kind: "capturing" } | { kind: "exit"; exit: ExitInfo } | { kind: "cancelled" };

class Deferred<T> {
  resolve!: (v: T) => void;
  readonly promise = new Promise<T>((r) => {
    this.resolve = r;
  });
}

/** One helper process and the part it records. */
export class PartRun {
  session: CaptureSession | null = null;
  readonly ingest: PartIngest;
  clock: PartClock | null = null;
  readonly capturing = new Deferred<StartSignal>();
  /** `part.started` written. */
  started = false;
  /** `part.ended` written. */
  ended = false;
  /** A stop requested by the app is in progress: an exit is expected. */
  retiring = false;
  cancelled = false;
  /** The start failed or timed out; anything the helper still sends is ignored. */
  failed = false;
  helperVersion = "unknown";
  lastWarn: string | null = null;
  lastPacketAt = 0;
  bridge: { helperNs: bigint; appMono: bigint } | null = null;
  readonly health = new Map<Channel, string>();
  deadTimer: unknown = null;
  /** The dead-call timer fired and asked for a restart; cleared when the call side recovers. */
  deadFired = false;
  noBuffersRebuilt = false;
  stallReported = false;

  constructor(
    readonly part: number,
    ingest: IngestOptions,
  ) {
    this.ingest = new PartIngest(ingest);
  }

  /** Where the file ends, from the helper's `stopped` line or the last packet. */
  fileSeconds(exit?: ExitInfo | null): number {
    return exit?.stopped?.fileSeconds ?? this.ingest.fileSeconds;
  }
}

export interface CaptureChoice {
  mic: string;
  call: string;
  excludeResponsible?: string;
}

export interface ControllerDeps {
  engine: CaptureEngine;
  clock: Clock;
  budgets: CallBudgets;
  ingest: Omit<IngestOptions, "onGap" | "onFirstAudio">;
  writer?: WriterOptions;
  isWarm(): boolean;
  markWarm(): void;
  onEvent?(callId: string, e: LogEvent): void;
  /**
   * Every packet, after pause and mute are applied to the ingest. The recognizer takes its audio
   * from `ingest` (aligned, muted, bounded); tests look at `p`.
   */
  onPacket?(callId: string, part: number, p: Packet, ingest: PartIngest): void;
  /**
   * Runs before `call.ended` is written, within `budgets.flushMs`: the live recognizer writes the
   * segments still open. A call never waits on it past the budget.
   */
  beforeEnd?(callId: string): Promise<void>;
}

export type StartOk = { call: string; folder: string; part: number; startMs: number };

type LaunchResult =
  | { ok: true; run: PartRun }
  | { ok: false; cancelled: true; run: PartRun }
  | { ok: false; cancelled: false; stage: string; error: string; exitCode: number | null };

export class CallController {
  status: CallStatus = "idle";
  readonly view: CallView;
  muted = false;
  /** The part being recorded. */
  current: PartRun | null = null;
  /** A part whose helper is starting and has not captured yet. */
  launching: PartRun | null = null;
  private writer: LogWriter | null;
  /** Holders of the writer beyond the call's own capture (the final pass). */
  private holds = 0;
  private lastPart: number;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly autoRestarts: number[] = [];
  private restarting = false;
  private stopping: Promise<Outcome> | null = null;
  private watchdog: unknown = null;
  private readonly background = new Set<Promise<unknown>>();

  private constructor(
    readonly id: string,
    readonly dir: string,
    private readonly deps: ControllerDeps,
    public capture: CaptureChoice,
    events: readonly LogEvent[],
    writer: LogWriter | null,
  ) {
    this.writer = writer;
    this.view = fold(events);
    this.lastPart = 0;
    for (const e of events) {
      if (e.type === "part.started" || e.type === "part.ended")
        this.lastPart = Math.max(this.lastPart, e.part);
    }
  }

  /** A new call in a folder that was just created: writes `call.created`. */
  static create(
    dir: string,
    created: Extract<EventDraft, { type: "call.created" }>,
    deps: ControllerDeps,
    capture: CaptureChoice,
  ): CallController {
    const writer = LogWriter.open(dir, deps.writer);
    const c = new CallController(created.id, dir, deps, capture, [], writer);
    c.append(created);
    return c;
  }

  /** An existing call from disk, for a restart. No writer is held until it is needed. */
  static async load(
    dir: string,
    deps: ControllerDeps,
    capture: CaptureChoice,
  ): Promise<CallController> {
    const { events } = await readLog(join(dir, EVENTS_FILE));
    const first = events[0];
    if (first?.type !== "call.created") throw new Error(`${dir} has no call.created`);
    const c = new CallController(first.id, dir, deps, capture, events, null);
    const s = c.view.state;
    c.status = s === "failed" ? "failed" : s === "interrupted" ? "interrupted" : "ended";
    return c;
  }

  get live(): boolean {
    return this.status === "starting" || this.status === "recording" || this.status === "paused";
  }

  /** Last `t` of an event that ended audio, for the stale-restart rule. */
  lastAudioAt(): number {
    let t = 0;
    for (const p of this.view.parts()) {
      const ended = p.ended ? p.clock.wallFromAudio(p.ended.fileSeconds) : p.wallStart;
      t = Math.max(t, ended);
    }
    return t || (this.view.call?.t ?? 0);
  }

  // -------------------------------------------------------------------------
  // Log

  private append(draft: EventDraft): LogEvent {
    if (!this.writer) throw new Error(`call ${this.id} has no open writer`);
    const e = this.writer.append(draft);
    this.view.apply(e);
    this.deps.onEvent?.(this.id, e);
    return e;
  }

  private setStatus(to: CallStatus): void {
    if (this.status === to) return;
    assertTransition(this.status, to);
    this.status = to;
    if (to === "recording") this.armWatchdog();
  }

  private closeWriter(): void {
    if (this.holds > 0) return;
    this.writer?.close();
    this.writer = null;
  }

  /**
   * Appends an event from another part of the app (the recognizers). The log has one writer per
   * call, and this is it. Returns null when the log is closed (the call ended and nothing holds
   * it); the event is then dropped, and the final pass covers what it would have said.
   */
  record(draft: EventDraft): LogEvent | null {
    if (!this.writer) return null;
    return this.append(draft);
  }

  /**
   * Keeps the log open for writing after the call ends (the final pass), reopening it if needed.
   * Returns the release function; the writer closes when the last holder releases and the call is
   * not live.
   */
  holdWriter(): () => void {
    this.writer ??= LogWriter.open(this.dir, this.deps.writer);
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds === 0 && !this.live && this.status !== "stopping") this.closeWriter();
    };
  }

  /** Gives the live recognizer its budget to write the open segments before the call ends. */
  private async flushBeforeEnd(): Promise<void> {
    const hook = this.deps.beforeEnd;
    if (!hook) return;
    await withDeadline(this.deps.clock, hook(this.id), this.deps.budgets.flushMs);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, done);
    return p;
  }

  private spawnBackground(p: Promise<unknown>): void {
    this.background.add(p);
    const done = () => this.background.delete(p);
    p.then(done, (err) => {
      done();
      console.error(`call ${this.id}: background task failed`, err);
    });
  }

  /** Settles when every stop and automatic restart this call started has finished. For tests. */
  async idle(): Promise<void> {
    while (this.pending.size > 0 || this.background.size > 0) {
      await Promise.allSettled([...this.pending, ...this.background]);
    }
  }

  // -------------------------------------------------------------------------
  // Start

  /** Starts part 1 of a new call. Answers once the helper reports `capturing`. */
  async begin(): Promise<Outcome<StartOk>> {
    const t0 = this.deps.clock.now();
    this.setStatus("starting");
    const r = await this.launch();
    if (r.ok) {
      this.current = r.run;
      this.setStatus("recording");
      return {
        ok: true,
        call: this.id,
        folder: this.dir,
        part: r.run.part,
        startMs: this.deps.clock.now() - t0,
      };
    }
    if (r.cancelled) {
      return fail(409, "cancelled", "the call was stopped before capture started", {
        call: this.id,
      });
    }
    this.append({ type: "call.failed", stage: r.stage, error: r.error });
    this.setStatus("failed");
    this.closeWriter();
    return startFailure(r, this.id);
  }

  private nextPart(): number {
    this.lastPart++;
    return this.lastPart;
  }

  /**
   * Spawns a helper for the next part and waits for `capturing` within the start budget. The
   * budget starts after the spawn returned. On `capturing` the handler writes `part.started`.
   */
  private async launch(): Promise<LaunchResult> {
    const run = new PartRun(this.nextPart(), {
      ...this.deps.ingest,
      onGap: (g) => this.onGap(run, g.a, g.fromNs, g.toNs),
    });
    this.launching = run;
    try {
      mkdirSync(join(this.dir, "audio"), { recursive: true });
      mkdirSync(join(this.dir, "logs"), { recursive: true });
      try {
        run.session = this.deps.engine.start(
          {
            part: run.part,
            out: join(this.dir, partFile(run.part)),
            mic: this.capture.mic,
            call: this.capture.call,
            excludeResponsible: this.capture.excludeResponsible,
            logPath: join(this.dir, partLog(run.part)),
          },
          {
            packet: (p) => this.onPacket(run, p),
            message: (m) => this.onMessage(run, m),
            exit: (e) => this.onExit(run, e),
          },
        );
      } catch (err) {
        run.failed = true;
        return {
          ok: false,
          cancelled: false,
          stage: "spawn",
          error: (err as Error).message,
          exitCode: null,
        };
      }
      if (run.cancelled) return { ok: false, cancelled: true, run };
      const budget = this.deps.isWarm()
        ? this.deps.budgets.warmStartMs
        : this.deps.budgets.coldStartMs;
      const r = await withDeadline(this.deps.clock, run.capturing.promise, budget);
      if (!r.ok) {
        run.failed = true;
        run.session.kill();
        return {
          ok: false,
          cancelled: false,
          stage: "open",
          error: `the capture helper did not start capturing within ${budget} ms`,
          exitCode: null,
        };
      }
      const sig = r.value;
      if (sig.kind === "capturing") return { ok: true, run };
      if (sig.kind === "cancelled") return { ok: false, cancelled: true, run };
      run.failed = true;
      return {
        ok: false,
        cancelled: false,
        stage: "open",
        error: describeExit(sig.exit, run.lastWarn),
        exitCode: sig.exit.code,
      };
    } finally {
      if (this.launching === run) this.launching = null;
    }
  }

  // -------------------------------------------------------------------------
  // Helper events

  private onPacket(run: PartRun, p: Packet): void {
    if (run.failed || run.cancelled) return;
    const now = this.deps.clock.now();
    run.lastPacketAt = now;
    run.stallReported = false;
    run.bridge = {
      helperNs: p.captureNs + BigInt(Math.round((p.samples.length / CAPTURE_RATE) * 1e9)),
      appMono: this.deps.clock.mono(),
    };
    run.ingest.push(p);
    this.deps.onPacket?.(this.id, run.part, p, run.ingest);
  }

  private onMessage(run: PartRun, m: HelperMessage): void {
    switch (m.type) {
      case "hello":
        run.helperVersion = m.version;
        break;
      case "capturing":
        this.onCapturing(run, m.capture_ns, m.mic?.name ?? null, m.call?.mode ?? "none", m.exclude);
        break;
      case "health":
        if (run.started && !run.ended) this.onHealth(run, m);
        break;
      case "warn":
        run.lastWarn = `${m.code}: ${m.msg}`;
        break;
      default:
        break;
    }
  }

  private onCapturing(
    run: PartRun,
    captureNs: string | number,
    mic: string | null,
    mode: string,
    exclude: string[],
  ): void {
    if (run.cancelled || run.failed || run.started) return;
    const anchor = nsFromWire(captureNs);
    const e = this.append({
      type: "part.started",
      part: run.part,
      file: partFile(run.part),
      wallStart: this.deps.clock.now(),
      monoStart: nsToMs(anchor),
      mic,
      call: exclude.length > 0 ? { mode, exclude } : { mode },
      capture: `${this.deps.engine.name} ${run.helperVersion}`,
    });
    if (e.type === "part.started") run.clock = new PartClock(e);
    run.started = true;
    run.lastPacketAt = this.deps.clock.now();
    run.bridge = { helperNs: anchor, appMono: this.deps.clock.mono() };
    if (this.muted) {
      run.ingest.muted = true;
      this.append({ type: "mute", part: run.part, a: 0 });
    }
    if (this.status === "paused") {
      // A restart during a pause (a crash, a stall, a click) keeps the call paused: the new part
      // takes no audio until the user resumes, exactly as the old one would not have.
      run.ingest.pause();
      this.append({
        type: "pause",
        part: run.part,
        a: 0,
        wall: this.deps.clock.now(),
        mono: this.helperNowMs(run),
      });
      // The helper may report `capturing` from inside `start`, before its session is stored.
      queueMicrotask(() => run.session?.send("pause"));
    }
    this.deps.markWarm();
    run.capturing.resolve({ kind: "capturing" });
  }

  private onExit(run: PartRun, e: ExitInfo): void {
    if (!run.started) {
      run.capturing.resolve({ kind: "exit", exit: e });
      return;
    }
    if (run.retiring || run.ended) return;
    // The helper exited on its own while capturing.
    this.endPart(run, "helper-exit", run.fileSeconds(e));
    if (run === this.current && (this.status === "recording" || this.status === "paused")) {
      this.spawnBackground(this.autoRestart("the capture helper exited"));
    }
  }

  private onHealth(run: PartRun, m: HealthMsg): void {
    if (run.health.get(m.ch) !== m.state) {
      run.health.set(m.ch, m.state);
      this.append({
        type: "health",
        part: run.part,
        ch: m.ch,
        state: m.state,
        silentFor: m.silent_for,
        rebuilds: Math.max(0, Math.round(m.rebuilds)),
        detail: m.detail,
      });
    }
    if (run !== this.current) return;
    if (m.ch === "call" && m.state === "dead") {
      if (run.deadTimer === null) {
        run.deadTimer = this.deps.clock.setTimeout(() => {
          run.deadTimer = null;
          if (
            run === this.current &&
            !run.ended &&
            run.health.get("call") === "dead" &&
            this.status === "recording"
          ) {
            run.deadFired = true;
            this.spawnBackground(this.autoRestart("the call side stayed dead"));
          }
        }, this.deps.budgets.deadRestartMs);
      }
    } else if (m.ch === "call") {
      this.clearDead(run);
    }
    if (m.state === "no-buffers" && !run.noBuffersRebuilt) {
      run.noBuffersRebuilt = true;
      run.session?.send("rebuild_call");
      run.session?.send("rebuild_mic");
    }
    if (m.state === "tapped-apps-exited") void this.stop();
  }

  private clearDead(run: PartRun): void {
    run.deadFired = false;
    if (run.deadTimer !== null) {
      this.deps.clock.clearTimeout(run.deadTimer);
      run.deadTimer = null;
    }
  }

  private onGap(run: PartRun, a: number, fromNs: bigint, toNs: bigint): void {
    if (!run.clock || run.ended) return;
    const wallFrom = run.clock.wallFromCapture(fromNs);
    const wallTo = run.clock.wallFromCapture(toNs);
    this.append({ type: "gap", part: run.part, a, wallFrom, wallTo, reason: "sleep" });
    run.clock.gap({ a, wallTo });
  }

  private endPart(
    run: PartRun,
    reason: Extract<EventDraft, { type: "part.ended" }>["reason"],
    fileSeconds: number,
  ): void {
    if (run.ended) return;
    run.ended = true;
    this.clearDead(run);
    this.append({ type: "part.ended", part: run.part, reason, fileSeconds });
  }

  /** Stops a part's helper within the stop budget and writes its `part.ended`. */
  private retire(run: PartRun, reason: "stop" | "restart" | "cancelled"): Promise<void> {
    run.retiring = true;
    const session = run.session;
    if (!session) {
      if (reason === "cancelled") this.endPart(run, "cancelled", 0);
      return Promise.resolve();
    }
    return this.track(
      session.stop(this.deps.budgets.stopMs).then((out) => {
        if (reason === "cancelled")
          this.endPart(run, "cancelled", run.started ? run.fileSeconds(out.exit) : 0);
        else this.endPart(run, out.killed ? "killed" : reason, run.fileSeconds(out.exit));
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Watchdog: a helper that sends nothing at all is wedged

  private armWatchdog(): void {
    if (this.watchdog !== null) return;
    const every = Math.max(50, Math.min(1000, Math.floor(this.deps.budgets.stallMs / 4)));
    const tick = () => {
      this.watchdog = null;
      if (!this.live) return;
      const run = this.current;
      if (
        this.status === "recording" &&
        run?.started &&
        !run.ended &&
        !run.retiring &&
        !run.stallReported &&
        !this.restarting &&
        this.deps.clock.now() - run.lastPacketAt > this.deps.budgets.stallMs
      ) {
        run.stallReported = true;
        const silentFor = (this.deps.clock.now() - run.lastPacketAt) / 1000;
        for (const ch of CHANNELS) {
          run.health.set(ch, "stalled");
          this.append({
            type: "health",
            part: run.part,
            ch,
            state: "stalled",
            silentFor,
            rebuilds: 0,
            detail: "no audio from the capture helper; restarting it",
          });
        }
        this.spawnBackground(this.autoRestart("the capture helper stalled"));
      }
      this.watchdog = this.deps.clock.setTimeout(tick, every);
    };
    this.watchdog = this.deps.clock.setTimeout(tick, every);
  }

  private disarmWatchdog(): void {
    if (this.watchdog !== null) {
      this.deps.clock.clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  // -------------------------------------------------------------------------
  // Restart

  /** A new part in the same call. Make before break: the old helper stops after the new captures. */
  async restart(opts: { force?: boolean } = {}): Promise<Outcome<{ part: number }>> {
    if (this.status === "recording" || this.status === "paused") return this.restartLive();
    if (this.status === "ended" || this.status === "interrupted" || this.status === "failed") {
      const age = this.deps.clock.now() - this.lastAudioAt();
      if (age > this.deps.budgets.staleRestartMs && !opts.force) {
        return fail(
          409,
          "stale_restart",
          "the last audio is over an hour old; restart with force",
          { call: this.id },
        );
      }
      return this.reopen();
    }
    return fail(409, "not_restartable", `the call is ${this.status}`, { call: this.id });
  }

  /**
   * The part being recorded has no working helper: it exited, it stalled, or its call side stayed
   * dead. Only then does a failed restart try again.
   */
  private needsRestart(): boolean {
    const run = this.current;
    return !run || run.ended || run.stallReported || run.deadFired;
  }

  private async restartLive(): Promise<Outcome<{ part: number }>> {
    if (this.restarting)
      return fail(409, "restart_in_progress", "a restart is already running", { call: this.id });
    const r = await this.replaceHelper();
    // Whoever asked for this restart, a failure that leaves the call without a working helper is
    // retried (the automatic-restart limit still applies, so it ends in `interrupted`, never in a
    // call that says recording and captures nothing).
    if (
      !r.ok &&
      r.code !== "cancelled" &&
      (this.status === "recording" || this.status === "paused") &&
      this.needsRestart()
    ) {
      this.spawnBackground(this.autoRestart("a restart failed"));
    }
    return r;
  }

  private async replaceHelper(): Promise<Outcome<{ part: number }>> {
    this.restarting = true;
    try {
      const old = this.current;
      const r = await this.launch();
      if (!r.ok) {
        if (r.cancelled)
          return fail(409, "cancelled", "the call was stopped during the restart", {
            call: this.id,
          });
        return startFailure(r, this.id);
      }
      if (this.status !== "recording" && this.status !== "paused") {
        // Stopped or interrupted while the new helper was starting.
        await this.retire(r.run, "stop");
        return fail(409, "cancelled", "the call ended during the restart", { call: this.id });
      }
      this.current = r.run;
      if (old && !old.ended) void this.retire(old, "restart");
      return { ok: true, part: r.run.part };
    } finally {
      this.restarting = false;
    }
  }

  private async reopen(): Promise<Outcome<{ part: number }>> {
    const before = this.status;
    try {
      this.writer ??= LogWriter.open(this.dir, this.deps.writer);
    } catch (err) {
      if (err instanceof LockError) {
        return fail(409, "locked", `another writer holds the call's log (pid ${err.holderPid})`, {
          call: this.id,
        });
      }
      throw err;
    }
    this.setStatus("starting");
    const r = await this.launch();
    if (r.ok) {
      this.current = r.run;
      this.setStatus("recording");
      return { ok: true, part: r.run.part };
    }
    if (r.cancelled)
      return fail(409, "cancelled", "the call was stopped before capture started", {
        call: this.id,
      });
    // A restart of a call that already has audio never writes call.failed.
    this.setStatus(before);
    this.closeWriter();
    return startFailure(r, this.id);
  }

  private async autoRestart(_cause: string): Promise<void> {
    // A restart already running retries on its own if it fails (see `restartLive`).
    if (this.restarting) return;
    const now = this.deps.clock.now();
    const window = this.deps.budgets.autoRestartWindowMs;
    while (this.autoRestarts.length > 0 && now - (this.autoRestarts[0] as number) > window)
      this.autoRestarts.shift();
    if (this.autoRestarts.length >= this.deps.budgets.autoRestartLimit) {
      await this.interrupt();
      return;
    }
    this.autoRestarts.push(now);
    if (this.status !== "recording" && this.status !== "paused") return;
    await this.restartLive();
  }

  /** Too many automatic restarts: stop capturing, keep the call resumable. */
  private async interrupt(): Promise<void> {
    if (this.status !== "recording" && this.status !== "paused") return;
    this.setStatus("interrupted");
    this.disarmWatchdog();
    const launching = this.launching;
    if (launching) this.cancelLaunch(launching);
    if (this.current && !this.current.ended) void this.retire(this.current, "stop");
    await this.drain();
    await this.flushBeforeEnd();
    this.append({ type: "call.ended", reason: "interrupted" });
    this.closeWriter();
  }

  private cancelLaunch(run: PartRun): void {
    run.cancelled = true;
    run.capturing.resolve({ kind: "cancelled" });
    void this.retire(run, "cancelled");
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // -------------------------------------------------------------------------
  // Controls

  /** Stops the call. Resolves within the stop budget plus the kill grace, even if the helper hangs. */
  stop(): Promise<Outcome> {
    if (this.stopping) return this.stopping;
    if (!this.live)
      return Promise.resolve(
        fail(409, "not_live", `the call is ${this.status}`, { call: this.id }),
      );
    this.stopping = this.doStop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async doStop(): Promise<Outcome> {
    this.setStatus("stopping");
    this.disarmWatchdog();
    const launching = this.launching;
    if (launching) this.cancelLaunch(launching);
    const run = this.current;
    if (run && !run.ended) void this.retire(run, "stop");
    await this.drain();
    await this.flushBeforeEnd();
    this.append({ type: "call.ended", reason: "stop" });
    this.setStatus("ended");
    this.closeWriter();
    return { ok: true };
  }

  pause(): Outcome {
    const run = this.current;
    if (this.status !== "recording" || !run || this.restarting) {
      return fail(409, "not_recording", `the call is ${this.status}`, { call: this.id });
    }
    run.ingest.pause();
    run.session?.send("pause");
    this.append({
      type: "pause",
      part: run.part,
      a: run.ingest.fileSeconds,
      wall: this.deps.clock.now(),
      mono: this.helperNowMs(run),
    });
    this.setStatus("paused");
    return { ok: true };
  }

  resume(): Outcome {
    const run = this.current;
    if (this.status !== "paused" || !run)
      return fail(409, "not_paused", `the call is ${this.status}`, { call: this.id });
    run.session?.send("resume");
    run.ingest.resume();
    const e = this.append({
      type: "resume",
      part: run.part,
      a: run.ingest.fileSeconds,
      wall: this.deps.clock.now(),
      mono: this.helperNowMs(run),
    });
    if (e.type === "resume") run.clock?.resume(e);
    run.lastPacketAt = this.deps.clock.now();
    this.setStatus("recording");
    return { ok: true };
  }

  mute(on: boolean): Outcome {
    const run = this.current;
    if ((this.status !== "recording" && this.status !== "paused") || !run) {
      return fail(409, "not_recording", `the call is ${this.status}`, { call: this.id });
    }
    if (this.muted === on) return { ok: true };
    this.muted = on;
    run.ingest.muted = on;
    this.append({ type: on ? "mute" : "unmute", part: run.part, a: run.ingest.fileSeconds });
    return { ok: true };
  }

  /** The helper's host clock now, in ms, bridged from the latest packet. */
  private helperNowMs(run: PartRun): number {
    const b = run.bridge;
    if (!b) return nsToMs(this.deps.clock.mono());
    return nsToMs(b.helperNs + (this.deps.clock.mono() - b.appMono));
  }
}

function describeExit(e: ExitInfo, warn: string | null): string {
  const how =
    e.code === EXIT.permission
      ? "permission denied"
      : e.code === EXIT.noDevice
        ? "device not found"
        : e.code === EXIT.unavailable
          ? "capture unavailable"
          : e.protocolError
            ? `protocol error (${e.protocolError})`
            : "exited";
  const code = e.code !== null ? `code ${e.code}` : `signal ${e.signal ?? "unknown"}`;
  return `the capture helper ${how} before capturing (${code})${warn ? `: ${warn}` : ""}`;
}

function startFailure(
  r: { stage: string; error: string; exitCode: number | null },
  call: string,
): Extract<Outcome, { ok: false }> {
  if (r.exitCode === EXIT.permission)
    return fail(403, "permission", r.error, { stage: r.stage, call });
  return fail(503, "capture_failed", r.error, { stage: r.stage, call });
}
