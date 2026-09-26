/**
 * The dictation session over the fake helper (scripts/fake-helper.ts `dictate`, DC-T1): scripted
 * keys, a WAV as the mic, the fake inserter, the live Worker's `decode` on the fake engine. No
 * device, no key, no clipboard: the fake records what it would have inserted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import type { Decoded } from "../src/main/asr/live-worker.ts";
import { LiveAsr } from "../src/main/asr/live-worker.ts";
import type { Packet } from "../src/main/capture/protocol.ts";
import { DictationService } from "../src/main/dictation/service.ts";
import { type DictationEngine, DictationSession } from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import { FAKE_HELPER, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const RC = "RightCommand";
const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function fastEngine(): DictationEngine {
  const asr = new LiveAsr(
    {
      models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
      inThread: true,
    },
    () => undefined,
  );
  cleanups.push(() => asr.close());
  return { name: "fast", decode: (s, o) => asr.decode(s, o) };
}

/** The mic: "hello" from 1.0 s, "world" from 2.2 s. */
function micWav(dir: string): string {
  const path = join(dir, "mic.wav");
  writeFileSync(
    path,
    monoWav(concat(silence(1), speak(["hello"]), silence(0.95), speak(["world"]), silence(4))),
  );
  return path;
}

interface Rig {
  svc: DictationService;
  tap: string;
  inserted: string;
  /** Waits until the fake has played every scripted key. */
  played(): Promise<void>;
}

function rig(keys: [number, string, boolean][], switches: string[] = []): Rig {
  const t = tempDir("akou-dict-session-");
  cleanups.push(t.cleanup);
  const keyFile = join(t.dir, "keys.jsonl");
  writeFileSync(
    keyFile,
    keys.map(([at, key, down]) => JSON.stringify({ at, key, down } satisfies KeyInput)).join("\n"),
  );
  const tap = join(t.dir, "tap.jsonl");
  const inserted = join(t.dir, "inserted.jsonl");
  const svc = new DictationService({
    configDir: t.dir,
    engine: fastEngine,
    now: () => Date.now(),
  });
  cleanups.push(() => svc.close());
  svc.start(
    [
      process.execPath,
      FAKE_HELPER,
      "dictate",
      "--wav",
      micWav(t.dir),
      "--keys",
      keyFile,
      "--tap-log",
      tap,
      "--inserter-log",
      inserted,
      ...switches,
    ],
    () => ({ hotkey: RC, draft: "", fixLast: "", pasteLast: "", activation: "hold-or-toggle" }),
  );
  return {
    svc,
    tap,
    inserted,
    played: () =>
      until(() => lines(tap).length >= keys.length, 10_000, "the fake to play the keys"),
  };
}

/** Waits for the helper's messages to be read and every decode and insert to settle. */
async function settle(r: Rig): Promise<void> {
  await r.played();
  await new Promise((res) => setTimeout(res, 150));
  await r.svc.session()?.settled();
}

