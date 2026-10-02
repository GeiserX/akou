/**
 * Per-app rules and spacing on the app's side (docs/ux/DICTATION.md DC-U9, DC-S4): what the rule
 * for the app captured at the press does to a session (its engine, language, formatting pass,
 * how its text goes in, its send key, the draft box it opens), and the spacing fields each insert
 * carries to the helper. The session is driven by the helper's messages directly, over a fake
 * engine; the draft box over a fake session and window. Nothing opens a device, types or pastes.
 * The helper's half (the read before the insert, the table of spaces and case) is tested in
 * `native/akou-capture/src/dictate/spacing.rs` and `session.rs`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Target } from "../src/core/dictation/events.ts";
import type { Decoded } from "../src/main/asr/live-worker.ts";
import type { Packet } from "../src/main/capture/protocol.ts";
import type { AppRule } from "../src/main/config/schema.ts";
import { DraftBox } from "../src/main/dictation/draft.ts";
import type { AppToHelper } from "../src/main/dictation/protocol.ts";
import {
  DEFAULT_INSERT,
  type DecodeRequest,
  DictationSession,
  type DraftRule,
  type InsertPolicy,
} from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import type { DraftOpen } from "../src/ui/dictation-protocol.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const CHAT: Target = { app: "com.example.chat", pid: 7, window: "w7", field: "editable" };
const TERM: Target = { app: "com.example.term", pid: 8, window: "w8", field: "editable" };
const OTHER: Target = { app: "com.example.notes", pid: 9, window: "w9", field: "editable" };
/** A terminal whose rule types. */
const RULES_TYPE: AppRule[] = [{ app: TERM.app, insert: "type" }];

const packet = (): Packet => ({
  ch: "mic",
  zeroFilled: false,
  captureNs: 0n,
  fileSeconds: 0,
  samples: new Float32Array(320),
});

interface Rig {
  s: DictationSession;
  log: DictationLog;
  sent: AppToHelper[];
  /** The engine names asked for and each decode's request, in order. */
  engines: (string | undefined)[];
  decodes: DecodeRequest[];
  formats: (string | undefined)[];
  drafts: { id: string; reason: string; focus: boolean; rule?: DraftRule }[];
  /** The engines whose request was opened at the press (DC-R6), in order. */
  opened: string[];
  /** One dictation into `target`, with `key` pressed while listening; resolves with its insert. */
  dictate(target: Target, key?: string): Promise<Extract<AppToHelper, { type: "insert" }> | null>;
}

function rig(
  o: {
    rules?: AppRule[];
    policy?: InsertPolicy;
    text?: string;
    language?: string;
    draftOpens?: boolean;
    /** The engine the settings pick (`dictation.engine`); `remote` takes the audio at the press. */
    globalEngine?: string;
    accessibility?: "granted" | "denied";
  } = {},
): Rig {
  const t = tempDir("akou-dict-rules-");
  cleanups.push(t.cleanup);
  const log = new DictationLog(t.dir);
  cleanups.push(() => log.close());
  const sent: AppToHelper[] = [];
  const engines: (string | undefined)[] = [];
  const decodes: DecodeRequest[] = [];
  const formats: (string | undefined)[] = [];
  const drafts: Rig["drafts"] = [];
  const opened: string[] = [];
  const s = new DictationSession({
    log,
    engine: (name) => {
      engines.push(name);
      const engine = name ?? o.globalEngine ?? "fast";
      const decode = async (d: DecodeRequest): Promise<Decoded> => {
        decodes.push(d);
        return {
          text: o.text ?? "Hello there.",
          words: [],
          language: null,
          model: "m",
          ms: 1,
          spans: 1,
        };
      };
      return {
        name: engine,
        decode: (_s, d) => decode(d),
        // Only the remote takes the audio during the hold (DC-R6).
        ...(engine === "remote"
          ? {
              open: (d: DecodeRequest) => {
                opened.push(engine);
                return { push: () => {}, decode: () => decode(d), cancel: () => {} };
              },
            }
          : {}),
      };
    },
    send: (c) => sent.push(c),
    bindings: () => ({
      hotkey: "RightCommand",
      draft: "",
      fixLast: "",
      pasteLast: "",
      activation: "hold",
    }),
    now: () => Date.now(),
    ...(o.language ? { language: () => o.language } : {}),
    format: async (_text, mode) => {
      formats.push(mode);
      return null;
    },
    insertPolicy: () => o.policy ?? { ...DEFAULT_INSERT, sendKey: "Enter" },
    appRule: (app) => o.rules?.find((r) => r.app === app),
    onDraft: (id, reason, focus, rule) => {
      drafts.push({ id, reason, focus, ...(rule ? { rule } : {}) });
      return o.draftOpens ?? true;
    },
  });
  s.onMessage({
    type: "ready",
    protocol: "akou-dictate/1",
    version: "0",
    grants: { mic: "granted", accessibility: o.accessibility ?? "granted" },
    backend: "fake",
    swallow_keys: true,
  });
  let n = 0;
  return {
    s,
    log,
    sent,
    engines,
    decodes,
    formats,
    drafts,
    opened,
    dictate: async (target, key) => {
      const id = String(++n);
      const before = sent.length;
      const logged = log.items().length;
      s.onMessage({ type: "session.started", id, target, capture_ns: "0" });
      s.onPacket(packet());
      if (key) s.onMessage({ type: "key", name: key });
      s.onMessage({ type: "session.ended", id, reason: "release" });
      await until(
        () =>
          sent
            .slice(before)
            .some((c) => (c.type === "insert" || c.type === "settled") && c.id === id) &&
          log.items().length > logged,
        2000,
        "the insert or the settle",
      );
      const ins = sent.slice(before).find((c) => c.type === "insert" && c.id === id);
      return (ins as Extract<AppToHelper, { type: "insert" }> | undefined) ?? null;
    },
  };
}

