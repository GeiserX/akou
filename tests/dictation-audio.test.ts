/**
 * A dictation's kept audio (docs/ux/DICTATION.md DC-H2) and Retry (DC-G1) through the dictation
 * service over the fake helper (scripts/fake-helper.ts `dictate`): scripted keys, a WAV as the mic,
 * the fake inserter, the fake engine. No device, no key, no clipboard.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import { LiveAsr } from "../src/main/asr/live-worker.ts";
import { DictationService, type DictationServiceOptions } from "../src/main/dictation/service.ts";
import type { DictationEngine } from "../src/main/dictation/session.ts";
import type { DraftOpen } from "../src/ui/dictation-protocol.ts";
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
  const chipless = {
    open: () => {},
    chip: () => {},
    append: () => {},
    showInactive: () => {},
    hide: () => {},
  };

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
    r.svc.draft.attach({
      open: () => {},
      chip: () => {},
      append: () => {},
      showInactive: () => {},
      hide: () => {},
    });
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

describe("DC-H2, DC-A4: dictation.keepAudio off, a dictation appended to the draft box", () => {
  const TARGET = { app: "com.example.chat", pid: 7, window: "w7", field: "editable" } as const;

  /** The hold's dictation, made while the box had the keyboard on another draft, once appended. */
  const append = async (keep: boolean) => {
    const r = rig(HOLD, { keepAudio: () => keep });
    r.svc.draft.attach({
      open: () => {},
      chip: () => {},
      append: () => {},
      showInactive: () => {},
      hide: () => {},
    });
    const log = r.svc.log;
    const draft = "d-draft";
    log.append({
      type: "dictation.started",
      id: draft,
      target: TARGET,
      engine: "fast",
      by: "user",
    });
    log.append({ type: "dictation.ended", id: draft, reason: "release", seconds: 1 });
    log.append({
      type: "dictation.text",
      id: draft,
      raw: "see you",
      text: "see you",
      language: "en",
      words: [],
      engine: "fast",
      model: "parakeet",
      ms: 80,
    });
    log.append({ type: "dictation.drafted", id: draft, reason: "focus-changed" });
    expect(r.svc.draft.open(draft, { focus: true })).toEqual({ ok: true });
    await r.svc.draft.handlers.focused({ on: true });
    await until(
      () => log.items().some((it) => it.id !== draft && it.state === "drafted"),
      10_000,
      "the append",
    );
    const id = log.items().find((it) => it.id !== draft)?.id as string;
    expect(log.events().find((e) => e.id === id && e.type === "dictation.drafted")).toMatchObject({
      reason: "append",
    });
    return { r, draft, id };
  };

  test("its audio goes as it is appended, and it is discarded with the draft", async () => {
    const { r, draft, id } = await append(false);
    expect(r.audioFiles()).toEqual([]);
    expect(await r.svc.draft.handlers.discard({ id: draft })).toBe(true);
    expect(r.svc.log.item(id)?.state).toBe("discarded");
  });

  test("positive control: with keepAudio on, its audio stays", async () => {
    const { r, id } = await append(true);
    expect(r.audioFiles()).toEqual([`${id}.wav`]);
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

  test("akou-5v8: a retry given a language forces it; without one, dictation.language", async () => {
    const asked: (string | undefined)[] = [];
    const best: DictationEngine = {
      name: "best",
      decode: async (_s, o) => {
        asked.push(o.language);
        const es = o.language === "es";
        return {
          text: es ? "hola" : "hello",
          words: [],
          language: o.language ?? "en",
          model: "qwen",
          ms: 7,
          spans: 1,
        };
      },
    };
    const svc = new DictationService({
      configDir: scratch(),
      engine: () => best,
      now: () => Date.now(),
      language: () => "en",
    });
    cleanups.push(() => svc.close());
    const audio = concat(speak(["hello"]), silence(0.5));
    const clip = await svc.transcribeClip(audio, { by: "test" });
    svc.audio.write(clip.id, audio);
    asked.length = 0;
    expect(await svc.retry(clip.id, { language: "es" })).toMatchObject({
      ok: true,
      answer: { text: "hola", language: "es", language_forced: true },
    });
    // Positive control: with no language asked, the setting's stands.
    expect(await svc.retry(clip.id)).toMatchObject({
      ok: true,
      answer: { text: "hello", language: "en" },
    });
    expect(asked).toEqual(["es", "en"]);
    expect(svc.log.item(clip.id)).toMatchObject({ text: "hello", language: "en" });
  });
});