describe("DC-A1 over the fake helper", () => {
  test("a push-to-talk hold is transcribed and sent to the fake inserter", async () => {
    const r = rig([
      [800, RC, true],
      [1600, RC, false],
    ]);
    await until(() => lines(r.inserted).length === 1, 10_000, "the insert");
    expect(lines(r.inserted)[0]).toMatchObject({
      type: "insert",
      text: "hello",
      method: "paste",
      send_key: "none",
      target: { app: "com.example.editor", field: "editable" },
    });
    await until(() => r.svc.log.items()[0]?.state === "inserted", 5000, "the receipt");
    const it = r.svc.log.items()[0];
    expect(it).toMatchObject({ by: "user", text: "hello", raw: "hello", engine: "fast" });
    expect(r.svc.status()).toMatchObject({ enabled: true, state: "idle", backend: "fake" });
  });

  test("a tap latches and a tap at 3 s ends one session of about 3 s", async () => {
    const r = rig([
      [0, RC, true],
      [120, RC, false],
      [3000, RC, true],
      [3100, RC, false],
    ]);
    await until(() => r.svc.log.items()[0]?.state === "inserted", 10_000, "the dictation");
    const items = r.svc.log.items();
    expect(items.length).toBe(1);
    expect(items[0]?.text).toBe("hello world");
    // The key-down to the tap, plus the ring before and the post-roll after.
    expect(items[0]?.seconds as number).toBeGreaterThan(3);
    expect(items[0]?.seconds as number).toBeLessThan(3.6);
  });

  test("Right Command+C is a copy: nothing is kept, and C reaches the app", async () => {
    const r = rig([
      [800, RC, true],
      [840, "C", true],
      [880, "C", false],
      [920, RC, false],
    ]);
    await settle(r);
    expect(r.svc.log.events()).toEqual([]);
    expect(lines(r.inserted)).toEqual([]);
    expect(lines(r.tap).filter((k) => k.key === "C")).toEqual([
      { key: "C", down: true, swallowed: false },
      { key: "C", down: false, swallowed: false },
    ]);
    expect(r.svc.status().state).toBe("idle");
  });

  test("positive control: the same presses without C latch listening on", async () => {
    const r = rig([
      [800, RC, true],
      [920, RC, false],
    ]);
    await settle(r);
    expect(r.svc.status().state).toBe("listening");
  });

  test("a 1 s hold with C at 800 ms ends at C with nothing kept, and C passes through", async () => {
    const r = rig([
      [0, RC, true],
      [800, "C", true],
      [850, "C", false],
      [1000, RC, false],
    ]);
    await settle(r);
    expect(r.svc.log.events()).toEqual([]);
    expect(lines(r.tap)).toContainEqual({ key: "C", down: true, swallowed: false });
  });
});

describe("the insert", () => {
  test("into a password field, only the clipboard is written (DC-N8)", async () => {
    const r = rig(
      [
        [800, RC, true],
        [1600, RC, false],
      ],
      ["--field", "secure"],
    );
    await until(() => lines(r.inserted).length === 1, 10_000, "the insert");
    expect(lines(r.inserted)[0]).toMatchObject({ method: "clipboard" });
  });

  test("a target that lost focus fails the insert, and the log says so (--focus-change)", async () => {
    const r = rig(
      [
        [800, RC, true],
        [1600, RC, false],
      ],
      ["--focus-change"],
    );
    await until(() => r.svc.log.items()[0]?.state === "failed", 10_000, "the failure");
    expect(r.svc.log.items()[0]?.error).toBe("insert: focus_changed");
    expect(r.svc.log.items()[0]?.text).toBe("hello");
  });
});

describe("the helper's stdout and stderr are two pipes", () => {
  const TARGET = { app: "a", pid: 1, window: "w", field: "editable" as const };
  const packet = (n: number): Packet => ({
    ch: "mic",
    zeroFilled: false,
    captureNs: 0n,
    fileSeconds: 0,
    samples: new Float32Array(n),
  });

  function session() {
    const t = tempDir("akou-dict-pipes-");
    cleanups.push(t.cleanup);
    const log = new DictationLog(t.dir);
    cleanups.push(() => log.close());
    const got: number[] = [];
    const engine: DictationEngine = {
      name: "fast",
      decode: async (s): Promise<Decoded> => {
        got.push(s.length);
        return { text: "ok", words: [], language: null, model: "m", ms: 1, spans: 1 };
      },
    };
    const s = new DictationSession({
      log,
      engine: () => engine,
      send: () => {},
      bindings: () => ({ hotkey: RC, draft: "", fixLast: "", pasteLast: "", activation: "hold" }),
      now: () => Date.now(),
    });
    return { s, got };
  }

  test("`session.ended` read before the last packets waits for them", async () => {
    const { s, got } = session();
    s.onMessage({ type: "session.started", id: "s1", target: TARGET, capture_ns: "0" });
    s.onPacket(packet(320));
    s.onMessage({ type: "session.ended", id: "s1", reason: "release", samples: 960 });
    expect(s.state).toBe("listening");
    s.onPacket(packet(320));
    s.onPacket(packet(320));
    await s.settled();
    expect(got).toEqual([960]);
  });
});
