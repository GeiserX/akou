/**
 * The call state machine, driven by a scripted in-process helper and a manual clock, so every
 * budget is exact and no test waits on real time (TRAPS T4.31).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PartClock } from "../src/core/log/clock.ts";
import type { LogEvent } from "../src/core/log/events.ts";
import { LOCK_FILE } from "../src/core/log/writer.ts";
import { folderName, slugify, ulid } from "../src/main/call/folder.ts";
import { CallManager } from "../src/main/call/manager.ts";
import { opusDurationSeconds } from "../src/main/call/recovery.ts";
import {
  assertTransition,
  type CallBudgets,
  type CallStatus,
  canTransition,
  TRANSITIONS,
  TransitionError,
} from "../src/main/call/state.ts";
import { flush, logOf, ManualClock, ofType, ScriptedEngine, types } from "./capture-helpers.ts";
import { jsonl, LogBuilder, T0, TZ, tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(budgets: Partial<CallBudgets> = {}) {
  const { dir: root, cleanup } = tempDir();
  cleanups.push(cleanup);
  const clock = new ManualClock();
  const engine = new ScriptedEngine(clock);
  const events: LogEvent[] = [];
  const mgr = new CallManager({
    root,
    engine,
    clock,
    tz: TZ,
    user: "Ana",
    budgets: { stallMs: 1e12, ...budgets },
    onEvent: (_, e) => events.push(e),
  });
  return { root, clock, engine, mgr, events };
}

/** Starts a call whose helper captures at once. */
async function started(s: ReturnType<typeof setup>, title = "Weekly sync") {
  s.engine.onStart = (x) => x.capturing();
  const r = await s.mgr.start({ workspace: "work", title });
  if (!r.ok) throw new Error(`start failed: ${r.error}`);
  s.engine.onStart = null;
  return r;
}

describe("state table", () => {
  test("every status has its exits and nothing else", () => {
    const all: CallStatus[] = [
      "idle",
      "starting",
      "recording",
      "paused",
      "stopping",
      "ended",
      "failed",
      "interrupted",
    ];
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...all].sort());
    expect(canTransition("idle", "starting")).toBe(true);
    expect(canTransition("idle", "recording")).toBe(false);
    expect(canTransition("stopping", "recording")).toBe(false);
    expect(canTransition("failed", "recording")).toBe(false);
    expect(() => assertTransition("ended", "paused")).toThrow(TransitionError);
  });
});

