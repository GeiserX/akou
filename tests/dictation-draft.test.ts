/**
 * The draft box's main side (docs/ux/DICTATION.md DC-S1, DC-L1, DC-L4, DC-L6): what each key of
 * the box does, when the offer to learn a word is put to the user, what its answers write, and the
 * shell's window for it. Over a real dictation log with a fake session, a fake window and timers
 * run by hand; no window, key, device or clipboard is touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { DictationDraft } from "../src/core/dictation/events.ts";
import { pairHistory, shouldAsk } from "../src/core/dictation/learn.ts";
import { DraftBox, type DraftBoxOptions, LEARNED_MS } from "../src/main/dictation/draft.ts";
import type { InsertOutcome } from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import { knowsPair, learnPair, unlearnPair } from "../src/main/dictation/vocab.ts";
import { emptyVocab, type MergedEntry } from "../src/main/vocab/files.ts";
import type { Bridge } from "../src/main/window/bridge.ts";
import { type DraftHandlers, Shell, type ShellApp } from "../src/main/window/shell.ts";
import type { DraftOpen } from "../src/ui/dictation-protocol.ts";
import type { Chip } from "../src/ui/pill-protocol.ts";
import { tempDir } from "./helpers.ts";
import { fakeUi } from "./shell-helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const TARGET = { app: "com.example.chat", pid: 7, window: "w7", field: "editable" } as const;
const HEARD = "tell the cooper netties team";
const FIXED = "tell the Kubernetes team";

/** Timers run by hand. */
function manualLater() {
  const due: { ms: number; fn: () => void; live: boolean }[] = [];
  return {
    later: (ms: number, fn: () => void) => {
      const t = { ms, fn, live: true };
      due.push(t);
      return () => {
        t.live = false;
      };
    },
    run: (ms: number) => {
      for (const t of due.splice(0)) if (t.live && t.ms === ms) t.fn();
    },
  };
}

function box(o: Partial<DraftBoxOptions> & { outcome?: InsertOutcome } = {}) {
  const t = tempDir("akou-draft-");
  cleanups.push(t.cleanup);
  const log = new DictationLog(t.dir, () => 1000);
  cleanups.push(() => log.close());
  const inserts: { id: string; text: string; sendKey: string }[] = [];
  const copies: string[] = [];
  const learned: string[] = [];
  const opens: DraftOpen[] = [];
  const chips: Chip[] = [];
  const calls: string[] = [];
  const timers = manualLater();
  const session = {
    insertText: async (id: string, text: string, _t: unknown, sendKey: string) => {
      inserts.push({ id, text, sendKey });
      const out = o.outcome ?? { ok: true, method: "paste" };
      if (out.ok) log.append({ type: "dictation.inserted", id, method: "paste", receipt_ms: 5 });
      return out;
    },
    copyText: async (text: string) => {
      copies.push(text);
      return { ok: true, method: "clipboard" } as InsertOutcome;
    },
  };
  const b = new DraftBox({
    log,
    platform: "darwin",
    session: () => session as never,
    sendKey: () => "Enter",
    learnMode: () => "ask",
    engines: () => ["fast", "best"],
    retry: async () => ({
      ok: true,
      answer: { text: "tell the Kubernetes team", words: [], engine: "best", model: "q", ms: 9 },
    }),
    learnEntry: async (p) => {
      learned.push(`+${p.heard}>${p.term}`);
    },
    unlearnEntry: async (p) => {
      learned.push(`-${p.heard}>${p.term}`);
    },
    later: timers.later,
    ...o,
  });
  b.attach({
    open: (d) => {
      opens.push(d);
      calls.push(d.focus ? "show" : "showInactive");
    },
    chip: (c) => chips.push(c),
    showInactive: () => calls.push("showInactive"),
    hide: () => calls.push("hide"),
  });
  let n = 0;
  /** A dictation in the log: decoded, then drafted (the focus guard) or inserted. */
  const dictation = (text = HEARD, end: "drafted" | "inserted" = "drafted") => {
    const id = `d${++n}`;
    const add = (d: DictationDraft) => log.append(d);
    add({ type: "dictation.started", id, target: TARGET, engine: "fast", by: "user" });
    add({ type: "dictation.ended", id, reason: "release", seconds: 2 });
    add({
      type: "dictation.text",
      id,
      raw: text,
      text,
      language: "en",
      words: [],
      engine: "fast",
      model: "parakeet",
      ms: 80,
    });
    if (end === "drafted") add({ type: "dictation.drafted", id, reason: "focus-changed" });
    else add({ type: "dictation.inserted", id, method: "paste", receipt_ms: 5 });
    return id;
  };
  const learnEvents = () =>
    log
      .events()
      .filter((e) => e.type === "dictation.learn")
      .map((e) => (e as { status: string }).status);
  return {
    b,
    log,
    inserts,
    copies,
    learned,
    opens,
    chips,
    calls,
    timers,
    dictation,
    learnEvents,
  };
}

