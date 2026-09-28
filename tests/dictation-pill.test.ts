/**
 * The dictation pill's main side (docs/ux/DICTATION.md section 5.1, DC-O1, DC-O2, DC-D2): what the
 * page is told for each state of a session, the window's no-focus style per OS, where it opens,
 * and that no message ever carries the dictated words. The shell runs over the fake `NativeUi`;
 * the whole-app case runs the fake helper, so no window, key, device or clipboard is touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DictationDraft, DictationEvent } from "../src/core/dictation/events.ts";
import { LEARNED_MS } from "../src/main/dictation/learner.ts";
import type { DictationFollow } from "../src/main/dictation/service.ts";
import { MAX_WARNING } from "../src/main/dictation/session.ts";
import { Bridge } from "../src/main/window/bridge.ts";
import { hotkeyLabel } from "../src/main/window/hotkey.ts";
import {
  AUTO_LANGUAGE,
  BUSY_MS,
  BUSY_NOTE,
  CHIP_WAIT_MS,
  DONE_MS,
  ERROR_MS,
  LOADING_NOTE,
  levelDb,
  type PillDictation,
  type PillSend,
  pillRpc,
  settledWords,
} from "../src/main/window/pill.ts";
import {
  appForShell,
  DRAFT_SIZE,
  type NativeUi,
  PILL_SIZE,
  type PillStyle,
  placeDraft,
  placePill,
  type Rect,
  Shell,
  type ShellApp,
  type ShellState,
} from "../src/main/window/shell.ts";
import { fileState } from "../src/main/window/state.ts";
import type { Chip, ChipAnswer, PillState } from "../src/ui/pill-protocol.ts";
import { type AppRig, appRig, FAKE_MODELS, type RigOptions } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";
import { fakeUi } from "./shell-helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const TARGET = { app: "com.example.editor", pid: 1, window: "w1", field: "editable" } as const;

/** A dictation the pill follows, driven by hand: its state, its log events and its levels. */
function fakeDictation() {
  const st = { state: "idle", loading: false, swallow_keys: true as boolean | null };
  const followers = new Set<(m: DictationFollow) => void>();
  const controls: string[] = [];
  /** Whether each follower asked for partials (DC-E5). */
  const wantsPartials: boolean[] = [];
  /** The languages the chip moves between, and the ones it forced (akou-5v8). */
  const choice = {
    languages: ["en", "es"] as readonly string[],
    switchable: true,
    language: null as string | null,
  };
  const forced: string[] = [];
  let seq = 0;
  const d: PillDictation = {
    status: () => ({ ...st }),
    follow: (fn, o) => {
      followers.add(fn);
      wantsPartials.push(o?.partials?.() === true);
      return () => followers.delete(fn);
    },
    control: async (a) => {
      controls.push(a);
      return true;
    },
    languageChoice: () => choice,
    setLanguage: (l) => {
      forced.push(l);
      return st.state === "listening";
    },
  };
  const tell = (m: DictationFollow) => {
    for (const fn of followers) fn(m);
  };
  const event = (draft: DictationDraft) =>
    tell({ kind: "event", e: { ...draft, v: 1, seq: ++seq, t: seq } as DictationEvent });
  return { d, st, controls, tell, event, followers, wantsPartials, choice, forced };
}

/** A recording page: every message the main side sent it, in order. */
function recorder() {
  const sent: { name: string; payload: unknown }[] = [];
  const send: PillSend = {
    state: (s) => sent.push({ name: "state", payload: s }),
    level: (l) => sent.push({ name: "level", payload: l }),
    preview: (p) => sent.push({ name: "preview", payload: p }),
    chip: (c) => sent.push({ name: "chip", payload: c }),
  };
  const states = () => sent.filter((m) => m.name === "state").map((m) => m.payload as PillState);
  return { sent, send, states };
}

/** Timers run by hand, so no test waits on a clock. */
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
    /** Runs every live timer of `ms`. */
    run: (ms: number) => {
      for (const t of due.splice(0)) if (t.live && t.ms === ms) t.fn();
    },
    pending: () => due.filter((t) => t.live).map((t) => t.ms),
  };
}

function pill(o: { preview?: unknown; platform?: string } = {}) {
  const f = fakeDictation();
  const r = recorder();
  const t = manualLater();
  const visible: boolean[] = [];
  const p = pillRpc(f.d, () => r.send, {
    platform: o.platform ?? "darwin",
    hotkey: () => "RightCommand",
    label: hotkeyLabel,
    now: () => 1000,
    onVisible: (v) => visible.push(v),
    preview: { setting: () => o.preview ?? false },
    later: t.later,
  });
  cleanups.push(() => p.close());
  const to = (state: string) => {
    f.st.state = state;
    p.update();
  };
  return { ...f, ...r, t, p, visible, to };
}

/** A spoken dictation through the log, as the session writes it. */
function spoken(f: ReturnType<typeof pill>, id: string) {
  f.event({ type: "dictation.started", id, target: TARGET, engine: "fast", by: "user" });
  f.event({ type: "dictation.ended", id, reason: "release", seconds: 2 });
}

