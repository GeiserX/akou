/**
 * The tray while a call is live (docs/ux/DESKTOP.md DK-T2, DK-T3, DK-T4, DK-L2): the elapsed time
 * in the macOS title, the menu's header, health warning, Pause or Resume, Stop and Ask about this
 * call, and the login item applied from Settings. The shell runs over the fake `NativeUi`; the
 * whole-app cases run the fake capture helper.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import type { Bridge } from "../src/main/window/bridge.ts";
import {
  hoursMinutes,
  minutesText,
  nextMinuteIn,
  Shell,
  type ShellApp,
  TRAY_TITLE_MAX,
  type TrayMenuItem,
  trayMenu,
  trayTitle,
} from "../src/main/window/shell.ts";
import type { AppStatus } from "../src/ui/protocol.ts";
import { appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { fakeUi, shellOn } from "./shell-helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const MIN = 60_000;
const START = 1_700_000_000_000;

type Live = NonNullable<AppStatus["live"]>;
function live(o: Partial<Live> = {}): Live {
  return {
    call: "c1",
    title: "Weekly sync",
    workspace: "work",
    state: "recording",
    muted: false,
    lag: 0,
    startedAt: START,
    lost: [],
    ...o,
  };
}

/** The menu as its labels, a separator as `---`. */
const shape = (items: TrayMenuItem[]) =>
  items.map((i) => (i.type === "separator" ? "---" : i.label));

describe("DK-T3: the elapsed time in the macOS tray title", () => {
  const share = { active: false };

  test("h:mm from the call's first part, macOS only", () => {
    const at = (ms: number, platform = "darwin") =>
      trayTitle({ live: live(), share }, undefined, { platform, now: START + ms });
    expect(at(23 * MIN + 10_000)).toBe("0:23");
    expect(at(30_000)).toBe("0:00");
    expect(at(65 * MIN)).toBe("1:05");
    expect(at(10 * 60 * MIN + 59_999)).toBe("10:00");
    // Windows draws no title beside the icon, and an AppIndicator label shows on some panels only.
    expect(at(23 * MIN, "linux")).toBe("");
    expect(at(23 * MIN, "win32")).toBe("");
    // No first part yet, or no clock: no time to show.
    expect(
      trayTitle({ live: live({ startedAt: null }), share }, undefined, {
        platform: "darwin",
        now: START,
      }),
    ).toBe("");
    expect(trayTitle({ live: live(), share }, undefined, { platform: "darwin" })).toBe("");
    // A clock that reads before the start shows none of a negative time.
    expect(at(-5 * MIN)).toBe("0:00");
  });

  test("paused keeps its bars, and a dictation and a share keep priority over the time", () => {
    const o = { platform: "darwin", now: START + 23 * MIN };
    expect(trayTitle({ live: live({ state: "paused" }), share }, undefined, o)).toBe("❚❚");
    expect(trayTitle({ live: live(), share }, "listening", o)).toBe("● dictating");
    expect(trayTitle({ live: live(), share }, "transcribing", o)).toBe("… transcribing");
    expect(trayTitle({ live: live(), share: { active: true } }, undefined, o)).toBe("● shared");
    expect(trayTitle({ live: live(), share }, "idle", o)).toBe("0:23");
  });

  test("the tray moves once a minute, on the call's own minute", () => {
    expect(nextMinuteIn(START, START)).toBe(MIN);
    expect(nextMinuteIn(START, START + 23 * MIN + 10_000)).toBe(50_000);
    expect(nextMinuteIn(START, START + 2 * MIN)).toBe(MIN);
    expect(hoursMinutes(59 * MIN + 59_999)).toBe("0:59");
    expect(minutesText(0)).toBe("under 1 min");
    expect(minutesText(23 * MIN + 59_000)).toBe("23 min");
    expect(minutesText(60 * MIN)).toBe("1 h");
    expect(minutesText(65 * MIN)).toBe("1 h 5 min");
  });
});