describe("folders and ids", () => {
  test("a folder is named from the LOCAL start time and a title slug", () => {
    expect(folderName(T0, TZ, "Weekly sync!")).toBe("2026-09-23_153612_weekly-sync");
    expect(slugify("  Ünïcode — review  ")).toBe("unicode-review");
    expect(slugify("!!!")).toBe("call");
  });

  test("ULIDs are 26 Crockford characters and sort by time", () => {
    const a = ulid(T0);
    const b = ulid(T0 + 1);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  test("two calls in the same second never share a folder", async () => {
    const s = setup();
    const a = await started(s, "Same");
    await s.mgr.stop("live");
    const b = await started(s, "Same");
    expect(a.folder).not.toBe(b.folder);
    expect(b.folder.endsWith("_same-2")).toBe(true);
  });
});

describe("start", () => {
  test("201 only after capturing; part.started carries the helper's clock as its anchor", async () => {
    const s = setup();
    const p = s.mgr.start({ workspace: "work", title: "Sync" });
    await flush();
    expect(s.mgr.live()?.status).toBe("starting");
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await s.clock.advance(500);
    expect(settled).toBe(false);
    s.engine.last.capturing();
    const r = await p;
    expect(r.ok).toBe(true);
    const e = ofType(s.events, "part.started")[0];
    expect(e?.monoStart).toBe(Number(s.engine.last.anchorNs) / 1e6);
    expect(e?.wallStart).toBe(T0 + 500);
    expect(e?.capture).toBe("scripted 9.9.9");
    expect(types(s.events)).toEqual(["call.created", "part.started"]);
  });

  test("[T1.26] stop 200 ms after start with a slow (cold) helper cancels the part, never fails it", async () => {
    const s = setup();
    const p = s.mgr.start({ workspace: "work" });
    await s.clock.advance(200);
    const stop = s.mgr.stop("live");
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: "cancelled" });
    expect((await stop).ok).toBe(true);
    // The helper reports capturing later (a 3 s cold open): ignored.
    await s.clock.advance(2800);
    s.engine.last.capturing();
    await flush();
    expect(types(s.events)).toEqual(["call.created", "part.ended", "call.ended"]);
    expect(ofType(s.events, "part.ended")[0]?.reason).toBe("cancelled");
    expect(ofType(s.events, "call.failed")).toEqual([]);
    expect(s.mgr.live()).toBeNull();
  });

  test("[T1.26] capturing past the start budget fails cleanly with 503 capture_failed {stage: open}", async () => {
    const s = setup();
    const p = s.mgr.start({ workspace: "work" });
    await s.clock.advance(10_000);
    const r = await p;
    expect(r).toMatchObject({ ok: false, status: 503, code: "capture_failed", stage: "open" });
    expect(s.engine.last.exitInfo?.killedByUs).toBe(true);
    const failed = ofType(s.events, "call.failed");
    expect(failed.length).toBe(1);
    expect(failed[0]?.stage).toBe("open");
    expect(s.mgr.live()).toBeNull();
  });

  test("[T1.26] no timeout starts before the helper is spawned", async () => {
    const s = setup();
    s.engine.spawnMs = 20_000; // a spawn that takes 20 s on its own
    const p = s.mgr.start({ workspace: "work" });
    await s.clock.advance(9_000);
    s.engine.last.capturing();
    expect((await p).ok).toBe(true);
  });

  test("[T3.6] the cold budget is 10 s, then warm starts get 3 s", async () => {
    const s = setup();
    let p = s.mgr.start({ workspace: "work" });
    await s.clock.advance(9_900);
    s.engine.last.capturing();
    expect((await p).ok).toBe(true);
    await s.mgr.stop("live");
    // Warm: 3.5 s is past the budget.
    p = s.mgr.start({ workspace: "work" });
    await s.clock.advance(3_000);
    expect(await p).toMatchObject({ ok: false, stage: "open" });
    // Positive control: 2.5 s is inside it.
    p = s.mgr.start({ workspace: "work" });
    await s.clock.advance(2_500);
    s.engine.last.capturing();
    expect((await p).ok).toBe(true);
  });

  test("[T2.49] a helper exiting 77 is 403 permission; the folder is kept, listed as failed, never live", async () => {
    const s = setup();
    const ok = await started(s, "Earlier");
    await s.mgr.stop("live");
    s.engine.onStart = (x) => x.exit(77);
    const r = await s.mgr.start({ workspace: "work", title: "Denied" });
    expect(r).toMatchObject({ ok: false, status: 403, code: "permission", stage: "open" });
    if (r.ok) throw new Error("unreachable");
    const failedId = r.call as string;
    const dir = s.mgr.controller(failedId)?.dir as string;
    expect(existsSync(dir)).toBe(true);
    const log = await logOf(dir);
    expect(types(log)).toEqual(["call.created", "call.failed"]);
    expect(s.mgr.live()).toBeNull();
    expect(s.mgr.calls({ failed: true }).map((c) => c.id)).toEqual([failedId]);
    // `live` never points at it, and neither does `last`.
    const live = s.mgr.resolve("live");
    expect(live).toMatchObject({ ok: false, status: 404, code: "no_live_call" });
    if (live.ok) throw new Error("unreachable");
    expect(live.last?.id).toBe(ok.call);
  });

  test("a helper that cannot be spawned fails at stage spawn", async () => {
    const s = setup();
    s.engine.spawnError = "ENOENT";
    const r = await s.mgr.start({ workspace: "work" });
    expect(r).toMatchObject({ ok: false, status: 503, stage: "spawn" });
    expect(ofType(s.events, "call.failed")[0]?.stage).toBe("spawn");
  });

  test("a folder that cannot be created fails at stage folder, before any spawn", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const root = join(dir, "not-a-dir");
    writeFileSync(root, "x");
    const clock = new ManualClock();
    const engine = new ScriptedEngine(clock);
    const mgr = new CallManager({ root, engine, clock, tz: TZ });
    const r = await mgr.start({ workspace: "work" });
    expect(r).toMatchObject({ ok: false, status: 503, stage: "folder" });
    expect(engine.sessions.length).toBe(0);
  });

  test("one live call at a time: a second start is 409 already_recording", async () => {
    const s = setup();
    const a = await started(s);
    const r = await s.mgr.start({ workspace: "work" });
    expect(r).toMatchObject({ ok: false, status: 409, code: "already_recording", call: a.call });
  });
});

