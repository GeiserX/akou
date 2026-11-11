/**
 * Every dictation settles (docs/ux/DICTATION.md section 10): one whose helper exits during the
 * decode fails instead of waiting for a receipt that never comes, one left unsettled by a quit fails
 * at the next start, and a draft box call that throws fails only its own dictation. The session is
 * driven with the helper's lines directly; nothing types, pastes or opens a window.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Packet } from "../src/main/capture/protocol.ts";
import type { AppToHelper } from "../src/main/dictation/protocol.ts";
import { DictationService } from "../src/main/dictation/service.ts";
import { type DictationEngine, DictationSession } from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const TARGET = { app: "com.example.chat", pid: 7, window: "w7", field: "editable" as const };
const PACKET: Packet = {
  ch: "mic",
  zeroFilled: false,
  captureNs: 0n,
  fileSeconds: 0,
  samples: new Float32Array(3200),
};

const reading = (text: string) => ({
  text,
  words: [],
  language: "en",
  model: "m",
  ms: 1,
  spans: 1,
});

/** An engine whose decode waits until the test lets it finish. */
function heldEngine(text: string) {
  const calls: (() => void)[] = [];
  const engine: DictationEngine = {
    name: "fast",
    decode: () =>
      new Promise((resolve) => {
        calls.push(() => resolve(reading(text)));
      }),
  };
  return { engine, calls };
}

function session(
  engine: DictationEngine,
  extra: Partial<ConstructorParameters<typeof DictationSession>[0]> = {},
) {
  const t = tempDir("akou-dict-settle-");
  cleanups.push(t.cleanup);
  const log = new DictationLog(t.dir);
  cleanups.push(() => log.close());
  const sent: AppToHelper[] = [];
  const s = new DictationSession({
    log,
    engine: () => engine,
    send: (c) => sent.push(c),
    bindings: () => ({
      hotkey: "RightCommand",
      draft: "",
      fixLast: "",
      pasteLast: "",
      activation: "hold",
    }),
    now: () => Date.now(),
    ...extra,
  });
  /** One dictation, `draft` ended with Shift+Enter. */
  const dictate = (id: string, draft = false) => {
    s.onMessage({
      type: "session.started",
      id,
      target: TARGET,
      capture_ns: "0",
      ...(draft ? { draft: true } : {}),
    });
    s.onPacket(PACKET);
    s.onMessage({ type: "session.ended", id, reason: "release" });
  };
  return { s, log, sent, dictate };
}

describe("T4.40: the helper exits while a dictation decodes", () => {
  test("[T4.40] the dictation fails with its text kept, and no insert goes to the dead helper", async () => {
    const { engine, calls } = heldEngine("hello world");
    const { s, log, sent, dictate } = session(engine);
    dictate("1");
    await until(() => calls.length === 1, 5000, "the decode");
    s.helperGone();
    calls[0]?.();
    await s.settled();
    expect(sent.some((c) => c.type === "insert")).toBe(false);
    const [it] = log.items();
    expect(it).toMatchObject({
      state: "failed",
      text: "hello world",
      error: "the dictation helper stopped",
    });
  });

  test("[T4.40] positive control: with the helper still there the same decode goes to the helper", async () => {
    const { engine, calls } = heldEngine("hello world");
    const { s, log, sent, dictate } = session(engine);
    dictate("1");
    await until(() => calls.length === 1, 5000, "the decode");
    calls[0]?.();
    await s.settled();
    expect(sent.find((c) => c.type === "insert")).toMatchObject({ text: "hello world" });
    expect(log.items()[0]?.state).toBe("inserting");
  });

  test("[T4.40] a dictation left unsettled by a quit fails at the next start, and retention can let it go", async () => {
    const t = tempDir("akou-dict-settle-");
    cleanups.push(t.cleanup);
    const dir = join(t.dir, "dictation");
    const log = new DictationLog(dir);
    for (const id of ["d1", "d2"]) {
      log.append({ type: "dictation.started", id, target: TARGET, engine: "fast", by: "user" });
      log.append({ type: "dictation.ended", id, reason: "release", seconds: 1 });
    }
    log.append({
      type: "dictation.text",
      id: "d1",
      raw: "kept words",
      text: "kept words",
      language: "en",
      words: [],
      engine: "fast",
      model: "m",
      ms: 1,
    });
    // A finished one is left alone.
    log.append({ type: "dictation.started", id: "d0", target: TARGET, engine: "fast", by: "user" });
    log.append({ type: "dictation.empty", id: "d0" });
    log.close();
    const before = new DictationLog(dir);
    expect(before.items().map((i) => [i.id, i.state])).toEqual([
      ["d0", "empty"],
      ["d2", "transcribing"],
      ["d1", "inserting"],
    ]);
    before.close();
    const svc = new DictationService({ configDir: t.dir, engine: () => null, now: () => 1 });
    expect(svc.log.items().map((i) => [i.id, i.state, i.text])).toEqual([
      ["d0", "empty", null],
      ["d2", "failed", null],
      ["d1", "failed", "kept words"],
    ]);
    expect(svc.log.item("d1")?.error).toBe("akou stopped before this dictation finished");
    await svc.close();
    // With retainDays 0 a failed dictation is finished, so all but the newest go.
    const again = new DictationService({
      configDir: t.dir,
      engine: () => null,
      now: () => 1,
      retainDays: () => 0,
    });
    cleanups.push(() => again.close());
    expect(again.log.items().map((i) => i.id)).toEqual(["d0"]);
  });
});

describe("T4.41: a draft box call that throws", () => {
  test("[T4.41] fails only its own dictation; the next one still decodes and goes in", async () => {
    const said: DictationEngine = {
      name: "fast",
      decode: async () => reading("next words"),
    };
    const { s, log, sent, dictate } = session(said, {
      onDraft: () => {
        throw new Error("the window is gone");
      },
    });
    dictate("1", true);
    await s.settled();
    dictate("2");
    await until(() => sent.some((c) => c.type === "insert"), 5000, "the second insert");
    await s.settled();
    const items = log.items();
    expect(items.map((i) => i.state)).toEqual(["inserting", "failed"]);
    expect(sent.find((c) => c.type === "insert")).toMatchObject({ id: "2", text: "next words" });
  });

  test("[T4.41] positive control: a draft box that opens drafts the dictation", async () => {
    const said: DictationEngine = {
      name: "fast",
      decode: async () => reading("words"),
    };
    const { s, log, dictate } = session(said, { onDraft: () => true });
    dictate("1", true);
    await s.settled();
    expect(log.items()[0]?.state).toBe("drafted");
  });
});
