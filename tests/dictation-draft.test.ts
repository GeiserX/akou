/**
 * The draft box's main side (docs/ux/DICTATION.md DC-S1, DC-L1, DC-L4, DC-L6): what each key of
 * the box does, when the offer to learn a word is put to the user, what its answers write, and the
 * shell's window for it. Over a real dictation log with a fake session, a fake window and timers
 * run by hand; no window, key, device or clipboard is touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { DictationDraft } from "../src/core/dictation/events.ts";
import { pairHistory, shouldAsk } from "../src/core/dictation/learn.ts";
import {
  ALT_MAX_WORDS,
  alternatives,
  DraftBox,
  type DraftBoxOptions,
  LEARNED_MS,
  type RetryReading,
} from "../src/main/dictation/draft.ts";
import type { InsertOutcome } from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import { knowsPair, learnPair, unlearnPair } from "../src/main/dictation/vocab.ts";
import { emptyVocab, type MergedEntry } from "../src/main/vocab/files.ts";
import type { Bridge } from "../src/main/window/bridge.ts";
import { type DraftHandlers, Shell, type ShellApp } from "../src/main/window/shell.ts";
import type { DraftOpen } from "../src/ui/dictation-protocol.ts";
import type { Chip } from "../src/ui/pill-protocol.ts";
import { until } from "./capture-helpers.ts";
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
  const appended: string[] = [];
  const calls: string[] = [];
  const timers = manualLater();
  const session = {
    insertText: async (id: string, text: string, _t: unknown, sendKey: string) => {
      inserts.push({ id, text, sendKey });
      const out = o.outcome ?? { ok: true, method: "paste", receipt_ms: 5 };
      if (out.ok) log.append({ type: "dictation.inserted", id, method: "paste", receipt_ms: 5 });
      return out;
    },
    copyText: async (text: string) => {
      copies.push(text);
      return { ok: true, method: "clipboard", receipt_ms: 0 } as InsertOutcome;
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
    append: (text) => appended.push(text),
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
    appended,
    calls,
    timers,
    dictation,
    learnEvents,
  };
}

describe("DC-U6: the box shows what was heard beside the AI tidy's text", () => {
  /** A drafted dictation the engine heard as `raw` and akou wrote as `text`. */
  const drafted = (f: ReturnType<typeof box>, id: string, text: string, formatted: boolean) => {
    f.log.append({ type: "dictation.started", id, target: TARGET, engine: "fast", by: "user" });
    f.log.append({ type: "dictation.ended", id, reason: "release", seconds: 2 });
    f.log.append({
      type: "dictation.text",
      id,
      raw: "um three apples",
      text,
      language: "en",
      words: [],
      engine: "fast",
      model: "parakeet",
      ms: 80,
      ...(formatted ? { formatted: true } : {}),
    });
    f.log.append({ type: "dictation.drafted", id, reason: "focus-changed" });
  };

  test("a tidied dictation opens with what the engine heard; one the tidy did not write, without", () => {
    const f = box();
    drafted(f, "t1", "Three apples.", true);
    f.b.open("t1", { focus: false });
    expect(f.opens.at(-1)).toMatchObject({ text: "Three apples.", heard: "um three apples" });
    // The control: fillers and spoken punctuation change the text too, with no tidy.
    drafted(f, "t2", "three apples", false);
    f.b.open("t2", { focus: false });
    expect(f.opens.at(-1)?.text).toBe("three apples");
    expect(f.opens.at(-1)?.heard).toBeUndefined();
  });
});

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

  test("the box hears the audio's length, its language and where the engine ran; a remote retry is not local", async () => {
    const f = box({
      retry: async () => ({
        ok: true,
        answer: { text: FIXED, words: [], engine: "remote", model: null, ms: 400 },
      }),
    });
    const a = f.dictation();
    f.b.open(a, { focus: false });
    expect(f.opens.at(-1)).toMatchObject({ seconds: 2, language: "en", local: true });
    expect(await f.b.handlers.retry({ id: a, engine: "remote" })).toBe(true);
    expect(f.opens.at(-1)).toMatchObject({
      engine: "remote",
      local: false,
      seconds: 2,
      language: "en",
    });
  });

  test("a draft answered while its retry decodes is not shown again, so it is never inserted twice", async () => {
    let decoded: () => void = () => {};
    const f = box({
      retry: () =>
        new Promise((done) => {
          decoded = () =>
            done({
              ok: true,
              answer: { text: FIXED, words: [], engine: "best", model: "q", ms: 9 },
            });
        }),
    });
    const a = f.dictation();
    f.b.open(a, { focus: true });
    const retried = f.b.handlers.retry({ id: a, engine: "best" });
    // Enter with a fix: the chip keeps the box on this dictation while the retry decodes.
    expect(await f.b.handlers.insert({ id: a, text: FIXED, send: false })).toBe(true);
    expect(f.chips).toHaveLength(1);
    const opens = f.opens.length;
    decoded();
    expect(await retried).toBe(false);
    expect(f.opens).toHaveLength(opens);
    expect(await f.b.handlers.insert({ id: a, text: FIXED, send: false })).toBe(false);
    expect(f.inserts).toHaveLength(1);
  });

  test("a draft left unanswered when another opens over it closes its learn window", async () => {
    const closed: string[] = [];
    const f = box({ closeLearnWindow: (id) => closed.push(id) });
    const a = f.dictation();
    f.b.open(a, { focus: false });
    f.b.open(a, { focus: true });
    expect(closed).toEqual([]);
    const b = f.dictation();
    f.b.open(b, { focus: false });
    expect(closed).toEqual([a]);
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

describe("DC-A4: a dictation made while the box has the keyboard", () => {
  test("goes into the open draft only while the page says the box has the keyboard", async () => {
    const f = box();
    const a = f.dictation();
    const m = f.dictation("more");
    expect(f.b.takesDictation()).toBe(false);
    f.b.open(a, { focus: true });
    expect(f.b.append(m, "more")).toBe(false);
    expect(await f.b.handlers.focused({ on: true })).toBe(true);
    expect(f.b.takesDictation()).toBe(true);
    expect(f.b.append(m, "more")).toBe(true);
    expect(f.appended).toEqual(["more"]);
    await f.b.handlers.focused({ on: false });
    expect(f.b.append(m, "again")).toBe(false);
    // Answered (inserted), the box takes no more even with the keyboard.
    await f.b.handlers.focused({ on: true });
    await f.b.handlers.insert({ id: a, text: `${HEARD} more`, send: false });
    expect(f.b.append(m, "late")).toBe(false);
    expect(f.appended).toEqual(["more"]);
  });

  const MORE = "and then send the notes to the whole group";

  /** A box on a draft with dictation `MORE` appended to it while it had the keyboard. */
  const appended = async (o: Partial<DraftBoxOptions> & { outcome?: InsertOutcome } = {}) => {
    const f = box(o);
    const a = f.dictation();
    const m = f.dictation(MORE);
    f.b.open(a, { focus: true });
    await f.b.handlers.focused({ on: true });
    expect(f.b.append(m, MORE)).toBe(true);
    const state = () => f.log.item(m)?.state;
    return { f, a, m, state };
  };

  test("an appended dictation is inserted with the draft, and its words are no fix to learn", async () => {
    const { f, a, state } = await appended();
    expect(state()).toBe("drafted");
    await f.b.handlers.insert({ id: a, text: `${HEARD} ${MORE}`, send: false });
    expect(state()).toBe("inserted");
    expect(f.learnEvents()).toEqual([]);
    expect(f.chips).toEqual([]);
  });

  test("positive control: a fix in a draft with appended text is still proposed, and only it", async () => {
    const { f, a } = await appended();
    await f.b.handlers.insert({ id: a, text: `${FIXED} ${MORE}`, send: false });
    expect(f.chips).toEqual([
      { id: a, candidates: [{ term: "Kubernetes", heard: "cooper netties" }], mode: "ask" },
    ]);
  });

  test("Escape discards the appended dictation with the draft", async () => {
    const { f, a, state } = await appended();
    expect(await f.b.handlers.discard({ id: a })).toBe(true);
    expect(f.log.item(a)?.state).toBe("discarded");
    expect(state()).toBe("discarded");
  });

  test("a Retry's reading replaces the field, so the appended dictation is discarded", async () => {
    const { f, a, state } = await appended();
    expect(await f.b.handlers.retry({ id: a, engine: "best" })).toBe(true);
    expect(state()).toBe("discarded");
    expect(f.log.item(a)?.state).toBe("drafted");
  });

  test("a refused insert reopens the draft with the appended dictation still in it", async () => {
    const { f, a, state } = await appended({ outcome: { ok: false, reason: "focus-changed" } });
    expect(await f.b.handlers.insert({ id: a, text: `${HEARD} ${MORE}`, send: false })).toBe(false);
    expect(state()).toBe("drafted");
    expect(await f.b.handlers.discard({ id: a })).toBe(true);
    expect(state()).toBe("discarded");
  });
});

describe("akou-5v8: the draft box's language chip", () => {
  /** A box whose retry answers in the language asked for, recording each ask. */
  const bilingual = (o: Partial<DraftBoxOptions> = {}) => {
    const asked: { engine: string; language: string | undefined }[] = [];
    const f = box({
      languages: () => ["en", "es"],
      retry: async (_id, engine, language) => {
        asked.push({ engine, language });
        return {
          ok: true,
          answer: {
            text: language === "es" ? "dile al equipo" : "tell the team",
            language: language ?? "en",
            words: [],
            engine,
            model: "q",
            ms: 12,
          },
        };
      },
      ...o,
    });
    return { ...f, asked };
  };

  test("a click decodes the same audio again in the next language, on an engine that takes one, and the text is replaced", async () => {
    const f = bilingual();
    const a = f.dictation();
    f.b.open(a, { focus: false });
    // The reading came from fast, which picks its own language: the switch runs on best.
    expect(f.opens.at(-1)).toMatchObject({ language: "en", languageSwitch: true });
    expect(f.opens.at(-1)?.languageForced).toBeUndefined();
    expect(await f.b.handlers.language({ id: a })).toBe(true);
    expect(f.asked).toEqual([{ engine: "best", language: "es" }]);
    expect(f.opens.at(-1)).toMatchObject({
      id: a,
      text: "dile al equipo",
      language: "es",
      languageForced: true,
      languageSwitch: true,
      engine: "best (q)",
      focus: true,
    });
    // The next click goes round to the first language, on the reading's own engine.
    expect(await f.b.handlers.language({ id: a })).toBe(true);
    expect(f.asked[1]).toEqual({ engine: "best", language: "en" });
    expect(f.opens.at(-1)).toMatchObject({ text: "tell the team", language: "en" });
    // Enter inserts the reading shown, and the edit is diffed against it, not the first one.
    expect(await f.b.handlers.insert({ id: a, text: "tell the team", send: false })).toBe(true);
    expect(f.inserts).toEqual([{ id: a, text: "tell the team", sendKey: "none" }]);
    expect(f.learnEvents()).toEqual([]);
  });

  test("positive controls: one language, or no engine that takes a forced one, leaves the chip read-only", async () => {
    const one = bilingual({ languages: () => ["en"] });
    const a = one.dictation();
    one.b.open(a, { focus: false });
    expect(one.opens.at(-1)?.language).toBe("en");
    expect(one.opens.at(-1)?.languageSwitch).toBeUndefined();
    expect(await one.b.handlers.language({ id: a })).toBe(false);

    const fastOnly = bilingual({ engines: () => ["fast"] });
    const b = fastOnly.dictation();
    fastOnly.b.open(b, { focus: false });
    expect(fastOnly.opens.at(-1)?.languageSwitch).toBeUndefined();
    expect(await fastOnly.b.handlers.language({ id: b })).toBe(false);
    expect([...one.asked, ...fastOnly.asked]).toEqual([]);
  });

  test("a draft answered while the switch decodes is not shown again", async () => {
    let decoded: () => void = () => {};
    const f = bilingual({
      retry: () =>
        new Promise((res) => {
          decoded = () =>
            res({
              ok: true,
              answer: {
                text: "hola",
                language: "es",
                words: [],
                engine: "best",
                model: null,
                ms: 1,
              },
            });
        }),
    });
    const a = f.dictation();
    f.b.open(a, { focus: false });
    const switched = f.b.handlers.language({ id: a });
    expect(await f.b.handlers.discard({ id: a })).toBe(true);
    decoded();
    expect(await switched).toBe(false);
    expect(f.opens).toHaveLength(1);
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

  test("with a warm Qwen the audio check confirms the fix on the dictation's audio", async () => {
    const asked: { id: string; glossary: readonly string[] }[] = [];
    const f = box({
      recheck: (id) => async (glossary) => {
        asked.push({ id, glossary });
        return "tell the Kubernetes team";
      },
    });
    const a = f.dictation();
    f.b.open(a, { focus: true });
    await f.b.handlers.insert({ id: a, text: FIXED, send: false });
    expect(asked).toEqual([{ id: a, glossary: ["Kubernetes"] }]);
    expect(f.log.events().filter((e) => e.type === "dictation.learn")).toEqual([
      expect.objectContaining({ term: "Kubernetes", status: "proposed", evidence: "audio" }),
    ]);
    expect(f.chips).toHaveLength(1);
  });

  test("positive control: an audio check that still hears the heard form proposes nothing", async () => {
    const f = box({ recheck: () => async () => HEARD });
    const a = f.dictation();
    f.b.open(a, { focus: true });
    await f.b.handlers.insert({ id: a, text: FIXED, send: false });
    expect(f.learnEvents()).toEqual([]);
    expect(f.chips).toEqual([]);
    // The insert went in all the same.
    expect(f.inserts.map((i) => i.text)).toEqual([FIXED]);
  });

  test("the insert does not wait for the audio check; the chip comes once the check is done", async () => {
    let answer: (text: string) => void = () => {};
    const f = box({
      recheck: () => () =>
        new Promise<string>((res) => {
          answer = res;
        }),
    });
    const a = f.dictation();
    f.b.open(a, { focus: true });
    const done = f.b.handlers.insert({ id: a, text: FIXED, send: false });
    await until(() => f.inserts.length === 1, 2000, "the insert");
    expect(f.chips).toEqual([]);
    answer(FIXED);
    expect(await done).toBe(true);
    expect(f.chips).toHaveLength(1);
  });

  test("a draft opened during the audio check keeps its learn window; the answered one's closes", async () => {
    let answer: (text: string) => void = () => {};
    const closed: string[] = [];
    const f = box({
      closeLearnWindow: (id) => closed.push(id),
      recheck: () => () =>
        new Promise<string>((res) => {
          answer = res;
        }),
    });
    const a = f.dictation();
    f.b.open(a, { focus: true });
    const done = f.b.handlers.insert({ id: a, text: FIXED, send: false });
    await until(() => f.inserts.length === 1, 2000, "the insert");
    const b = f.dictation();
    f.b.open(b, { focus: true });
    // The check still hears the heard form: no chip, so the answered draft's window closes now.
    answer(HEARD);
    expect(await done).toBe(true);
    expect(closed).toEqual([a]);
    expect(f.b.holding()).toBe(b);
  });

  test("a refused insert reopens the box without waiting for the audio check", async () => {
    let answer: (text: string) => void = () => {};
    const f = box({
      outcome: { ok: false, reason: "focus-changed" },
      recheck: () => () =>
        new Promise<string>((res) => {
          answer = res;
        }),
    });
    const a = f.dictation();
    f.b.open(a, { focus: true });
    const done = f.b.handlers.insert({ id: a, text: FIXED, send: false });
    await until(() => f.opens.length === 2, 2000, "the box to reopen");
    expect(f.opens[1]).toMatchObject({ id: a, text: FIXED, focus: false });
    answer(FIXED);
    expect(await done).toBe(false);
    expect(f.chips).toHaveLength(1);
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

  test("a refused Learn, a failed Undo or a failed learn step logs no dictated word", async () => {
    const quoting = () =>
      new Error('"Kubernetes" is a word for calls too: add "cooper netties" to it');
    const logs: string[] = [];
    const onLog = (_level: string, msg: string) => logs.push(msg);

    const f = box({ onLog, learnEntry: async () => Promise.reject(quoting()) });
    const c = await fix(f);
    if (!c) throw new Error("no chip");
    await f.b.handlers.chip({ id: c.id, action: "learn", terms: ["Kubernetes"] });

    const g = box({ onLog, unlearnEntry: async () => Promise.reject(quoting()) });
    const d = await fix(g);
    if (!d) throw new Error("no chip");
    await g.b.handlers.chip({ id: d.id, action: "learn", terms: ["Kubernetes"] });
    await g.b.handlers.chip({ id: d.id, action: "undo" });

    const h = box({
      onLog,
      commonWords: () => {
        throw quoting();
      },
    });
    expect(await fix(h)).toBeUndefined();

    // Each path logged once, so the check below looked at real lines.
    expect(logs.map((m) => m.replace(/^dictation d\d+: /, ""))).toEqual([
      "a word was not learned (Error)",
      "undo failed (Error)",
      "no learning (Error)",
    ]);
    for (const m of logs) expect(m).not.toMatch(/kubernetes|cooper|netties/i);
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
          append: () => {},
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

describe("DC-S1, akou-w51.81: the other engine's reading under an unsure word", () => {
  test("each word of a stretch the two readings heard differently gets the other's words there", () => {
    expect(
      alternatives(["ship", "it", "to", "grafanna", "today"], "Ship it to Grafana today."),
    ).toEqual([undefined, undefined, undefined, "Grafana", undefined]);
    // A stretch of two words heard as one: both carry it, so the page marks them as one.
    expect(
      alternatives(["tell", "the", "cooper", "netties", "team"], "tell the Kubernetes team"),
    ).toEqual([undefined, undefined, "Kubernetes", "Kubernetes", undefined]);
    // A word only one reading has is offered nothing: there is nothing to put in its place.
    expect(alternatives(["deploy", "it", "now"], "deploy now")).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // Positive control: readings that agree, bar case and punctuation, offer nothing.
    expect(alternatives(["Hello,", "world"], "hello world!")).toEqual([undefined, undefined]);
    // Past the cap nothing is compared.
    const long = Array.from({ length: ALT_MAX_WORDS + 1 }, () => "a");
    expect(alternatives(long, "b").every((x) => x === undefined)).toBe(true);
  });

  /** A dictation `best` read as text only, as its engine gives no words, drafted by the guard. */
  const bestDictation = (f: ReturnType<typeof box>, text: string, language = "en") => {
    const id = "b1";
    f.log.append({ type: "dictation.started", id, target: TARGET, engine: "best", by: "user" });
    f.log.append({ type: "dictation.ended", id, reason: "release", seconds: 2 });
    f.log.append({
      type: "dictation.text",
      id,
      raw: text,
      text,
      language,
      words: [],
      engine: "best",
      model: "qwen",
      ms: 300,
    });
    f.log.append({ type: "dictation.drafted", id, reason: "focus-changed" });
    return id;
  };
  /** `fast`'s reading of the same audio: unsure of `grafanna`. */
  const fastReading = (language: string | null = "en"): RetryReading => ({
    text: "ship it to grafanna today",
    language,
    words: [
      { w: "ship", s: 0, e: 0.3, c: 0.97 },
      { w: "it", s: 0.3, e: 0.4, c: 0.95 },
      { w: "to", s: 0.4, e: 0.5, c: 0.93 },
      { w: "grafanna", s: 0.5, e: 1, c: 0.21 },
      { w: "today", s: 1, e: 1.4, c: 0.9 },
    ],
    engine: "fast",
    model: "parakeet",
    ms: 40,
  });
  const altsOf = (d: DraftOpen | undefined) =>
    (d?.words ?? []).filter((w) => w.alt).map((w) => [w.w, w.alt]);

  test("a retry on another engine sends each word what the first reading heard there", async () => {
    const f = box({ retry: async () => ({ ok: true, answer: fastReading() }) });
    const id = bestDictation(f, "Ship it to Grafana today.");
    f.b.open(id, { focus: false });
    expect(f.opens.at(-1)?.words).toEqual([]);
    expect(await f.b.handlers.retry({ id, engine: "fast" })).toBe(true);
    const shown = f.opens.at(-1);
    expect(shown?.text).toBe("ship it to grafanna today");
    expect(altsOf(shown)).toEqual([["grafanna", ["Grafana"]]]);
    expect(shown?.words?.find((w) => w.w === "grafanna")?.c).toBe(0.21);
  });

  test("the error's Retry on another engine opens the box with the first reading as the other", () => {
    const f = box();
    const id = bestDictation(f, "Ship it to Grafana today.");
    expect(f.b.open(id, { focus: true, reading: fastReading() })).toEqual({ ok: true });
    expect(altsOf(f.opens.at(-1))).toEqual([["grafanna", ["Grafana"]]]);
  });

  test("positive controls: the same engine again, or a reading in another language, offers nothing", async () => {
    const same = box({
      retry: async () => ({ ok: true, answer: { ...fastReading(), engine: "fast" } }),
    });
    const a = same.dictation("ship it to Grafana today");
    same.b.open(a, { focus: false });
    expect(await same.b.handlers.retry({ id: a, engine: "fast" })).toBe(true);
    expect(same.opens.at(-1)?.text).toBe("ship it to grafanna today");
    expect(altsOf(same.opens.at(-1))).toEqual([]);

    const other = box({ retry: async () => ({ ok: true, answer: fastReading("es") }) });
    const b = bestDictation(other, "Ship it to Grafana today.", "en");
    other.b.open(b, { focus: false });
    expect(await other.b.handlers.retry({ id: b, engine: "fast" })).toBe(true);
    expect(altsOf(other.opens.at(-1))).toEqual([]);
  });

  test("a refused insert reopens the user's text with no words, and a later retry still compares", async () => {
    let n = 0;
    const f = box({
      outcome: { ok: false, reason: "the target is gone" },
      retry: async () => {
        n++;
        return { ok: true, answer: fastReading() };
      },
    });
    const id = bestDictation(f, "Ship it to Grafana today.");
    f.b.open(id, { focus: false });
    await f.b.handlers.retry({ id, engine: "fast" });
    await f.b.handlers.insert({ id, text: "ship it to Grafana today", send: false });
    expect(f.opens.at(-1)?.text).toBe("ship it to Grafana today");
    expect(f.opens.at(-1)?.words).toEqual([]);
    expect(await f.b.handlers.retry({ id, engine: "fast" })).toBe(true);
    // The box read fast already, and before it best: the same engine again keeps best as the other.
    expect(altsOf(f.opens.at(-1))).toEqual([["grafanna", ["Grafana"]]]);
    expect(n).toBe(2);
  });
});