describe("stop", () => {
  test("stop gives part.ended {stop} with the helper's file length, then call.ended", async () => {
    const s = setup();
    await started(s);
    s.engine.last.audio(1.5);
    expect((await s.mgr.stop("live")).ok).toBe(true);
    expect(types(s.events).slice(-2)).toEqual(["part.ended", "call.ended"]);
    expect(ofType(s.events, "part.ended")[0]).toMatchObject({ reason: "stop", fileSeconds: 1.5 });
    expect(s.engine.last.sent).toContain("stop");
  });

  test("[T0.9] a hung teardown is killed at the stop budget; a new start is accepted at once", async () => {
    const s = setup();
    await started(s);
    s.engine.last.hangOnStop = true;
    let done = false;
    const stop = s.mgr.stop("live").then((r) => {
      done = true;
      return r;
    });
    await s.clock.advance(4_999);
    expect(done).toBe(false);
    // The app is not blocked meanwhile: a new call starts while the old helper hangs.
    s.engine.onStart = (x) => x.capturing();
    const next = await s.mgr.start({ workspace: "work", title: "Next" });
    expect(next.ok).toBe(true);
    await s.clock.advance(1);
    expect(done).toBe(true);
    expect((await stop).ok).toBe(true);
    const killed = s.events.filter((e) => e.type === "part.ended" && e.reason === "killed");
    expect(killed.length).toBe(1);
  });

  test("[T4.31] budgets are injected: a 100 ms stop budget resolves at 100 ms on a fake clock", async () => {
    const s = setup({ stopMs: 100 });
    await started(s);
    s.engine.last.hangOnStop = true;
    let done = false;
    void s.mgr.stop("live").then(() => {
      done = true;
    });
    await s.clock.advance(99);
    expect(done).toBe(false);
    await s.clock.advance(1);
    expect(done).toBe(true);
  });
});

