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
  NOTICE_MS,
  PILL_MAX_HEIGHT,
  type PillDictation,
  type PillRpcHandlers,
  type PillSend,
  PRESS_MS,
  pillRpc,
  settledWords,
} from "../src/main/window/pill.ts";
import {
  appForShell,
  areaOf,
  DRAFT_SIZE,
  type NativeUi,
  PILL_SIZE,
  type PillPlace,
  type PillStyle,
  pillBase,
  pillPlaces,
  placeDraft,
  placePill,
  type Rect,
  rememberPill,
  Shell,
  type ShellApp,
  type ShellState,
  sizePill,
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
    /** The language the door's start chose for the session listening. */
    chosen: null as string | null,
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

  test("an error's buttons: what the dictation offers, each run for it, and the island steps aside or comes back", async () => {
    const f = pill();
    const ran: string[] = [];
    let answer = true;
    let offered: ("retry" | "copy" | "open-draft")[] = ["retry", "copy", "open-draft"];
    f.d.errorActions = () => ({ actions: offered, retryLabel: "Retry locally" });
    f.d.errorAction = async (id, a) => {
      ran.push(`${id}:${a}`);
      return answer;
    };
    const fail = (id: string) => {
      f.to("listening");
      spoken(f, id);
      f.to("transcribing");
      f.event({ type: "dictation.failed", id, error: "remote akou not reachable" });
      f.to("idle");
    };
    fail("d1");
    const error: PillState = {
      state: "error",
      message: "remote akou not reachable",
      actions: ["retry", "copy", "open-draft"],
      retryLabel: "Retry locally",
    };
    expect(f.states().at(-1)).toEqual(error);
    // With buttons to reach, it stays as long as a notice.
    expect(f.t.pending()).toEqual([NOTICE_MS]);
    // Retry: transcribing while it decodes, then the island makes way for the draft box.
    expect(await f.p.handlers.control({ action: "retry" })).toBe(true);
    expect(f.states().slice(-2)).toEqual([
      { state: "transcribing", since: 1000 },
      { state: "hidden" },
    ]);
    expect(f.t.pending()).toEqual([]);

    // A button that could not do it brings the error back for its time.
    fail("d2");
    answer = false;
    expect(await f.p.handlers.control({ action: "copy" })).toBe(false);
    expect(f.states().at(-1)).toEqual(error);
    expect(f.t.pending()).toEqual([NOTICE_MS]);
    answer = true;
    expect(await f.p.handlers.control({ action: "copy" })).toBe(true);
    expect(f.states().at(-1)).toEqual({ state: "done", how: "copied", note: "⌘V" });
    expect(f.t.pending()).toEqual([DONE_MS]);

    fail("d3");
    expect(await f.p.handlers.control({ action: "open-draft" })).toBe(true);
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
    expect(ran).toEqual(["d1:retry", "d2:copy", "d2:copy", "d3:open-draft"]);

    // Positive controls: a button the error does not offer, or no error up, runs nothing.
    offered = ["copy"];
    fail("d4");
    expect(await f.p.handlers.control({ action: "retry" })).toBe(false);
    f.t.run(NOTICE_MS);
    expect(await f.p.handlers.control({ action: "copy" })).toBe(false);
    expect(ran).toHaveLength(4);
  });

  test("a Retry that answers after a new press leaves the island to the new dictation", async () => {
    const f = pill();
    let answer: (ok: boolean) => void = () => {};
    f.d.errorActions = () => ({ actions: ["retry"] });
    f.d.errorAction = () => new Promise<boolean>((res) => (answer = res));
    f.to("listening");
    spoken(f, "d1");
    f.to("transcribing");
    f.event({ type: "dictation.failed", id: "d1", error: "remote akou not reachable" });
    f.to("idle");
    const retried = f.p.handlers.control({ action: "retry" });
    expect(f.states().at(-1)?.state).toBe("transcribing");
    // The user presses again while the retry decodes.
    f.to("listening");
    expect(f.states().at(-1)?.state).toBe("listening");
    answer(true);
    expect(await retried).toBe(true);
    expect(f.states().at(-1)?.state).toBe("listening");
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

  test("settledWords counts the words the last partial started with too", () => {
    expect(settledWords([], ["a", "b"])).toBe(0);
    expect(settledWords(["a", "b"], ["a", "b", "c"])).toBe(2);
    expect(settledWords(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
    expect(settledWords(["a", "b"], ["x", "a", "b"])).toBe(0);
  });

  test("[H-11] a partial is the whole dictation, however long, and reaches the page whole", () => {
    const f = pill({ preview: true });
    f.to("listening");
    const said = Array.from({ length: 3000 }, (_, i) => `word${i}`);
    f.tell({ kind: "partial", text: said.slice(0, 2999).join(" "), language: "en" });
    f.tell({ kind: "partial", text: said.join(" "), language: "en" });
    const last = f.sent.filter((m) => m.name === "preview").at(-1)?.payload;
    expect(last).toEqual({ text: said.join(" "), settled: said.slice(0, 2999).join(" ").length });
  });

  test("[H-11] the page's height reaches the window, bounded; the edge is the page's to pull", async () => {
    const heights: number[] = [];
    const f = fakeDictation();
    const r = recorder();
    const p = pillRpc(f.d, () => r.send, {
      platform: "darwin",
      hotkey: () => "RightCommand",
      label: hotkeyLabel,
      now: () => 1000,
      onVisible: () => {},
      preview: { setting: () => true },
      later: manualLater().later,
      edge: "bottom",
      resize: (h) => heights.push(h),
    });
    cleanups.push(() => p.close());
    expect(await p.handlers.size({ height: 99.2 })).toBe(true);
    expect(await p.handlers.size({ height: 10_000 })).toBe(true);
    for (const bad of [0, -5, Number.NaN, "120"])
      expect(await p.handlers.size({ height: bad as number })).toBe(false);
    expect(heights).toEqual([100, PILL_MAX_HEIGHT]);
    expect(await p.handlers.layout({})).toEqual({ edge: "bottom" });
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

  test("a session the door started in a language shows it as chosen from the start", () => {
    const f = pill();
    f.choice.chosen = "es";
    f.to("listening");
    expect(lang(f)).toEqual({ tag: "es", switchable: true, forced: true });
    // Positive control: the next session, started with none, starts from the setting again.
    f.choice.chosen = null;
    f.to("idle");
    f.to("listening");
    expect(lang(f)).toEqual({ tag: AUTO_LANGUAGE, switchable: true, forced: false });
  });

  test("the done island says the language the text went in as, only for a user of two or more", () => {
    const run = (languages: readonly string[], heard: string | null) => {
      const f = pill();
      f.choice.languages = languages;
      f.to("listening");
      spoken(f, "d1");
      f.to("transcribing");
      f.event({
        type: "dictation.text",
        id: "d1",
        raw: "hola",
        text: "hola",
        language: heard,
        words: [],
        engine: "best",
        model: "qwen",
        ms: 90,
      });
      f.event({ type: "dictation.inserted", id: "d1", method: "paste", receipt_ms: 5 });
      f.to("idle");
      return f.states().at(-1);
    };
    expect(run(["en", "es"], "es")).toEqual({ state: "done", how: "inserted", language: "es" });
    // Positive controls: one language, or an engine that named none, say nothing.
    expect(run(["en"], "es")).toEqual({ state: "done", how: "inserted" });
    expect(run(["en", "es"], null)).toEqual({ state: "done", how: "inserted" });
  });

  test("the click does nothing outside listening", async () => {
    const f = pill();
    f.to("transcribing");
    expect(await f.p.handlers.control({ action: "language" })).toBe(false);
    expect(f.forced).toEqual([]);
    expect(f.controls).toEqual([]);
  });
});

describe("DC-O1: the island at rest from the key-down", () => {
  /** The pill with a `place` that records where the shell was asked to move it. */
  function placed() {
    const f = fakeDictation();
    const r = recorder();
    const t = manualLater();
    const visible: boolean[] = [];
    const moves: unknown[] = [];
    const clock = { now: 1000 };
    const p = pillRpc(f.d, () => r.send, {
      platform: "darwin",
      hotkey: () => "RightCommand",
      label: hotkeyLabel,
      now: () => clock.now,
      onVisible: (v) => visible.push(v),
      preview: { setting: () => false },
      later: t.later,
      place: (frame) => moves.push({ frame, showing: visible.at(-1) === true }),
    });
    cleanups.push(() => p.close());
    const to = (state: string) => {
      f.st.state = state;
      p.update();
    };
    return { ...f, ...r, t, p, visible, moves, to, clock };
  }
  const FRAME = { x: 1600, y: 200, width: 900, height: 700 };

  test("a key-down shows the dot, placed first, and the session takes the island from it", () => {
    const f = placed();
    f.tell({ kind: "press", on: true, frame: FRAME });
    expect(f.moves).toEqual([{ frame: FRAME, showing: false }]);
    expect(f.states()).toEqual([{ state: "pressed" }]);
    expect(f.visible.at(-1)).toBe(true);
    // The session's changes while the press settles do not take the dot down.
    f.to("idle");
    expect(f.states().at(-1)).toEqual({ state: "pressed" });
    f.to("listening");
    expect(f.states().at(-1)).toMatchObject({ state: "listening" });
    // Its own timer is gone with it: listening stays past it.
    expect(f.t.pending()).toEqual([]);
  });

  test("a dropped press hides the dot, and nothing else", () => {
    const f = placed();
    f.tell({ kind: "press", on: true, frame: null });
    expect(f.moves).toEqual([{ frame: null, showing: false }]);
    f.tell({ kind: "press", on: false, frame: null });
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
    expect(f.visible.at(-1)).toBe(false);
    // Positive control: a press off while a session listens leaves the session's island alone.
    f.to("listening");
    f.tell({ kind: "press", on: false, frame: null });
    expect(f.states().at(-1)).toMatchObject({ state: "listening" });
  });

  test("a dot with nothing after it goes after PRESS_MS", () => {
    const f = placed();
    f.tell({ kind: "press", on: true, frame: null });
    expect(f.t.pending()).toEqual([PRESS_MS]);
    f.t.run(PRESS_MS);
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
    expect(f.visible.at(-1)).toBe(false);
  });

  test("a press takes the island from an outcome, never from a session", () => {
    const f = placed();
    f.to("listening");
    spoken(f, "d1");
    f.to("transcribing");
    f.tell({ kind: "press", on: true, frame: FRAME });
    expect(f.states().at(-1)).toMatchObject({ state: "transcribing" });
    expect(f.moves).toEqual([]);
    f.event({ type: "dictation.inserted", id: "d1", method: "paste", receipt_ms: 5 });
    f.to("idle");
    expect(f.states().at(-1)).toEqual({ state: "done", how: "inserted" });
    f.tell({ kind: "press", on: true, frame: FRAME });
    expect(f.states().at(-1)).toEqual({ state: "pressed" });
    // The outcome's timer no longer hides the island; the press's own does.
    expect(f.t.pending()).toEqual([PRESS_MS]);
  });

  test("the dictation key in a shortcut gives the error back with its buttons and the time it had left", async () => {
    const f = placed();
    const ran: string[] = [];
    f.d.errorActions = () => ({ actions: ["retry", "copy", "open-draft"] });
    f.d.errorAction = async (id, action) => {
      ran.push(`${id}:${action}`);
      return true;
    };
    f.to("listening");
    spoken(f, "d1");
    f.to("transcribing");
    f.event({ type: "dictation.failed", id: "d1", error: "remote akou not reachable" });
    f.to("idle");
    const error = f.states().at(-1);
    expect(error).toMatchObject({ state: "error", actions: ["retry", "copy", "open-draft"] });
    // Right ⌘+C 4 s into the error's 10 s: a press, then dropped by the C.
    f.clock.now += 4000;
    f.tell({ kind: "press", on: true, frame: FRAME });
    expect(f.states().at(-1)).toEqual({ state: "pressed" });
    f.tell({ kind: "press", on: false, frame: null });
    expect(f.states().at(-1)).toEqual(error);
    expect(f.visible.at(-1)).toBe(true);
    expect(f.t.pending()).toEqual([NOTICE_MS - 4000]);
    expect(await f.p.handlers.control({ action: "retry" })).toBe(true);
    expect(ran).toEqual(["d1:retry"]);

    // The done island comes back the same way; one whose time ran out under the dot does not.
    f.to("listening");
    spoken(f, "d2");
    f.to("transcribing");
    f.event({ type: "dictation.inserted", id: "d2", method: "paste", receipt_ms: 5 });
    f.to("idle");
    const done = f.states().at(-1);
    expect(done).toEqual({ state: "done", how: "inserted" });
    f.tell({ kind: "press", on: true, frame: null });
    f.tell({ kind: "press", on: false, frame: null });
    expect(f.states().at(-1)).toEqual(done);
    f.tell({ kind: "press", on: true, frame: null });
    f.clock.now += DONE_MS;
    f.tell({ kind: "press", on: false, frame: null });
    expect(f.states().at(-1)).toEqual({ state: "hidden" });
    expect(f.visible.at(-1)).toBe(false);
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
    expect(placePill([], "bottom", AREAS)).toEqual({ x: cx, y: 875 - height - 24, width, height });
    // The island sits right under the menu bar, where a notch would be.
    expect(placePill([], "top", AREAS)).toEqual({ x: cx, y: 25 + 4, width, height });
    const cy = 25 + (850 - height) / 2;
    expect(placePill([], "left", AREAS)).toEqual({ x: 24, y: cy, width, height });
    expect(placePill([], "right", AREAS)).toEqual({ x: 1440 - width - 24, y: cy, width, height });
  });

  test("on another display it centres on that display's edge; a display gone means the primary", () => {
    const { width, height } = PILL_SIZE;
    const second = AREAS[1] as Rect;
    expect(placePill([], "top", AREAS, second)).toEqual({
      x: 1440 + (1920 - width) / 2,
      y: 4,
      width,
      height,
    });
    const gone = { x: 5000, y: 0, width: 800, height: 600 };
    expect(placePill([], "top", AREAS, gone)).toEqual(placePill([], "top", AREAS));
  });

  test("the draft box drops from the island: its own island where the pill's is, at the top centre", () => {
    const pill = placePill([], "top", AREAS);
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

  test("[H-11] the window grows away from its edge: up at the bottom, down anywhere else, so its row never moves", () => {
    const base = placePill([], "top", AREAS);
    expect(sizePill(base, "top", 320)).toEqual({ ...base, height: 320 });
    const bottom = placePill([], "bottom", AREAS);
    const tall = sizePill(bottom, "bottom", 320);
    expect(tall.y + tall.height).toBe(bottom.y + bottom.height);
    const short = sizePill(bottom, "bottom", 90);
    expect(short.y + short.height).toBe(bottom.y + bottom.height);
    // At a side the page still lays its row at the top: the top stays, so Stop and Cancel do not
    // move as lines are added.
    for (const edge of ["left", "right"]) {
      const side = placePill([], edge, AREAS);
      const grown = sizePill(side, edge, 300);
      expect(grown.y).toBe(side.y);
      expect(grown.x).toBe(side.x);
    }
    // Never past its display, and never taller than it.
    const primary = AREAS[0] as Rect;
    expect(sizePill(bottom, "bottom", 5000, primary)).toMatchObject({
      y: primary.y,
      height: primary.height,
    });
    // The place kept for a window of any height is the one it grew from.
    for (const edge of ["top", "bottom", "left", "right"]) {
      const b = placePill([], edge, AREAS);
      expect(pillBase(sizePill(b, edge, 137), edge)).toEqual(b);
    }
  });

  test("a dragged place is kept for its display and edge only, and pulled whole onto that display", () => {
    const { width, height } = PILL_SIZE;
    const second = AREAS[1] as Rect;
    const dragged = { x: 2000, y: 600, width, height };
    const places = rememberPill([], "bottom", dragged, AREAS);
    expect(places).toEqual([{ edge: "bottom", area: second, frame: dragged }]);
    expect(placePill(places, "bottom", AREAS, second)).toEqual(dragged);
    // The primary keeps its own default, and another edge its own.
    expect(placePill(places, "bottom", AREAS)).toEqual(placePill([], "bottom", AREAS));
    expect(placePill(places, "top", AREAS, second)).toEqual(placePill([], "top", AREAS, second));
    // A place half off its display comes back whole onto it.
    const past = rememberPill([], "bottom", { ...dragged, x: 3300 }, AREAS);
    expect(placePill(past, "bottom", AREAS, second).x).toBe(1440 + 1920 - width);
    // A second drag on the same display replaces the first; the other display's place stays.
    const both = rememberPill(
      rememberPill(places, "bottom", { x: 100, y: 300, width, height }, AREAS),
      "bottom",
      { ...dragged, x: 2100 },
      AREAS,
    );
    expect(both.map((p) => [p.area.x, p.frame.x])).toEqual([
      [0, 100],
      [1440, 2100],
    ]);
  });

  test("the display of a window: the one it overlaps most, else the nearest", () => {
    expect(areaOf({ x: 1300, y: 100, width: 400, height: 300 }, AREAS)).toEqual(AREAS[1]);
    expect(areaOf({ x: 1000, y: 100, width: 400, height: 300 }, AREAS)).toEqual(AREAS[0]);
    // Only the menu bar strip, outside the primary's work area: still the primary.
    expect(areaOf({ x: 100, y: 0, width: 300, height: 20 }, AREAS)).toEqual(AREAS[0]);
    expect(areaOf({ x: 9000, y: 100, width: 10, height: 10 }, AREAS)).toEqual(AREAS[1]);
    expect(areaOf({ x: 0, y: 0, width: 10, height: 10 }, [])).toBeUndefined();
  });

  test("the shell's state file keeps a place per display, and reads the single place of before", () => {
    const t = tempDir("akou-pill-state-");
    cleanups.push(t.cleanup);
    const store = fileState(t.dir);
    const place: PillPlace = {
      edge: "top",
      area: AREAS[1] as Rect,
      frame: { x: 2000, y: 4, width: 480, height: 200 },
    };
    store.save({ pillPlaces: [place] });
    expect(store.load()).toEqual({ pillPlaces: [place] });
    // A place missing a part is dropped alone.
    writeFileSync(
      join(t.dir, "shell.json"),
      JSON.stringify({ pillPlaces: [place, { edge: "top", frame: place.frame }] }),
    );
    expect(store.load()).toEqual({ pillPlaces: [place] });
    // The single place of before is read as the place on the display it overlaps.
    const old: ShellState = { pill: { x: 2000, y: 600, width: 480, height: 200 }, pillEdge: "top" };
    store.save(old);
    expect(store.load()).toEqual(old);
    expect(pillPlaces(old, AREAS)).toEqual([
      { edge: "top", area: AREAS[1] as Rect, frame: { x: 2000, y: 600, width: 480, height: 200 } },
    ]);
    // A place without its edge is not trusted.
    writeFileSync(join(t.dir, "shell.json"), JSON.stringify({ pill: old.pill }));
    expect(store.load()).toEqual({});
  });

  /** The shell over a hand-driven dictation, with a fake `openPill`. */
  async function shellWith(o: {
    platform: string;
    pill?: string;
    state?: ShellState;
    refuse?: boolean;
    /** The displays' work areas, the primary first. */
    areas?: Rect[];
  }) {
    const fd = fakeDictation();
    const f = fakeUi();
    if (o.areas) f.areas = o.areas;
    const opened: { frame: Rect; style: PillStyle }[] = [];
    const win = {
      visible: false,
      closed: 0,
      frame: (_r: Rect) => {},
      /** Every move the shell made, and whether the window showed at that moment. */
      moves: [] as { to: Rect; visible: boolean }[],
      /** The pill's handlers, as the page's requests reach them. */
      rpc: null as PillRpcHandlers | null,
    };
    const r = recorder();
    const ui: NativeUi = {
      ...f.ui,
      openPill: (p) => {
        if (o.refuse) throw new Error("no window handle");
        opened.push({ frame: p.frame, style: p.style });
        win.rpc = p.rpc;
        return {
          window: {
            setFrame: (to) => {
              win.moves.push({ to, visible: win.visible });
            },
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
      expect(s.opened).toEqual([{ frame: placePill([], "bottom", fakeUi().areas), style }]);
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

  test("[H-11] the page's height resizes the window from its edge, and a drag while tall keeps the place", async () => {
    const s = await shellWith({ platform: "darwin" });
    const at = s.opened.at(-1)?.frame as Rect;
    await s.win.rpc?.handlers.size({ height: 96 });
    const short = s.win.moves.at(-1)?.to as Rect;
    // Bottom: the window's bottom edge stays, and the width.
    expect(short).toEqual({ x: at.x, y: at.y + at.height - 96, width: at.width, height: 96 });
    // Its own resize, reported back as a move, is not a drag.
    s.win.frame(short);
    await s.win.rpc?.handlers.size({ height: 260 });
    const tall = s.win.moves.at(-1)?.to as Rect;
    expect(tall.y + tall.height).toBe(at.y + at.height);
    expect(tall.height).toBe(260);
    // The same height again moves nothing.
    const moves = s.win.moves.length;
    await s.win.rpc?.handlers.size({ height: 260 });
    expect(s.win.moves).toHaveLength(moves);
    // Dragged while tall: the place kept is the one it would have at the resting size.
    const dragged = { ...tall, x: tall.x - 100, y: tall.y - 50 };
    s.win.frame(dragged);
    s.to("off");
    expect(s.saved().pillPlaces?.[0]?.frame).toEqual(pillBase(dragged, "bottom"));
    expect(s.saved().pillPlaces?.[0]?.frame.height).toBe(PILL_SIZE.height);
    expect(await s.win.rpc?.handlers.layout({})).toEqual({ edge: "bottom" });
  });

  test("dictation off closes the window; a drag is remembered and restored at the next open", async () => {
    const s = await shellWith({ platform: "darwin" });
    const place = { x: 900, y: 500, width: PILL_SIZE.width, height: PILL_SIZE.height };
    s.win.frame(place);
    s.to("off");
    expect(s.win.closed).toBe(1);
    expect(s.saved()).toEqual({
      pillPlaces: [{ edge: "bottom", area: s.f.areas[0] as Rect, frame: place }],
    });
    s.to("idle");
    expect(s.opened.at(-1)?.frame).toEqual(place);
  });

  test("the single place of before opens where it was, and is written back as a per-display place", async () => {
    const place = { x: 900, y: 500, width: PILL_SIZE.width, height: PILL_SIZE.height };
    const s = await shellWith({ platform: "darwin", state: { pill: place, pillEdge: "bottom" } });
    expect(s.opened.at(-1)?.frame).toEqual(place);
    s.win.frame({ ...place, x: 800 });
    s.to("off");
    expect(s.saved()).toEqual({
      pillPlaces: [{ edge: "bottom", area: s.f.areas[0] as Rect, frame: { ...place, x: 800 } }],
    });
  });

  describe("DC-O1: the pill opens on the display of the window the text goes to", () => {
    const TWO: Rect[] = [
      { x: 0, y: 25, width: 1440, height: 850 },
      { x: 1440, y: 0, width: 1920, height: 1080 },
    ];
    const ON_SECOND = { x: 1600, y: 200, width: 1200, height: 700 };

    const twoDisplays = () => shellWith({ platform: "darwin", areas: TWO });

    test("a key-down in a window on the second display moves the pill there before the dot shows", async () => {
      const s = await twoDisplays();
      s.fd.tell({ kind: "press", on: true, frame: ON_SECOND });
      const there = placePill([], "bottom", TWO, TWO[1]);
      expect(s.win.moves).toEqual([{ to: there, visible: false }]);
      expect(s.win.visible).toBe(true);
      expect(s.r.states().at(-1)).toEqual({ state: "pressed" });
      // The move the OS reports back is the shell's own, not a drag: nothing is saved.
      s.win.frame(there);
      s.to("off");
      expect(s.saved()).toEqual({});
    });

    test("positive control: a window on the display the pill is on, or none known, moves nothing", async () => {
      const s = await twoDisplays();
      s.fd.tell({ kind: "press", on: true, frame: { x: 100, y: 100, width: 600, height: 400 } });
      s.fd.tell({ kind: "press", on: false, frame: null });
      s.fd.tell({ kind: "press", on: true, frame: null });
      expect(s.win.moves).toEqual([]);
      expect(s.r.states().at(-1)).toEqual({ state: "pressed" });
      // The same shell does move for the second display.
      s.fd.tell({ kind: "press", on: false, frame: null });
      s.fd.tell({ kind: "press", on: true, frame: ON_SECOND });
      expect(s.win.moves).toHaveLength(1);
    });

    test("a drag on the second display is its place there, and the primary keeps its own", async () => {
      const s = await twoDisplays();
      s.fd.tell({ kind: "press", on: true, frame: ON_SECOND });
      const dragged = { x: 2500, y: 700, width: PILL_SIZE.width, height: PILL_SIZE.height };
      s.win.frame(dragged);
      // Back to a window on the primary: its default place; then the second display again.
      s.fd.tell({ kind: "press", on: false, frame: null });
      s.fd.tell({ kind: "press", on: true, frame: { x: 10, y: 60, width: 500, height: 500 } });
      s.fd.tell({ kind: "press", on: false, frame: null });
      s.fd.tell({ kind: "press", on: true, frame: ON_SECOND });
      expect(s.win.moves.map((m) => m.to)).toEqual([
        placePill([], "bottom", TWO, TWO[1]),
        placePill([], "bottom", TWO),
        dragged,
      ]);
      // After a restart the second display's place is still there.
      s.to("off");
      expect(s.saved()).toEqual({
        pillPlaces: [{ edge: "bottom", area: TWO[1] as Rect, frame: dragged }],
      });
      // It opens again where it was dragged last, so a press with no frame (Linux) finds it there.
      s.to("idle");
      expect(s.opened.at(-1)?.frame).toEqual(dragged);
      s.fd.tell({ kind: "press", on: true, frame: { x: 10, y: 60, width: 500, height: 500 } });
      s.fd.tell({ kind: "press", on: false, frame: null });
      s.fd.tell({ kind: "press", on: true, frame: ON_SECOND });
      expect(s.win.moves.at(-1)?.to).toEqual(dragged);
    });
  });
});

describe("DC-O1: the pill over a whole app", () => {
  async function rig(
    o: Pick<RigOptions, "models" | "jobs"> & {
      settings?: Record<string, unknown>;
      helperArgs?: string[];
    } = {},
  ): Promise<AppRig> {
    const t = tempDir("akou-dict-pill-");
    cleanups.push(t.cleanup);
    const wav = join(t.dir, "mic.wav");
    writeFileSync(wav, monoWav(concat(speak(["hello"]), silence(3))));
    const r = await appRig({
      helperArgs: ["--wav", wav, ...(o.helperArgs ?? [])],
      // Named, since the default is off on Linux.
      settings: { "dictation.enabled": true, "dictation.pill": "bottom", ...o.settings },
      ...(o.models !== undefined ? { models: o.models } : {}),
      ...(o.jobs ? { jobs: o.jobs } : {}),
    });
    cleanups.push(() => r.close());
    await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
    return r;
  }

  /**
   * The real shell's pill over `r`, recording what the page is told and where the shell moved the
   * window, on the displays `areas` (one by default).
   */
  async function pillOver(r: AppRig, areas?: Rect[]) {
    const f = fakeUi();
    if (areas) f.areas = areas;
    const rec = recorder();
    const moves: Rect[] = [];
    let rpc: Parameters<NonNullable<NativeUi["openPill"]>>[0]["rpc"] | null = null;
    f.ui.openPill = (o) => {
      rpc = o.rpc;
      return {
        window: {
          setFrame: (to) => moves.push(to),
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
    return { f, rec, control, moves };
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

  // Two app rigs and two spoken dictations played in real time: about 3.7 s on every OS, and its
  // waits allow 10 s, so bun's 5 s default was never this test's budget.
  test("the helper's press names the window with the keyboard: the pill moves to its display, then the dot shows", async () => {
    const two: Rect[] = [
      { x: 0, y: 25, width: 1440, height: 850 },
      { x: 1440, y: 0, width: 1920, height: 1080 },
    ];
    const r = await rig({ helperArgs: ["--target-frame", "1600,200,900,700"] });
    const p = await pillOver(r, two);
    await dictate(p);
    expect(p.moves).toEqual([placePill([], "bottom", two, two[1])]);
    expect(p.rec.states()[0]).toEqual({ state: "pressed" });
    // Positive control: the same press with no frame (a helper that cannot tell) moves nothing.
    const plain = await pillOver(await rig(), two);
    await dictate(plain);
    expect(plain.moves).toEqual([]);
    expect(plain.rec.states()[0]).toEqual({ state: "pressed" });
  }, 20_000);

  // A whole app and a dictation in real time, about 2.2 s; its waits allow 10 s too.
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
    // The dot from the press, then the session's island.
    expect(p.rec.states().map((s) => s.state)).toEqual(["pressed", "listening", "transcribing"]);
    writeFileSync(gate, "");
    await until(
      () => p.rec.states().some((s) => s.state === "done"),
      10_000,
      "the insert once the model is ready",
    );
    expect(p.rec.states().at(-1)).toEqual({ state: "done", how: "inserted" });
    expect(r.app.dictation()?.log.items()[0]).toMatchObject({ state: "inserted", text: "hello" });
  }, 20_000);

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
          setFrame: () => {},
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
    expect(rec.states().map((s) => s.state)).toEqual([
      "pressed",
      "listening",
      "transcribing",
      "done",
    ]);
    expect(rec.states().at(-1)).toEqual({ state: "done", how: "inserted" });
    expect(r.app.dictation()?.log.items()[0]).toMatchObject({ text: "hello" });
    expect(rec.sent.some((m) => JSON.stringify(m.payload).includes("hello"))).toBe(false);
    await until(() => !visible, 5000, "the pill to hide after its time");
  });
});
