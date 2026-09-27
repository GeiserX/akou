/**
 * What stands between a decode and an insert (docs/ux/DICTATION.md DC-E6, DC-S7): the silence
 * guard (no speech, no decode), the echo guard (an answer that is the engine's context is decoded
 * again without it) and filler removal. The sessions run over the fake helper with a WAV mic and
 * the fake inserter, the engines are the deterministic fakes or stubs: no device, no key, no
 * clipboard.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import { CONTEXT_WRAPPER, isEcho } from "../src/core/dictation/echo.ts";
import { removeFillers } from "../src/core/dictation/fillers.ts";
import { LiveAsr } from "../src/main/asr/live-worker.ts";
import { DictationService, type DictationServiceOptions } from "../src/main/dictation/service.ts";
import type { DecodeRequest, DictationEngine } from "../src/main/dictation/session.ts";
import { FAKE_HELPER, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav, roomNoise } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const RC = "RightCommand";
const INVENTED = "thank you for watching";
const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** The fake Parakeet in this thread; `hallucinate` makes it invent a sentence on noise (SV-R5). */
function fakeAsr(hallucinate?: string): LiveAsr {
  const asr = new LiveAsr(
    {
      models: {
        kind: "module",
        path: FAKE_MODELS,
        model: "fake-parakeet",
        options: hallucinate ? { hallucinate } : {},
      },
      inThread: true,
    },
    () => undefined,
  );
  cleanups.push(() => asr.close());
  return asr;
}

/** An engine that answers each decode from `answers` in turn and records what it was asked. */
function stub(answers: { text: string; language?: string }[], asked: DecodeRequest[] = []) {
  let i = 0;
  const engine: DictationEngine = {
    name: "best",
    decode: async (_s, o) => {
      asked.push(o);
      const a = answers[Math.min(i++, answers.length - 1)] as { text: string; language?: string };
      return {
        text: a.text,
        words: [],
        language: a.language ?? null,
        model: "stub",
        ms: 1,
        spans: 1,
      };
    },
  };
  return { engine: () => engine, asked };
}

interface Rig {
  svc: DictationService;
  inserted: string;
  commands: string;
}

/** A dictation service over the fake helper: a hold of RightCommand from 0.8 s to 2.4 s. */
function rig(mic: Float32Array, o: Partial<DictationServiceOptions>): Rig {
  const t = tempDir("akou-dict-guards-");
  cleanups.push(t.cleanup);
  const keys = join(t.dir, "keys.jsonl");
  const hold: KeyInput[] = [
    { at: 800, key: RC, down: true },
    { at: 2400, key: RC, down: false },
  ];
  writeFileSync(keys, hold.map((k) => JSON.stringify(k)).join("\n"));
  const wav = join(t.dir, "mic.wav");
  writeFileSync(wav, monoWav(mic));
  const inserted = join(t.dir, "inserted.jsonl");
  const commands = join(t.dir, "commands.jsonl");
  const svc = new DictationService({
    configDir: t.dir,
    engine: () => null,
    now: () => Date.now(),
    ...o,
  });
  cleanups.push(() => svc.close());
  svc.start(
    [
      process.execPath,
      FAKE_HELPER,
      "dictate",
      "--wav",
      wav,
      "--keys",
      keys,
      "--inserter-log",
      inserted,
      "--commands-log",
      commands,
    ],
    () => ({ hotkey: RC, draft: "", fixLast: "", pasteLast: "", activation: "hold-or-toggle" }),
  );
  return { svc, inserted, commands };
}

/** Waits for the dictation to reach a final state. */
async function done(r: Rig) {
  await until(
    () => ["inserted", "empty", "failed"].includes(r.svc.log.items()[0]?.state ?? ""),
    10_000,
    "the dictation",
  );
  await r.svc.session()?.settled();
  return r.svc.log.items()[0];
}

const NOISE = roomNoise(4);
const HELLO = concat(silence(1), speak(["hello"]), silence(3));