describe("DC-S1: the draft box's keys", () => {
  test("Enter inserts where the session began with no send key; Ctrl+Enter presses dictation.sendKey", async () => {
    const f = box();
    const a = f.dictation();
    expect(f.b.open(a, { focus: false })).toEqual({ ok: true });
    expect(f.opens[0]).toMatchObject({
      id: a,
      text: HEARD,
      to: TARGET.app,
      engine: "fast (parakeet)",
      ms: 80,
      engines: ["fast", "best"],
      focus: false,
      platform: "darwin",
    });
    expect(await f.b.handlers.insert({ id: a, text: HEARD, send: false })).toBe(true);
    const b = f.dictation();
    f.b.open(b, { focus: true });
    expect(await f.b.handlers.insert({ id: b, text: "sent", send: true })).toBe(true);
    expect(f.inserts).toEqual([
      { id: a, text: HEARD, sendKey: "none" },
      { id: b, text: "sent", sendKey: "Enter" },
    ]);
    expect(f.calls).toEqual(["showInactive", "hide", "show", "hide"]);
    // A second answer to the same draft does nothing.
    expect(await f.b.handlers.insert({ id: b, text: "again", send: false })).toBe(false);
  });

  test("a refused insert opens the box again with the user's text, without the keyboard", async () => {
    const f = box({ outcome: { ok: false, reason: "focus-changed" } });
    const a = f.dictation();
    f.b.open(a, { focus: true });
    expect(await f.b.handlers.insert({ id: a, text: "my own words", send: false })).toBe(false);
    expect(f.opens.at(-1)).toMatchObject({ id: a, text: "my own words", focus: false });
    expect(f.log.item(a)?.state).toBe("drafted");
    expect(f.b.holding()).toBe(a);
  });

  test("a fix offered once for a dictation is not proposed again by a second Enter or a Copy", async () => {
    const f = box({ outcome: { ok: false, reason: "focus-changed" } });
    const a = f.dictation();
    f.b.open(a, { focus: true });
    await f.b.handlers.insert({ id: a, text: FIXED, send: false });
    await f.b.handlers.copy({ id: a, text: FIXED });
    await f.b.handlers.insert({ id: a, text: FIXED, send: false });
    expect(f.learnEvents()).toEqual(["proposed"]);
    expect(f.chips).toHaveLength(1);
  });

  test("Escape discards a draft that never reached the app, and leaves an inserted one inserted", async () => {
    const f = box();
    const a = f.dictation();
    f.b.open(a, { focus: false });
    expect(await f.b.handlers.discard({ id: a })).toBe(true);
    expect(f.log.item(a)?.state).toBe("discarded");
    expect(f.inserts).toEqual([]);
    const b = f.dictation(HEARD, "inserted");
    f.b.open(b, { focus: true, fix: true });
    expect(await f.b.handlers.discard({ id: b })).toBe(true);
    expect(f.log.item(b)?.state).toBe("inserted");
  });

  test("Fix learns and inserts nothing; Copy goes through the clipboard; Retry shows the new reading", async () => {
    const f = box();
    const a = f.dictation(HEARD, "inserted");
    f.b.open(a, { focus: true, fix: true });
    expect(await f.b.handlers.insert({ id: a, text: FIXED, send: false })).toBe(true);
    expect(f.inserts).toEqual([]);
    expect(f.learnEvents()).toEqual(["proposed"]);

    const b = f.dictation();
    f.b.open(b, { focus: false });
    expect(await f.b.handlers.copy({ id: b, text: "copied words" })).toBe(true);
    expect(f.copies).toEqual(["copied words"]);
    expect(await f.b.handlers.retry({ id: b, engine: "best" })).toBe(true);
    expect(f.opens.at(-1)).toMatchObject({ id: b, text: FIXED, engine: "best (q)", ms: 9 });
  });

  test("a dictation with no text, or a clip with no target outside Fix, does not open", () => {
    const f = box();
    expect(f.b.open("dnone", { focus: true })).toMatchObject({ ok: false, code: "not_found" });
    f.log.append({ type: "dictation.started", id: "c1", target: null, engine: "fast", by: "api" });
    f.log.append({ type: "dictation.ended", id: "c1", reason: "clip", seconds: 1 });
    f.log.append({ type: "dictation.empty", id: "c1" });
    expect(f.b.open("c1", { focus: true })).toMatchObject({ ok: false, code: "no_text" });
    expect(f.b.open("c1", { focus: true, text: "typed" })).toMatchObject({ code: "no_target" });
    expect(f.b.open("c1", { focus: true, fix: true, text: "typed" })).toEqual({ ok: true });
    f.b.attach(null);
    const a = f.dictation();
    expect(f.b.open(a, { focus: true })).toMatchObject({ ok: false, code: "no_draft_box" });
  });
});

