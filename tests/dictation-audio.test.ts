/**
 * A dictation's kept audio (docs/ux/DICTATION.md DC-H2) and Retry (DC-G1) through the dictation
 * service over the fake helper (scripts/fake-helper.ts `dictate`): scripted keys, a WAV as the mic,
 * the fake inserter, the fake engine. No device, no key, no clipboard.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import { LiveAsr } from "../src/main/asr/live-worker.ts";
import { DictationService, type DictationServiceOptions } from "../src/main/dictation/service.ts";
import type { DictationEngine } from "../src/main/dictation/session.ts";
import { FAKE_HELPER, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

// The fake helper runs in real time; a loaded runner passes bun's 5 s default.
setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const RC = "RightCommand";
const DAY = 24 * 60 * 60 * 1000;
const HOLD: [number, string, boolean][] = [
  [800, RC, true],
  [1600, RC, false],
];
/** A hold with another key during it: DC-A1's interrupt, kept as cancelled. */
const CANCEL: [number, string, boolean][] = [
  [0, RC, true],
  [800, "C", true],
  [850, "C", false],
  [1000, RC, false],
];

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

function scratch(): string {
  const t = tempDir("akou-dict-audio-");
  cleanups.push(t.cleanup);
  return t.dir;
}

interface Rig {
  dir: string;
  svc: DictationService;
  audioFiles(): string[];
}

/** A service over the fake helper, "hello" (or `words`) on the mic from 1 s, running `keys` once. */
function rig(
  keys: [number, string, boolean][],
  extra: Partial<DictationServiceOptions> = {},
  switches: string[] = [],
  dir = scratch(),
  words = ["hello"],
): Rig {
  const keyFile = join(dir, "keys.jsonl");
  writeFileSync(
    keyFile,
    keys.map(([at, key, down]) => JSON.stringify({ at, key, down } satisfies KeyInput)).join("\n"),
  );
  const mic = join(dir, "mic.wav");
  writeFileSync(mic, monoWav(concat(silence(1), speak(words), silence(3))));
  const fast = fastEngine();
  const svc = new DictationService({
    configDir: dir,
    engine: () => fast,
    now: () => Date.now(),
    ...extra,
  });
  cleanups.push(() => svc.close());
  svc.start(
    [
      process.execPath,
      FAKE_HELPER,
      "dictate",
      "--wav",
      mic,
      "--keys",
      keyFile,
      "--inserter-log",
      join(dir, "inserted.jsonl"),
      ...switches,
    ],
    () => ({ hotkey: RC, draft: "", fixLast: "", pasteLast: "", activation: "hold-or-toggle" }),
  );
  const audioDir = join(dir, "dictation", "audio");
  return {
    dir,
    svc,
    audioFiles: () => (existsSync(audioDir) ? readdirSync(audioDir).sort() : []),
  };
}

const settledAs = (r: Rig, state: string) =>
  until(() => r.svc.log.items()[0]?.state === state, 10_000, `the dictation ${state}`);

const first = (r: Rig) => r.svc.log.items()[0]?.id as string;

describe("DC-H2: a spoken dictation's audio is kept", () => {
  test("the audio of an inserted dictation is kept beside the log, as long as the dictation", async () => {
    const r = rig(HOLD);
    await settledAs(r, "inserted");
    const id = first(r);
    expect(r.audioFiles()).toEqual([`${id}.wav`]);
    const samples = (await r.svc.audio.read(id)) as Float32Array;
    expect(samples.length / 16000).toBeCloseTo(r.svc.log.items()[0]?.seconds as number, 2);
  });

  test("a cancelled dictation keeps its audio too, for a retry from history", async () => {
    const r = rig(CANCEL);
    await settledAs(r, "cancelled");
    expect(r.audioFiles()).toEqual([`${first(r)}.wav`]);
  });

  test("a password field's audio is never written", async () => {
    const r = rig(HOLD, {}, ["--field", "secure"]);
    await settledAs(r, "inserted");
    expect(r.audioFiles()).toEqual([]);
  });

  test("deleting a dictation deletes its audio, and the log keeps only the tombstone", async () => {
    const r = rig(HOLD);
    await settledAs(r, "inserted");
    const id = first(r);
    expect(r.svc.forget([id])).toEqual([id]);
    expect(r.audioFiles()).toEqual([]);
    expect(r.svc.log.events().map((e) => e.type)).toEqual(["dictation.deleted"]);
  });

  test("31 days on, the retention sweep takes the audio with the dictation", async () => {
    const clock = { now: 1_000 * DAY };
    const r = rig(HOLD, { now: () => clock.now, retainDays: () => 30 });
    await settledAs(r, "inserted");
    clock.now += 29 * DAY;
    r.svc.sweep();
    expect(r.audioFiles()).toHaveLength(1);
    clock.now += 2 * DAY;
    r.svc.sweep();
    expect(r.audioFiles()).toEqual([]);
  });
});