describe("DC-U9: the rule for the app at the press", () => {
  const RULES: AppRule[] = [
    { app: CHAT.app, mode: "draft-send", sendKey: "Cmd+Enter" },
    { app: TERM.app, insert: "type", engine: "remote", language: "es", format: "off" },
  ];

  test("a draft-send rule opens the draft box, taking the keyboard, and inserts nothing", async () => {
    const r = rig({ rules: RULES });
    expect(await r.dictate(CHAT)).toBeNull();
    const id = r.log.items()[0]?.id as string;
    expect(r.drafts).toEqual([
      { id, reason: "rule", focus: true, rule: { enterSends: true, sendKey: "Cmd+Enter" } },
    ]);
    expect(r.log.item(id)?.state).toBe("drafted");
    // The helper stops holding Escape and Enter at once.
    expect(r.sent.some((c) => c.type === "settled" && c.id === "1")).toBe(true);
  });

  test("a key pressed during the session wins over the rule: Enter inserts and sends", async () => {
    const r = rig({ rules: RULES });
    const ins = await r.dictate(CHAT, "Enter");
    expect(r.drafts).toEqual([]);
    // The rule's send key, not dictation.sendKey.
    expect(ins?.send_key).toBe("Cmd+Enter");
  });

  test("a draft rule with no draft box fails the dictation instead of losing it silently", async () => {
    const r = rig({ rules: [{ app: CHAT.app, mode: "draft" }], draftOpens: false });
    expect(await r.dictate(CHAT)).toBeNull();
    expect(r.drafts[0]?.rule).toEqual({ enterSends: false });
    expect(r.log.items()[0]?.state).toBe("failed");
  });

  test("insert: type types; engine, language and format come from the rule", async () => {
    const r = rig({ rules: RULES, language: "en" });
    const ins = await r.dictate(TERM);
    expect(ins?.method).toBe("type");
    expect(r.engines.at(-1)).toBe("remote");
    expect(r.decodes).toEqual([{ language: "es" }]);
    expect(r.formats).toEqual(["off"]);
    expect(r.log.items()[0]?.engine).toBe("remote");
  });

  test("a text with a line break is pasted even under type, so no Return is pressed", async () => {
    const r = rig({ rules: RULES, text: "one\ntwo" });
    expect((await r.dictate(TERM))?.method).toBe("paste");
  });

  test("language auto in a rule lets the engine choose over a forced dictation.language", async () => {
    const r = rig({ rules: [{ app: TERM.app, language: "auto" }], language: "en" });
    await r.dictate(TERM);
    expect(r.decodes).toEqual([{}]);
  });

  test("the rule's engine is the one opened at the press, not the global remote (DC-R6)", async () => {
    const r = rig({ rules: [{ app: TERM.app, engine: "fast" }], globalEngine: "remote" });
    const engineOf = (t: Target) => r.log.items().find((i) => i.target?.app === t.app)?.engine;
    await r.dictate(TERM);
    expect(r.opened).toEqual([]);
    expect(engineOf(TERM)).toBe("fast");
    // Positive control: an app with no rule opens the global remote at its press.
    await r.dictate(OTHER);
    expect(r.opened).toEqual(["remote"]);
    expect(engineOf(OTHER)).toBe("remote");
  });

  test("Shift+Enter's draft box carries the rule's send key and insert method, never Enter sends", async () => {
    const r = rig({ rules: RULES });
    expect(await r.dictate(CHAT, "Shift+Enter")).toBeNull();
    expect(await r.dictate(TERM, "Shift+Enter")).toBeNull();
    expect(r.drafts.map((d) => [d.reason, d.rule])).toEqual([
      ["key", { enterSends: false, sendKey: "Cmd+Enter" }],
      ["key", { enterSends: false, insert: "type" }],
    ]);
  });

  test("the focus guard's draft box carries the rule too; a dictation with no rule carries none", async () => {
    const r = rig({ rules: RULES });
    for (const target of [TERM, OTHER]) {
      const ins = await r.dictate(target);
      r.s.onMessage({ type: "insert.failed", id: ins?.id as string, reason: "focus-changed" });
    }
    expect(r.drafts.map((d) => [d.reason, d.focus, d.rule])).toEqual([
      ["focus-changed", false, { enterSends: false, insert: "type" }],
      ["focus-changed", false, undefined],
    ]);
  });

  test("positive control: an app with no rule uses the globals", async () => {
    const r = rig({ rules: RULES, language: "en" });
    const ins = await r.dictate(OTHER, "Enter");
    expect(ins?.method).toBe("paste");
    expect(ins?.send_key).toBe("Enter");
    expect(r.engines.at(-1)).toBeUndefined();
    expect(r.decodes).toEqual([{ language: "en" }]);
    expect(r.formats).toEqual([undefined]);
    expect(r.drafts).toEqual([]);
  });
});

