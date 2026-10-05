/**
 * Why the dictation key does nothing, said on the island (docs/ux/DICTATION.md DC-N1, DC-A2): the
 * helper lost the Accessibility grant it started with, which on macOS kills the key tap, or Secure
 * Input keeps a keyed chord from the tap while a modifier alone still reaches it. The pill's main
 * side runs over a hand-driven dictation first, then over a whole app with the fake helper, which
 * reads its grants from a file the test changes as the OS would; nothing opens a device, presses a
 * key or opens System Settings.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import type { DictationDraft, DictationEvent } from "../src/core/dictation/events.ts";
import { REGRANT_POLL_MS } from "../src/main/dictation/service.ts";
import { Bridge } from "../src/main/window/bridge.ts";
import { hotkeyLabel } from "../src/main/window/hotkey.ts";
import {
  DONE_MS,
  keyedChord,
  NOTICE_MS,
  type PillDictation,
  type PillSend,
  pillRpc,
  SECURE_REPEAT_MS,
} from "../src/main/window/pill.ts";
import { type WindowSend, windowRpc } from "../src/main/window/rpc.ts";
import { appForShell, type NativeUi, Shell } from "../src/main/window/shell.ts";
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

type Follow = Parameters<PillDictation["follow"]>[0];

/** The pill's main side over a dictation driven by hand, its timers and clock run by the test. */
function pill(o: { platform?: string; hotkey?: string; grant?: boolean } = {}) {
  const st: { state: string; lost?: string[] } = { state: "idle" };
  const followers = new Set<Follow>();
  const d: PillDictation = {
    status: () => ({
      state: st.state,
      loading: false,
      swallow_keys: true,
      ...(st.lost ? { lost: st.lost } : {}),
    }),
    follow: (fn) => {
      followers.add(fn);
      return () => followers.delete(fn);
    },
    control: async () => true,
  };
  const states: PillState[] = [];
  const send: PillSend = {
    state: (s) => states.push(s),
    level: () => {},
    preview: () => {},
    chip: () => {},
  };
  const due: { ms: number; fn: () => void; live: boolean }[] = [];
  const clock = { now: 1_000_000 };
  const panes: number[] = [];
  const visible: boolean[] = [];
  const p = pillRpc(d, () => send, {
    platform: o.platform ?? "darwin",
    hotkey: () => o.hotkey ?? "Command+Shift+D",
    label: hotkeyLabel,
    now: () => clock.now,
    onVisible: (v) => visible.push(v),
    preview: { setting: () => false },
    later: (ms, fn) => {
      const t = { ms, fn, live: true };
      due.push(t);
      return () => {
        t.live = false;
      };
    },
    ...(o.grant === false
      ? {}
      : {
          grant: async () => {
            panes.push(clock.now);
            return true;
          },
        }),
  });
  cleanups.push(() => p.close());
  const tell = (m: Parameters<Follow>[0]) => {
    for (const fn of followers) fn(m);
  };
  const run = (ms: number) => {
    for (const t of due.splice(0)) if (t.live && t.ms === ms) t.fn();
  };
  const to = (state: string) => {
    st.state = state;
    p.update();
  };
  let seq = 0;
  const event = (draft: DictationDraft) =>
    tell({ kind: "event", e: { ...draft, v: 1, seq: ++seq, t: seq } as DictationEvent });
  /** Timers still due: what would fire if the test ran them. */
  const pending = () => due.filter((t) => t.live).map((t) => t.ms);
  return { p, tell, states, run, clock, panes, visible, to, st, event, pending };
}

const TARGET = { app: "com.example.editor", pid: 1, window: "w1", field: "editable" } as const;

