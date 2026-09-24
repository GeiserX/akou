/**
 * All calls of one app run (docs/DESIGN.md sections 1.5, 4.1, 4.5 and 6.2).
 *
 * - **One live call at a time.** A start while a call is starting, recording or paused answers
 *   `409 already_recording`. A call that is stopping does not block a new start: its helper is
 *   killed within the stop budget whatever happens, and two helpers may hold a tap at once.
 * - **Crash recovery at the next start.** `init()` closes what a previous run left open (see
 *   `recovery.ts`) and indexes every call on disk. `start()` runs it first if nobody did.
 * - **`live` and `last`.** Every call reference is a call id, `live` or `last`. `live` with
 *   nothing recording is `404 no_live_call` carrying the last call. `last` is refused with `400`
 *   on the live controls (`stop`, `pause`, `resume`, `mute`, `unmute`), so a control can never land
 *   on a finished call (TRAPS T3.14). `last` never names a failed start.
 */

import { join } from "node:path";
import type { LogEvent } from "../../core/log/events.ts";
import type { CallView } from "../../core/log/fold.ts";
import { readLog } from "../../core/log/reader.ts";
import { EVENTS_FILE, type WriterOptions } from "../../core/log/writer.ts";
import { type CaptureEngine, type Clock, realClock } from "../capture/engine.ts";
import type { IngestOptions, PartIngest } from "../capture/ingest.ts";
import type { Packet } from "../capture/protocol.ts";
import { CallController, type CaptureChoice, type StartOk } from "./call.ts";
import { checkWorkspace, createCallFolder, ulid } from "./folder.ts";
import {
  type CallSummary,
  listCallDirs,
  type RecoveryAction,
  recoverCall,
  summarize,
} from "./recovery.ts";
import { type CallBudgets, DEFAULT_BUDGETS, fail, type Outcome } from "./state.ts";

export interface CallManagerOptions {
  /** `~/Recordings/akou`, or a temporary folder in tests. */
  root: string;
  engine: CaptureEngine;
  clock?: Clock;
  budgets?: Partial<CallBudgets>;
  /** The user's name, written into `call.created`. */
  user?: string;
  /** IANA zone for folder names and `call.created.tz`. Defaults to the system zone. */
  tz?: string;
  akouVersion?: string;
  /** Default capture choice. */
  capture?: Partial<CaptureChoice>;
  ingest?: Omit<IngestOptions, "onGap" | "onFirstAudio">;
  writer?: WriterOptions;
  onEvent?(callId: string, e: LogEvent): void;
  onPacket?(callId: string, part: number, p: Packet, ingest: PartIngest): void;
  /** See `ControllerDeps.beforeEnd`: the live recognizer's flush before `call.ended`. */
  beforeEnd?(callId: string): Promise<void>;
}

export interface StartRequest {
  workspace?: string;
  title?: string;
  template?: string;
  mic?: string;
  call?: string;
}

export type CallRef = string;

/** Controls that must never land on a finished call. */
export const LIVE_CONTROLS = ["stop", "pause", "resume", "mute", "unmute"] as const;

export class CallManager {
  private readonly clock: Clock;
  private readonly budgets: CallBudgets;
  private readonly controllers = new Map<string, CallController>();
  private readonly index = new Map<string, CallSummary>();
  private warm = false;
  private initP: Promise<RecoveryAction[]> | null = null;
  /** Folders recovery could not read. They are skipped, never fatal. */
  readonly recoveryErrors: { dir: string; error: string }[] = [];

  constructor(private readonly o: CallManagerOptions) {
    this.clock = o.clock ?? realClock;
    this.budgets = { ...DEFAULT_BUDGETS, ...o.budgets };
  }

  /** Recovers crashed calls and indexes the root. Runs once; later calls share the result. */
  init(): Promise<RecoveryAction[]> {
    this.initP ??= this.runInit();
    return this.initP;
  }