describe("DC-O1, DC-R3: the buttons of the pill's error sheet", () => {
  /** The draft box's window, recording what it opens. */
  const drafts = (r: Rig) => {
    const opens: DraftOpen[] = [];
    r.svc.draft.attach({
      open: (d) => opens.push(d),
      chip: () => {},
      append: () => {},
      showInactive: () => {},
      hide: () => {},
    });
    return opens;
  };

  test("a remote failure offers Retry locally: it decodes on best and opens the draft on that reading, inserting nothing", async () => {
    const fast = fastEngine();
    const decoded: string[] = [];
    const remote: DictationEngine = {
      name: "remote",
      decode: async () => {
        throw new Error("remote akou not reachable");
      },
    };
    const best: DictationEngine = {
      name: "best",
      decode: async (s, o) => {
        decoded.push("best");
        return { ...(await fast.decode(s, o)), engine: "best", model: "qwen" };
      },
    };
    const r = rig(HOLD, {
      engine: (name) => (name === "best" ? best : name === "fast" ? fast : remote),
      draft: { engines: () => ["fast", "best", "remote"] },
    });
    const opens = drafts(r);
    await settledAs(r, "failed");
    const id = first(r);
    expect(r.svc.errorActions(id)).toEqual({ actions: ["retry"], retryLabel: "Retry locally" });
    // No text: nothing to copy or open.
    expect(await r.svc.errorAction(id, "copy")).toBe(false);
    expect(await r.svc.errorAction(id, "open-draft")).toBe(false);
    expect(opens).toEqual([]);
    expect(await r.svc.errorAction(id, "retry")).toBe(true);
    expect(decoded).toEqual(["best"]);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ id, text: "hello", engine: "best (qwen)", focus: true });
    // The box's Enter inserts; the retry itself changed nothing in the log.
    expect(r.svc.log.item(id)?.state).toBe("failed");
  });

  test("a failed insert offers Copy and Open draft on its text, and Retry on its own engine", async () => {
    const r = rig(HOLD, { draft: { engines: () => ["fast"] } }, [
      "--no-receipt",
      "--receipt-timeout-ms",
      "300",
    ]);
    const opens = drafts(r);
    await settledAs(r, "failed");
    const id = first(r);
    expect(r.svc.log.item(id)).toMatchObject({ text: "hello", error: "insert: no-receipt" });
    expect(r.svc.errorActions(id)).toEqual({ actions: ["retry", "copy", "open-draft"] });
    expect(await r.svc.errorAction(id, "copy")).toBe(true);
    const inserts = readFileSync(join(r.dir, "inserted.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { text?: string; method?: string });
    expect(inserts.at(-1)).toMatchObject({ text: "hello", method: "clipboard" });
    expect(await r.svc.errorAction(id, "open-draft")).toBe(true);
    expect(opens.at(-1)).toMatchObject({ id, text: "hello", focus: true });
    // With the helper gone there is nothing to copy with: Copy is not offered.
    await r.svc.stop();
    expect(r.svc.errorActions(id)).toEqual({ actions: ["retry", "open-draft"] });
  });

  test("a remote reading whose insert failed retries on the remote, not locally: the remote was fine", async () => {
    const fast = fastEngine();
    const decoded: string[] = [];
    const named = (name: string): DictationEngine => ({
      name,
      decode: async (s, o) => {
        decoded.push(name);
        return { ...(await fast.decode(s, o)), engine: name };
      },
    });
    const remote = named("remote");
    const best = named("best");
    const r = rig(
      HOLD,
      {
        engine: (name) => (name === "best" ? best : name === "fast" ? fast : remote),
        draft: { engines: () => ["fast", "best", "remote"] },
      },
      ["--no-receipt", "--receipt-timeout-ms", "300"],
    );
    const opens = drafts(r);
    await settledAs(r, "failed");
    const id = first(r);
    expect(r.svc.log.item(id)).toMatchObject({
      engine: "remote",
      text: "hello",
      error: "insert: no-receipt",
    });
    expect(r.svc.errorActions(id)).toEqual({ actions: ["retry", "copy", "open-draft"] });
    decoded.length = 0;
    expect(await r.svc.errorAction(id, "retry")).toBe(true);
    expect(decoded).toEqual(["remote"]);
    expect(opens.at(-1)).toMatchObject({ id, text: "hello", focus: true });
  });

  test("a Retry that answers while a new dictation listens opens the draft without the keyboard", async () => {
    const fast = fastEngine();
    let r: Rig | null = null;
    const remote: DictationEngine = {
      name: "remote",
      decode: async () => {
        throw new Error("remote akou not reachable");
      },
    };
    const best: DictationEngine = {
      name: "best",
      decode: async (s, o) => {
        // The user pressed the key again while the slow decode ran.
        const session = r?.svc.session();
        if (session) session.state = "listening";
        return { ...(await fast.decode(s, o)), engine: "best", model: "qwen" };
      },
    };
    r = rig(HOLD, {
      engine: (name) => (name === "best" ? best : name === "fast" ? fast : remote),
      draft: { engines: () => ["fast", "best", "remote"] },
    });
    const opens = drafts(r);
    await settledAs(r, "failed");
    const id = first(r);
    expect(await r.svc.errorAction(id, "retry")).toBe(true);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ id, text: "hello", focus: false });
    const session = r.svc.session();
    if (session) session.state = "idle";
  });

  test("a language chosen for the session holds for the error's Retry (akou-5v8)", async () => {
    const fast = fastEngine();
    const remote: DictationEngine = {
      name: "remote",
      decode: async () => {
        throw new Error("remote akou not reachable");
      },
    };
    /**
     * A failed remote dictation retried on best. The session is started from the door, in `es`
     * when `language` is given: the same session language a click on the pill's chip sets.
     */
    const run = async (language?: string) => {
      const asked: (string | undefined)[] = [];
      const best: DictationEngine = {
        name: "best",
        decode: async (s, o) => {
          asked.push(o.language);
          return {
            ...(await fast.decode(s, o)),
            engine: "best",
            model: "qwen",
            language: o.language ?? "en",
          };
        },
      };
      const r = rig([], {
        engine: (name) => (name === "best" ? best : name === "fast" ? fast : remote),
        languages: () => ["en", "es"],
        draft: { engines: () => ["fast", "best", "remote"] },
      });
      const opens = drafts(r);
      await until(() => r.svc.status().state === "idle", 10_000, "the helper ready");
      const start = await r.svc.control("start", undefined, language ? { language } : {});
      expect(start.ok).toBe(true);
      // The fake's mic runs in real time: let "hello" (from 1 s) be spoken before the stop.
      await Bun.sleep(2000);
      expect((await r.svc.control("stop")).ok).toBe(true);
      await settledAs(r, "failed");
      expect(await r.svc.errorAction(first(r), "retry")).toBe(true);
      return { asked, open: opens.at(-1) };
    };
    const chosen = await run("es");
    expect(chosen.asked).toEqual(["es"]);
    expect(chosen.open).toMatchObject({ language: "es", languageForced: true });
    // Positive control: with no language chosen the retry asks for none, and nothing is ringed.
    const plain = await run();
    expect(plain.asked).toEqual([undefined]);
    expect(plain.open?.language).toBe("en");
    expect(plain.open?.languageForced).toBeUndefined();
  });

  test("positive control: a failure with no text and no audio kept offers nothing", async () => {
    const remote: DictationEngine = {
      name: "remote",
      decode: async () => {
        throw new Error("remote akou not reachable");
      },
    };
    const r = rig(HOLD, {
      engine: () => remote,
      keepAudio: () => false,
      draft: { engines: () => ["fast", "best"] },
    });
    await settledAs(r, "failed");
    const id = first(r);
    expect(r.audioFiles()).toEqual([]);
    expect(r.svc.errorActions(id)).toEqual({ actions: [] });
    expect(await r.svc.errorAction(id, "retry")).toBe(false);
  });
});