describe("DC-O1: the pill's states from the session", () => {
  test("listening, transcribing, inserted, then hidden once its time is up", async () => {
    const f = pill();
    f.to("listening");
    expect(f.states().at(-1)).toEqual({
      state: "listening",
      since: 1000,
      keys: ["escape", "enter", "shift-enter"],
      hotkey: "Right ⌘",
      language: { tag: AUTO_LANGUAGE, switchable: true, forced: false },
    });
    expect(f.visible.at(-1)).toBe(true);
    spoken(f, "d1");
    f.to("transcribing");
    f.to("inserting");
    // One transcribing state across the decode and the insert: the clock does not restart.
    expect(f.states().filter((s) => s.state === "transcribing")).toHaveLength(1);
    f.event({ type: "dictation.inserted", id: "d1", method: "paste", receipt_ms: 5 });
    f.to("idle");
    expect(f.states().at(-1)).toEqual({ state: "done", how: "inserted" });
    expect(f.visible.at(-1)).toBe(true);
    expect(f.t.pending()).toEqual([DONE_MS]);
    f.t.run(DONE_MS);
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
    expect(f.visible.at(-1)).toBe(false);
    // The page that boots late pulls what shows now.
    expect(await f.p.handlers.state({})).toEqual({ state: "hidden" });
  });

  test("a key source that cannot hold keys gets only the dictation key's hint", () => {
    const f = pill({ platform: "linux" });
    f.st.swallow_keys = false;
    f.to("listening");
    expect(f.states().at(-1)).toMatchObject({ keys: [], hotkey: "Right Win" });
  });

  test("the dictation key pressed while transcribing flashes still transcribing (DC-A4)", () => {
    const f = pill();
    f.to("listening");
    f.st.loading = true;
    f.to("transcribing");
    f.tell({ kind: "busy" });
    expect(f.states().at(-1)).toEqual({ state: "transcribing", since: 1000, note: BUSY_NOTE });
    f.t.run(BUSY_MS);
    // Back to the line it had, with the clock it had.
    expect(f.states().at(-1)).toEqual({ state: "transcribing", since: 1000, note: LOADING_NOTE });
  });

  test("a busy press with nothing transcribing shows nothing", () => {
    const f = pill();
    f.to("listening");
    const before = f.states().length;
    f.tell({ kind: "busy" });
    expect(f.states()).toHaveLength(before);
  });

  test("one minute before dictation.maxMinutes, listening says so under the hints (DC-A3)", () => {
    const f = pill();
    f.to("listening");
    f.tell({ kind: "warning", note: MAX_WARNING });
    expect(f.states().at(-1)).toEqual({
      state: "listening",
      since: 1000,
      keys: ["escape", "enter", "shift-enter"],
      hotkey: "Right ⌘",
      language: { tag: AUTO_LANGUAGE, switchable: true, forced: false },
      note: MAX_WARNING,
    });
    // Positive control: a warning with nothing listening shows nothing.
    f.to("transcribing");
    const before = f.states().length;
    f.tell({ kind: "warning", note: MAX_WARNING });
    expect(f.states()).toHaveLength(before);
  });

  test("the engine still loading at the release says so under transcribing", () => {
    const f = pill();
    f.to("listening");
    f.st.loading = true;
    f.to("transcribing");
    expect(f.states().at(-1)).toEqual({ state: "transcribing", since: 1000, note: LOADING_NOTE });
  });

  test("a fallback's notice and a clipboard-only insert's paste hint", () => {
    const f = pill();
    f.to("listening");
    spoken(f, "d1");
    f.to("transcribing");
    f.tell({ kind: "notice", id: "d1", notice: "best failed, used fast" });
    f.event({ type: "dictation.inserted", id: "d1", method: "paste", receipt_ms: 5 });
    expect(f.states().at(-1)).toEqual({
      state: "done",
      how: "inserted",
      note: "best failed, used fast",
    });
    f.to("idle");
    f.to("listening");
    spoken(f, "d2");
    f.to("transcribing");
    f.event({ type: "dictation.inserted", id: "d2", method: "clipboard", receipt_ms: 0 });
    expect(f.states().at(-1)).toEqual({ state: "done", how: "copied", note: "⌘V" });
  });

  test("a failure shows its message for its time; empty and cancelled hide at once", () => {
    const f = pill();
    f.to("listening");
    spoken(f, "d1");
    f.to("transcribing");
    f.event({ type: "dictation.failed", id: "d1", error: "insert: focus-changed" });
    f.to("idle");
    expect(f.states().at(-1)).toEqual({
      state: "error",
      message: "insert: focus-changed",
      actions: [],
    });
    expect(f.t.pending()).toEqual([ERROR_MS]);
    f.t.run(ERROR_MS);
    expect(f.states().at(-1)).toEqual({ state: "hidden" });

    f.to("listening");
    spoken(f, "d2");
    f.to("transcribing");
    f.event({ type: "dictation.empty", id: "d2" });
    f.to("idle");
    expect(f.states().at(-1)).toEqual({ state: "hidden" });

    f.to("listening");
    spoken(f, "d3");
    f.event({ type: "dictation.cancelled", id: "d3" });
    f.to("idle");
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
  });

  test("a new press drops the last outcome at once, and its timer can no longer hide the pill", () => {
    const f = pill();
    f.to("listening");
    spoken(f, "d1");
    f.to("transcribing");
    f.event({ type: "dictation.inserted", id: "d1", method: "paste", receipt_ms: 5 });
    f.to("idle");
    f.to("listening");
    f.t.run(DONE_MS);
    expect(f.states().at(-1)?.state).toBe("listening");
  });

  test("a clip sent to the API never shows on the pill", () => {
    const f = pill();
    f.event({ type: "dictation.started", id: "c1", target: null, engine: "fast", by: "agent:x" });
    f.event({ type: "dictation.failed", id: "c1", error: "no speech model is loaded" });
    f.event({ type: "dictation.inserted", id: "c1", method: "paste", receipt_ms: 1 });
    expect(f.states()).toEqual([]);
  });

  test("dictation off or the helper starting hides the pill, whatever it showed", () => {
    const f = pill();
    f.to("listening");
    f.to("off");
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
    f.to("listening");
    f.to("starting");
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
  });

  test("the meter gets the mic level in dBFS, only while listening", () => {
    expect(levelDb(1)).toBe(0);
    expect(levelDb(0.1)).toBe(-20);
    expect(levelDb(0)).toBe(-60);
    expect(levelDb(1e-9)).toBe(-60);
    expect(levelDb(4)).toBe(0);
    const f = pill();
    f.tell({ kind: "level", rms: 0.1 });
    f.to("listening");
    f.tell({ kind: "level", rms: 0.1 });
    f.to("transcribing");
    f.tell({ kind: "level", rms: 0.1 });
    expect(f.sent.filter((m) => m.name === "level")).toEqual([
      { name: "level", payload: { db: -20 } },
    ]);
  });

  test("Stop and Cancel reach the session door; the buttons with nothing behind them do not", async () => {
    const f = pill();
    expect(await f.p.handlers.control({ action: "stop" })).toBe(true);
    expect(await f.p.handlers.control({ action: "cancel" })).toBe(true);
    expect(await f.p.handlers.control({ action: "retry" })).toBe(false);
    expect(await f.p.handlers.control({ action: "copy" })).toBe(false);
    expect(await f.p.handlers.control({ action: "open-draft" })).toBe(false);
    expect(await f.p.handlers.chip({ id: "d1", action: "learn" })).toBe(false);
    expect(f.controls).toEqual(["stop", "cancel"]);
  });
});

