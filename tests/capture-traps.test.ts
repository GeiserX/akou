/**
 * Capture and call traps against a real child process: `scripts/fake-helper.ts` speaking
 * `akou-capture/1`, spawned, stopped and killed through `AkouCaptureEngine` exactly as the app
 * spawns the Rust helper. Budgets are small real durations; every wait has a deadline below the
 * test timeout, so a regression fails instead of hanging (TRAPS T4.31).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { processAlive } from "../src/core/log/writer.ts";
import { CallManager } from "../src/main/call/manager.ts";
import type { CallBudgets } from "../src/main/call/state.ts";
import type { CaptureStartOptions } from "../src/main/capture/engine.ts";
import { AkouCaptureEngine, KILL_GRACE_MS } from "../src/main/capture/helper.ts";
import type { Packet } from "../src/main/capture/protocol.ts";
import { logOf, ofType, until } from "./capture-helpers.ts";
import { writeCallWav } from "./fixtures/audio.ts";
import { TZ, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "..", "scripts", "fake-helper.ts");
const LONG = 20_000;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Rig {
  root: string;
  mgr: CallManager;
  events: LogEvent[];
  packets: { part: number; p: Packet; at: number }[];
  pids: number[];
}

function rig(
  switches: (o: CaptureStartOptions) => string[],
  budgets: Partial<CallBudgets> = {},
  command?: string[],
): Rig {
  const { dir: root, cleanup } = tempDir();
  const events: LogEvent[] = [];
  const packets: Rig["packets"] = [];
  const pids: number[] = [];
  const engine = new AkouCaptureEngine({
    command: command ?? [process.execPath, FAKE],
    extraArgs: switches,
  });
  const inner = engine.start.bind(engine);
  engine.start = (o, h) => {
    const s = inner(o, h);
    if (s.pid) pids.push(s.pid);
    return s;
  };
  const mgr = new CallManager({
    root,
    engine,
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
  return { root, mgr, events, packets, pids };
}

const has = (events: LogEvent[], f: (e: LogEvent) => boolean) => () => events.some(f);

describe("real child process: start and stop", () => {
  test(
    "[T1.26] stop 200 ms after start while the helper is still opening: cancelled, never failed",
    async () => {
      const r = rig(() => ["--capturing-delay", "3000"], { coldStartMs: 10_000 });
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
      const r = rig(() => ["--capturing-delay", "4000"], { coldStartMs: 500 });
      const t0 = performance.now();
      const res = await r.mgr.start({ workspace: "work" });
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(res).toMatchObject({ ok: false, status: 503, code: "capture_failed", stage: "open" });
      expect(ofType(r.events, "call.failed")[0]?.stage).toBe("open");
      await until(() => !processAlive(r.pids[0] as number), 2_000, "the helper to be killed");
    },
    LONG,
  );

  test(
    "[T2.49] a helper exiting 77 before capturing answers 403 and writes call.failed",
    async () => {
      const r = rig(() => ["--exit-before-capturing", "77"]);
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
      const r = rig((o) => (o.part === 1 ? ["--hang-on-stop"] : []), { stopMs: budget });
      const a = await r.mgr.start({ workspace: "work", title: "Hangs" });
      expect(a.ok).toBe(true);
      await until(() => r.packets.length > 10, 3_000, "packets");
      // The event loop keeps turning while the helper hangs.
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const t0 = performance.now();
      const stop = await r.mgr.stop("live");
      const took = performance.now() - t0;
      clearInterval(timer);
      expect(stop.ok).toBe(true);
      expect(took).toBeGreaterThanOrEqual(budget - 20);
      expect(took).toBeLessThan(budget + KILL_GRACE_MS);
      expect(ticks).toBeGreaterThan(took / 10 / 4);
      expect(ofType(r.events, "part.ended")[0]).toMatchObject({ reason: "killed" });
      expect(processAlive(r.pids[0] as number)).toBe(false);
      const t1 = performance.now();
      const b = await r.mgr.start({ workspace: "work", title: "Next" });
      expect(b.ok).toBe(true);
      expect(performance.now() - t1).toBeLessThan(3_000);
    },
    LONG,
  );

  test(
    "the helper's stderr is kept in the part's capture log",
    async () => {
      const r = rig(() => []);
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
    "a helper that writes garbage on stdout is killed; the start fails, nothing is trusted",
    async () => {
      const script =
        "process.stdout.write('not a packet stream at all, just text'); await Bun.sleep(30000);";
      const r = rig(() => [], { coldStartMs: 1_500 }, [process.execPath, "-e", script]);
      const res = await r.mgr.start({ workspace: "work" });
      expect(res).toMatchObject({ ok: false, status: 503, stage: "open" });
      if (res.ok) throw new Error("unreachable");
      expect(res.error).toContain("protocol error");
    },
    LONG,
  );

  test(
    "[T3.6] with the app running, a warm start answers 201 within 1 s",
    async () => {
      const r = rig(() => []);
      const warm = await r.mgr.start({ workspace: "work" });
      expect(warm.ok).toBe(true);
      await r.mgr.stop("live");
      const t0 = performance.now();
      const res = await r.mgr.start({ workspace: "work" });
      const took = performance.now() - t0;
      expect(res.ok).toBe(true);
      expect(took).toBeLessThan(1_000);
    },
    LONG,
  );

  test(
    "[T2.51] quit stops the live helper within the stop budget and leaves the log ended",
    async () => {
      const r = rig(() => [], { stopMs: 500 });
      const a = await r.mgr.start({ workspace: "work" });
      if (!a.ok) throw new Error(a.error);
      await until(() => r.packets.length > 10, 3_000, "packets");
      const t0 = performance.now();
      await r.mgr.quit();
      expect(performance.now() - t0).toBeLessThan(500 + KILL_GRACE_MS);
      expect(processAlive(r.pids[0] as number)).toBe(false);
      const log = await logOf(a.folder);
      expect(log.slice(-2).map((e) => e.type)).toEqual(["part.ended", "call.ended"]);
      expect(r.mgr.live()).toBeNull();
    },
    LONG,
  );
});

describe("real child process: while recording", () => {
  test(
    "[T0.16] silent from the start: mic frames arrive from the first second, call side zero-filled",
    async () => {
      const { dir, cleanup } = tempDir();
      cleanups.push(cleanup);
      const wav = join(dir, "call.wav");
      writeCallWav(wav, 4);
      const r = rig(() => ["--wav", wav, "--call-silent"]);
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
      const r = rig((o) => (o.part === 1 ? ["--call-dead-at", "0.5", "--speed", "20"] : []), {
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
    "helper crash: part.ended {helper-exit}, automatic restart; after stop the next start answers fast",
    async () => {
      const r = rig((o) => (o.part === 1 ? ["--crash-at", "0.3"] : []));
      const a = await r.mgr.start({ workspace: "work" });
      expect(a.ok).toBe(true);
      await until(
        has(r.events, (e) => e.type === "part.started" && e.part === 2),
        5_000,
        "restart after crash",
      );
      const ended = ofType(r.events, "part.ended")[0];
      expect(ended).toMatchObject({ part: 1, reason: "helper-exit" });
      expect(ended?.fileSeconds).toBeGreaterThan(0.2);
      expect(r.mgr.live()?.status).toBe("recording");
      await r.mgr.stop("live");
      const t0 = performance.now();
      const b = await r.mgr.start({ workspace: "work" });
      expect(b.ok).toBe(true);
      expect(performance.now() - t0).toBeLessThan(3_000);
    },
    LONG,
  );

  test(
    "[T3.2] a restart continues the same call as a new part in the same folder",
    async () => {
      const r = rig(() => []);
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
      for (const f of ["audio/part-001.opus", "audio/part-002.opus", "logs/capture-part-002.log"]) {
        expect(existsSync(join(a.folder, f))).toBe(true);
      }
      expect(new Set(ofType(log, "call.created").map((e) => e.id)).size).toBe(1);
    },
    LONG,
  );

  test(
    "[T0.15] one source never delivers: queues stay bounded and both channels stay aligned",
    async () => {
      const r = rig(() => ["--call-omit", "--speed", "20"]);
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
      const r = rig((o) => (o.part === 1 ? ["--stall-at", "0.5"] : []), { stallMs: 400 });
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
      const r = rig(() => ["--sleep-at", "0.5", "--sleep-for", "3600", "--speed", "5"]);
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
      const r = rig(() => []);
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