  private async runInit(): Promise<RecoveryAction[]> {
    const actions: RecoveryAction[] = [];
    for (const { dir, workspace } of listCallDirs(this.o.root)) {
      if ([...this.controllers.values()].some((c) => c.dir === dir)) continue;
      // One unreadable folder must never stop a start: skip it and say so.
      try {
        const a = await recoverCall(dir, {
          now: () => this.clock.now(),
          abandonAfterMs: this.budgets.abandonAfterMs,
          writerOptions: this.o.writer,
        });
        if (a) actions.push(a);
        await this.reindex(dir, workspace);
      } catch (err) {
        this.recoveryErrors.push({ dir, error: (err as Error).message });
      }
    }
    return actions;
  }

  private async reindex(dir: string, workspace: string): Promise<void> {
    const { events } = await readLog(join(dir, EVENTS_FILE));
    const s = summarize(dir, workspace, events);
    if (s) this.index.set(s.id, s);
  }

  private deps(workspace: string) {
    return {
      engine: this.o.engine,
      clock: this.clock,
      budgets: this.budgets,
      ingest: this.o.ingest ?? {},
      writer: this.o.writer,
      isWarm: () => this.warm,
      markWarm: () => {
        this.warm = true;
      },
      onEvent: (id: string, e: LogEvent) => {
        this.onEvent(id, workspace, e);
        this.o.onEvent?.(id, e);
      },
      onPacket: this.o.onPacket,
      beforeEnd: this.o.beforeEnd,
    };
  }

  private onEvent(id: string, workspace: string, e: LogEvent): void {
    const c = this.controllers.get(id);
    if (!c) return;
    const prev = this.index.get(id);
    const live = c.view.live || c.live;
    this.index.set(id, {
      id,
      dir: c.dir,
      workspace,
      title: c.view.call?.title ?? prev?.title ?? "",
      createdAt: c.view.call?.t ?? prev?.createdAt ?? e.t,
      state: c.view.state,
      endedAt: live ? null : e.t,
      parts: c.view.parts().length,
    });
  }

  /** The live call: starting, recording or paused. */
  live(): CallController | null {
    for (const c of this.controllers.values()) if (c.live) return c;
    return null;
  }

  /** Every known call, newest first. */
  calls(opts: { failed?: boolean } = {}): CallSummary[] {
    const all = [...this.index.values()].sort((a, b) => b.createdAt - a.createdAt);
    return opts.failed
      ? all.filter((c) => c.state === "failed")
      : all.filter((c) => c.state !== "failed");
  }

  private lastSummary(): CallSummary | null {
    return this.calls()[0] ?? null;
  }

  /**
   * Resolves `live`, `last` or an id. `control` is true for the live controls, which refuse
   * `last`.
   */
  resolve(ref: CallRef, opts: { control?: boolean } = {}): Outcome<{ id: string }> {
    if (ref === "live") {
      const c = this.live();
      if (c) return { ok: true, id: c.id };
      const last = this.lastSummary();
      return {
        ...fail(404, "no_live_call", "nothing is recording"),
        last: last ? { id: last.id, title: last.title, endedAt: last.endedAt } : null,
      };
    }
    if (ref === "last") {
      if (opts.control) {
        return fail(
          400,
          "last_refused",
          "`last` is refused on live controls; name the call or use `live`",
        );
      }
      const last = this.lastSummary();
      return last ? { ok: true, id: last.id } : fail(404, "no_calls", "there are no calls yet");
    }
    if (this.index.has(ref) || this.controllers.has(ref)) return { ok: true, id: ref };
    return fail(404, "not_found", `no call ${ref}`);
  }

  view(ref: CallRef): CallView | null {
    const r = this.resolve(ref);
    if (!r.ok) return null;
    return this.controllers.get(r.id)?.view ?? null;
  }

  controller(id: string): CallController | undefined {
    return this.controllers.get(id);
  }

  // -------------------------------------------------------------------------
  // Start