describe("DC-H2: dictation.keepAudio off", () => {
  test("the audio survives the insert and goes when the learn window closes; the text stays", async () => {
    const r = rig(HOLD, { keepAudio: () => false });
    await settledAs(r, "inserted");
    const id = first(r);
    expect(r.audioFiles()).toEqual([`${id}.wav`]);
    // A sweep while the window is open leaves it alone.
    r.svc.sweep();
    expect(r.audioFiles()).toEqual([`${id}.wav`]);
    r.svc.closeLearnWindow(id);
    expect(r.audioFiles()).toEqual([]);
    expect(r.svc.log.items()[0]).toMatchObject({ id, state: "inserted", text: "hello" });
  });

  test("the window closes by itself after its time", async () => {
    const r = rig(HOLD, { keepAudio: () => false, learnWindowMs: 50 });
    await settledAs(r, "inserted");
    await until(() => r.audioFiles().length === 0, 5000, "the audio to go");
    expect(r.svc.log.items()[0]?.text).toBe("hello");
  });

  test("positive control: with keepAudio on, closing the window keeps the audio", async () => {
    const r = rig(HOLD, { keepAudio: () => true });
    await settledAs(r, "inserted");
    r.svc.closeLearnWindow(first(r));
    expect(r.audioFiles()).toHaveLength(1);
  });

  test("a dictation that was not inserted, or with dictation.learn off, has no window", async () => {
    const cancelled = rig(CANCEL, { keepAudio: () => false });
    await settledAs(cancelled, "cancelled");
    expect(cancelled.audioFiles()).toEqual([]);
    const noLearn = rig(HOLD, { keepAudio: () => false, learns: () => false });
    await settledAs(noLearn, "inserted");
    expect(noLearn.audioFiles()).toEqual([]);
  });
});

describe("DC-H2: dictation.keepAudio off, the learning check", () => {
  // The fake engine hears "kubernetes" as "kubernetis": the fix the user makes in the box.
  const WORDS = ["deploy", "to", "kubernetes"];
  const HOLD_LONG: [number, string, boolean][] = [
    [800, RC, true],
    [2600, RC, false],
  ];
  const chipless = { open: () => {}, chip: () => {}, showInactive: () => {}, hide: () => {} };

  test("the audio survives the insert, the check runs on it, and it goes when the window closes; the text stays", async () => {
    const heard: number[] = [];
    const r = rig(
      HOLD_LONG,
      {
        keepAudio: () => false,
        draft: { learnMode: () => "ask" },
        check: () => async (samples, glossary) => {
          heard.push(samples.length);
          return `deploy to ${glossary[0]}`;
        },
      },
      [],
      scratch(),
      WORDS,
    );
    r.svc.draft.attach(chipless);
    await settledAs(r, "inserted");
    const id = first(r);
    const it = r.svc.log.items()[0];
    expect(it?.text).toBe("deploy to kubernetis");
    expect(r.audioFiles()).toEqual([`${id}.wav`]);
    // Fix on the history item: the box for teaching, Enter learns and inserts nothing.
    expect(r.svc.draft.open(id, { focus: true, fix: true })).toEqual({ ok: true });
    await r.svc.draft.handlers.insert({ id, text: "deploy to Kubernetes", send: false });
    // The check decoded the kept file, the whole utterance.
    expect(heard).toHaveLength(1);
    expect((heard[0] as number) / 16000).toBeCloseTo(it?.seconds as number, 2);
    expect(r.svc.log.events().filter((e) => e.type === "dictation.learn")).toEqual([
      expect.objectContaining({ term: "Kubernetes", status: "proposed", evidence: "audio" }),
    ]);
    expect(r.audioFiles()).toEqual([`${id}.wav`]);
    // Closing the chip closes the learn window: the audio goes at once, the text stays.
    expect(await r.svc.draft.handlers.chip({ id, action: "ignore" })).toBe(true);
    expect(r.audioFiles()).toEqual([]);
    expect(r.svc.log.items()[0]).toMatchObject({
      id,
      state: "inserted",
      text: "deploy to kubernetis",
    });
  });

  test("positive control: with no local Qwen for the check, the fix is proposed with evidence none", async () => {
    const r = rig(
      HOLD_LONG,
      { keepAudio: () => false, draft: { learnMode: () => "ask" }, check: () => null },
      [],
      scratch(),
      WORDS,
    );
    r.svc.draft.attach(chipless);
    await settledAs(r, "inserted");
    const id = first(r);
    r.svc.draft.open(id, { focus: true, fix: true });
    await r.svc.draft.handlers.insert({ id, text: "deploy to Kubernetes", send: false });
    expect(r.svc.log.events().filter((e) => e.type === "dictation.learn")).toEqual([
      expect.objectContaining({ term: "Kubernetes", evidence: "none" }),
    ]);
  });
});

