/**
 * The spoken send (docs/ux/DICTATION.md DC-S5): with `dictation.spokenSend` on, a dictation ending
 * in "send it" (Spanish "envíalo") inserts the rest and presses the send key; the phrase anywhere
 * else is text. The session is driven with the helper's lines directly, and the insert is the
 * command it sends: nothing types, pastes or touches the clipboard.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spokenSend } from "../src/core/dictation/send.ts";
import type { Packet } from "../src/main/capture/protocol.ts";
import type { AppToHelper } from "../src/main/dictation/protocol.ts";
import {
  DEFAULT_INSERT,
  DictationSession,
  type InsertPolicy,
} from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("DC-S5: the phrase counts only at the very end", () => {
  const cases: [string, string, boolean][] = [
    ["tell them I'll send it tomorrow", "tell them I'll send it tomorrow", false],
    ["tell them tomorrow send it", "tell them tomorrow", true],
    ["Tell them tomorrow. Send it.", "Tell them tomorrow.", true],
    ["Tell them tomorrow, send it!", "Tell them tomorrow", true],
    ["dile que mañana, envíalo", "dile que mañana", true],
    ["dile que mañana envialo", "dile que mañana", true],
    ["send it", "send it", false],
    ["resend it", "resend it", false],
    ["send it later", "send it later", false],
  ];
  for (const [said, text, send] of cases) {
    test(JSON.stringify(said), () => {
      expect(spokenSend(said)).toEqual({ text, send });
    });
  }
});

describe("DC-S5: a spoken dictation ending in send it", () => {
  const TARGET = { app: "a", pid: 1, window: "w", field: "editable" as const };
  const SEND_ENTER: InsertPolicy = { ...DEFAULT_INSERT, sendKey: "Enter" };

  async function dictate(
    said: string,
    o: {
      spokenSend?: boolean;
      insert?: InsertPolicy;
      secure?: boolean;
      format?: (text: string) => Promise<{ text: string; skipped: string | null }>;
    } = {},
  ) {
    const t = tempDir("akou-dict-send-");
    cleanups.push(t.cleanup);
    const log = new DictationLog(t.dir);
    cleanups.push(() => log.close());
    const sent: AppToHelper[] = [];
    const s = new DictationSession({
      log,
      engine: () => ({
        name: "fast",
        decode: async () => ({
          text: said,
          words: [],
          language: null,
          model: "m",
          ms: 1,
          spans: 1,
        }),
      }),
      send: (c) => sent.push(c),
      bindings: () => ({
        hotkey: "RightCommand",
        draft: "",
        fixLast: "",
        pasteLast: "",
        activation: "hold",
      }),
      now: () => Date.now(),
      insertPolicy: () => o.insert ?? SEND_ENTER,
      spokenSend: () => o.spokenSend ?? true,
      ...(o.format ? { format: o.format } : {}),
    });
    const target = o.secure ? { ...TARGET, field: "secure" as const } : TARGET;
    s.onMessage({ type: "session.started", id: "1", target, capture_ns: "0" });
    const p: Packet = {
      ch: "mic",
      zeroFilled: false,
      captureNs: 0n,
      fileSeconds: 0,
      samples: new Float32Array(3200),
    };
    s.onPacket(p);
    s.onMessage({ type: "session.ended", id: "1", reason: "release" });
    await until(() => sent.some((c) => c.type === "insert"), 5000, "the insert");
    const insert = sent.find((c) => c.type === "insert") as Extract<
      AppToHelper,
      { type: "insert" }
    >;
    return { insert, events: log.events() };
  }

  test("inserts the words before it and presses the send key; history keeps what was said", async () => {
    const { insert, events } = await dictate("tell them tomorrow send it");
    expect(insert).toMatchObject({ text: "tell them tomorrow", send_key: "Enter" });
    expect(events.find((e) => e.type === "dictation.text")).toMatchObject({
      raw: "tell them tomorrow send it",
      text: "tell them tomorrow",
    });
  });

  test("the phrase in the middle is text, and nothing is sent", async () => {
    const { insert } = await dictate("tell them I'll send it tomorrow");
    expect(insert).toMatchObject({ text: "tell them I'll send it tomorrow", send_key: "none" });
  });

  test("positive control: with dictation.spokenSend off the phrase is typed and nothing sent", async () => {
    const { insert } = await dictate("tell them tomorrow send it", { spokenSend: false });
    expect(insert).toMatchObject({ text: "tell them tomorrow send it", send_key: "none" });
  });

  test("sendKey none presses nothing, the phrase still leaves", async () => {
    const { insert } = await dictate("tell them tomorrow send it", {
      insert: { ...DEFAULT_INSERT, sendKey: "none" },
    });
    expect(insert).toMatchObject({ text: "tell them tomorrow", send_key: "none" });
  });

  test("a clipboard-only insert pastes nothing, so nothing is sent", async () => {
    const { insert } = await dictate("tell them tomorrow send it", {
      insert: { ...SEND_ENTER, method: "clipboard" },
    });
    expect(insert).toMatchObject({ method: "clipboard", send_key: "none" });
  });

  test("the phrase is judged before the formatting pass, which never sees it", async () => {
    const seen: string[] = [];
    // A provider that tidies the text and drops a trailing command of its own accord.
    const format = async (text: string) => {
      seen.push(text);
      return { text: "Tell them tomorrow.", skipped: null };
    };
    const { insert } = await dictate("tell them tomorrow send it", { format });
    expect(seen).toEqual(["tell them tomorrow"]);
    expect(insert).toMatchObject({ text: "Tell them tomorrow.", send_key: "Enter" });
    // Positive control: a formatted text that merely ends in the phrase sends nothing.
    const added = await dictate("tell them tomorrow", {
      format: async () => ({ text: "Tell them tomorrow, send it.", skipped: null }),
    });
    expect(added.insert).toMatchObject({ send_key: "none" });
  });

  test("a password field gets exactly what was heard", async () => {
    const { insert } = await dictate("hunter two send it", { secure: true });
    expect(insert).toMatchObject({ text: "hunter two send it", send_key: "none" });
  });
});