describe("DC-N1: the Accessibility grant lost after the start", () => {
  test("the island says the key does nothing, with the pane's button, for its time", async () => {
    const f = pill({ hotkey: "RightCommand" });
    f.tell({ kind: "grant-lost", name: "accessibility" });
    expect(f.states.at(-1)).toEqual({
      state: "notice",
      reason: "grant-lost",
      message: "Right ⌘ does nothing without Accessibility",
      detail:
        "macOS took the grant back. Turn akou on under Accessibility and dictation starts again.",
      actions: ["grant"],
    });
    expect(f.visible.at(-1)).toBe(true);
    // The helper going idle again does not take it down before its time.
    f.to("idle");
    expect(f.p.shown().state).toBe("notice");
    f.run(NOTICE_MS);
    expect(f.p.shown()).toEqual({ state: "hidden" });
    expect(f.visible.at(-1)).toBe(false);
  });

  test("over a session the island keeps its Stop and its outcome; the notice shows once it is free", () => {
    const f = pill({ hotkey: "RightCommand" });
    f.to("listening");
    f.tell({ kind: "grant-lost", name: "accessibility" });
    // With a dead tap, the listening island's Stop is the only way out of a latched session.
    expect(f.p.shown().state).toBe("listening");
    expect(f.pending()).toEqual([]);
    f.event({ type: "dictation.started", id: "d1", target: TARGET, engine: "fast", by: "user" });
    f.to("transcribing");
    expect(f.p.shown().state).toBe("transcribing");
    // Nothing is due to hide the island under the session.
    expect(f.pending()).toEqual([]);
    f.event({ type: "dictation.inserted", id: "d1", method: "paste", receipt_ms: 5 });
    f.to("idle");
    expect(f.p.shown()).toEqual({ state: "done", how: "inserted" });
    f.run(DONE_MS);
    expect(f.p.shown()).toMatchObject({
      state: "notice",
      reason: "grant-lost",
      actions: ["grant"],
    });
    expect(f.visible.at(-1)).toBe(true);
    f.run(NOTICE_MS);
    expect(f.p.shown()).toEqual({ state: "hidden" });
  });

  test("a session cancelled shows it at once; a grant back by then shows nothing", () => {
    const f = pill();
    f.to("listening");
    f.tell({ kind: "grant-lost", name: "accessibility" });
    f.to("idle");
    expect(f.p.shown()).toMatchObject({ state: "notice", reason: "grant-lost" });

    // The app read the grant back and started the helper again while the session ran.
    const back = pill();
    back.st.lost = ["accessibility"];
    back.to("listening");
    back.tell({ kind: "grant-lost", name: "accessibility" });
    back.st.lost = [];
    back.to("idle");
    expect(back.p.shown()).toEqual({ state: "hidden" });
    expect(back.states.map((s) => s.state)).toEqual(["listening", "hidden"]);
  });

  test("its button opens the pane and takes the notice down; with nothing up it does nothing", async () => {
    const f = pill();
    expect(await f.p.handlers.control({ action: "grant" })).toBe(false);
    expect(f.panes).toHaveLength(0);
    f.tell({ kind: "grant-lost", name: "accessibility" });
    expect(await f.p.handlers.control({ action: "grant" })).toBe(true);
    expect(f.panes).toHaveLength(1);
    expect(f.p.shown()).toEqual({ state: "hidden" });
  });

  test("with no way to open the pane the notice offers no button", () => {
    const f = pill({ grant: false });
    f.tell({ kind: "grant-lost", name: "accessibility" });
    expect(f.p.shown()).toMatchObject({ state: "notice", reason: "grant-lost", actions: [] });
  });

  test("only macOS's Accessibility grant: another grant or another OS leaves the island alone", () => {
    const mic = pill();
    mic.tell({ kind: "grant-lost", name: "mic" });
    const linux = pill({ platform: "linux" });
    linux.tell({ kind: "grant-lost", name: "accessibility" });
    expect([...mic.states, ...linux.states]).toEqual([]);
    // Positive control: the same message on macOS shows.
    const mac = pill();
    mac.tell({ kind: "grant-lost", name: "accessibility" });
    expect(mac.states.map((s) => s.state)).toEqual(["notice"]);
  });
});