describe("DC-L1: the draft box learns from the edit", () => {
  test('"cooper netties" fixed to "Kubernetes" is proposed and the chip shows; Enter with no edit writes nothing', async () => {
    const f = box();
    const a = f.dictation();
    f.b.open(a, { focus: true });
    await f.b.handlers.insert({ id: a, text: HEARD, send: false });
    expect(f.learnEvents()).toEqual([]);
    expect(f.chips).toEqual([]);

    const b = f.dictation();
    f.b.open(b, { focus: true });
    await f.b.handlers.insert({ id: b, text: FIXED, send: false });
    expect(f.log.events().filter((e) => e.type === "dictation.learn")).toEqual([
      expect.objectContaining({
        id: b,
        term: "Kubernetes",
        heard: "cooper netties",
        status: "proposed",
        evidence: "none",
      }),
    ]);
    expect(f.chips).toEqual([
      { id: b, candidates: [{ term: "Kubernetes", heard: "cooper netties" }], mode: "ask" },
    ]);
    // The box stays up without the keyboard for the chip, after the insert.
    expect(f.calls.slice(-2)).toEqual(["hide", "showInactive"]);
  });

  test("with dictation.learn off no candidate is computed", async () => {
    const f = box({ learnMode: () => "off" });
    const a = f.dictation();
    f.b.open(a, { focus: true });
    await f.b.handlers.insert({ id: a, text: FIXED, send: false });
    expect(f.learnEvents()).toEqual([]);
    expect(f.chips).toEqual([]);
  });
});