describe("DC-L4, DC-L2: the learn chip in the pill after a direct insert", () => {
  const CHIP: Chip = {
    id: "d1",
    candidates: [{ term: "Kubernetes", heard: "kubernetis" }],
    mode: "ask",
  };

  function withChip() {
    const f = pill();
    const answers: ChipAnswer[] = [];
    f.d.chip = async (a) => {
      answers.push(a);
      return true;
    };
    return { ...f, answers };
  }

  test("a chip shows the idle pill's window; Learn keeps it for the Undo line, then it hides", async () => {
    const f = withChip();
    f.tell({ kind: "chip", chip: CHIP });
    expect(f.sent.at(-1)).toEqual({ name: "chip", payload: CHIP });
    expect(f.states()).toEqual([]);
    expect(f.visible.at(-1)).toBe(true);
    const learn: ChipAnswer = { id: "d1", action: "learn", terms: ["Kubernetes"] };
    expect(await f.p.handlers.chip(learn)).toBe(true);
    expect(f.answers).toEqual([learn]);
    expect(f.visible.at(-1)).toBe(true);
    expect(f.t.pending()).toEqual([LEARNED_MS]);
    f.t.run(LEARNED_MS);
    expect(f.visible.at(-1)).toBe(false);
  });

  test("Not a word takes it down at once, and an outcome still showing keeps the window", async () => {
    const f = withChip();
    spoken(f, "d0");
    f.event({ type: "dictation.inserted", id: "d0", method: "paste", receipt_ms: 5 });
    f.to("idle");
    f.tell({ kind: "chip", chip: CHIP });
    expect(await f.p.handlers.chip({ id: "d1", action: "reject", terms: ["Kubernetes"] })).toBe(
      true,
    );
    expect(f.visible.at(-1)).toBe(true);
    f.t.run(DONE_MS);
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
    expect(f.visible.at(-1)).toBe(false);
  });

  test("an outcome ending under a chip leaves the window up until the chip is answered", async () => {
    const f = withChip();
    spoken(f, "d0");
    f.event({ type: "dictation.inserted", id: "d0", method: "paste", receipt_ms: 5 });
    f.to("idle");
    f.tell({ kind: "chip", chip: CHIP });
    f.t.run(DONE_MS);
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
    expect(f.visible.at(-1)).toBe(true);
    expect(await f.p.handlers.chip({ id: "d1", action: "ignore" })).toBe(true);
    expect(f.visible.at(-1)).toBe(false);
  });

  test("a page that never answers is taken as ignoring the chip", () => {
    const f = withChip();
    f.tell({ kind: "chip", chip: CHIP });
    expect(f.t.pending()).toEqual([CHIP_WAIT_MS]);
    f.t.run(CHIP_WAIT_MS);
    expect(f.answers).toEqual([{ id: "d1", action: "ignore" }]);
    expect(f.visible.at(-1)).toBe(false);
  });

  test("a word learned for the user (learn: auto) stays for its Undo line only", () => {
    const f = withChip();
    f.tell({ kind: "chip", chip: { ...CHIP, mode: "learned" } });
    expect(f.visible.at(-1)).toBe(true);
    expect(f.t.pending()).toEqual([LEARNED_MS]);
    f.t.run(LEARNED_MS);
    expect(f.answers).toEqual([]);
    expect(f.visible.at(-1)).toBe(false);
  });
});

