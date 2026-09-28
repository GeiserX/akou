/**
 * The keys during a dictation and how its text goes in (docs/ux/DICTATION.md DC-A4, DC-S2, DC-S3),
 * over the fake helper (scripts/fake-helper.ts `dictate`): scripted keys through the port of the
 * real helper's activation rule, a WAV as the mic, the fake inserter, and the live Worker's decode
 * on the fake engine. The engine starts a decode only once every scripted key has been played, so
 * a key after the release lands while the dictation is still transcribing, whatever the machine's
 * speed. Nothing opens a device, reads a key, types, pastes or touches the clipboard.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import type { DictationItem } from "../src/core/dictation/events.ts";
import { SPOKEN_PUNCTUATION } from "../src/core/dictation/punctuation.ts";
import { LiveAsr } from "../src/main/asr/live-worker.ts";
import type { Packet } from "../src/main/capture/protocol.ts";
import type { AppToHelper } from "../src/main/dictation/protocol.ts";
import {
  type DictationFollow,
  DictationService,
  type DictationServiceOptions,
} from "../src/main/dictation/service.ts";
import {
  DEFAULT_INSERT,
  type DictationEngine,
  DictationSession,
  type InsertPolicy,
} from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import type { DraftOpen } from "../src/ui/dictation-protocol.ts";
import { FAKE_HELPER, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

// The fake helper is a process; a loaded runner passes bun's 5 s default.
setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const RC = "RightCommand";
const lines = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Enter as the send key, as the settings' default; everything else as `DEFAULT_INSERT`. */
const SEND_ENTER: InsertPolicy = { ...DEFAULT_INSERT, sendKey: "Enter" };

interface Rig {
  svc: DictationService;
  tap: string;
  inserter: string;
  commands: string;
  follow: DictationFollow[];
  opened: DraftOpen[];
  /** Waits until every decode and insert settled, after every key was played. */
  settled(): Promise<void>;
  item(): DictationItem | undefined;
  /** What the fake inserter recorded, the inserts and the send keys, in order. */
  inserts(): Record<string, unknown>[];
}

type Key = [number, string, boolean];

function rig(
  keys: Key[],
  o: { insert?: InsertPolicy; switches?: string[]; extra?: Partial<DictationServiceOptions> } = {},
): Rig {
  const t = tempDir("akou-dict-keys-");
  cleanups.push(t.cleanup);
  const wav = join(t.dir, "mic.wav");
  // "hello" from 1.0 s.
  writeFileSync(wav, monoWav(concat(silence(1), speak(["hello"]), silence(3))));
  const keyFile = join(t.dir, "keys.jsonl");
  writeFileSync(
    keyFile,
    keys.map(([at, key, down]) => JSON.stringify({ at, key, down } satisfies KeyInput)).join("\n"),
  );
  const tap = join(t.dir, "tap.jsonl");
  const inserter = join(t.dir, "inserter.jsonl");
  const commands = join(t.dir, "commands.jsonl");
  const played = () => until(() => lines(tap).length >= keys.length, 10_000, "the keys");
  const asr = new LiveAsr(
    {
      models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
      inThread: true,
    },
    () => undefined,
  );
  cleanups.push(() => asr.close());
  // A decode starts once every key is played: a key after the release finds it transcribing.
  const engine: DictationEngine = {
    name: "fast",
    decode: async (s, d) => {
      await played();
      return asr.decode(s, d);
    },
  };
  const follow: DictationFollow[] = [];
  const opened: DraftOpen[] = [];
  const svc = new DictationService({
    configDir: t.dir,
    engine: () => engine,
    now: () => Date.now(),
    insert: () => o.insert ?? SEND_ENTER,
    ...o.extra,
  });
  cleanups.push(() => svc.close());
  svc.follow((m) => {
    if (m.kind !== "level") follow.push(m);
  });
  svc.draft.attach({
    open: (d) => opened.push(d),
    chip: () => {},
    showInactive: () => {},
    hide: () => {},
  });
  svc.start(
    [
      process.execPath,
      FAKE_HELPER,
      "dictate",
      "--wav",
      wav,
      "--keys",
      keyFile,
      "--tap-log",
      tap,
      "--inserter-log",
      inserter,
      "--commands-log",
      commands,
      ...(o.switches ?? []),
    ],
    () => ({ hotkey: RC, draft: "", fixLast: "", pasteLast: "", activation: "hold-or-toggle" }),
  );
  return {
    svc,
    tap,
    inserter,
    commands,
    follow,
    opened,
    settled: async () => {
      await played();
      // Every dictation has reached an outcome and the fake has answered its insert.
      await until(
        () => {
          const items = svc.log.items();
          return (
            items.length > 0 &&
            items.every((i) => i.state !== "listening" && i.state !== "transcribing") &&
            svc.status().state === "idle"
          );
        },
        10_000,
        "the dictation to settle",
      );
      await svc.session()?.settled();
    },
    item: () => svc.log.items()[0],
    inserts: () => lines(inserter),
  };
}