describe("DC-H2: dictation.keepAudio off, a drafted dictation", () => {
  test("keeps its audio while the draft waits in the box, past the window's time and a sweep, and loses it when the box answers", async () => {
    const r = rig(HOLD, { keepAudio: () => false, learnWindowMs: 50, learns: () => false }, [
      "--focus-change",
    ]);
    r.svc.draft.attach({ open: () => {}, chip: () => {}, showInactive: () => {}, hide: () => {} });
    await settledAs(r, "drafted");
    const id = first(r);
    await Bun.sleep(200);
    r.svc.sweep();
    // The box's Retry still has the audio to decode.
    expect(r.audioFiles()).toEqual([`${id}.wav`]);
    expect(await r.svc.draft.handlers.discard({ id })).toBe(true);
    expect(r.audioFiles()).toEqual([]);
  });
});

describe("DC-H2: the audio at the next start", () => {
  test("a file with no dictation goes; a finished dictation's goes only with keepAudio off", async () => {
    const r = rig(HOLD);
    await settledAs(r, "inserted");
    const id = first(r);
    await r.svc.close();
    const audioDir = join(r.dir, "dictation", "audio");
    writeFileSync(join(audioDir, "dgone.wav"), "left by a crash");
    const reopen = (keepAudio: boolean) => {
      const svc = new DictationService({
        configDir: r.dir,
        engine: () => null,
        now: () => Date.now(),
        keepAudio: () => keepAudio,
      });
      cleanups.push(() => svc.close());
      return svc;
    };
    reopen(true);
    expect(readdirSync(audioDir)).toEqual([`${id}.wav`]);
    const off = reopen(false);
    expect(readdirSync(audioDir)).toEqual([]);
    expect(off.log.items()[0]).toMatchObject({ id, text: "hello" });
  });
});

describe("DC-G1: retry", () => {
  test("decodes the kept audio again on the engine asked for, and leaves the dictation alone", async () => {
    const heard: number[] = [];
    const fast = fastEngine();
    const best: DictationEngine = {
      name: "best",
      decode: async (s) => {
        heard.push(s.length);
        return { text: "hello again", words: [], language: "en", model: "qwen", ms: 7, spans: 1 };
      },
    };
    const r = rig(HOLD, { engine: (name) => (name === "best" ? best : fast) });
    await settledAs(r, "inserted");
    const id = first(r);
    const before = r.svc.log.events().length;
    const res = await r.svc.retry(id, { engine: "best" });
    expect(res).toEqual({
      ok: true,
      answer: {
        id,
        text: "hello again",
        raw: "hello again",
        language: "en",
        words: [],
        engine: "best",
        model: "qwen",
        ms: 7,
      },
    });
    expect(heard).toEqual([(await r.svc.audio.read(id))?.length as number]);
    expect(r.svc.log.events()).toHaveLength(before);
    expect(r.svc.log.items()[0]).toMatchObject({ text: "hello", engine: "fast" });
  });

  test("refusals: no such dictation, no audio kept (a clip), no model for the engine", async () => {
    const fast = fastEngine();
    const svc = new DictationService({
      configDir: scratch(),
      engine: (name) => (name === "best" ? null : fast),
      now: () => Date.now(),
    });
    cleanups.push(() => svc.close());
    expect(await svc.retry("dnone")).toMatchObject({ ok: false, code: "not_found" });
    const audio = concat(speak(["hello"]), silence(0.5));
    const clip = await svc.transcribeClip(audio, { by: "test" });
    expect(clip.text).toBe("hello");
    expect(await svc.retry(clip.id)).toMatchObject({ ok: false, code: "no_audio" });
    // With audio there: the engine asked for has no model, and the one that has decodes it.
    svc.audio.write(clip.id, audio);
    expect(await svc.retry(clip.id, { engine: "best" })).toMatchObject({
      ok: false,
      code: "models_missing",
    });
    expect(await svc.retry(clip.id)).toMatchObject({ ok: true, answer: { text: "hello" } });
  });
});