describe("DC-D2, DC-O2: no message to the pill carries the dictated words", () => {
  const SAID = "the launch code is swordfish";

  /**
   * A whole session whose transcript is `SAID`, with a partial of it while listening from the
   * session (DC-E5) and one handed to the pill directly.
   */
  function session(o: { preview?: unknown }) {
    const f = pill(o);
    f.to("listening");
    f.tell({ kind: "level", rms: 0.2 });
    f.tell({ kind: "partial", text: SAID, language: "en" });
    f.p.preview(SAID);
    spoken(f, "d1");
    f.to("transcribing");
    f.event({
      type: "dictation.text",
      id: "d1",
      raw: SAID,
      text: SAID,
      language: "en",
      words: [{ w: "swordfish", s: 1, e: 1.5, c: 0.9 }],
      engine: "fast",
      model: "m",
      ms: 10,
    });
    f.to("inserting");
    f.event({ type: "dictation.inserted", id: "d1", method: "paste", receipt_ms: 5 });
    f.to("idle");
    return f;
  }
  const carries = (f: ReturnType<typeof pill>) =>
    f.sent.some((m) => JSON.stringify(m.payload).includes("swordfish"));

  test("with the preview off, every message is free of the words", () => {
    const f = session({ preview: false });
    expect(f.sent.length).toBeGreaterThan(3);
    expect(carries(f)).toBe(false);
    expect(f.sent.some((m) => m.name === "preview")).toBe(false);
  });

  test("a preview setting that is not exactly true sends nothing either", () => {
    expect(carries(session({ preview: "true" }))).toBe(false);
  });

  test("positive control: the preview on sends the session's partial", () => {
    const f = session({ preview: true });
    expect(f.sent.filter((m) => m.name === "preview")).toEqual([
      { name: "preview", payload: { text: SAID, settled: 0 } },
      { name: "preview", payload: { text: SAID, settled: SAID.length } },
    ]);
    expect(carries(f)).toBe(true);
  });

  test("a partial that comes after listening ended is never sent", () => {
    const f = pill({ preview: true });
    f.to("listening");
    f.to("transcribing");
    f.tell({ kind: "partial", text: SAID, language: "en" });
    expect(carries(f)).toBe(false);
  });
});