/** A push-to-talk hold of Right Command over "hello". */
const HOLD: Key[] = [
  [800, RC, true],
  [1700, RC, false],
];
/** A key pressed and let go at `at`. */
const press = (at: number, key: string): Key[] => [
  [at, key, true],
  [at + 30, key, false],
];
/** Shift and Enter together: Shift+Enter. */
const shiftEnter = (at: number): Key[] => [
  [at, "LeftShift", true],
  [at + 10, "Enter", true],
  [at + 20, "Enter", false],
  [at + 30, "LeftShift", false],
];

type Mode = "insert" | "send" | "draft" | "cancelled";

/** The mode a press ended in, from the log and the fake inserter. */
function modeOf(r: Rig): Mode {
  const it = r.item();
  const ins = r.inserts();
  if (it?.state === "cancelled") return "cancelled";
  if (it?.state === "drafted") return "draft";
  if (it?.state !== "inserted") throw new Error(`no outcome: ${JSON.stringify(it)}`);
  return ins.some((l) => l.type === "send") ? "send" : "insert";
}

describe("DC-S3: the key you press picks the mode, one row per key path", () => {
  const rows: [string, Key[], Mode][] = [
    ["a push-to-talk hold of the dictation key inserts", HOLD, "insert"],
    [
      "a tap latches, and a second tap inserts",
      [
        [800, RC, true],
        [900, RC, false],
        [2500, RC, true],
        [2600, RC, false],
      ],
      "insert",
    ],
    [
      "Enter during the hold ends it, inserts, then sends",
      [[800, RC, true], ...press(1600, "Enter"), [1700, RC, false]],
      "send",
    ],
    [
      "Enter while it transcribes: send after the insert",
      [...HOLD, ...press(1900, "Enter")],
      "send",
    ],
    [
      "Shift+Enter during a latched session opens the draft box",
      [[800, RC, true], [900, RC, false], ...shiftEnter(2500)],
      "draft",
    ],
    [
      // Shift pressed during a modifier-only hold is DC-A1's interrupt, before Enter comes.
      "Shift then Enter during a push-to-talk hold is the interrupt: cancelled",
      [[800, RC, true], ...shiftEnter(1600), [1700, RC, false]],
      "cancelled",
    ],
    [
      "Shift+Enter while it transcribes opens the draft box",
      [...HOLD, ...shiftEnter(1900)],
      "draft",
    ],
    [
      "Escape during a latched session cancels",
      [[800, RC, true], [900, RC, false], ...press(2500, "Escape")],
      "cancelled",
    ],
    [
      "Escape while it transcribes keeps the text as cancelled",
      [...HOLD, ...press(1900, "Escape")],
      "cancelled",
    ],
  ];
  for (const [name, keys, mode] of rows) {
    test(name, async () => {
      const r = rig(keys);
      await r.settled();
      expect(modeOf(r)).toBe(mode);
    });
  }
});