describe("DC-L4: the chip asks once", () => {
  /** One more identical fix in a Fix box; answers whether a chip came. */
  async function fix(f: ReturnType<typeof box>): Promise<Chip | undefined> {
    const before = f.chips.length;
    const a = f.dictation(HEARD, "inserted");
    f.b.open(a, { focus: true, fix: true });
    await f.b.handlers.insert({ id: a, text: FIXED, send: false });
    return f.chips.length > before ? f.chips.at(-1) : undefined;
  }

  test("ignored, it comes back once at the third identical fix, then never", async () => {
    const f = box();
    const shown: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await fix(f);
      shown.push(c !== undefined);
      if (c) expect(await f.b.handlers.chip({ id: c.id, action: "ignore" })).toBe(true);
    }
    expect(shown).toEqual([true, false, true, false]);
    expect(f.learnEvents()).toEqual([
      "proposed",
      "ignored",
      "proposed",
      "proposed",
      "ignored",
      "proposed",
    ]);
  });

  test("Not a word writes rejected, and the same pair is never proposed again", async () => {
    const f = box();
    const c = await fix(f);
    if (!c) throw new Error("no chip");
    expect(await f.b.handlers.chip({ id: c.id, action: "reject", terms: ["Kubernetes"] })).toBe(
      true,
    );
    expect(await fix(f)).toBeUndefined();
    expect(f.learnEvents()).toEqual(["proposed", "rejected"]);
  });

  test("Learn writes the entry and accepted, Undo takes it back out; the box goes after the Undo line", async () => {
    const f = box();
    const c = await fix(f);
    if (!c) throw new Error("no chip");
    await f.b.handlers.chip({ id: c.id, action: "learn", terms: ["Kubernetes"] });
    expect(f.learned).toEqual(["+cooper netties>Kubernetes"]);
    expect(f.learnEvents()).toEqual(["proposed", "accepted"]);
    await f.b.handlers.chip({ id: c.id, action: "undo" });
    expect(f.learned).toEqual(["+cooper netties>Kubernetes", "-cooper netties>Kubernetes"]);
    expect(f.learnEvents()).toEqual(["proposed", "accepted", "ignored"]);
    expect(f.calls.at(-1)).toBe("hide");

    // Without Undo the box waits for the Undo line's time, then goes.
    const g = box();
    const d = await fix(g);
    if (!d) throw new Error("no chip");
    await g.b.handlers.chip({ id: d.id, action: "learn", terms: ["Kubernetes"] });
    expect(g.calls.at(-1)).not.toBe("hide");
    g.timers.run(LEARNED_MS);
    expect(g.calls.at(-1)).toBe("hide");
  });

  test("with dictation.learn auto the entry is written before the chip, which offers only Undo", async () => {
    const f = box({ learnMode: () => "auto" });
    const c = await fix(f);
    expect(f.learned).toEqual(["+cooper netties>Kubernetes"]);
    expect(c).toMatchObject({ mode: "learned", candidates: [{ term: "Kubernetes" }] });
    expect(f.learnEvents()).toEqual(["proposed", "accepted"]);

    // A new draft while the Undo line is up leaves the line its own time, then the box goes.
    const b = f.dictation();
    f.b.open(b, { focus: true });
    await f.b.handlers.discard({ id: b });
    expect(f.calls.at(-1)).not.toBe("hide");
    f.timers.run(LEARNED_MS);
    expect(f.calls.at(-1)).toBe("hide");
  });

  test("the ask rule: first, third, never after a no", () => {
    expect(shouldAsk(undefined)).toBe(true);
    expect([0, 1, 2, 3].map((proposed) => shouldAsk({ proposed, rejected: false }))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(shouldAsk({ proposed: 0, rejected: true })).toBe(false);
    const h = pairHistory([
      { type: "dictation.learn", heard: "Cooper Netties", term: "kubernetes", status: "proposed" },
      { type: "dictation.learn", heard: "cooper netties", term: "Kubernetes", status: "rejected" },
      { type: "dictation.text" },
    ]);
    expect([...h.values()]).toEqual([{ proposed: 1, rejected: true }]);
  });
});