describe("restart", () => {
  test("[T3.2] [T2.48] three restarts: one folder, one log, four parts, make before break", async () => {
    const s = setup();
    const a = await started(s);
    for (let i = 0; i < 3; i++) {
      s.engine.last.audio(0.5);
      const p = s.mgr.restart("live");
      await flush();
      // Make before break: the old helper has not been asked to stop yet.
      expect(s.engine.sessions.at(-2)?.sent).not.toContain("stop");
      s.engine.last.capturing();
      expect(await p).toMatchObject({ ok: true, part: i + 2 });
      await s.mgr.controller(a.call)?.idle();
    }
    const ws = join(s.root, "work");
    expect(readdirSync(ws).length).toBe(1);
    const log = await logOf(a.folder);
    const parts = log.filter((e) => e.type === "part.started" || e.type === "part.ended");
    expect(parts.map((e) => `${e.type}:${(e as { part: number }).part}`)).toEqual([
      "part.started:1",
      "part.started:2",
      "part.ended:1",
      "part.started:3",
      "part.ended:2",
      "part.started:4",
      "part.ended:3",
    ]);
    expect(ofType(log, "part.ended").every((e) => e.reason === "restart")).toBe(true);
    expect(s.mgr.view(a.call)?.parts().length).toBe(4);
    expect(s.mgr.view(a.call)?.live).toBe(true);
  });

  test("a restart whose new helper never captures keeps the old part recording", async () => {
    const s = setup();
    const a = await started(s);
    const p = s.mgr.restart("live");
    await s.clock.advance(3_000);
    expect(await p).toMatchObject({ ok: false, status: 503, stage: "open" });
    expect(s.mgr.controller(a.call)?.status).toBe("recording");
    expect(s.mgr.controller(a.call)?.current?.part).toBe(1);
    expect(ofType(s.events, "part.ended")).toEqual([]);
  });

  test("helper crash: part.ended {helper-exit}, then an automatic restart as the next part", async () => {
    const s = setup();
    const a = await started(s);
    s.engine.onStart = (x) => x.capturing();
    s.engine.last.audio(0.4);
    s.engine.last.exit(70);
    await s.mgr.controller(a.call)?.idle();
    expect(ofType(s.events, "part.ended")[0]).toMatchObject({
      part: 1,
      reason: "helper-exit",
      fileSeconds: 0.4,
    });
    expect(ofType(s.events, "part.started").map((e) => e.part)).toEqual([1, 2]);
    expect(s.mgr.live()?.id).toBe(a.call);
  });

  test("five automatic restarts within ten minutes make the call interrupted", async () => {
    const s = setup();
    const a = await started(s);
    s.engine.onStart = (x) => x.capturing();
    for (let i = 0; i < 6; i++) {
      s.engine.last.exit(70);
      await s.mgr.controller(a.call)?.idle();
      await s.clock.advance(1_000);
    }
    expect(s.engine.sessions.length).toBe(6);
    expect(ofType(s.events, "call.ended")).toMatchObject([{ reason: "interrupted" }]);
    expect(s.mgr.controller(a.call)?.status).toBe("interrupted");
    expect(s.mgr.live()).toBeNull();
    // One click resumes it as a new part.
    s.engine.onStart = (x) => x.capturing();
    expect(await s.mgr.restart(a.call)).toMatchObject({ ok: true, part: 7 });
  });

  test("positive control: the same crashes spread over more than ten minutes never interrupt", async () => {
    const s = setup();
    const a = await started(s);
    s.engine.onStart = (x) => x.capturing();
    for (let i = 0; i < 8; i++) {
      s.engine.last.exit(70);
      await s.mgr.controller(a.call)?.idle();
      await s.clock.advance(3 * 60_000);
    }
    expect(ofType(s.events, "call.ended")).toEqual([]);
    expect(s.mgr.controller(a.call)?.status).toBe("recording");
  });

  test("[T0.2] a dead call side for 60 s triggers an automatic restart", async () => {
    const s = setup();
    await started(s);
    s.engine.onStart = (x) => x.capturing();
    s.engine.last.health("call", "dead", 1);
    await s.clock.advance(59_999);
    expect(s.engine.sessions.length).toBe(1);
    await s.clock.advance(1);
    expect(s.engine.sessions.length).toBe(2);
    const h = ofType(s.events, "health");
    expect(h[0]).toMatchObject({ part: 1, ch: "call", state: "dead", rebuilds: 1 });
  });

  test("positive control: dead that recovers before 60 s restarts nothing; health is written on change only", async () => {
    const s = setup();
    await started(s);
    s.engine.last.health("call", "dead", 1);
    s.engine.last.health("call", "dead", 2);
    await s.clock.advance(30_000);
    s.engine.last.health("call", "ok", 2);
    await s.clock.advance(120_000);
    expect(s.engine.sessions.length).toBe(1);
    expect(ofType(s.events, "health").map((e) => e.state)).toEqual(["dead", "ok"]);
  });

  test("silent from start: `no-buffers` gets exactly one rebuild of each source", async () => {
    const s = setup();
    await started(s);
    s.engine.last.health("call", "no-buffers");
    s.engine.last.health("mic", "no-buffers");
    expect(s.engine.last.sent.filter((c) => c.startsWith("rebuild"))).toEqual([
      "rebuild_call",
      "rebuild_mic",
    ]);
  });

  test("a helper that sends no packets at all for the stall budget is restarted", async () => {
    const s = setup({ stallMs: 10_000 });
    await started(s);
    s.engine.onStart = (x) => x.capturing();
    for (let i = 0; i < 20; i++) {
      s.engine.last.audio(0.5);
      await s.clock.advance(500);
    }
    expect(s.engine.sessions.length).toBe(1);
    await s.clock.advance(11_000);
    expect(s.engine.sessions.length).toBe(2);
    const stalled = ofType(s.events, "health").filter((e) => e.state === "stalled");
    expect(stalled.map((e) => e.ch).sort()).toEqual(["call", "mic"]);
  });

  test("restarting a finished call over an hour old needs force", async () => {
    const s = setup();
    const a = await started(s);
    s.engine.last.audio(1);
    await s.mgr.stop("live");
    await s.clock.advance(61 * 60_000);
    s.engine.onStart = (x) => x.capturing();
    expect(await s.mgr.restart("last")).toMatchObject({ ok: false, code: "stale_restart" });
    expect(await s.mgr.restart("last", { force: true })).toMatchObject({ ok: true, part: 2 });
    expect(s.mgr.live()?.id).toBe(a.call);
  });
});