describe("DC-A4: Escape, Enter and Shift+Enter during a session", () => {
  test("Escape during a session: no insert, and a dictation.cancelled event", async () => {
    const r = rig([[800, RC, true], [900, RC, false], ...press(2500, "Escape")]);
    await r.settled();
    expect(r.inserts()).toEqual([]);
    expect(r.svc.log.events().map((e) => e.type)).toContain("dictation.cancelled");
    expect(lines(r.tap).find((k) => k.key === "Escape" && k.down)).toMatchObject({
      swallowed: true,
    });
  });

  test("Enter: the insert, then exactly one send-key press after its receipt", async () => {
    const r = rig([[800, RC, true], ...press(1600, "Enter"), [1700, RC, false]], {
      switches: ["--receipt-ms", "400"],
    });
    await r.settled();
    const ins = r.inserts();
    expect(ins.map((l) => l.type)).toEqual(["insert", "send"]);
    expect(ins[0]).toMatchObject({ text: "hello", send_key: "Enter" });
    expect(ins[1]).toMatchObject({ key: "Enter" });
    expect(r.item()).toMatchObject({ state: "inserted", text: "hello" });
    expect(lines(r.tap).find((k) => k.key === "Enter" && k.down)).toMatchObject({
      swallowed: true,
    });
  });

  test("Enter after the release, before the receipt, is swallowed and sends after the insert", async () => {
    const r = rig([...HOLD, ...press(1900, "Enter")], { switches: ["--receipt-ms", "400"] });
    await r.settled();
    expect(r.inserts().map((l) => [l.type, l.send_key ?? l.key])).toEqual([
      ["insert", "Enter"],
      ["send", "Enter"],
    ]);
    expect(lines(r.tap).find((k) => k.key === "Enter" && k.down)).toMatchObject({
      swallowed: true,
    });
  });

  test("positive control: the same hold with no Enter inserts with no send key", async () => {
    const r = rig(HOLD, { switches: ["--receipt-ms", "400"] });
    await r.settled();
    expect(r.inserts().map((l) => [l.type, l.send_key])).toEqual([["insert", "none"]]);
  });

  test("Shift+Enter: the draft box opens with the keyboard, and nothing is inserted", async () => {
    const r = rig([[800, RC, true], [900, RC, false], ...shiftEnter(2500)]);
    await r.settled();
    expect(r.inserts()).toEqual([]);
    expect(r.svc.log.events().find((e) => e.type === "dictation.drafted")).toMatchObject({
      reason: "key",
    });
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0]).toMatchObject({ text: "hello", focus: true });
    // The helper stops holding the keys at once rather than 8 s later. The fake logs each command
    // as it reads it, so the line may land a moment after the draft opened.
    await until(
      () => lines(r.commands).some((c) => c.type === "settled"),
      5000,
      "settled sent to the helper",
    );
  });

  test("Escape while transcribing: the text stays in history as cancelled, nothing goes in", async () => {
    const r = rig([...HOLD, ...press(1900, "Escape")]);
    await r.settled();
    expect(r.inserts()).toEqual([]);
    expect(r.item()).toMatchObject({ state: "cancelled", text: "hello" });
  });

  test("the dictation key while transcribing starts nothing and flashes the pill", async () => {
    const r = rig([...HOLD, ...press(1900, RC)]);
    await r.settled();
    expect(r.svc.log.items()).toHaveLength(1);
    expect(r.follow.filter((m) => m.kind === "busy")).toHaveLength(1);
    expect(r.item()).toMatchObject({ state: "inserted", text: "hello" });
  });

  test("a key source without swallow_keys passes Enter through and never sends", async () => {
    const r = rig([[800, RC, true], ...press(1600, "Enter"), [1700, RC, false]], {
      switches: ["--no-swallow"],
    });
    await r.settled();
    expect(r.svc.status().swallow_keys).toBe(false);
    expect(lines(r.tap).find((k) => k.key === "Enter" && k.down)).toMatchObject({
      swallowed: false,
    });
    expect(r.inserts().map((l) => [l.type, l.send_key])).toEqual([["insert", "none"]]);
  });

  test("positive control: with no session the same keys pass through", async () => {
    const keys = [...press(100, "Enter"), ...shiftEnter(300), ...press(500, "Escape")];
    const r = rig(keys);
    await until(() => lines(r.tap).length >= keys.length, 10_000, "the keys");
    const downs = lines(r.tap).filter((k) => k.down && k.key !== "LeftShift");
    expect(downs.map((k) => [k.key, k.swallowed])).toEqual([
      ["Enter", false],
      ["Enter", false],
      ["Escape", false],
    ]);
    expect(r.svc.log.items()).toEqual([]);
  });
});

describe("DC-S2: the send key after the paste receipt", () => {
  const enterDuringHold: Key[] = [[800, RC, true], ...press(1600, "Enter"), [1700, RC, false]];

  test("a receipt that never comes: no send key at all, then the helper's no-receipt is the dictation's failure", async () => {
    const r = rig(enterDuringHold, { switches: ["--no-receipt", "--receipt-timeout-ms", "300"] });
    await r.settled();
    expect(r.inserts().map((l) => [l.type, l.send_key])).toEqual([["insert", "Enter"]]);
    expect(r.item()).toMatchObject({ state: "failed", error: "insert: no-receipt" });
    // The pill shows a dictation.failed as its error state (tests/dictation-pill.test.ts).
    expect(r.follow.some((m) => m.kind === "event" && m.e.type === "dictation.failed")).toBe(true);
  });

  test("sendKey: none presses nothing even on Enter", async () => {
    const r = rig(enterDuringHold, { insert: { ...DEFAULT_INSERT, sendKey: "none" } });
    await r.settled();
    expect(r.inserts().map((l) => [l.type, l.send_key])).toEqual([["insert", "none"]]);
  });

  test("the send key setting is the key pressed", async () => {
    const r = rig(enterDuringHold, { insert: { ...DEFAULT_INSERT, sendKey: "Cmd+Enter" } });
    await r.settled();
    expect(r.inserts().map((l) => [l.type, l.send_key ?? l.key])).toEqual([
      ["insert", "Cmd+Enter"],
      ["send", "Cmd+Enter"],
    ]);
  });

  test("clipboard only: Enter presses nothing, and the insert is a copy", async () => {
    const r = rig(enterDuringHold, { insert: { ...SEND_ENTER, method: "clipboard" } });
    await r.settled();
    expect(r.inserts().map((l) => [l.type, l.method, l.send_key])).toEqual([
      ["insert", "clipboard", "none"],
    ]);
    // The pill's `Copied · ⌘V` comes from this method (tests/dictation-pill.test.ts).
    expect(r.svc.log.events().find((e) => e.type === "dictation.inserted")).toMatchObject({
      method: "clipboard",
    });
  });

  test("sendAlways sends after a plain hold", async () => {
    const r = rig(HOLD, { insert: { ...SEND_ENTER, sendAlways: true } });
    await r.settled();
    expect(r.inserts().map((l) => l.type)).toEqual(["insert", "send"]);
  });

  test("dictation.restoreClipboard reaches the helper; type pastes until DC-N7", async () => {
    const r = rig(HOLD, { insert: { ...SEND_ENTER, method: "type", restore: false } });
    await r.settled();
    expect(r.inserts()[0]).toMatchObject({ method: "paste", restore: false });
  });

  test("positive control: the default restores, so the insert carries no restore", async () => {
    const r = rig(HOLD);
    await r.settled();
    expect(r.inserts()[0]).toMatchObject({ method: "paste" });
    expect(r.inserts()[0]).not.toHaveProperty("restore");
  });
});