  /**
   * `POST /calls`. Creates the folder and the log, spawns the helper, and answers once it
   * reports `capturing`.
   */
  async start(req: StartRequest = {}): Promise<Outcome<StartOk>> {
    await this.init();
    // Everything from here to the spawn is synchronous, so two starts cannot both pass the check.
    const live = this.live();
    if (live)
      return fail(409, "already_recording", "a call is already recording", { call: live.id });
    const workspace = req.workspace ?? "default";
    const bad = checkWorkspace(workspace);
    if (bad) return fail(400, "bad_workspace", bad);
    const title = req.title?.trim() || "Call";
    const tz = this.o.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = this.clock.now();
    const id = ulid(now);
    const capture: CaptureChoice = {
      mic: req.mic ?? this.o.capture?.mic ?? "default",
      call: req.call ?? this.o.capture?.call ?? "system",
      excludeResponsible: this.o.capture?.excludeResponsible,
    };
    let dir: string;
    let c: CallController;
    try {
      // Stage "folder": the folder, the lock and call.created. Nothing is spawned yet.
      dir = createCallFolder(this.o.root, workspace, now, tz, title);
      c = CallController.create(
        dir,
        {
          type: "call.created",
          id,
          schema: 1,
          workspace,
          title,
          tz,
          user: this.o.user ?? "",
          akou: this.o.akouVersion ?? "0.0.0",
          ...(req.template ? { template: req.template } : {}),
        },
        this.deps(workspace),
        capture,
      );
    } catch (err) {
      return fail(
        503,
        "capture_failed",
        `cannot create the call folder: ${(err as Error).message}`,
        {
          stage: "folder",
        },
      );
    }
    this.controllers.set(id, c);
    this.onEvent(id, workspace, c.view.call as LogEvent);
    return c.begin();
  }

  // -------------------------------------------------------------------------
  // Controls

  private async control(ref: CallRef, name: (typeof LIVE_CONTROLS)[number]): Promise<Outcome> {
    const r = this.resolve(ref, { control: true });
    if (!r.ok) return r;
    const c = this.controllers.get(r.id);
    if (!c?.live) return fail(409, "not_live", "that call is not recording", { call: r.id });
    switch (name) {
      case "stop":
        return c.stop();
      case "pause":
        return c.pause();
      case "resume":
        return c.resume();
      case "mute":
        return c.mute(true);
      case "unmute":
        return c.mute(false);
    }
  }

  stop(ref: CallRef = "live"): Promise<Outcome> {
    return this.control(ref, "stop");
  }

  pause(ref: CallRef = "live"): Promise<Outcome> {
    return this.control(ref, "pause");
  }

  resume(ref: CallRef = "live"): Promise<Outcome> {
    return this.control(ref, "resume");
  }

  mute(ref: CallRef = "live"): Promise<Outcome> {
    return this.control(ref, "mute");
  }

  unmute(ref: CallRef = "live"): Promise<Outcome> {
    return this.control(ref, "unmute");
  }

  /** A new part in the same call. `last` is accepted here (DESIGN 6.2). */
  async restart(
    ref: CallRef = "live",
    opts: { force?: boolean } = {},
  ): Promise<Outcome<{ part: number }>> {
    await this.init();
    const r = this.resolve(ref);
    if (!r.ok) return r;
    let c = this.controllers.get(r.id);
    if (!c?.live) {
      const other = this.live();
      if (other && other.id !== r.id) {
        return fail(409, "already_recording", "another call is recording", { call: other.id });
      }
    }
    if (!c) {
      const s = this.index.get(r.id);
      if (!s) return fail(404, "not_found", `no call ${r.id}`);
      const capture: CaptureChoice = {
        mic: this.o.capture?.mic ?? "default",
        call: this.o.capture?.call ?? "system",
        excludeResponsible: this.o.capture?.excludeResponsible,
      };
      c = await CallController.load(s.dir, this.deps(s.workspace), capture);
      this.controllers.set(c.id, c);
    }
    return c.restart(opts);
  }

  /** The quit path: stop the live call within the stop budget, then settle everything. */
  async quit(): Promise<void> {
    const c = this.live();
    if (c) await c.stop();
    await Promise.all([...this.controllers.values()].map((x) => x.idle()));
  }
}
