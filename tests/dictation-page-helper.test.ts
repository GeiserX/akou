/**
 * The Dictation page's wires into the helper, on the main side, over the fake helper
 * (scripts/fake-helper.ts `dictate`): the key recorder gets the helper's keys, Fn included (DC-U3);
 * the helper is told the microphone after `ready` and on a change (DC-U4); and the grants are read
 * by a probe while no helper runs, and a grant given since the helper started starts it again
 * (DC-U2, DC-N3). No device, no key, no prompt: the fake reports what it is told to.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DictationService, type DictationServiceOptions } from "../src/main/dictation/service.ts";
import type { Bridge } from "../src/main/window/bridge.ts";
import { windowRpc } from "../src/main/window/rpc.ts";
import { FAKE_HELPER, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const lines = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const BINDINGS = () =>
  ({
    hotkey: "RightCommand",
    draft: "",
    fixLast: "",
    pasteLast: "",
    activation: "hold-or-toggle",
  }) as const;

interface Rig {
  svc: DictationService;
  commands: string;
  /** The fake helper's command with `switches`, as the service starts it. */
  argv: string[];
}

function rig(switches: string[], extra: Partial<DictationServiceOptions> = {}): Rig {
  const t = tempDir("akou-dict-page-");
  cleanups.push(t.cleanup);
  const commands = join(t.dir, "commands.jsonl");
  const argv = [process.execPath, FAKE_HELPER, "dictate", "--commands-log", commands, ...switches];
  const svc = new DictationService({
    configDir: t.dir,
    engine: () => null,
    now: Date.now,
    ...extra,
  });
  cleanups.push(() => svc.close());
  return { svc, commands, argv };
}

async function started(r: Rig): Promise<void> {
  r.svc.start(r.argv, BINDINGS);
  await until(() => r.svc.status().state === "idle", 10_000, "the helper ready");
}

const sent = (r: Rig, type: string) => lines(r.commands).filter((c) => c.type === type);

describe("DC-U3: the recorder gets the helper's keys", () => {
  /** The window's RPC over `svc`, and what it sent the page. */
  function window(svc: DictationService | null) {
    const keys: string[] = [];
    const bridge = {
      app: { dictation: () => svc },
      watchLifecycle: () => () => {},
    } as unknown as Bridge;
    const rpc = windowRpc(
      bridge,
      () => ({
        followed: () => {},
        asked: () => {},
        status: () => {},
        showCall: () => {},
        showSettings: () => {},
        askQuit: () => {},
        dictationKey: ({ name }) => keys.push(name),
      }),
      async () => false,
    );
    return { rpc, keys };
  }

  test("recording on: the helper gets record_keys and its Fn reaches the page; the window closing ends it", async () => {
    const r = rig(["--recorder-keys", "Fn,RightCommand"]);
    await started(r);
    const w = window(r.svc);
    expect(await w.rpc.handlers.recordDictationKeys({ on: true })).toBe(true);
    await until(() => w.keys.length === 2, 5000, "the recorder's keys");
    expect(w.keys).toEqual(["Fn", "RightCommand"]);
    expect(sent(r, "record_keys")).toEqual([{ type: "record_keys", on: true }]);

    // A key while recording is the recorder's, never the session's: no session started.
    expect(r.svc.status().state).toBe("idle");
    w.rpc.close();
    await until(() => sent(r, "record_keys").length === 2, 5000, "record_keys off");
    expect(sent(r, "record_keys")[1]).toEqual({ type: "record_keys", on: false });
  });

  test("a helper started again for a grant while the recorder is open keeps reporting to it", async () => {
    let argv: string[] = [];
    const r = rig(
      ["--recorder-keys", "Fn", "--grants", "mic", "--probe-grants", "mic,accessibility"],
      { probe: () => [...argv, "--probe"] },
    );
    argv = r.argv;
    await started(r);
    const first = r.svc.session();
    const w = window(r.svc);
    await w.rpc.handlers.recordDictationKeys({ on: true });
    await until(() => w.keys.length === 1, 5000, "the first helper's key");
    // Accessibility arrives: the helper is started again with the page's recorder still open.
    await r.svc.grants();
    await until(
      () => r.svc.session() !== first && r.svc.status().state === "idle",
      10_000,
      "the helper started again",
    );
    await until(() => sent(r, "record_keys").length === 2, 5000, "record_keys to the new helper");
    expect(sent(r, "record_keys")).toEqual([
      { type: "record_keys", on: true },
      { type: "record_keys", on: true },
    ]);
    await until(() => w.keys.length === 2, 5000, "the new helper's key reaching the page");
    w.rpc.close();
    await until(() => sent(r, "record_keys").length === 3, 5000, "record_keys off");
  });

  test("a recorder closed while the helper restarts for a grant is not opened by the new one", async () => {
    let argv: string[] = [];
    const r = rig(
      ["--recorder-keys", "Fn", "--grants", "mic", "--probe-grants", "mic,accessibility"],
      { probe: () => [...argv, "--probe"] },
    );
    argv = r.argv;
    await started(r);
    const first = r.svc.session();
    const w = window(r.svc);
    await w.rpc.handlers.recordDictationKeys({ on: true });
    // The restart begins: the old helper is stopping and no helper is up when the page closes.
    await r.svc.grants();
    w.rpc.close();
    await until(
      () => r.svc.session() !== first && r.svc.status().state === "idle",
      10_000,
      "the helper started again",
    );
    await until(() => sent(r, "rebind").length === 2, 5000, "the second rebind");
    await Bun.sleep(200);
    expect(sent(r, "record_keys")).toEqual([{ type: "record_keys", on: true }]);
  });

  test("with dictation off the recorder is told no, and takes what the page sees", async () => {
    const w = window(null);
    expect(await w.rpc.handlers.recordDictationKeys({ on: true })).toBe(false);
    // Positive control: a service with no helper up says no too.
    const r = rig([]);
    const w2 = window(r.svc);
    expect(await w2.rpc.handlers.recordDictationKeys({ on: true })).toBe(false);
  });
});