describe("DC-E6: the silence guard", () => {
  test("room noise on an engine that invents on noise: nothing inserted, dictation.empty", async () => {
    const asr = fakeAsr(INVENTED);
    const r = rig(NOISE, {
      engine: () => ({ name: "fast", decode: (s, o) => asr.decode(s, o) }),
      speech: (s) => asr.speech(s),
    });
    const it = await done(r);
    expect(it?.state).toBe("empty");
    expect(it?.text).toBeNull();
    expect(lines(r.inserted)).toEqual([]);
    // The helper stops holding Escape and Enter at once rather than after 8 s. The fake logs
    // each command as it reads it, so the line may land a moment after the log's event.
    await until(
      () => lines(r.commands).some((c) => c.type === "settled"),
      5000,
      "settled sent to the helper",
    );
    expect(r.svc.log.events().map((e) => e.type)).toEqual([
      "dictation.started",
      "dictation.ended",
      "dictation.empty",
    ]);
  }, 15_000);

  test("positive control: without the guard the same noise is inserted as the invented sentence", async () => {
    const asr = fakeAsr(INVENTED);
    const r = rig(NOISE, {
      engine: () => ({ name: "fast", decode: (s, o) => asr.decode(s, o) }),
    });
    const it = await done(r);
    expect(it?.state).toBe("inserted");
    expect(lines(r.inserted)[0]?.text).toContain(INVENTED);
  });

  test("speech passes the guard and is inserted", async () => {
    const asr = fakeAsr(INVENTED);
    const r = rig(HELLO, {
      engine: () => ({ name: "fast", decode: (s, o) => asr.decode(s, o) }),
      speech: (s) => asr.speech(s),
    });
    expect((await done(r))?.text).toBe("hello");
    expect(lines(r.inserted)[0]).toMatchObject({ text: "hello" });
  });

  test("any engine is guarded: noise never reaches a best or remote engine", async () => {
    const asr = fakeAsr();
    const s = stub([{ text: INVENTED }]);
    const r = rig(NOISE, { engine: s.engine, speech: (x) => asr.speech(x) });
    expect((await done(r))?.state).toBe("empty");
    expect(s.asked).toEqual([]);
  });

  test("a speech check that fails decodes anyway: a broken guard never loses a dictation", async () => {
    const s = stub([{ text: "hello" }]);
    const r = rig(HELLO, {
      engine: s.engine,
      speech: async () => {
        throw new Error("the recognizer stopped");
      },
    });
    expect((await done(r))?.text).toBe("hello");
  });

  test("the Worker's speech check: noise is none, a word is some", async () => {
    const asr = fakeAsr();
    expect(await asr.speech(roomNoise(3))).toBe(false);
    expect(await asr.speech(silence(2))).toBe(false);
    expect(await asr.speech(HELLO)).toBe(true);
  });
});