describe("DC-A2: Secure Input keeps a keyed chord from the tap", () => {
  test("a keyed chord gets the notice when Secure Input turns on, and loses it when it turns off", () => {
    const f = pill({ hotkey: "Command+Shift+D" });
    f.tell({ kind: "secure-input", on: true });
    expect(f.states.at(-1)).toEqual({
      state: "notice",
      reason: "secure-input",
      message: "⌘⇧D cannot reach akou while Secure Input is on",
      detail:
        "A password field or a terminal’s secure entry holds the keyboard. A key alone, such as Right ⌘, still works.",
      actions: [],
    });
    f.tell({ kind: "secure-input", on: false });
    expect(f.p.shown()).toEqual({ state: "hidden" });
  });

  test("a key alone still works under Secure Input, so it gets no notice", () => {
    for (const hotkey of ["RightCommand", "Fn"]) {
      const f = pill({ hotkey });
      f.tell({ kind: "secure-input", on: true });
      expect(f.states).toEqual([]);
    }
    expect(keyedChord("Command+Shift+D")).toBe(true);
    expect(keyedChord("RightCommand")).toBe(false);
    expect(keyedChord("not a key+")).toBe(false);
  });

  test("it comes back at most once per SECURE_REPEAT_MS, as a terminal turns it on at every switch", () => {
    const f = pill();
    f.tell({ kind: "secure-input", on: true });
    f.tell({ kind: "secure-input", on: false });
    f.clock.now += SECURE_REPEAT_MS - 1;
    f.tell({ kind: "secure-input", on: true });
    expect(f.states.map((s) => s.state)).toEqual(["notice", "hidden"]);
    f.tell({ kind: "secure-input", on: false });
    f.clock.now += 1;
    f.tell({ kind: "secure-input", on: true });
    expect(f.states.map((s) => s.state)).toEqual(["notice", "hidden", "notice"]);
  });

  test("never over a session or its outcome, and a notice only off macOS never", () => {
    const f = pill();
    f.to("listening");
    f.tell({ kind: "secure-input", on: true });
    expect(f.p.shown().state).toBe("listening");
    // Turning off does not take down a state that is not its notice.
    f.tell({ kind: "secure-input", on: false });
    expect(f.p.shown().state).toBe("listening");
    const linux = pill({ platform: "linux" });
    linux.tell({ kind: "secure-input", on: true });
    expect(linux.states).toEqual([]);
  });

  test("a session that comes straight to transcribing is not hidden by the notice's timer", () => {
    const f = pill();
    f.tell({ kind: "secure-input", on: true });
    expect(f.p.shown().state).toBe("notice");
    // A tap too short for the watch to see it listening: the session is transcribing next.
    f.to("transcribing");
    f.run(NOTICE_MS);
    expect(f.p.shown().state).toBe("transcribing");
    expect(f.visible.at(-1)).toBe(true);
  });

  test("never over a learn chip, which keeps the island to itself", () => {
    const f = pill();
    f.tell({
      kind: "chip",
      chip: { id: "d1", candidates: [{ term: "Kubernetes", heard: "kubernetis" }], mode: "ask" },
    });
    f.tell({ kind: "secure-input", on: true });
    expect(f.states).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Over a whole app with the fake helper

const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** The app with dictation on, the fake helper given `args`, and the real shell's pill over it. */
async function pillApp(settings: Record<string, unknown>, args: string[]) {
  const t = tempDir("akou-dict-notice-");
  cleanups.push(t.cleanup);
  const wav = join(t.dir, "mic.wav");
  writeFileSync(wav, monoWav(concat(silence(1), speak(["hello"]), silence(3))));
  const r: AppRig = await appRig({
    helperArgs: ["--wav", wav, ...args],
    settings: { "dictation.enabled": true, "dictation.pill": "top", ...settings },
  });
  cleanups.push(() => r.close());
  await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
  const f = fakeUi();
  const states: PillState[] = [];
  let rpc: Parameters<NonNullable<NativeUi["openPill"]>>[0]["rpc"] | null = null;
  f.ui.openPill = (o) => {
    rpc = o.rpc;
    return {
      window: {
        setFrame: () => {},
        showInactive: () => {},
        hide: () => {},
        close: () => {},
        onClose: () => {},
        onFrame: () => {},
      },
      send: {
        state: (s) => states.push(s),
        level: () => {},
        preview: () => {},
        chip: () => {},
      },
    };
  };
  const panes: string[] = [];
  // The pane's button is spied on: no test opens System Settings.
  const app = {
    ...appForShell(r.app),
    openSettingsPane: async (pane: string) => {
      panes.push(pane);
      return true;
    },
  };
  const shell = new Shell(app, new Bridge(r.app), f.ui, {
    platform: "darwin",
    setLoginItem: async () => {},
  });
  cleanups.push(() => shell.close());
  await shell.start();
  await until(() => rpc !== null, 5000, "the pill's window");
  const control = (action: string) =>
    (rpc as unknown as { handlers: { control: (p: object) => Promise<boolean> } }).handlers.control(
      { action },
    );
  return { r, dir: t.dir, states, control, panes };
}

describe("DC-A2 over a whole app: Secure Input on, the fake helper hears modifiers only", () => {
  /**
   * `hotkey` bound, Secure Input turned on at key time `secureAt` (none: never), and `keys` held
   * from 0.9 s to 2.0 s, played after the test's own `rebind`, once the pill follows.
   */
  async function press(hotkey: string, keys: string[], secureAt: number | null) {
    const t = tempDir("akou-dict-secure-");
    cleanups.push(t.cleanup);
    const script: KeyInput[] = [
      ...keys.map((key) => ({ at: 900, key, down: true })),
      ...keys.toReversed().map((key) => ({ at: 2000, key, down: false })),
    ];
    const keysFile = join(t.dir, "keys.jsonl");
    writeFileSync(keysFile, script.map((k) => JSON.stringify(k)).join("\n"));
    const tap = join(t.dir, "tap.jsonl");
    const a = await pillApp({ "dictation.hotkey": hotkey }, [
      "--keys",
      keysFile,
      "--play-after-rebinds",
      "2",
      "--tap-log",
      tap,
      ...(secureAt === null ? [] : ["--secure-input-at", String(secureAt)]),
    ]);
    const d = a.r.app.dictation();
    expect(await d?.rebind()).toEqual({ ok: true });
    await until(() => lines(tap).length === script.length, 5000, "every key played");
    return { ...a, tap: lines(tap), d };
  }

  // Keys played in real time from 0.9 s to 2 s after a whole app starts: about 2.5 s on every OS,
  // and the waits allow 10 s, so bun's 5 s default was never these tests' budget.
  test("a keyed chord starts nothing and the island says why", async () => {
    const s = await press("Command+Shift+D", ["LeftCommand", "LeftShift", "D"], 0);
    await until(() => s.states.some((x) => x.state === "notice"), 5000, "the notice");
    expect(s.states.find((x) => x.state === "notice")).toMatchObject({
      reason: "secure-input",
      message: `${hotkeyLabel("Command+Shift+D", "darwin")} cannot reach akou while Secure Input is on`,
    });
    // macOS handed the tap the modifiers only; the D never reached the rule.
    expect(s.tap.filter((k) => k.lost === "secure-input").map((k) => k.key)).toEqual(["D", "D"]);
    await Bun.sleep(500);
    expect(s.d?.log.items()).toEqual([]);
    expect(s.states.some((x) => x.state === "listening")).toBe(false);
  }, 20_000);

  test("a modifier alone still starts a session under Secure Input", async () => {
    const s = await press("RightCommand", ["RightCommand"], 0);
    await until(() => s.states.some((x) => x.state === "done"), 10_000, "the dictation done");
    // Secure Input on at the key-down: the secure-field guard copies the text, never pastes it and
    // keeps no words of it (DC-N8).
    expect(s.states.map((x) => x.state)).toEqual(["pressed", "listening", "transcribing", "done"]);
    expect(s.states.at(-1)).toEqual({ state: "done", how: "copied", note: "⌘V" });
    expect(s.d?.log.items()[0]).toMatchObject({ state: "inserted", text: null });
  }, 20_000);

  test("control: the same chord with Secure Input off starts a session", async () => {
    const s = await press("Command+Shift+D", ["LeftCommand", "LeftShift", "D"], null);
    await until(() => s.d?.log.items()[0]?.state === "inserted", 10_000, "the dictation inserted");
    expect(s.states.some((x) => x.state === "notice")).toBe(false);
  }, 20_000);
});

describe("DC-N1 over a whole app: the grant taken back and given again", () => {
  test("the island and GET /dictation say it is lost, and the helper starts again once it is back", async () => {
    const t = tempDir("akou-dict-grant-");
    cleanups.push(t.cleanup);
    const grants = join(t.dir, "grants");
    writeFileSync(grants, "mic,accessibility");
    const a = await pillApp({}, ["--grants-file", grants]);
    const d = a.r.app.dictation();
    const before = d?.session();
    expect(d?.status().lost).toEqual([]);
    // The key recorder's `Use Fn` asks whether the helper hears keys (DC-N2).
    const win = windowRpc(
      { app: { dictation: () => d }, watchLifecycle: () => () => {} } as unknown as Bridge,
      () => ({ dictationKey: () => {} }) as unknown as WindowSend,
      async () => false,
    );
    cleanups.push(() => win.close());
    const hears = () => win.handlers.recordDictationKeys({ on: true });
    expect(await hears()).toBe(true);

    // The OS takes the grant back: the fake says `grant.lost`, as the real helper does on wake.
    writeFileSync(grants, "mic");
    await until(() => a.states.some((x) => x.state === "notice"), 5000, "the notice");
    expect(a.states.find((x) => x.state === "notice")).toMatchObject({
      reason: "grant-lost",
      actions: ["grant"],
    });
    const res = await a.r.api("GET", "/dictation");
    expect(res.body).toMatchObject({
      grants: { mic: "granted", accessibility: "denied" },
      lost: ["accessibility"],
    });
    // The dead tap hears no Fn: the recorder must not blame the keyboard.
    expect(await hears()).toBe(false);
    // Its button reaches the Accessibility pane through the app (spied on here).
    expect(await a.control("grant")).toBe(true);
    expect(a.panes).toEqual(["accessibility"]);
    // Still lost, no page asking: the app reads the grants by itself and waits.
    await Bun.sleep(REGRANT_POLL_MS + 500);
    expect(d?.session()).toBe(before);

    // Given again: the next read starts the helper again, whose tap works, with nothing lost.
    writeFileSync(grants, "mic,accessibility");
    await until(
      () => d?.session() !== before && d?.status().state === "idle",
      REGRANT_POLL_MS * 3 + 5000,
      "the helper started again",
    );
    expect(d?.status()).toMatchObject({
      lost: [],
      grants: { mic: "granted", accessibility: "granted" },
    });
    expect(a.r.logs.some((l) => l.msg.includes("a grant arrived since the helper started"))).toBe(
      true,
    );
    expect(await hears()).toBe(true);
  }, 30_000);
});