describe("DC-U4: the microphone goes to the helper", () => {
  test("after ready, the setting's microphone; a change sends it again", async () => {
    const mic = { device: "", preferBuiltIn: true };
    const r = rig([], { mic: () => mic });
    await started(r);
    await until(() => sent(r, "rebuild_mic").length === 1, 5000, "rebuild_mic after ready");
    expect(sent(r, "rebuild_mic")[0]).toEqual({
      type: "rebuild_mic",
      device: "default",
      prefer_built_in: true,
    });
    mic.device = "usb-mic-1";
    mic.preferBuiltIn = false;
    r.svc.rebuildMic();
    await until(() => sent(r, "rebuild_mic").length === 2, 5000, "rebuild_mic on a change");
    expect(sent(r, "rebuild_mic")[1]).toEqual({
      type: "rebuild_mic",
      device: "usb-mic-1",
      prefer_built_in: false,
    });
  });

  test("positive control: with no microphone setting, none is sent", async () => {
    const r = rig([]);
    await started(r);
    await until(() => sent(r, "rebind").length === 1, 5000, "the rebind");
    await Bun.sleep(200);
    expect(sent(r, "rebuild_mic")).toEqual([]);
  });
});

describe("DC-U8: dictation.muteMedia goes to the helper", () => {
  test("after ready, the setting as it is; a change sends it again", async () => {
    const media = { on: false };
    const r = rig([], { pauseMedia: () => media.on });
    await started(r);
    await until(() => sent(r, "pause_media").length === 1, 5000, "pause_media after ready");
    expect(sent(r, "pause_media")[0]).toEqual({ type: "pause_media", on: false });
    media.on = true;
    r.svc.pauseMedia();
    await until(() => sent(r, "pause_media").length === 2, 5000, "pause_media on a change");
    expect(sent(r, "pause_media")[1]).toEqual({ type: "pause_media", on: true });
  });

  test("negative control: with no media setting, none is sent", async () => {
    const r = rig([]);
    await started(r);
    await until(() => sent(r, "rebind").length === 1, 5000, "the rebind");
    await Bun.sleep(200);
    expect(sent(r, "pause_media")).toEqual([]);
  });
});