describe("DC-L6: a learned pair in the vocabulary file", () => {
  const pair = { term: "Vercel", heard: "versal", id: "d1" };

  test("Learn writes a dictation-scoped entry, and Undo removes the entry it made", () => {
    const learned = learnPair(emptyVocab(), pair, "2026-09-27");
    expect(learned.entries).toEqual([
      {
        term: "Vercel",
        heard: ["versal"],
        source: "dictation:d1",
        confirmed: true,
        added_at: "2026-09-27",
        entryScope: "dictation",
      },
    ]);
    // A second heard form joins the same entry; Undo of it leaves the first.
    const two = learnPair(learned, { ...pair, heard: "ver sell", id: "d2" }, "2026-09-28");
    expect(two.entries[0]?.heard).toEqual(["versal", "ver sell"]);
    expect(unlearnPair(two, { ...pair, heard: "ver sell", id: "d2" }).entries[0]?.heard).toEqual([
      "versal",
    ]);
    expect(unlearnPair(learned, pair).entries).toEqual([]);
    const merged = learned.entries as MergedEntry[];
    expect(knowsPair(merged, "Versal", "vercel")).toBe(true);
    expect(knowsPair(merged, "versel", "Vercel")).toBe(false);
  });

  test("a word the file holds for calls is refused, so a dictation fix never reaches calls", () => {
    const calls = {
      ...emptyVocab(),
      entries: [
        { term: "Vercel", heard: [], source: "user", confirmed: true, added_at: "2026-01-01" },
      ],
    };
    expect(() => learnPair(calls, pair, "2026-09-27")).toThrow(/word for calls too/);
  });
});

describe("DC-S1: the shell's draft window", () => {
  test("it opens hidden while dictation runs, shows without the keyboard for an automatic open, and closes with dictation off", async () => {
    const f = fakeUi();
    let state = "idle";
    let fire: () => void = () => {};
    const attached: (unknown | null)[] = [];
    const opened: { url: string; handlers: DraftHandlers }[] = [];
    const calls: string[] = [];
    const sent: string[] = [];
    f.ui.openDraft = (o) => {
      opened.push(o);
      return {
        window: {
          show: () => calls.push("show"),
          showInactive: () => calls.push("showInactive"),
          hide: () => calls.push("hide"),
          close: () => calls.push("close"),
          onClose: () => {},
        },
        send: {
          open: (d) => sent.push(`open ${d.id}`),
          chip: (c) => sent.push(`chip ${c.id}`),
        },
      };
    };
    const handlers = {} as DraftHandlers;
    const got: { w: Parameters<DraftBox["attach"]>[0] } = { w: null };
    const app: ShellApp = {
      status: async () => ({ live: null, share: { active: false } }),
      start: async () => ({ ok: true, call: "c1" }),
      stopLive: async () => {},
      config: () => ({ settings: { "app.hotkey": "", "app.openAtLogin": false } }),
      saveSetting: async () => {},
      quit: async () => {},
      openSettingsPane: async () => false,
      openWindow: async () => {},
      onAnnounce: () => () => {},
      dictation: {
        state: () => state,
        status: () => ({ state, loading: false, swallow_keys: true }),
        control: async () => true,
        watch: (fn) => {
          fire = fn;
          return () => {};
        },
        follow: () => () => {},
        hotkey: () => "RightCommand",
        draft: () => ({
          handlers,
          attach: (w) => {
            attached.push(w);
            got.w = w;
          },
        }),
      },
    };
    const shell = new Shell(
      app,
      { watchLifecycle: () => () => {}, app: { watch: () => () => {} } } as unknown as Bridge,
      f.ui,
      {
        platform: "darwin",
        setLoginItem: async () => {},
      },
    );
    cleanups.push(() => shell.close());
    await shell.start();
    expect(opened.map((o) => o.url)).toEqual(["views://draft/index.html"]);
    expect(opened[0]?.handlers).toBe(handlers);
    expect(calls).toEqual([]);
    const d = { id: "d1", text: "t", engine: "fast", ms: 1, engines: [], platform: "darwin" };
    got.w?.open({ ...d, focus: false });
    got.w?.open({ ...d, id: "d2", focus: true });
    expect(calls).toEqual(["showInactive", "show"]);
    expect(sent).toEqual(["open d1", "open d2"]);
    state = "off";
    fire();
    expect(calls.at(-1)).toBe("close");
    expect(attached.at(-1)).toBeNull();
  });
});