describe("DK-T4: the tray menu", () => {
  const now = START + 23 * MIN + 10_000;

  test("live: the call's header, Pause, Stop and Ask, then dictation, Show and Quit", () => {
    expect(
      shape(trayMenu({ live: live(), now, dictation: "idle", dictationKey: "⌘ Right" })),
    ).toEqual([
      "Weekly sync · work · 23 min",
      "---",
      "❚❚ Pause",
      "■ Stop recording",
      "---",
      "Ask about this call…",
      "---",
      "Start dictation (⌘ Right)",
      "Show akou",
      "---",
      "Quit akou",
    ]);
    const m = trayMenu({ live: live(), now });
    // The header says what records; it is not a control.
    expect(m[0]).toMatchObject({ type: "normal", enabled: false });
    const action = (label: string) =>
      m.find((i) => i.type === "normal" && i.label === label) as { action: string } | undefined;
    expect(action("❚❚ Pause")?.action).toBe("pause");
    expect(action("■ Stop recording")?.action).toBe("stop");
    expect(action("Ask about this call…")?.action).toBe("ask");
  });

  test("paused offers Resume; a dead side gets a warning line; idle is Record", () => {
    const paused = trayMenu({ live: live({ state: "paused" }), now });
    expect(shape(paused)).toContain("▶ Resume");
    expect(shape(paused)).not.toContain("❚❚ Pause");
    expect(paused.find((i) => i.type === "normal" && i.label === "▶ Resume")).toMatchObject({
      action: "resume",
    });

    const dead = trayMenu({ live: live({ lost: ["call", "mic"] }), now });
    expect(shape(dead).slice(0, 4)).toEqual([
      "Weekly sync · work · 23 min",
      "⚠ System audio lost",
      "⚠ Microphone lost",
      "---",
    ]);
    for (const i of dead.slice(1, 3)) expect(i).toMatchObject({ enabled: false });
    // Positive control: a healthy call has no warning line.
    expect(shape(trayMenu({ live: live(), now })).some((l) => l.startsWith("⚠"))).toBe(false);

    expect(shape(trayMenu({ live: null }))).toEqual(["● Record", "Show akou", "---", "Quit akou"]);
    // Open at login is in Settings, never the tray.
    for (const m of [trayMenu({ live: null }), trayMenu({ live: live(), now }), paused, dead]) {
      expect(shape(m)).not.toContain("Open at login");
      expect(m.some((i) => i.type === "normal" && i.action === "login")).toBe(false);
    }
  });

  test("the header cuts a long title, names an untitled call, and leaves out what it lacks", () => {
    const long = "Quarterly planning for the new onboarding flow and the pricing page";
    const [head] = shape(trayMenu({ live: live({ title: long }), now }));
    const title = (head ?? "").split(" · ")[0] ?? "";
    expect(title.length).toBe(TRAY_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(shape(trayMenu({ live: live({ title: " " }), now }))[0]).toBe(
      "Untitled call · work · 23 min",
    );
    expect(shape(trayMenu({ live: live({ workspace: "", startedAt: null }), now }))[0]).toBe(
      "Weekly sync",
    );
  });
});

describe("the tray over a fake app", () => {
  function fakeApp() {
    const state = { live: true, paused: false, calls: [] as string[], windows: 0 };
    let shell: Shell | null = null;
    const app: ShellApp = {
      status: async () => ({
        live: state.live ? live({ state: state.paused ? "paused" : "recording" }) : null,
        share: { active: false },
      }),
      start: async () => ({ ok: true, call: "c1" }),
      stopLive: async () => {
        state.calls.push("stop");
      },
      pauseLive: async () => {
        state.calls.push("pause");
        state.paused = true;
      },
      resumeLive: async () => {
        state.calls.push("resume");
        state.paused = false;
      },
      config: () => ({ settings: { "app.hotkey": "", "app.openAtLogin": false } }),
      quit: async () => {},
      openSettingsPane: async () => false,
      openWindow: async (call) => {
        state.windows++;
        shell?.show(call);
      },
      onAnnounce: () => () => {},
    };
    return { app, state, bind: (s: Shell) => (shell = s) };
  }

  function bridge(): { bridge: Bridge; lifecycle: () => void } {
    const b = { fire: () => {} };
    return {
      bridge: {
        watchLifecycle: (fn: () => void) => {
          b.fire = fn;
          return () => {};
        },
        app: { status: async () => ({}), watch: () => () => {} },
      } as unknown as Bridge,
      lifecycle: () => b.fire(),
    };
  }

  test("Pause and Resume call the app's pause and resume; the menu follows", async () => {
    const f = fakeUi();
    const a = fakeApp();
    const b = bridge();
    const shell = new Shell(a.app, b.bridge, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
      now: () => START + 5 * MIN,
    });
    cleanups.push(() => shell.close());
    await shell.start();
    const labels = () => shape(f.trayMenu() as TrayMenuItem[]);
    expect(labels()[0]).toBe("Weekly sync · work · 5 min");
    expect(f.title()).toBe("0:05");
    f.tray("pause");
    await until(() => a.state.calls.includes("pause"), 1000, "pause");
    b.lifecycle();
    await until(() => labels().includes("▶ Resume"), 1000, "the Resume item");
    expect(f.title()).toBe("❚❚");
    f.tray("resume");
    await until(() => a.state.calls.includes("resume"), 1000, "resume");
    b.lifecycle();
    await until(() => labels().includes("❚❚ Pause"), 1000, "the Pause item");
    expect(f.title()).toBe("0:05");
  });

  test("Ask about this call opens the window on the live call and asks the page to focus the ask box", async () => {
    const f = fakeUi();
    const a = fakeApp();
    const shell = new Shell(a.app, bridge().bridge, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
    });
    a.bind(shell);
    cleanups.push(() => shell.close());
    await shell.start();
    f.tray("ask");
    await until(() => a.state.windows === 1, 1000, "the window");
    // The page is still loading: the message waits for its boot.
    expect(f.log).not.toContain("call c1 ask");
    await f.boot();
    expect(f.log.filter((l) => l.startsWith("call "))).toEqual(["call c1 ask"]);
  });

  test("the title and header move at the call's next minute with no event, and stop with the call", async () => {
    const f = fakeUi();
    const a = fakeApp();
    // 80 ms before the call's 23rd minute.
    let now = START + 23 * MIN - 80;
    const shell = new Shell(a.app, bridge().bridge, f.ui, {
      platform: "darwin",
      setLoginItem: async () => {},
      now: () => now,
    });
    cleanups.push(() => shell.close());
    await shell.start();
    expect(f.title()).toBe("0:22");
    now += 100;
    await until(() => f.title() === "0:23", 2000, "the next minute");
    expect(shape(f.trayMenu() as TrayMenuItem[])[0]).toBe("Weekly sync · work · 23 min");
    // Closed: no timer is left to refresh a tray that is gone.
    await shell.close();
    const menus = f.trayMenu();
    now += MIN;
    await Bun.sleep(200);
    expect(f.trayMenu()).toBe(menus);
  });
});