describe("DC-E6: the echo guard", () => {
  test("an answer holding the context wrapper is decoded again without context", async () => {
    const s = stub([{ text: `${CONTEXT_WRAPPER} Kubernetes, Hetzner.` }, { text: "deploy today" }]);
    const r = rig(HELLO, { engine: s.engine });
    const it = await done(r);
    expect(s.asked).toEqual([{}, { context: false }]);
    expect(it).toMatchObject({ text: "deploy today", raw: "deploy today", echo_retry: true });
    expect(lines(r.inserted)[0]).toMatchObject({ text: "deploy today" });
  });

  test("positive control: a plain answer is decoded once and records no retry", async () => {
    const s = stub([{ text: "deploy today" }]);
    const r = rig(HELLO, { engine: s.engine });
    const it = await done(r);
    expect(s.asked).toEqual([{}]);
    expect(it?.echo_retry).toBe(false);
    const text = r.svc.log.events().find((e) => e.type === "dictation.text");
    expect(text && "echo_retry" in text).toBe(false);
  });

  test("an echo again with no context is nothing said: nothing is inserted", async () => {
    const s = stub([{ text: `${CONTEXT_WRAPPER} Kubernetes.` }]);
    const r = rig(HELLO, { engine: s.engine });
    expect((await done(r))?.state).toBe("empty");
    expect(lines(r.inserted)).toEqual([]);
  });

  test("an answer that is mostly the glossary is an echo; one term said alone is not", () => {
    const glossary = ["Kubernetes", "Hetzner", "Vercel"];
    expect(isEcho("Kubernetes, Hetzner, Vercel.", glossary)).toBe(true);
    expect(isEcho("Kubernetes Hetzner Vercel and Kubernetes", glossary)).toBe(true);
    expect(isEcho("Kubernetes", glossary)).toBe(false);
    expect(isEcho("deploy Kubernetes on Hetzner today for the whole team", glossary)).toBe(false);
    expect(isEcho("Kubernetes, Hetzner, Vercel.", [])).toBe(false);
    expect(isEcho("technical terms: foo", [])).toBe(true);
    // Said as words, with no colon, the phrase is speech.
    expect(isEcho("these technical terms are hard", [])).toBe(false);
  });
});

describe("DC-S7: filler words", () => {
  test.each([
    ["um so the uh plan", ["en"], "so the plan"],
    ["Um, so the, uh, plan.", ["en"], "So the plan."],
    ["Ship it, umm.", ["en"], "Ship it."],
    ["Hmm, erm, okay", ["en"], "Okay"],
    ["first line\num second", ["en"], "first line\nsecond"],
    ["este libro", ["es"], "este libro"],
    ["Este es el plan", ["es"], "Este es el plan"],
    ["Este, bueno, vale.", ["es"], "Bueno, vale."],
    ["¿eh, vienes?", ["es"], "¿vienes?"],
    ["mmm vale", ["es"], "vale"],
    // No language known: the hesitations, never a word of a list.
    ["uh the plan, este.", [], "the plan, este."],
    ["Hmm, the plan", [], "The plan"],
    // Gated by language: `um` is Portuguese for "a", `este` English for nothing.
    ["um livro", ["pt"], "um livro"],
    ["este, the plan", ["en"], "este, the plan"],
    ["plan um", ["en-US"], "plan"],
  ])("%p in %p is %p", (text, langs, want) => {
    expect(removeFillers(text, langs)).toBe(want);
  });

  test("a dictation inserts without fillers and history keeps what was said", async () => {
    const s = stub([{ text: "um so the uh plan", language: "en" }]);
    const r = rig(HELLO, { engine: s.engine, fillers: () => true });
    const it = await done(r);
    expect(lines(r.inserted)[0]).toMatchObject({ text: "so the plan" });
    expect(it).toMatchObject({ text: "so the plan", raw: "um so the uh plan" });
  });

  test("positive control: with dictation.fillers off the text goes in as said", async () => {
    const s = stub([{ text: "um so the uh plan", language: "en" }]);
    const r = rig(HELLO, { engine: s.engine, fillers: () => false });
    await done(r);
    expect(lines(r.inserted)[0]).toMatchObject({ text: "um so the uh plan" });
  });

  test("with no language from the engine, dictation.languages gates the list", async () => {
    const s = stub([{ text: "Este, bueno, vale." }]);
    const r = rig(HELLO, { engine: s.engine, fillers: () => true, languages: () => ["es"] });
    await done(r);
    expect(lines(r.inserted)[0]).toMatchObject({ text: "Bueno, vale." });
  });

  test("a dictation that was only fillers inserts nothing and keeps what was said", async () => {
    const s = stub([{ text: "Um.", language: "en" }]);
    const r = rig(HELLO, { engine: s.engine, fillers: () => true });
    const it = await done(r);
    expect(it).toMatchObject({ state: "empty", raw: "Um." });
    expect(lines(r.inserted)).toEqual([]);
  });
});
