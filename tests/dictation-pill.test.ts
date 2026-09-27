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
import type { DictationFollow } from "../src/main/dictation/service.ts";
import { Bridge } from "../src/main/window/bridge.ts";
import { hotkeyLabel } from "../src/main/window/hotkey.ts";
import {
  DONE_MS,
  ERROR_MS,
  LOADING_NOTE,
  levelDb,
  type PillDictation,
  type PillSend,
  pillRpc,
} from "../src/main/window/pill.ts";
import {
  appForShell,
  type NativeUi,
  PILL_SIZE,
  type PillStyle,
  placePill,
  type Rect,
  Shell,
  type ShellApp,
  type ShellState,
} from "../src/main/window/shell.ts";
import { fileState } from "../src/main/window/state.ts";
import type { PillState } from "../src/ui/pill-protocol.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
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
  let seq = 0;
  const d: PillDictation = {
    status: () => ({ ...st }),
    follow: (fn) => {
      followers.add(fn);
      return () => followers.delete(fn);
    },
    control: async (a) => {
      controls.push(a);
      return true;
    },
  };
  const tell = (m: DictationFollow) => {
    for (const fn of followers) fn(m);
  };
  const event = (draft: DictationDraft) =>
    tell({ kind: "event", e: { ...draft, v: 1, seq: ++seq, t: seq } as DictationEvent });
  return { d, st, controls, tell, event, followers };
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

function pill(o: { preview?: unknown; hidden?: boolean; platform?: string } = {}) {
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
    preview: { setting: () => o.preview ?? false, hiddenFromCapture: () => o.hidden ?? false },
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
      keys: ["escape"],
      hotkey: "Right ⌘",
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
    expect(f.states().at(-1)).toEqual({ state: "done", how: "copied", note: "copied, press ⌘V" });
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

describe("DC-D2, DC-O2: no message to the pill carries the dictated words", () => {
  const SAID = "the launch code is swordfish";

  /** A whole session whose transcript is `SAID`, with a partial of it while listening. */
  function session(o: { preview?: unknown; hidden?: boolean }) {
    const f = pill(o);
    f.to("listening");
    f.tell({ kind: "level", rms: 0.2 });
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
    const f = session({ preview: false, hidden: true });
    expect(f.sent.length).toBeGreaterThan(3);
    expect(carries(f)).toBe(false);
    expect(f.sent.some((m) => m.name === "preview")).toBe(false);
  });

  test("with the preview on and the window not hidden from capture, the same", () => {
    expect(carries(session({ preview: true, hidden: false }))).toBe(false);
  });

  test("positive control: the preview on and the window hidden from capture sends the partial", () => {
    const f = session({ preview: true, hidden: true });
    expect(f.sent.filter((m) => m.name === "preview")).toEqual([
      { name: "preview", payload: { text: SAID } },
    ]);
    expect(carries(f)).toBe(true);
  });
});

describe("DC-O1: the pill's window", () => {
  const AREAS: Rect[] = [
    { x: 0, y: 25, width: 1440, height: 850 },
    { x: 1440, y: 0, width: 1920, height: 1080 },
  ];

  test("each edge centres it on that side of the primary work area", () => {
    const { width, height } = PILL_SIZE;
    expect(placePill({}, "bottom", AREAS)).toEqual({ x: 500, y: 875 - height - 24, width, height });
    expect(placePill({}, "top", AREAS)).toEqual({ x: 500, y: 49, width, height });
    expect(placePill({}, "left", AREAS)).toEqual({ x: 24, y: 384, width, height });
    expect(placePill({}, "right", AREAS)).toEqual({ x: 1440 - width - 24, y: 384, width, height });
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
    return { shell, opened, win, r, to, settings, saved: () => saved, fd, logs, f };
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
    // Nothing is left following the session for a window that never opened.
    expect(s.fd.followers.size).toBe(0);
    await until(() => s.f.title() === "● dictating", 1000, "the tray to say dictating");
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
  async function rig(): Promise<AppRig> {
    const t = tempDir("akou-dict-pill-");
    cleanups.push(t.cleanup);
    const wav = join(t.dir, "mic.wav");
    writeFileSync(wav, monoWav(concat(speak(["hello"]), silence(3))));
    const r = await appRig({
      helperArgs: ["--wav", wav],
      settings: { "dictation.enabled": true },
    });
    cleanups.push(() => r.close());
    await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
    return r;
  }

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