describe("pause, resume, mute", () => {
  test("[T2.52] a line after a 5-minute pause carries the correct wall time", async () => {
    const s = setup();
    const a = await started(s);
    const sess = s.engine.last;
    for (let i = 0; i < 100; i++) {
      sess.audio(0.1);
      await s.clock.advance(100);
    }
    expect((await s.mgr.pause("live")).ok).toBe(true);
    expect(sess.sent).toContain("pause");
    await s.clock.advance(5 * 60_000);
    expect((await s.mgr.resume("live")).ok).toBe(true);
    const resumeWall = s.clock.now();
    await s.clock.advance(50);
    const captureNs = s.clock.mono();
    sess.audio(0.1);
    const log = await logOf(a.folder);
    const pause = ofType(log, "pause")[0];
    const resume = ofType(log, "resume")[0];
    expect(pause).toMatchObject({ a: 10, wall: T0 + 10_000 });
    expect(resume).toMatchObject({ a: 10, wall: resumeWall });
    const clock = PartClock.fromEvents(log, 1) as PartClock;
    // Host clock: the packet's capture_ns maps to the wall time it was captured.
    expect(clock.wallFromCapture(captureNs)).toBeCloseTo(resumeWall + 50, 3);
    // File clock: 10.05 s into the file is 50 ms after the resume, not 50 ms after 10 s of call.
    expect(clock.wallFromAudio(10.05)).toBeCloseTo(resumeWall + 50, 3);
    // Positive control: without the resume anchor the same position is five minutes early.
    const noResume = PartClock.fromEvents(
      log.filter((e) => e.type !== "resume"),
      1,
    ) as PartClock;
    expect(resumeWall + 50 - noResume.wallFromAudio(10.05)).toBeCloseTo(5 * 60_000, 0);
  });

  test("controls answer 409 in the wrong state", async () => {
    const s = setup();
    await started(s);
    expect(await s.mgr.resume("live")).toMatchObject({ ok: false, code: "not_paused" });
    await s.mgr.pause("live");
    expect(await s.mgr.pause("live")).toMatchObject({ ok: false, code: "not_recording" });
  });

  test("mute zeroes the mic copy, is logged with its file position, and carries into the next part", async () => {
    const s = setup();
    const a = await started(s);
    const packets: { part: number; ch: string; v: number }[] = [];
    s.engine.last.audio(1);
    expect((await s.mgr.mute("live")).ok).toBe(true);
    const c = s.mgr.controller(a.call);
    expect(c?.current?.ingest.muted).toBe(true);
    s.engine.last.audio(0.5);
    const q = c?.current?.ingest.queues.mic.drain() ?? [];
    for (const ch of q) packets.push({ part: 1, ch: "mic", v: ch.samples[0] ?? -1 });
    expect(packets.map((p) => p.v)).toEqual([0.25, 0]);
    expect(ofType(s.events, "mute")[0]).toMatchObject({ part: 1, a: 1 });
    const p = s.mgr.restart("live");
    await flush();
    s.engine.last.capturing();
    await p;
    expect(ofType(s.events, "mute").map((e) => e.part)).toEqual([1, 2]);
    expect(c?.current?.ingest.muted).toBe(true);
    expect((await s.mgr.unmute("live")).ok).toBe(true);
    expect(ofType(s.events, "unmute")[0]?.part).toBe(2);
  });

  test("[spike] wake from sleep writes a gap with correct wall times", async () => {
    const s = setup();
    await started(s);
    const sess = s.engine.last;
    sess.audio(0.1);
    await s.clock.advance(100);
    sess.audio(0.1);
    // An hour of sleep: host clock and wall clock move, the file does not.
    await s.clock.advance(3_600_000);
    const wake = s.clock.now();
    sess.audio(0.1);
    const gap = ofType(s.events, "gap")[0];
    expect(gap).toBeDefined();
    expect(gap?.a).toBeCloseTo(0.2, 6);
    // From the end of the audio before the sleep (T0 + 200 ms) to the first packet after it.
    expect(gap?.wallFrom).toBeCloseTo(T0 + 200, 3);
    expect(gap?.wallTo).toBeCloseTo(wake, 3);
    expect(ofType(s.events, "gap").length).toBe(1);
  });
});

