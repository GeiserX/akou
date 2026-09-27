/**
 * A session that ends by itself (docs/ux/DICTATION.md DC-A3): a latched session after
 * `dictation.silenceStopSeconds` without speech, any session at `dictation.maxMinutes` after a
 * warning one minute before, and in both cases the audio is still transcribed. The session is
 * driven with the helper's lines and packets directly; the audio's own length is the clock and a
 * fake VAD hears speech in any sample that is not zero. Nothing opens a device or plays a sound.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { DictationEvent } from "../src/core/dictation/events.ts";
import { CAPTURE_RATE, type Packet } from "../src/main/capture/protocol.ts";
import type { Activation, AppToHelper } from "../src/main/dictation/protocol.ts";
import {
  type AutoStop,
  DictationSession,
  type EngineHold,
  MAX_WARNING,
} from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const TARGET = { app: "a", pid: 1, window: "w", field: "editable" as const };

interface Rig {
  s: DictationSession;
  log: DictationLog;
  /** Every command sent, with the seconds of audio fed when it went. */
  sent: { c: AppToHelper; at: number }[];
  warnings: { note: string; at: number }[];
  /** The buffers the engine decoded. */
  decoded: Float32Array[];
  /** Feeds `seconds` of audio in one-second packets, loud or silent, letting the VAD answer. */
  feed(seconds: number, loud: boolean): Promise<void>;
  fed(): number;
}

function rig(
  o: {
    activation?: Activation;
    autoStop?: AutoStop;
    speech?: (samples: Float32Array) => Promise<boolean | null>;
  } = {},
): Rig {
  const t = tempDir("akou-dict-autostop-");
  cleanups.push(t.cleanup);
  const log = new DictationLog(t.dir);
  cleanups.push(() => log.close());
  const sent: Rig["sent"] = [];
  const warnings: Rig["warnings"] = [];
  const decoded: Float32Array[] = [];
  let fed = 0;
  let packets = 0;
  const s = new DictationSession({
    log,
    engine: () => ({
      name: "fast",
      decode: async (samples) => {
        decoded.push(samples);
        return { text: "hello", words: [], language: null, model: "m", ms: 1, spans: 1 };
      },
    }),
    send: (c) => sent.push({ c, at: fed }),
    bindings: () => ({
      hotkey: "RightCommand",
      draft: "",
      fixLast: "",
      pasteLast: "",
      activation: o.activation ?? "hold-or-toggle",
    }),
    now: () => Date.now(),
    autoStop: () => o.autoStop ?? { silenceSeconds: 3, maxMinutes: 20 },
    speech: o.speech ?? (async (samples) => samples.some((x) => x !== 0)),
    onWarning: (note) => warnings.push({ note, at: fed }),
  });
  s.onMessage({
    type: "ready",
    protocol: "akou-dictate/1",
    version: "1",
    grants: { mic: "granted", accessibility: "granted" },
    backend: "fake",
    swallow_keys: true,
  });
  const feed = async (seconds: number, loud: boolean) => {
    for (let i = 0; i < seconds; i++) {
      const p: Packet = {
        ch: "mic",
        zeroFilled: false,
        captureNs: 0n,
        fileSeconds: packets++,
        samples: new Float32Array(CAPTURE_RATE).fill(loud ? 0.3 : 0),
      };
      fed++;
      s.onPacket(p);
      // The VAD answers between packets, as it does while the helper sends 20 ms at a time.
      await new Promise((res) => setTimeout(res, 0));
    }
  };
  return { s, log, sent, warnings, decoded, feed, fed: () => fed };
}

const stops = (r: Rig) => r.sent.filter((x) => x.c.type === "session.stop");
const events = (r: Rig): readonly DictationEvent[] => r.log.events();

/** The helper's answer to `session.stop`: it ends the session as a tap. */
function endAsTap(r: Rig, id = "1"): void {
  r.s.onMessage({ type: "session.ended", id, reason: "tap" });
}

