/**
 * DC-O3 on the main side: a spoken dictation over the fake helper (scripts/fake-helper.ts
 * `dictate`) cues its start, its stop, its cancel and its insert through `Cues`, into a fake player
 * that keeps the bytes; and the system player plays nothing under `bun test`, picks the OS's player
 * otherwise, and never spawns one here (its spawn is a fake). Nothing opens an output device.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import { LiveAsr } from "../src/main/asr/live-worker.ts";
import { cueCommand, cuesSilenced, SystemCuePlayer } from "../src/main/dictation/cues.ts";
import { DictationService } from "../src/main/dictation/service.ts";
import type { DictationEngine } from "../src/main/dictation/session.ts";
import { type CueMoment, Cues } from "../src/ui/dictation-cues.ts";
import { FAKE_HELPER, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const RC = "RightCommand";
const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function fastEngine(): DictationEngine {
  const asr = new LiveAsr(
    {
      models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
      inThread: true,
    },
    () => undefined,
  );
  cleanups.push(() => asr.close());
  return { name: "fast", decode: (s, o) => asr.decode(s, o) };
}

interface Played {
  moment: CueMoment;
  wav: Uint8Array;
}

/**
 * The service over the fake helper with `keys`, "hello" on the mic from 1.0 s, and its cues going
 * through `Cues` with `sounds` and `pill` into a player that keeps what it was given.
 */
async function dictate(
  keys: [number, string, boolean][],
  settings: { sounds: string; pill: string },
): Promise<Played[]> {
  const t = tempDir("akou-dict-cues-");
  cleanups.push(t.cleanup);
  const keyFile = join(t.dir, "keys.jsonl");
  writeFileSync(
    keyFile,
    keys.map(([at, key, down]) => JSON.stringify({ at, key, down } satisfies KeyInput)).join("\n"),
  );
  const wav = join(t.dir, "mic.wav");
  writeFileSync(wav, monoWav(concat(silence(1), speak(["hello"]), silence(3))));
  const tap = join(t.dir, "tap.jsonl");
  const played: Played[] = [];
  const cues = new Cues({ play: (w, moment) => played.push({ moment, wav: w }) }, () => settings);
  const svc = new DictationService({
    configDir: t.dir,
    engine: fastEngine,
    now: () => Date.now(),
    cue: (m) => cues.cue(m),
  });
  cleanups.push(() => svc.close());
  svc.start(
    [process.execPath, FAKE_HELPER, "dictate", "--wav", wav, "--keys", keyFile, "--tap-log", tap],
    () => ({ hotkey: RC, draft: "", fixLast: "", pasteLast: "", activation: "hold-or-toggle" }),
  );
  await until(() => lines(tap).length >= keys.length, 10_000, "the fake to play the keys");
  await Bun.sleep(150);
  await svc.session()?.settled();
  await until(() => svc.status().state === "idle", 5000, "the dictation to settle");
  return played;
}

const HOLD: [number, string, boolean][] = [
  [800, RC, true],
  [1800, RC, false],
];
const ESCAPED: [number, string, boolean][] = [
  [800, RC, true],
  [900, RC, false],
  [1500, "Escape", true],
  [1550, "Escape", false],
];

describe("DC-O3: a dictation's cues", () => {
  test("soft: start, stop and done for an insert, start and cancel for Escape, four distinct sounds", async () => {
    const inserted = await dictate(HOLD, { sounds: "soft", pill: "top" });
    expect(inserted.map((p) => p.moment)).toEqual(["start", "stop", "done"]);
    const escaped = await dictate(ESCAPED, { sounds: "soft", pill: "top" });
    expect(escaped.map((p) => p.moment)).toEqual(["start", "cancel"]);

    const byMoment = new Map([...inserted, ...escaped].map((p) => [p.moment, p.wav]));
    const sounds = [...byMoment.values()].map((w) => Buffer.from(w).toString("base64"));
    expect(new Set(sounds).size).toBe(4);
    for (const w of byMoment.values())
      expect(Buffer.from(w.subarray(0, 4)).toString()).toBe("RIFF");
  });

  test("off plays none, even with the pill off", async () => {
    expect(await dictate(HOLD, { sounds: "off", pill: "off" })).toEqual([]);
  });

  test("auto: cues while the pill is off, none while it shows", async () => {
    const hidden = await dictate(HOLD, { sounds: "auto", pill: "off" });
    expect(hidden.map((p) => p.moment)).toEqual(["start", "stop", "done"]);
    expect(await dictate(HOLD, { sounds: "auto", pill: "top" })).toEqual([]);
  });
});

describe("DC-O3: the system's player", () => {
  const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);

  test("under bun test it plays nothing; the same player outside a test spawns the OS's player", () => {
    expect(cuesSilenced()).toBe(true);
    const t = tempDir("akou-cue-player-");
    cleanups.push(t.cleanup);
    const spawned: string[][] = [];
    const player = (env: NodeJS.ProcessEnv) =>
      new SystemCuePlayer({
        env,
        platform: "darwin",
        dir: () => t.dir,
        spawn: (argv) => spawned.push(argv),
      });
    player({ NODE_ENV: "test" }).play(WAV, "start");
    player({ CI: "true" }).play(WAV, "start");
    expect(spawned).toEqual([]);

    // Positive control: with neither, the cue is written once and handed to afplay.
    const p = player({});
    p.play(WAV, "start");
    p.play(WAV, "start");
    expect(spawned.length).toBe(2);
    expect(spawned[0]?.[0]).toBe("/usr/bin/afplay");
    expect(spawned[1]).toEqual(spawned[0] as string[]);
    expect(new Uint8Array(readFileSync(spawned[0]?.[1] as string))).toEqual(WAV);
  });

  test("the player per OS, and none found is said once", () => {
    const none = () => null;
    expect(cueCommand("darwin", "/c/start.wav", none)).toEqual(["/usr/bin/afplay", "/c/start.wav"]);
    const win = cueCommand("win32", "C:\\it's\\start.wav", none);
    expect(win?.[0]).toBe("powershell.exe");
    expect(win?.at(-1)).toBe("(New-Object Media.SoundPlayer 'C:\\it''s\\start.wav').PlaySync()");
    const only = (bin: string) => (b: string) => (b === bin ? `/usr/bin/${b}` : null);
    expect(cueCommand("linux", "/c/s.wav", only("pw-play"))).toEqual([
      "/usr/bin/pw-play",
      "/c/s.wav",
    ]);
    expect(cueCommand("linux", "/c/s.wav", only("paplay"))).toEqual([
      "/usr/bin/paplay",
      "/c/s.wav",
    ]);
    expect(cueCommand("linux", "/c/s.wav", only("aplay"))).toEqual([
      "/usr/bin/aplay",
      "-q",
      "/c/s.wav",
    ]);
    expect(cueCommand("linux", "/c/s.wav", none)).toBeNull();

    const t = tempDir("akou-cue-none-");
    cleanups.push(t.cleanup);
    const said: string[] = [];
    const p = new SystemCuePlayer({
      env: {},
      platform: "linux",
      which: none,
      dir: () => t.dir,
      spawn: () => {
        throw new Error("never spawned");
      },
      onLog: (_level, msg) => said.push(msg),
    });
    p.play(WAV, "start");
    p.play(WAV, "stop");
    expect(said).toEqual([
      "dictation cue not played: no sound player found (pw-play, paplay or aplay)",
    ]);
  });
});