describe("over a whole app", () => {
  test("the status carries the call's start from its log and the sides that record nothing", async () => {
    const rig = await appRig();
    cleanups.push(() => rig.close());
    const id = await rig.startCall({ title: "Weekly sync" });
    const events = () =>
      readFileSync(join(rig.app.manager.summary(id)?.dir as string, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as LogEvent);
    await until(() => events().some((e) => e.type === "part.started"), 10_000, "recording");
    const part = events().find((e) => e.type === "part.started") as Extract<
      LogEvent,
      { type: "part.started" }
    >;
    const status = async () => (await rig.app.status()).live as Live;
    // From the log, not from this process: an app restarted mid-call reads the same start.
    expect((await status()).startedAt).toBe(part.wallStart);
    expect((await status()).lost).toEqual([]);
    await rig.app.write(id, {
      type: "health",
      part: part.part,
      ch: "call",
      state: "dead",
      silentFor: 12,
      rebuilds: 0,
      detail: "",
    });
    await until(async () => (await status()).lost?.includes("call") === true, 2000, "lost");
    expect((await status()).lost).toEqual(["call"]);
  }, 30_000);

  test("[DK-L2] PATCH /config app.openAtLogin applies the login item at once, from Settings or the CLI", async () => {
    const rig = await appRig();
    cleanups.push(() => rig.close());
    const logins: boolean[] = [];
    const { shell } = await shellOn(rig, { setLoginItem: async (on) => logins.push(on) });
    cleanups.push(() => shell.close());
    expect(logins).toEqual([false]);
    expect((await rig.api("PATCH", "/config", { "app.openAtLogin": true })).status).toBe(200);
    await until(() => logins.length === 2, 2000, "the login item on");
    expect(logins).toEqual([false, true]);
    // Another key changes nothing for the login item.
    expect((await rig.api("PATCH", "/config", { "user.name": "Bea" })).status).toBe(200);
    await Bun.sleep(200);
    expect(logins).toEqual([false, true]);
    expect((await rig.api("PATCH", "/config", { "app.openAtLogin": false })).status).toBe(200);
    await until(() => logins.length === 3, 2000, "the login item off");
    expect(logins).toEqual([false, true, false]);
  }, 30_000);
});