describe("[T3.14] `live` and `last`", () => {
  test("no live call: live is 404 with last; last is refused on every live control", async () => {
    const s = setup();
    expect(s.mgr.resolve("live")).toMatchObject({
      ok: false,
      status: 404,
      code: "no_live_call",
      last: null,
    });
    expect(s.mgr.resolve("last")).toMatchObject({ ok: false, status: 404, code: "no_calls" });
    const a = await started(s, "Standup");
    expect(s.mgr.resolve("live")).toEqual({ ok: true, id: a.call });
    await s.mgr.stop("live");
    const live = s.mgr.resolve("live");
    expect(live).toMatchObject({ ok: false, status: 404, code: "no_live_call" });
    if (live.ok) throw new Error("unreachable");
    expect(live.last).toMatchObject({ id: a.call, title: "Standup" });
    expect(typeof live.last?.endedAt).toBe("number");
    for (const control of ["stop", "pause", "resume", "mute", "unmute"] as const) {
      expect(await s.mgr[control]("last")).toMatchObject({
        ok: false,
        status: 400,
        code: "last_refused",
      });
    }
    // Positive control: GETs and restart accept `last`.
    expect(s.mgr.resolve("last")).toEqual({ ok: true, id: a.call });
    s.engine.onStart = (x) => x.capturing();
    expect(await s.mgr.restart("last")).toMatchObject({ ok: true, part: 2 });
  });

  test("a control on a named finished call is 409 not_live, never a write into it", async () => {
    const s = setup();
    const a = await started(s);
    await s.mgr.stop("live");
    const before = (await logOf(a.folder)).length;
    expect(await s.mgr.pause(a.call)).toMatchObject({ ok: false, code: "not_live" });
    expect((await logOf(a.folder)).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Crash recovery

function oggPage(granule: bigint, payload: Uint8Array): Uint8Array {
  const page = new Uint8Array(27 + 1 + payload.length);
  const v = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"), 0);
  v.setBigInt64(6, granule, true);
  v.setUint8(26, 1);
  v.setUint8(27, payload.length);
  page.set(payload, 28);
  return page;
}

function fakeOpus(seconds: number, preSkip = 312): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = 2;
  head[10] = preSkip & 0xff;
  head[11] = preSkip >> 8;
  const pages = [
    oggPage(0n, head),
    oggPage(-1n, new Uint8Array(10)),
    oggPage(BigInt(Math.round(seconds * 48000) + preSkip), new Uint8Array(20)),
  ];
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pages) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("crash recovery at the next start", () => {
  test("the Opus duration is the last granule minus the pre-skip", () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeFileSync(join(dir, "a.opus"), fakeOpus(12.5));
    expect(opusDurationSeconds(join(dir, "a.opus"))).toBeCloseTo(12.5, 6);
    writeFileSync(join(dir, "empty.opus"), "");
    expect(opusDurationSeconds(join(dir, "empty.opus"))).toBeNull();
    expect(opusDurationSeconds(join(dir, "missing.opus"))).toBeNull();
  });

  function callDir(root: string, name: string, events: readonly LogEvent[]): string {
    const dir = join(root, "work", name);
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "audio"), { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), jsonl(events));
    return dir;
  }

  test("an open part gets part.ended {crashed} with the file's duration; the next start answers at once", async () => {
    const s = setup();
    const b = new LogBuilder();
    b.created({ id: "01J8Z6Q4M2VX0K7B3D4E5F6G7A" });
    b.partStarted(1, T0);
    b.seg({ id: "l000001", text: "hello", a0: 1, a1: 4 });
    const dir = callDir(s.root, "2026-09-23_153612_crashed", b.events);
    writeFileSync(join(dir, "audio/part-001.opus"), fakeOpus(42));
    s.engine.onStart = (x) => x.capturing();
    const r = await s.mgr.start({ workspace: "work" });
    expect(r.ok).toBe(true);
    const log = await logOf(dir);
    expect(log.at(-1)).toMatchObject({
      type: "part.ended",
      part: 1,
      reason: "crashed",
      fileSeconds: 42,
    });
    expect(s.mgr.calls().find((c) => c.dir === dir)?.state).toBe("crashed");
  });

  test("without a readable Opus file the duration falls back to the furthest audio the log names", async () => {
    const s = setup();
    const b = new LogBuilder();
    b.created({ id: "01J8Z6Q4M2VX0K7B3D4E5F6G7B" });
    b.partStarted(1, T0);
    b.seg({ id: "l000001", text: "hello", a0: 10, a1: 17.5 });
    const dir = callDir(s.root, "c1", b.events);
    await s.mgr.init();
    expect((await logOf(dir)).at(-1)).toMatchObject({ type: "part.ended", fileSeconds: 17.5 });
  });

  test("a call that never captured gets call.failed; one between restart parts gets interrupted", async () => {
    const s = setup();
    const never = new LogBuilder();
    never.created({ id: "01J8Z6Q4M2VX0K7B3D4E5F6G7C" });
    const d1 = callDir(s.root, "never", never.events);
    const between = new LogBuilder();
    between.created({ id: "01J8Z6Q4M2VX0K7B3D4E5F6G7D" });
    between.partStarted(1, T0);
    between.partEnded(1, "helper-exit", 3);
    const d2 = callDir(s.root, "between", between.events);
    const actions = await s.mgr.init();
    expect(actions.length).toBe(2);
    expect((await logOf(d1)).at(-1)).toMatchObject({ type: "call.failed", stage: "crashed" });
    expect((await logOf(d2)).at(-1)).toMatchObject({ type: "call.ended", reason: "interrupted" });
    expect(s.mgr.resolve("live")).toMatchObject({ ok: false, code: "no_live_call" });
  });

  test("an interrupted call with no resume for 24 h is closed as abandoned", async () => {
    const s = setup();
    const b = new LogBuilder();
    b.created({ id: "01J8Z6Q4M2VX0K7B3D4E5F6G7E" });
    b.partStarted(1, T0);
    b.partEnded(1, "helper-exit", 3);
    b.add({ type: "call.ended", reason: "interrupted" });
    const dir = callDir(s.root, "old", b.events);
    s.clock.t = T0 + 25 * 60 * 60_000;
    await s.mgr.init();
    expect((await logOf(dir)).at(-1)).toMatchObject({ type: "call.ended", reason: "abandoned" });
  });

  test("positive control: a folder another live writer holds is left alone", async () => {
    const s = setup();
    const b = new LogBuilder();
    b.created({ id: "01J8Z6Q4M2VX0K7B3D4E5F6G7F" });
    b.partStarted(1, T0);
    const dir = callDir(s.root, "held", b.events);
    writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`);
    expect(await s.mgr.init()).toEqual([]);
    expect((await logOf(dir)).length).toBe(2);
  });
});