describe("DC-U4, DC-N3: the page's meter moves on the helper's level", () => {
  /** The window's RPC over `svc`, and the levels it sent the page. */
  function window(svc: DictationService | null) {
    const levels: number[] = [];
    const bridge = {
      app: { dictation: () => svc },
      watchLifecycle: () => () => {},
    } as unknown as Bridge;
    const rpc = windowRpc(
      bridge,
      () => ({
        followed: () => {},
        asked: () => {},
        status: () => {},
        showCall: () => {},
        showSettings: () => {},
        askQuit: () => {},
        dictationLevel: ({ db }) => levels.push(db),
      }),
      async () => false,
    );
    return { rpc, levels };
  }

  test("on: the helper gets meter and its levels reach the page with no session; off stops them", async () => {
    const t = tempDir("akou-dict-meter-");
    cleanups.push(t.cleanup);
    const r = rig(["--wav", speechWav(t.dir)]);
    await started(r);
    const w = window(r.svc);
    expect(await w.rpc.handlers.watchDictationMic({ on: true })).toBe(true);
    // The fake's mic is 0.4 s of silence, then speech: the meter reads both.
    await until(() => w.levels.some((db) => db > -40), 5000, "a spoken level");
    expect(w.levels.some((db) => db <= -60)).toBe(true);
    expect(w.levels.every((db) => db >= -60 && db <= 0)).toBe(true);
    expect(sent(r, "meter")).toEqual([{ type: "meter", on: true }]);
    expect(r.svc.status().state).toBe("idle");

    expect(await w.rpc.handlers.watchDictationMic({ on: false })).toBe(true);
    await until(() => sent(r, "meter").length === 2, 5000, "meter off");
    expect(sent(r, "meter")[1]).toEqual({ type: "meter", on: false });
    await Bun.sleep(150);
    const after = w.levels.length;
    await Bun.sleep(300);
    expect(w.levels.length).toBe(after);
  });

  test("the window closing turns the meter off", async () => {
    const r = rig([]);
    await started(r);
    const w = window(r.svc);
    expect(await w.rpc.handlers.watchDictationMic({ on: true })).toBe(true);
    w.rpc.close();
    await until(() => sent(r, "meter").length === 2, 5000, "meter off");
    expect(sent(r, "meter")[1]).toEqual({ type: "meter", on: false });
  });

  test("with dictation off the meter is told no; a helper that starts meanwhile gets it on, and off when the page closes", async () => {
    expect(await window(null).rpc.handlers.watchDictationMic({ on: true })).toBe(false);
    const r = rig([]);
    const w = window(r.svc);
    expect(await w.rpc.handlers.watchDictationMic({ on: true })).toBe(false);
    await started(r);
    await until(() => sent(r, "meter").length === 1, 5000, "meter after ready");
    expect(sent(r, "meter")[0]).toEqual({ type: "meter", on: true });
    w.rpc.close();
    await until(() => sent(r, "meter").length === 2, 5000, "meter off");
    expect(sent(r, "meter")[1]).toEqual({ type: "meter", on: false });
    // Positive control: a helper started with the meter off is never told to meter.
    const c = rig([]);
    await started(c);
    await until(() => sent(c, "rebind").length === 1, 5000, "the rebind");
    await Bun.sleep(200);
    expect(sent(c, "meter")).toEqual([]);
  });
});

describe("DC-U2, DC-N3: the grants before and after the helper starts", () => {
  test("off: a probe reads them, and without a probe nothing can say", async () => {
    const probe = [process.execPath, FAKE_HELPER, "dictate", "--grants", "mic", "--probe"];
    const r = rig([], { probe: () => probe });
    expect(await r.svc.grants()).toEqual({ mic: "granted", accessibility: "denied" });
    // The probe only printed and exited: no helper runs, dictation is still off.
    expect(r.svc.status()).toMatchObject({ enabled: false, state: "off", grants: null });
    expect(await rig([]).svc.grants()).toBeNull();
  });

  test("a grant given since the helper started starts it once again, and not twice", async () => {
    // The running helper was started without Accessibility; the probe now finds it given.
    let argv: string[] = [];
    const r = rig(["--grants", "mic", "--probe-grants", "mic,accessibility"], {
      probe: () => [...argv, "--probe"],
    });
    argv = r.argv;
    await started(r);
    const first = r.svc.session();
    expect(first?.ready?.grants).toEqual({ mic: "granted", accessibility: "denied" });

    expect(await r.svc.grants()).toEqual({ mic: "granted", accessibility: "granted" });
    await until(
      () => r.svc.session() !== first && r.svc.status().state === "idle",
      10_000,
      "the helper started again",
    );
    const second = r.svc.session();
    // The new one still says denied (this fake always does): a probe that disagrees with the
    // helper forever must not restart it in a loop.
    await Bun.sleep(1100);
    expect(await r.svc.grants()).toEqual({ mic: "granted", accessibility: "granted" });
    await Bun.sleep(300);
    expect(r.svc.session()).toBe(second);
    expect(sent(r, "rebind").length).toBe(2);
  });

  test("[akou-qpn] the macOS helper makes its own tap when Accessibility arrives: no restart for it", async () => {
    let argv: string[] = [];
    const r = rig(
      ["--backend", "cgeventtap", "--grants", "mic", "--probe-grants", "mic,accessibility"],
      { probe: () => [...argv, "--probe"] },
    );
    argv = r.argv;
    await started(r);
    const first = r.svc.session();
    expect(await r.svc.grants()).toEqual({ mic: "granted", accessibility: "granted" });
    await Bun.sleep(1500);
    expect(r.svc.session()).toBe(first);
    expect(sent(r, "rebind").length).toBe(1);
  });

  test("positive control: the macOS helper is still started again for the microphone", async () => {
    let argv: string[] = [];
    const r = rig(
      [
        "--backend",
        "cgeventtap",
        "--grants",
        "accessibility",
        "--probe-grants",
        "mic,accessibility",
      ],
      { probe: () => [...argv, "--probe"] },
    );
    argv = r.argv;
    await started(r);
    const first = r.svc.session();
    expect(first?.ready?.grants).toEqual({ mic: "denied", accessibility: "granted" });
    expect(await r.svc.grants()).toEqual({ mic: "granted", accessibility: "granted" });
    await until(
      () => r.svc.session() !== first && r.svc.status().state === "idle",
      10_000,
      "the helper started again",
    );
  });
});
