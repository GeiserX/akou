/**
 * A file job on the Qwen engine (akou-5an.93, ASR-5): the job pass decodes its units through a
 * llama-server `FinalEngine` in place of the model set's recognizer, which never loads, while the
 * model set still gives the VAD and the speaker labels. The engine's language and the job's
 * keywords reach the model; an engine that stays down fails the job instead of returning it empty.
 * The server is the fake of `fixtures/fake-llama-server.ts`.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LlamaEngineSpec } from "../src/main/asr/engine.ts";
import { JobWorker, runJobPass } from "../src/main/asr/finalize-worker.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { createLlamaEngine } from "../src/main/asr/llama-server.ts";
import { concat, FakeModels, silence, speak } from "./fixtures/asr-fake.ts";
import { roomNoise } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const FAKE_MODELS = join(import.meta.dir, "fixtures", "asr-fake.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function spec(fake: string[] = []): { spec: LlamaEngineSpec; requests: () => unknown[] } {
  const t = tempDir("akou-qwen-job-");
  cleanups.push(t.cleanup);
  const log = join(t.dir, "fake.log");
  return {
    spec: {
      kind: "llama-server",
      engine: QWEN_ASR,
      model: join(t.dir, "q.gguf"),
      mmproj: join(t.dir, "p.gguf"),
      accelerator: "cpu",
      command: [process.execPath, FAKE_LLAMA, "--fake-log", log, ...fake],
    },
    requests: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
            .filter((l) => l.body)
            .map((l) => l.body)
        : [],
  };
}

/** The process has ended: no such pid, or a zombie its terminated Worker never reaped. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  if (process.platform === "win32") return false;
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  return r.stdout.toString().trim().startsWith("Z");
}

const TWO_VOICES = concat(
  silence(0.4),
  speak(["hello", "world"], { voice: 1 }),
  silence(1.2),
  speak(["ok", "great"], { voice: 4 }),
  silence(0.4),
);

describe("a job on Qwen", () => {
  test("the units go to the engine, the lines carry speakers, and the recognizer never loads", async () => {
    const s = spec();
    const engine = createLlamaEngine(s.spec);
    cleanups.push(() => engine.unload());
    const models = new FakeModels();
    const r = await runJobPass(
      { samples: TWO_VOICES, diarize: true, decode: null },
      models,
      undefined,
      engine,
    );
    expect(r.model).toBe(QWEN_ASR);
    expect(r.language).toBe("en");
    expect(r.segments.map((x) => [x.speaker, x.text])).toEqual([
      ["s0", "hello world"],
      ["s1", "ok great"],
    ]);
    // The VAD and the diarizer came from the model set; its recognizer was never built.
    expect(models.recognizers).toHaveLength(0);
    expect(models.diarizers).toHaveLength(1);
    // One request per decoded piece.
    expect(s.requests().length).toBeGreaterThanOrEqual(2);
  });

  test("positive control: the same job without the engine decodes on the model set's recognizer", async () => {
    const models = new FakeModels();
    const r = await runJobPass({ samples: TWO_VOICES, diarize: true, decode: null }, models);
    expect(r.model).toBe("fake-parakeet");
    expect(models.recognizers).toHaveLength(1);
  });

  test("the job's language is forced and its keywords are the glossary", async () => {
    const s = spec();
    const engine = createLlamaEngine(s.spec);
    cleanups.push(() => engine.unload());
    const x = concat(silence(0.3), speak(["deploy", "hetzner"]), silence(0.5));
    const r = await runJobPass(
      { samples: x, diarize: false, decode: null, language: "es", glossary: ["Hetzner"] },
      new FakeModels(),
      undefined,
      engine,
    );
    expect(r.language).toBe("es");
    expect(r.text).toBe("deploy Hetzner");
    // The auto decode answered English, so the Spanish one was forced, with the same context.
    const body = s.requests()[1] as { messages: { role: string; content: unknown }[] };
    expect(body.messages[0]).toEqual({ role: "system", content: "Hetzner" });
    expect(body.messages.at(-1)).toEqual({
      role: "assistant",
      content: "language Spanish<asr_text>",
    });
  });

  test("the job's language is the one most of its text is in, not the first piece's", async () => {
    // A filler the model heard as Chinese, then two pieces of English: the job is English.
    let n = 0;
    const engine = {
      id: QWEN_ASR,
      features: { confidence: false, timestamps: false, glossary: true, languageId: true },
      load: async () => {},
      unload: async () => {},
      decode: async () => {
        n++;
        return n === 1
          ? { engine: QWEN_ASR, text: "嗯", words: [], lang: "zh", ms: 1 }
          : {
              engine: QWEN_ASR,
              text: "it is up there on the screen",
              words: [],
              lang: "en",
              ms: 1,
            };
      },
    };
    const x = concat(
      silence(0.3),
      speak(["yes"]),
      silence(1.2),
      speak(["hello", "world"]),
      silence(1.2),
      speak(["ok", "great"]),
      silence(0.4),
    );
    const r = await runJobPass(
      { samples: x, diarize: false, decode: null },
      new FakeModels(),
      undefined,
      engine,
    );
    expect(n).toBe(3);
    expect(r.language).toBe("en");
  });

  test("a piece with no speech in it is never sent to Qwen, which would invent a filler there", async () => {
    // Two turns with room noise between them: the turn boundaries make the noise its own piece.
    const x = concat(
      silence(0.3),
      speak(["hello", "world"], { voice: 1 }),
      roomNoise(3, 7, 0.02),
      speak(["ok", "great"], { voice: 4 }),
      silence(0.3),
    );
    const s = spec();
    const engine = createLlamaEngine(s.spec);
    cleanups.push(() => engine.unload());
    const r = await runJobPass(
      { samples: x, diarize: true, decode: null },
      new FakeModels(),
      undefined,
      engine,
    );
    expect(r.segments.map((g) => g.text)).toEqual(["hello world", "ok great"]);
    expect(s.requests()).toHaveLength(2);
    // Positive control: on the model set's recognizer the noise piece is decoded (and heard as nothing).
    const m = new FakeModels();
    await runJobPass({ samples: x, diarize: true, decode: null }, m);
    expect(m.calls).toHaveLength(3);
  });

  test("[SV-R5] ten seconds of room noise on best: empty text, and Qwen is never asked", async () => {
    const s = spec();
    const engine = createLlamaEngine(s.spec);
    cleanups.push(() => engine.unload());
    const r = await runJobPass(
      { samples: roomNoise(10), diarize: true, decode: null },
      new FakeModels(),
      undefined,
      engine,
    );
    expect([r.text, r.segments]).toEqual(["", []]);
    expect(s.requests()).toHaveLength(0);
  });

  test("an engine that stays down fails the job with engine_unavailable instead of skipping its text", async () => {
    const s = spec(["--fake-500", "99"]);
    const engine = createLlamaEngine(s.spec);
    cleanups.push(() => engine.unload());
    const err = await runJobPass(
      { samples: TWO_VOICES, diarize: false, decode: null },
      new FakeModels(),
      undefined,
      engine,
    ).catch((e) => e);
    expect(err.code).toBe("engine_unavailable");
  });

  test("through the job Worker: the spec's engine decodes, and closing the Worker stops llama-server", async () => {
    const s = spec();
    const w = new JobWorker({
      kind: "module",
      path: FAKE_MODELS,
      model: "fake-parakeet",
      options: {},
      final: s.spec,
    });
    const r = await w.run({
      samples: concat(silence(0.3), speak(["deploy", "today"]), silence(0.5)),
      diarize: false,
      decode: null,
      language: "auto",
      glossary: [],
    });
    expect(r.model).toBe(QWEN_ASR);
    expect(r.segments.map((x) => x.text)).toEqual(["deploy today"]);
    const pids = w.children();
    expect(pids).toHaveLength(1);
    w.close();
    await Bun.sleep(300);
    for (const pid of pids) expect(gone(pid)).toBe(true);
  });
});