describe("the session's own edges", () => {
  const TARGET = { app: "a", pid: 1, window: "w", field: "editable" as const };
  const packet = (): Packet => ({
    ch: "mic",
    zeroFilled: false,
    captureNs: 0n,
    fileSeconds: 0,
    samples: new Float32Array(320),
  });

  function session(o: { secure?: boolean } = {}) {
    const t = tempDir("akou-dict-keys-unit-");
    cleanups.push(t.cleanup);
    const log = new DictationLog(t.dir);
    cleanups.push(() => log.close());
    const sent: AppToHelper[] = [];
    const logs: string[] = [];
    const s = new DictationSession({
      log,
      engine: () => ({
        name: "fast",
        decode: async () => ({
          text: "hello",
          words: [],
          language: null,
          model: "m",
          ms: 1,
          spans: 1,
        }),
      }),
      send: (c) => sent.push(c),
      bindings: () => ({ hotkey: RC, draft: "", fixLast: "", pasteLast: "", activation: "hold" }),
      now: () => Date.now(),
      insertPolicy: () => SEND_ENTER,
      onLog: (_l, m) => logs.push(m),
      onDraft: () => true,
    });
    if (o.secure) s.onMessage({ type: "secure_input", on: true });
    return { s, sent, log, logs };
  }

  test("Enter after the text went to the helper does nothing, and says so", async () => {
    const { s, sent, logs } = session();
    s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    s.onPacket(packet());
    s.onMessage({ type: "session.ended", id: "1", reason: "release" });
    await until(() => sent.some((c) => c.type === "insert"), 2000, "the insert");
    s.onMessage({ type: "key", name: "Enter" });
    expect(sent.filter((c) => c.type === "insert")).toMatchObject([{ send_key: "none" }]);
    expect(logs).toEqual(["dictation: Enter came after the insert began, so it did nothing"]);
  });

  test("a password field: Shift+Enter never shows its text, and Enter sends nothing", async () => {
    const { s, sent, log } = session({ secure: true });
    s.onMessage({ type: "session.started", id: "1", target: TARGET, capture_ns: "0" });
    s.onPacket(packet());
    s.onMessage({ type: "key", name: "Shift+Enter" });
    s.onMessage({ type: "session.ended", id: "1", reason: "key" });
    await until(() => sent.some((c) => c.type === "insert"), 2000, "the insert");
    expect(sent.find((c) => c.type === "insert")).toMatchObject({
      method: "clipboard",
      send_key: "none",
    });
    expect(log.events().map((e) => e.type)).not.toContain("dictation.drafted");
  });
});

describe("DC-S6 on a spoken dictation", () => {
  test("with spoken punctuation on, the session inserts the mark", async () => {
    const r = rig(HOLD, {
      extra: {
        punctuation: () => SPOKEN_PUNCTUATION,
        languages: () => ["en"],
        engine: () => ({
          name: "fast",
          decode: async () => ({
            text: "hello comma world",
            words: [
              { w: "hello", s: 0, e: 0.4, c: 1 },
              { w: "comma", s: 1.2, e: 1.5, c: 1 },
              { w: "world", s: 2.3, e: 2.7, c: 1 },
            ],
            language: "en",
            model: "stub",
            ms: 1,
            spans: 1,
          }),
        }),
      },
    });
    await r.settled();
    expect(r.item()).toMatchObject({ raw: "hello comma world", text: "hello, world" });
    expect(r.inserts()[0]?.text).toBe("hello, world");
  });
});