describe("DC-E5: the words as you speak on the ticker", () => {
  test("the pill asks the session for partials only with the preview on", () => {
    expect(pill({ preview: true }).wantsPartials).toEqual([true]);
    // Off, nothing would show them: no decode is spent on them.
    expect(pill({ preview: false }).wantsPartials).toEqual([false]);
    expect(pill({ preview: "true" }).wantsPartials).toEqual([false]);
  });

  test("the words the last partial had too are settled, the rest still changing", () => {
    const f = pill({ preview: true });
    f.to("listening");
    f.tell({ kind: "partial", text: "the plan", language: "en" });
    f.tell({ kind: "partial", text: "the plan is  to", language: "en" });
    f.tell({ kind: "partial", text: "the plan is two", language: "en" });
    const previews = f.sent.filter((m) => m.name === "preview").map((m) => m.payload);
    expect(previews).toEqual([
      { text: "the plan", settled: 0 },
      { text: "the plan is to", settled: "the plan".length },
      { text: "the plan is two", settled: "the plan is".length },
    ]);
  });

  test("a new session starts with nothing settled", () => {
    const f = pill({ preview: true });
    f.to("listening");
    f.tell({ kind: "partial", text: "hello there", language: "en" });
    f.to("idle");
    f.to("listening");
    f.tell({ kind: "partial", text: "hello there", language: "en" });
    const last = f.sent.filter((m) => m.name === "preview").at(-1)?.payload;
    expect(last).toEqual({ text: "hello there", settled: 0 });
  });

  test("settledWords follows the words as the decoded end of the audio slides left", () => {
    expect(settledWords([], ["a", "b"])).toBe(0);
    expect(settledWords(["a", "b"], ["a", "b", "c"])).toBe(2);
    expect(settledWords(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
    // The start of a long dictation left the decoded window: the run starts later in the last one.
    expect(settledWords(["a", "b", "c", "d"], ["c", "d", "e"])).toBe(2);
    expect(settledWords(["a", "b"], ["x", "a", "b"])).toBe(0);
  });
});

describe("akou-5v8: the language chip on the listening island", () => {
  const lang = (f: ReturnType<typeof pill>) => {
    const s = f.states().at(-1);
    return s?.state === "listening" ? s.language : undefined;
  };

  test("a switchable engine shows the chip from the start, and keeps it through Parakeet's partials", () => {
    const f = pill({ preview: true });
    f.to("listening");
    expect(lang(f)).toEqual({ tag: AUTO_LANGUAGE, switchable: true, forced: false });
    // The preview decodes on `fast` (Parakeet), whose partials name no language.
    const n = f.states().length;
    f.tell({ kind: "partial", text: "hola a todos", language: null });
    expect(f.states()).toHaveLength(n);
    expect(lang(f)?.tag).toBe(AUTO_LANGUAGE);
  });

  test("with dictation.language set, the chip starts on it, not chosen by the chip", async () => {
    const f = pill();
    f.choice.language = "es";
    f.to("listening");
    expect(lang(f)).toEqual({ tag: "es", switchable: true, forced: false });
    expect(await f.p.handlers.control({ action: "language" })).toBe(true);
    expect(f.forced).toEqual(["en"]);
  });

  test("a partial that names its language shows it", () => {
    const f = pill();
    f.to("listening");
    f.tell({ kind: "partial", text: "hola a todos", language: "es" });
    expect(lang(f)).toEqual({ tag: "es", switchable: true, forced: false });
    // The same language again sends no new state.
    const n = f.states().length;
    f.tell({ kind: "partial", text: "hola a todos otra", language: "es" });
    expect(f.states()).toHaveLength(n);
    // Words never ride the state, preview off or on.
    expect(JSON.stringify(f.states())).not.toContain("hola");
  });

  test("a click moves the session to the next language and the chip says it was chosen", async () => {
    const f = pill();
    f.to("listening");
    f.tell({ kind: "partial", text: "hola", language: null });
    // From `auto`, the first click forces the first of the user's languages.
    expect(await f.p.handlers.control({ action: "language" })).toBe(true);
    expect(f.forced).toEqual(["en"]);
    expect(lang(f)).toEqual({ tag: "en", switchable: true, forced: true });
    // What the engine hears after that does not move a chosen language.
    f.tell({ kind: "partial", text: "hola", language: "es" });
    expect(lang(f)?.tag).toBe("en");
    expect(await f.p.handlers.control({ action: "language" })).toBe(true);
    expect(f.forced).toEqual(["en", "es"]);
    // The language chosen is the session's own: the next one starts from the setting again.
    f.to("idle");
    f.to("listening");
    expect(lang(f)).toEqual({ tag: AUTO_LANGUAGE, switchable: true, forced: false });
  });

  test("an engine that picks its own language shows the chip read-only and refuses the click", async () => {
    const f = pill();
    f.choice.switchable = false;
    f.to("listening");
    // Nothing to show until a partial names the language: Parakeet's never do.
    expect(lang(f)).toBeUndefined();
    f.tell({ kind: "partial", text: "hello", language: null });
    expect(lang(f)).toBeUndefined();
    f.tell({ kind: "partial", text: "hello", language: "en" });
    expect(lang(f)).toEqual({ tag: "en", switchable: false, forced: false });
    expect(await f.p.handlers.control({ action: "language" })).toBe(false);
    expect(f.forced).toEqual([]);
  });

  test("the click does nothing outside listening", async () => {
    const f = pill();
    f.to("transcribing");
    expect(await f.p.handlers.control({ action: "language" })).toBe(false);
    expect(f.forced).toEqual([]);
    expect(f.controls).toEqual([]);
  });
});

describe("DC-O1: the pill's window", () => {
  const AREAS: Rect[] = [
    { x: 0, y: 25, width: 1440, height: 850 },
    { x: 1440, y: 0, width: 1920, height: 1080 },
  ];

  test("each edge centres it on that side of the primary work area", () => {
    const { width, height } = PILL_SIZE;
    const cx = (1440 - width) / 2;
    expect(placePill({}, "bottom", AREAS)).toEqual({ x: cx, y: 875 - height - 24, width, height });
    // The island sits right under the menu bar, where a notch would be.
    expect(placePill({}, "top", AREAS)).toEqual({ x: cx, y: 25 + 4, width, height });
    const cy = 25 + (850 - height) / 2;
    expect(placePill({}, "left", AREAS)).toEqual({ x: 24, y: cy, width, height });
    expect(placePill({}, "right", AREAS)).toEqual({ x: 1440 - width - 24, y: cy, width, height });
  });

  test("the draft box drops from the island: its own island where the pill's is, at the top centre", () => {
    const pill = placePill({}, "top", AREAS);
    const draft = placeDraft(AREAS);
    expect(draft).toEqual({
      x: (1440 - DRAFT_SIZE.width) / 2,
      y: pill.y,
      width: DRAFT_SIZE.width,
      height: DRAFT_SIZE.height,
    });
    // Both windows centre the island they draw, so the two islands share a centre line.
    expect(draft.x + draft.width / 2).toBe(pill.x + pill.width / 2);
  });

  test("a dragged place is kept on its edge, pulled onto a display, and dropped for another edge", () => {
    const dragged = { x: 2000, y: 600, width: 1, height: 1 };
    const { width, height } = PILL_SIZE;
    expect(placePill({ frame: dragged, edge: "bottom" }, "bottom", AREAS)).toEqual({
      x: 2000,
      y: 600,
      width,
      height,
    });
    // Off every display: back onto the primary, whole.
    expect(placePill({ frame: { ...dragged, x: 9000 }, edge: "bottom" }, "bottom", AREAS).x).toBe(
      1440 - width,
    );
    expect(placePill({ frame: dragged, edge: "bottom" }, "top", AREAS)).toEqual(
      placePill({}, "top", AREAS),
    );
  });

  test("the shell's state file keeps the dragged place and its edge", () => {
    const t = tempDir("akou-pill-state-");
    cleanups.push(t.cleanup);
    const store = fileState(t.dir);
    const s: ShellState = { pill: { x: 1, y: 2, width: 3, height: 4 }, pillEdge: "top" };
    store.save(s);
    expect(store.load()).toEqual(s);
    // A place without its edge is not trusted.
    writeFileSync(join(t.dir, "shell.json"), JSON.stringify({ pill: s.pill }));
    expect(store.load()).toEqual({});
  });

  /** The shell over a hand-driven dictation, with a fake `openPill`. */
  async function shellWith(o: {
    platform: string;
    pill?: string;
    state?: ShellState;
    refuse?: boolean;
  }) {
    const fd = fakeDictation();
    const f = fakeUi();
    const opened: { frame: Rect; style: PillStyle }[] = [];
    const win = { visible: false, closed: 0, frame: (_r: Rect) => {} };
    const r = recorder();
    const ui: NativeUi = {
      ...f.ui,
      openPill: (p) => {
        if (o.refuse) throw new Error("no window handle");
        opened.push({ frame: p.frame, style: p.style });
        return {
          window: {
            showInactive: () => {
              win.visible = true;
            },
            hide: () => {
              win.visible = false;
            },
            close: () => {
              win.visible = false;
              win.closed++;
            },
            onClose: () => {},
            onFrame: (fn) => {
              win.frame = fn;
            },
          },
          send: r.send,
        };
      },
    };
    let fire = () => {};
    const released: string[] = [];
    const settings: Record<string, unknown> = {
      "app.hotkey": "",
      "app.openAtLogin": false,
      "dictation.pill": o.pill ?? "bottom",
    };
    const app: ShellApp = {
      status: async () => ({ live: null, share: { active: false } }),
      start: async () => ({ ok: true, call: "c1" }),
      stopLive: async () => {},
      config: () => ({ settings }),
      saveSetting: async () => {},
      quit: async () => {},
      openSettingsPane: async () => false,
      openWindow: async () => {},
      onAnnounce: () => () => {},
      dictation: {
        state: () => fd.st.state,
        status: () => ({ ...fd.st }),
        control: fd.d.control,
        watch: (fn) => {
          fire = fn;
          return () => {};
        },
        follow: fd.d.follow,
        hotkey: () => "RightCommand",
        releaseChip: (id) => released.push(id),
      },
    };
    const bridge = {
      watchLifecycle: () => () => {},
      app: { status: async () => ({}), watch: () => () => {} },
    } as unknown as Bridge;
    let saved: ShellState = o.state ?? {};
    const logs: string[] = [];
    const shell = new Shell(app, bridge, ui, {
      platform: o.platform,
      setLoginItem: async () => {},
      state: { load: () => saved, save: (s) => (saved = s) },
      onLog: (_level, msg) => logs.push(msg),
    });
    cleanups.push(() => shell.close());
    await shell.start();
    const to = (state: string) => {
      fd.st.state = state;
      fire();
    };
    return { shell, opened, win, r, to, settings, saved: () => saved, fd, logs, f, released };
  }

  test("macOS opens a non-activating panel, Windows a no-activate window, hidden until a session", async () => {
    for (const [platform, style] of [
      ["darwin", { styleMask: { NonactivatingPanel: true } }],
      ["win32", { noActivate: true }],
      ["linux", {}],
    ] as const) {
      const s = await shellWith({ platform });
      expect(s.opened).toEqual([{ frame: placePill({}, "bottom", fakeUi().areas), style }]);
      expect(s.win.visible).toBe(false);
      s.to("listening");
      expect(s.win.visible).toBe(true);
      expect(s.r.states().at(-1)).toMatchObject({ state: "listening" });
      s.to("idle");
      expect(s.win.visible).toBe(false);
      await s.shell.close();
    }
  });

  test("with dictation.pill off no window opens; turned on, the next state opens it", async () => {
    const s = await shellWith({ platform: "darwin", pill: "off" });
    s.to("listening");
    expect(s.opened).toEqual([]);
    // Positive control: the same shell with the setting on.
    s.settings["dictation.pill"] = "bottom";
    s.to("idle");
    expect(s.opened).toHaveLength(1);
    s.settings["dictation.pill"] = "off";
    s.to("listening");
    expect(s.win.closed).toBe(1);
    expect(s.win.visible).toBe(false);
  });

  test("a pill window that cannot open is logged, and the session and the tray carry on", async () => {
    const s = await shellWith({ platform: "win32", refuse: true });
    s.to("listening");
    expect(s.opened).toEqual([]);
    expect(s.logs.some((l) => l.includes("the dictation pill did not open"))).toBe(true);
    // Nothing is left following the session for a window that never opened: the one follower
    // is the shell's own, which turns a learn chip into a notification while no pill shows (DC-O4).
    expect(s.fd.followers.size).toBe(1);
    await until(() => s.f.title() === "● dictating", 1000, "the tray to say dictating");
  });

  test("DC-O4: a learn chip goes to the pill while it is on, and to one notification naming no word while it is off", async () => {
    const chip: Chip = {
      id: "d1",
      candidates: [{ term: "Kubernetes", heard: "kubernetis" }],
      mode: "ask",
    };
    const on = await shellWith({ platform: "darwin" });
    on.fd.tell({ kind: "chip", chip });
    expect(on.r.sent.filter((m) => m.name === "chip")).toEqual([{ name: "chip", payload: chip }]);
    expect(on.win.visible).toBe(true);
    expect(on.f.notices).toEqual([]);
    expect(on.released).toEqual([]);
    await on.shell.close();

    const off = await shellWith({ platform: "darwin", pill: "off" });
    off.fd.tell({ kind: "chip", chip });
    off.fd.tell({ kind: "chip", chip: { ...chip, id: "d2", mode: "learned" } });
    expect(off.f.notices).toEqual([
      {
        title: "akou can learn a word you fixed",
        body: "It waits in Words to review on the Dictation page.",
      },
      {
        title: "akou learned a word you fixed",
        body: "Undo it in Words to review on the Dictation page.",
      },
    ]);
    expect(off.released).toEqual(["d1", "d2"]);
  });

  test("dictation off closes the window; a drag is remembered and restored at the next open", async () => {
    const s = await shellWith({ platform: "darwin" });
    const place = { x: 900, y: 500, width: PILL_SIZE.width, height: PILL_SIZE.height };
    s.win.frame(place);
    s.to("off");
    expect(s.win.closed).toBe(1);
    expect(s.saved()).toMatchObject({ pill: place, pillEdge: "bottom" });
    s.to("idle");
    expect(s.opened.at(-1)?.frame).toEqual(place);
  });
});

describe("DC-O1: the pill over a whole app", () => {
  async function rig(
    o: Pick<RigOptions, "models" | "jobs"> & { settings?: Record<string, unknown> } = {},
  ): Promise<AppRig> {
    const t = tempDir("akou-dict-pill-");
    cleanups.push(t.cleanup);
    const wav = join(t.dir, "mic.wav");
    writeFileSync(wav, monoWav(concat(speak(["hello"]), silence(3))));
    const r = await appRig({
      helperArgs: ["--wav", wav],
      // Named, since the default is off on Linux.
      settings: { "dictation.enabled": true, "dictation.pill": "bottom", ...o.settings },
      ...(o.models !== undefined ? { models: o.models } : {}),
      ...(o.jobs ? { jobs: o.jobs } : {}),
    });
    cleanups.push(() => r.close());
    await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
    return r;
  }

  /** The real shell's pill over `r`, recording what the page is told. */
  async function pillOver(r: AppRig) {
    const f = fakeUi();
    const rec = recorder();
    let rpc: Parameters<NonNullable<NativeUi["openPill"]>>[0]["rpc"] | null = null;
    f.ui.openPill = (o) => {
      rpc = o.rpc;
      return {
        window: {
          showInactive: () => {},
          hide: () => {},
          close: () => {},
          onClose: () => {},
          onFrame: () => {},
        },
        send: rec.send,
      };
    };
    const shell = new Shell(appForShell(r.app), new Bridge(r.app), f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    cleanups.push(() => shell.close());
    await shell.start();
    await until(() => rpc !== null, 5000, "the pill's window");
    const control = (action: string) =>
      (
        rpc as unknown as { handlers: { control: (p: object) => Promise<boolean> } }
      ).handlers.control({ action });
    return { f, rec, control };
  }

  /** One spoken dictation from the tray, stopped from the pill once the pill says listening. */
  async function dictate(p: Awaited<ReturnType<typeof pillOver>>): Promise<void> {
    p.f.tray("dictate");
    await until(
      () => p.rec.states().some((s) => s.state === "listening"),
      5000,
      "the pill to say listening",
    );
    // The fake's mic runs in real time: the word is spoken before the stop.
    await Bun.sleep(1500);
    expect(await p.control("stop")).toBe(true);
  }

  test("DC-E2: a press while the live Worker still loads its model shows loading model, and inserts once it is ready", async () => {
    const t = tempDir("akou-dict-pill-load-");
    cleanups.push(t.cleanup);
    // The fake recognizer behind a gate: the Worker's load waits until the test opens it.
    const gate = join(t.dir, "gate");
    const mod = join(t.dir, "gated-models.ts");
    writeFileSync(
      mod,
      [
        'import { existsSync } from "node:fs";',
        `while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(20);`,
        `export { createModels } from ${JSON.stringify(FAKE_MODELS)};`,
      ].join("\n"),
    );
    const r = await rig({
      models: { kind: "module", path: mod, model: "fake-parakeet", options: {} },
    });
    expect(r.app.dictation()?.status().loading).toBe(true);
    const p = await pillOver(r);
    await dictate(p);
    await until(
      () => p.rec.states().some((s) => s.state === "transcribing"),
      5000,
      "the pill to say transcribing",
    );
    expect(p.rec.states().at(-1)).toMatchObject({ state: "transcribing", note: LOADING_NOTE });
    // The audio is kept: nothing is inserted, and nothing fails, while the model loads.
    await Bun.sleep(300);
    expect(r.app.dictation()?.log.items()[0]?.state).not.toBe("failed");
    expect(p.rec.states().map((s) => s.state)).toEqual(["listening", "transcribing"]);
    writeFileSync(gate, "");
    await until(
      () => p.rec.states().some((s) => s.state === "done"),
      10_000,
      "the insert once the model is ready",
    );
    expect(p.rec.states().at(-1)).toEqual({ state: "done", how: "inserted" });
    expect(r.app.dictation()?.log.items()[0]).toMatchObject({ state: "inserted", text: "hello" });
  });

  test("DC-E3: best chosen with Qwen missing starts its download, and the pill says fast ran meanwhile", async () => {
    const fetched: string[] = [];
    const r = await rig({
      settings: { "dictation.engine": "best" },
      jobs: {
        modelStore: {
          freeBytes: () => 1e13,
          // A download that never finishes.
          fetch: ((url: string | URL | Request) => {
            fetched.push(String(url instanceof Request ? url.url : url));
            return new Promise<Response>(() => {});
          }) as typeof fetch,
        },
      },
    });
    await until(() => fetched.length > 0, 10_000, "Qwen's download to start");
    const p = await pillOver(r);
    await dictate(p);
    await until(() => p.rec.states().some((s) => s.state === "done"), 10_000, "the insert");
    expect(p.rec.states().at(-1)).toEqual({
      state: "done",
      how: "inserted",
      note: "downloading best, using fast",
    });
    expect(r.app.dictation()?.log.items()[0]).toMatchObject({
      text: "hello",
      engine: "fast",
      fallback_from: "best",
    });
  });

  test("DC-E3: remote with no local model downloads nothing, reports fallback error, and a stopped remote shows the error state", async () => {
    const gone = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const url = `http://127.0.0.1:${gone.port}`;
    gone.stop(true);
    const fetched: string[] = [];
    const r = await rig({
      models: null,
      settings: { "dictation.engine": "remote", "dictation.remote.url": url },
      jobs: {
        modelStore: {
          freeBytes: () => 1e13,
          fetch: ((u: string | URL | Request) => {
            fetched.push(String(u instanceof Request ? u.url : u));
            return new Promise<Response>(() => {});
          }) as typeof fetch,
        },
      },
    });
    const st = (await r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({ engine: "remote", fallback: "error" });
    const p = await pillOver(r);
    await dictate(p);
    await until(() => p.rec.states().some((s) => s.state === "error"), 10_000, "the error state");
    expect(p.rec.states().at(-1)).toMatchObject({
      state: "error",
      message: expect.stringContaining(`${url} could not be reached`),
    });
    expect(r.app.dictation()?.log.items()[0]?.state).toBe("failed");
    expect(fetched).toEqual([]);
  });

  test("the pill's Stop ends a session into an insert, and no message carries its words", async () => {
    const r = await rig();
    const f = fakeUi();
    const rec = recorder();
    let rpc: Parameters<NonNullable<NativeUi["openPill"]>>[0]["rpc"] | null = null;
    let visible = false;
    f.ui.openPill = (o) => {
      rpc = o.rpc;
      return {
        window: {
          showInactive: () => {
            visible = true;
          },
          hide: () => {
            visible = false;
          },
          close: () => {},
          onClose: () => {},
          onFrame: () => {},
        },
        send: rec.send,
      };
    };
    const shell = new Shell(appForShell(r.app), new Bridge(r.app), f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    cleanups.push(() => shell.close());
    await shell.start();
    await until(() => rpc !== null, 5000, "the pill's window");
    f.tray("dictate");
    await until(() => visible, 5000, "the pill to show");
    // The key is the host's default (`RightCommand` here, a chord on Linux), labelled for macOS.
    // Labelled by `hotkeyLabel` itself, so this checks the wiring only; `Right ⌘` is pinned above.
    expect(rec.states().at(-1)).toMatchObject({
      state: "listening",
      hotkey: hotkeyLabel(r.app.dictation()?.hotkey() ?? "", "darwin"),
    });
    expect(r.app.dictation()?.hotkey()).not.toBe("");
    const handlers = (rpc as unknown as { handlers: { control: (p: object) => Promise<boolean> } })
      .handlers;
    expect(await handlers.control({ action: "stop" })).toBe(true);
    await until(
      () => rec.states().some((s) => s.state === "done"),
      10_000,
      "the pill to say inserted",
    );
    expect(rec.states().map((s) => s.state)).toEqual(["listening", "transcribing", "done"]);
    expect(rec.states().at(-1)).toEqual({ state: "done", how: "inserted" });
    expect(r.app.dictation()?.log.items()[0]).toMatchObject({ text: "hello" });
    expect(rec.sent.some((m) => JSON.stringify(m.payload).includes("hello"))).toBe(false);
    await until(() => !visible, 5000, "the pill to hide after its time");
  });
});
