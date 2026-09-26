/**
 * This machine's measured speed on the Models page (docs/ux/SERVER.md SV-U6, DESKTOP.md DK-E4) is
 * decode time over audio time, the same thing the published speed bar measures: a call's final
 * pass and a file job report `decode_s` without the recognizer's load or the speaker labels, and a
 * job whose llama-server engine starts for it reports none, since the start sits inside its first
 * decode. The slow parts are the fakes' busy-waits, so each check can fail on a fast machine too.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { JobWorker, runFinalPass, runJobPass } from "../src/main/asr/finalize-worker.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { concat, FakeModels, MemoryAudio, silence, speak } from "./fixtures/asr-fake.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const FAKE_MODELS = join(import.meta.dir, "fixtures", "asr-fake.ts");
/** Each slow part: longer than the fake decode of these clips takes on any machine. */
const SLOW_MS = 600;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const CLIP = concat(silence(0.4), speak(["hello", "world"], { voice: 1 }), silence(0.4));

function oneCall(): LogEvent[] {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.partEnded(1, "stop");
  b.add({ type: "call.ended", reason: "stop" });
  return b.events as LogEvent[];
}

async function callPass(o: ConstructorParameters<typeof FakeModels>[0]) {
  const models = new FakeModels(o);
  const result = await runFinalPass(
    { events: oneCall(), audio: new MemoryAudio({ 1: { mic: CLIP, call: CLIP } }), decode: null },
    models,
    () => {},
  );
  return { models, result };
}

describe("[SV-U6] a call's final pass times its decode alone", () => {
  test("the recognizer's load and the speaker labels are not in decode_s", async () => {
    const { models, result } = await callPass({ loadMs: SLOW_MS, diarizeMs: SLOW_MS });
    expect(result.ok).toBe(true);
    // Both slow parts ran in this pass.
    expect(models.loads["fake-parakeet"]).toBe(1);
    expect(models.diarizers.map((d) => d.calls)).toEqual([1]);
    expect(result.decode_s).toBeGreaterThan(0);
    expect(result.decode_s).toBeLessThan(SLOW_MS / 1000);
  });

  test("positive control: a slow decode shows in decode_s", async () => {
    const { models, result } = await callPass({ slowMs: SLOW_MS });
    expect(models.calls.length).toBeGreaterThan(0);
    expect(result.decode_s).toBeGreaterThanOrEqual((models.calls.length * SLOW_MS) / 1000);
  });
});

describe("[SV-U6] a file job times its decode alone", () => {
  test("the recognizer's load and the speaker labels are not in decode_s", async () => {
    const models = new FakeModels({ loadMs: SLOW_MS, diarizeMs: SLOW_MS });
    const r = await runJobPass({ samples: CLIP, diarize: true, decode: null }, models);
    expect(r.text).toBe("hello world");
    expect(models.loads["fake-parakeet"]).toBe(1);
    expect(models.diarizers.map((d) => d.calls)).toEqual([1]);
    expect(r.decode_s).toBeGreaterThan(0);
    expect(r.decode_s).toBeLessThan(SLOW_MS / 1000);
  });

  test("positive control: a slow decode shows in decode_s", async () => {
    const models = new FakeModels({ slowMs: SLOW_MS });
    const r = await runJobPass({ samples: CLIP, diarize: false, decode: null }, models);
    expect(models.calls.length).toBeGreaterThan(0);
    expect(r.decode_s).toBeGreaterThanOrEqual((models.calls.length * SLOW_MS) / 1000);
  });

  test("a job whose llama-server starts for it reports no decode time; the next job does", async () => {
    const t = tempDir("akou-measured-speed-");
    cleanups.push(t.cleanup);
    const w = new JobWorker({
      kind: "module",
      path: FAKE_MODELS,
      model: "fake-parakeet",
      options: {},
      final: {
        kind: "llama-server",
        engine: QWEN_ASR,
        model: join(t.dir, "q.gguf"),
        mmproj: join(t.dir, "p.gguf"),
        accelerator: "cpu",
        // The server takes this long to load its model, inside the first job's first decode.
        command: [process.execPath, FAKE_LLAMA, "--fake-loading-ms", String(SLOW_MS)],
      },
    });
    cleanups.push(() => w.close());
    const job = () =>
      w.run({
        samples: CLIP.slice(),
        diarize: false,
        decode: null,
        language: "auto",
        glossary: [],
      });
    const first = await job();
    expect(first.text).toBe("hello world");
    expect(first.decode_s).toBeUndefined();
    const second = await job();
    expect(second.text).toBe("hello world");
    expect(second.decode_s).toBeGreaterThan(0);
    expect(second.decode_s).toBeLessThan(SLOW_MS / 1000);
  });
});