describe("DC-A3: a latched session stops after silence", () => {
  test("silenceStopSeconds 3 ends a latched session 3 s after the last speech, and transcribes it", async () => {
    const r = rig({ activation: "toggle" });
    r.s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    await r.feed(1, true);
    await r.feed(10, false);
    expect(stops(r).map((x) => x.at)).toEqual([4]);
    endAsTap(r);
    await until(() => r.sent.some((x) => x.c.type === "insert"), 5000, "the insert");
    const ended = events(r).find((e) => e.type === "dictation.ended");
    expect(ended).toMatchObject({ reason: "silence", seconds: 11 });
    expect(r.decoded[0]?.length).toBe(11 * CAPTURE_RATE);
  });

  test("speech again resets the wait", async () => {
    const r = rig({ activation: "toggle" });
    r.s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    await r.feed(1, true);
    await r.feed(2, false);
    await r.feed(1, true);
    await r.feed(6, false);
    expect(stops(r).map((x) => x.at)).toEqual([7]);
  });

  test("positive control: with 0 it runs until the tap", async () => {
    const r = rig({ activation: "toggle", autoStop: { silenceSeconds: 0, maxMinutes: 20 } });
    r.s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    await r.feed(1, true);
    await r.feed(10, false);
    expect(stops(r)).toEqual([]);
  });

  test("a push-to-talk hold never stops after silence", async () => {
    const r = rig();
    r.s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    await r.feed(10, false);
    expect(stops(r)).toEqual([]);
  });

  test("the helper's `latched` makes a key session latched from then on", async () => {
    const r = rig();
    r.s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    await r.feed(2, false);
    expect(stops(r)).toEqual([]);
    r.s.onMessage({ type: "latched", id: "1" });
    await r.feed(4, false);
    // The silence counts from the latch: 2 s held, then 3 s latched.
    expect(stops(r).map((x) => x.at)).toEqual([5]);
  });

  test("the tray's or the CLI's start is latched; the key's next session is not", async () => {
    const r = rig();
    r.s.command("start");
    r.s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    await r.feed(4, false);
    expect(stops(r).map((x) => x.at)).toEqual([3]);
    endAsTap(r);
    await until(() => r.s.state !== "listening", 5000, "the end");
    r.s.onMessage({ type: "session.started", id: "2", target: TARGET, capture_ns: "0" });
    await r.feed(5, false);
    expect(stops(r)).toHaveLength(1);
  });

  test("a VAD with no verdict, or one that fails, never ends a session", async () => {
    for (const speech of [async () => null, () => Promise.reject(new Error("vad gone"))]) {
      const r = rig({ activation: "toggle", speech });
      r.s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
      await r.feed(6, false);
      expect(stops(r)).toEqual([]);
    }
  });

  test("a tap the user made is logged as a tap", async () => {
    const r = rig({ activation: "toggle" });
    r.s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    await r.feed(2, true);
    endAsTap(r);
    await until(() => r.sent.some((x) => x.c.type === "insert"), 5000, "the insert");
    expect(events(r).find((e) => e.type === "dictation.ended")).toMatchObject({ reason: "tap" });
  });
});

describe("DC-A3: any session stops at dictation.maxMinutes", () => {
  test("warned 60 s before, stopped at the length, and every second of it transcribed", async () => {
    const r = rig({ autoStop: { silenceSeconds: 3, maxMinutes: 2 } });
    r.s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    await r.feed(125, true);
    expect(r.warnings).toEqual([{ note: MAX_WARNING, at: 60 }]);
    expect(stops(r).map((x) => x.at)).toEqual([120]);
    endAsTap(r);
    await until(() => r.sent.some((x) => x.c.type === "insert"), 5000, "the insert");
    expect(events(r).find((e) => e.type === "dictation.ended")).toMatchObject({
      reason: "max",
      seconds: 125,
    });
    expect(r.decoded[0]?.length).toBe(125 * CAPTURE_RATE);
  });
});

describe("a session.started with no end before it", () => {
  function holdRig() {
    const t = tempDir("akou-dict-restart-");
    cleanups.push(t.cleanup);
    const log = new DictationLog(t.dir);
    cleanups.push(() => log.close());
    const holds: { cancelled: number }[] = [];
    const s = new DictationSession({
      log,
      engine: () => ({
        name: "remote",
        decode: async () => ({ text: "", words: [], language: null, model: "m", ms: 1, spans: 1 }),
        open: (): EngineHold => {
          const h = { cancelled: 0 };
          holds.push(h);
          return {
            push: () => {},
            decode: async () => ({
              text: "hi",
              words: [],
              language: null,
              model: "m",
              ms: 1,
              spans: 1,
            }),
            cancel: () => {
              h.cancelled++;
            },
          };
        },
      }),
      send: () => {},
      bindings: () => ({
        hotkey: "RightCommand",
        draft: "",
        fixLast: "",
        pasteLast: "",
        activation: "hold-or-toggle",
      }),
      now: () => Date.now(),
    });
    return { s, holds };
  }

  test("cancels the first session's remote request", () => {
    const { s, holds } = holdRig();
    s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    s.onMessage({ type: "session.started", id: "2", target: TARGET, capture_ns: "0" });
    expect(holds.map((h) => h.cancelled)).toEqual([1, 0]);
  });

  test("positive control: a session that ended is decoded, never cancelled", () => {
    const { s, holds } = holdRig();
    s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    s.onMessage({ type: "session.ended", id: "1", reason: "release" });
    s.onMessage({ type: "session.started", id: "2", target: TARGET, capture_ns: "0" });
    expect(holds.map((h) => h.cancelled)).toEqual([0, 0]);
  });
});