describe("DC-N3: no Accessibility grant, the clipboard only", () => {
  test("every insert is clipboard only and sends nothing, a rule's type and Enter included", async () => {
    const r = rig({ rules: RULES_TYPE, accessibility: "denied" });
    const a = await r.dictate(OTHER, "Enter");
    expect([a?.method, a?.send_key]).toEqual(["clipboard", "none"]);
    const b = await r.dictate(TERM);
    expect(b?.method).toBe("clipboard");
    // The draft box's insert too.
    void r.s.insertText("x", "hi", OTHER, "Enter", "type");
    expect(r.sent.at(-1)).toMatchObject({ type: "insert", method: "clipboard", send_key: "none" });
  });

  test("positive control: with the grant the same dictations paste, type and send", async () => {
    const r = rig({ rules: RULES_TYPE });
    const a = await r.dictate(OTHER, "Enter");
    expect([a?.method, a?.send_key]).toEqual(["paste", "Enter"]);
    expect((await r.dictate(TERM))?.method).toBe("type");
    void r.s.insertText("x", "hi", OTHER, "Enter", "type");
    expect(r.sent.at(-1)).toMatchObject({ type: "insert", method: "type", send_key: "Enter" });
  });

  test("a grant taken back turns the next insert to the clipboard (DC-N1)", async () => {
    const r = rig();
    expect((await r.dictate(OTHER))?.method).toBe("paste");
    r.s.onMessage({ type: "grant.lost", name: "accessibility" });
    expect((await r.dictate(OTHER))?.method).toBe("clipboard");
  });
});

describe("DC-U9: the draft box's own insert", () => {
  test("follows dictation.insert, pastes a line break, and a rule's method wins", async () => {
    const r = rig({ policy: { ...DEFAULT_INSERT, method: "type" } });
    const last = () => r.sent.at(-1) as Extract<AppToHelper, { type: "insert" }>;
    void r.s.insertText("x", "hi", OTHER, "none");
    expect(last().method).toBe("type");
    void r.s.insertText("x", "one\ntwo", OTHER, "none");
    expect(last().method).toBe("paste");
    void r.s.insertText("x", "hi", OTHER, "none", "clipboard");
    expect(last().method).toBe("clipboard");
  });
});

