/**
 * The tray carries dictation (docs/ux/DICTATION.md DC-O4): its title says `listening` and
 * `transcribing` whatever the pill setting, and its menu starts and stops a dictation through the
 * same session door as `POST /v1/dictation/start`. The shell runs over the fake `NativeUi`; the
 * whole-app case runs the fake helper, so no key, device or clipboard is touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bridge } from "../src/main/window/bridge.ts";
import { Shell, type ShellApp, trayMenu, trayTitle } from "../src/main/window/shell.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";
import { fakeUi, shellOn } from "./shell-helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const labels = (items: unknown[]) =>
  (items as { label?: string; action?: string }[]).map((i) => i.label).filter(Boolean);

describe("DC-O4: the tray's dictation item and title", () => {
  test("the menu starts in idle, stops while listening, and has no item while off", () => {
    const find = (d?: string) =>
      trayMenu({ live: false, openAtLogin: false, dictation: d }).filter(
        (i) => i.type === "normal" && i.action.startsWith("dictate"),
      );
    expect(find("idle")).toEqual([{ type: "normal", label: "Start dictation", action: "dictate" }]);
    expect(find("listening")).toEqual([
      { type: "normal", label: "■ Stop dictation", action: "dictate-stop" },
    ]);
    expect(find("off")).toEqual([]);
    expect(find(undefined)).toEqual([]);
    const busy = trayMenu({ live: false, openAtLogin: false, dictation: "transcribing" });
    expect(
      busy.find((i) => i.type === "normal" && i.label.startsWith("Transcribing")),
    ).toMatchObject({ enabled: false });
  });

  test("the title shows listening and transcribing over a call's own title", () => {
    const rec = { live: { state: "recording" } as never, share: { active: false } };
    expect(trayTitle(rec, "listening")).toBe("● dictating");
    expect(trayTitle(rec, "transcribing")).toBe("… transcribing");
    expect(trayTitle(rec, "inserting")).toBe("… transcribing");
    expect(trayTitle(rec, "idle")).toBe("● rec");
  });

  test("a state change reaches the tray at once, and the menu's items call the session door", async () => {
    const d = { state: "idle", calls: [] as string[], fire: () => {} };
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
        state: () => d.state,
        status: () => ({ state: d.state, loading: false, swallow_keys: false }),
        control: async (a) => {
          d.calls.push(a);
          return true;
        },
        watch: (fn) => {
          d.fire = fn;
          return () => {};
        },
        follow: () => () => {},
        hotkey: () => "Control+Shift+Space",
      },
    };
    const bridge = {
      watchLifecycle: () => () => {},
      app: { status: async () => ({}), watch: () => () => {} },
    } as unknown as Bridge;
    const f = fakeUi();
    const shell = new Shell(app, bridge, f.ui, { platform: "linux", setLoginItem: async () => {} });
    cleanups.push(() => shell.close());
    await shell.start();
    expect(f.title()).toBe("");
    expect(labels(f.trayMenu())).toContain("Start dictation");
    for (const [state, title] of [
      ["listening", "● dictating"],
      ["transcribing", "… transcribing"],
      ["idle", ""],
    ] as const) {
      d.state = state;
      d.fire();
      await until(() => f.title() === title, 1000, `the tray to show ${state}`);
    }
    f.tray("dictate");
    await until(() => d.calls.length === 1, 1000, "the Start item");
    d.state = "listening";
    d.fire();
    await until(() => labels(f.trayMenu()).includes("■ Stop dictation"), 1000, "the Stop item");
    f.tray("dictate-stop");
    await until(() => d.calls.length === 2, 1000, "the Stop item's call");
    expect(d.calls).toEqual(["start", "stop"]);
  });
});

describe("DC-O4: the tray over a whole app", () => {
  async function rig(): Promise<AppRig> {
    const t = tempDir("akou-dict-tray-");
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

  test("Start dictation listens, the title says so, and Stop ends it into history", async () => {
    const r = await rig();
    const { shell, f } = await shellOn(r, { platform: "linux" });
    cleanups.push(() => shell.close());
    await until(() => labels(f.trayMenu()).includes("Start dictation"), 5000, "the Start item");
    f.tray("dictate");
    await until(() => f.title() === "● dictating", 5000, "the tray to say dictating");
    expect(r.app.dictation()?.status().state).toBe("listening");
    f.tray("dictate-stop");
    await until(
      () => (r.app.dictation()?.log.items() ?? []).length === 1,
      5000,
      "the dictation in history",
    );
    await until(() => f.title() === "", 5000, "the tray back to idle");
  });
});