describe("DC-U9: the draft box a rule opened", () => {
  function box() {
    const t = tempDir("akou-dict-rules-box-");
    cleanups.push(t.cleanup);
    const log = new DictationLog(t.dir, () => 1000);
    cleanups.push(() => log.close());
    const inserts: { text: string; sendKey: string; insert?: string }[] = [];
    const opens: DraftOpen[] = [];
    const session = {
      insertText: async (
        id: string,
        text: string,
        _t: unknown,
        sendKey: string,
        insert?: string,
      ) => {
        inserts.push({ text, sendKey, ...(insert ? { insert } : {}) });
        log.append({ type: "dictation.inserted", id, method: "paste", receipt_ms: 5 });
        return { ok: true, method: "paste", receipt_ms: 5 };
      },
    };
    const b = new DraftBox({
      log,
      platform: "darwin",
      session: () => session as never,
      sendKey: () => "Enter",
      learnMode: () => "off",
      engines: () => [],
      retry: async () => ({ ok: false, message: "no" }),
      learnEntry: async () => {},
      unlearnEntry: async () => {},
    });
    b.attach({
      open: (d) => opens.push(d),
      chip: () => {},
      append: () => {},
      showInactive: () => {},
      hide: () => {},
    });
    const id = "d-1";
    log.append({ type: "dictation.started", id, target: CHAT, engine: "fast", by: "user" });
    log.append({
      type: "dictation.text",
      id,
      raw: "see you",
      text: "see you",
      language: "en",
      words: [],
      engine: "fast",
      model: "m",
      ms: 1,
    });
    log.append({ type: "dictation.drafted", id, reason: "rule" });
    return { b, id, inserts, opens };
  }

  test("the page is told Enter sends, and the send goes with the rule's key", async () => {
    const { b, id, inserts, opens } = box();
    expect(b.open(id, { focus: true, rule: { enterSends: true, sendKey: "Cmd+Enter" } }).ok).toBe(
      true,
    );
    expect(opens[0]?.enterSends).toBe(true);
    expect(opens[0]?.focus).toBe(true);
    // The page's Enter in such a box asks for the send.
    expect(await b.handlers.insert({ id, text: "see you", send: true })).toBe(true);
    expect(inserts).toEqual([{ text: "see you", sendKey: "Cmd+Enter" }]);
  });

  test("a rule's insert method goes with the box's Enter", async () => {
    const { b, id, inserts } = box();
    b.open(id, { focus: false, rule: { enterSends: false, insert: "type" } });
    await b.handlers.insert({ id, text: "see you", send: false });
    expect(inserts).toEqual([{ text: "see you", sendKey: "none", insert: "type" }]);
  });

  test("positive control: a box no rule opened sends with dictation.sendKey and says nothing of Enter", async () => {
    const { b, id, inserts, opens } = box();
    b.open(id, { focus: true });
    expect(opens[0]?.enterSends).toBeUndefined();
    await b.handlers.insert({ id, text: "see you", send: true });
    expect(inserts).toEqual([{ text: "see you", sendKey: "Enter" }]);
  });
});

describe("DC-S4: the spacing fields of an insert", () => {
  const SPACED: InsertPolicy = { ...DEFAULT_INSERT, smartSpacing: true, trailingSpace: true };

  test("smartSpacing and trailingSpace reach the helper with the insert", async () => {
    const ins = await rig({ policy: SPACED }).dictate(OTHER);
    expect(ins).toMatchObject({ smart_spacing: true, trailing_space: true });
  });

  test("positive control: with both off the insert carries neither, so nothing is read", async () => {
    const ins = await rig({ policy: DEFAULT_INSERT }).dictate(OTHER);
    expect(ins && "smart_spacing" in ins).toBe(false);
    expect(ins && "trailing_space" in ins).toBe(false);
  });

  test("a password field gets its text exactly as heard: no spacing asked", async () => {
    const ins = await rig({ policy: SPACED }).dictate({ ...OTHER, field: "secure" });
    expect(ins?.method).toBe("clipboard");
    expect(ins && ("smart_spacing" in ins || "trailing_space" in ins)).toBe(false);
  });

  test("the draft box's insert asks for the same spacing", async () => {
    const r = rig({ policy: SPACED });
    void r.s.insertText("x", "hi", OTHER, "none");
    expect(r.sent.at(-1)).toMatchObject({
      type: "insert",
      smart_spacing: true,
      trailing_space: true,
    });
  });
});
