/**
 * DC-E7 (docs/ux/DICTATION.md): the words as you speak from a streaming model, and
 * `dictation.final`. A session feeds its audio to a stream opened at the press and the stream's
 * words are the partials, with nothing decoded again; with no stream it falls back to the
 * re-decode of DC-E5. The text inserted comes from the source `dictation.final` names: the
 * stream's own words for `live`, the engine's decode of the buffer for the others. The live Worker
 * opens the stream on the engine a call runs when it hears the dictation, never a second copy.
 *
 * Driven message by message with a stub engine and a stub stream: no device, no key, no model.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { LiveToken } from "../src/main/asr/engine.ts";
import { type DictationStream, LiveAsr, LivePipeline } from "../src/main/asr/live-worker.ts";
import { CAPTURE_RATE, type Packet } from "../src/main/capture/protocol.ts";
import {
  finalOf,
  LIVE_MISSING_VERDICT,
  resolveDictationEngine,
} from "../src/main/dictation/engines.ts";
import { LiveWords, liveDecode, tokenWords } from "../src/main/dictation/live.ts";
import type { AppToHelper } from "../src/main/dictation/protocol.ts";
import {
  type DictationEngine,
  DictationSession,
  type EngineDecoded,
  type PreviewPartial,
  type WordStream,
} from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import { FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { created, FakeModels, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const TARGET = { app: "com.example.editor", pid: 1, window: "w1", field: "editable" } as const;
const DECODED = "the words parakeet decoded whole";
const STREAMED = "the words the stream heard";

const decoded = (text: string, engine?: string): EngineDecoded => ({
  text,
  words: [],
  language: null,
  model: "stub",
  ms: 1,
  spans: 1,
  ...(engine ? { engine } : {}),
});

/** A stub stream: it hears `STREAMED` a word per packet, and answers it whole at the release. */
function stubStream(o: { failed?: boolean } = {}) {
  const st = { pushed: 0, finished: 0, cancelled: 0 };
  let onText: (t: string) => void = () => {};
  const words = STREAMED.split(" ");
  const stream: WordStream = {
    ok: () => !o.failed,
    push: () => {
      st.pushed++;
      onText(words.slice(0, Math.min(words.length, st.pushed)).join(" "));
    },
    finish: async () => {
      st.finished++;
      return decoded(STREAMED, "live");
    },
    cancel: () => {
      st.cancelled++;
    },
  };
  return {
    st,
    open: (fn: (t: string) => void) => {
      onText = fn;
      return stream;
    },
  };
}

/** A session over an engine named `engine`, with `stream` as its stream at the press. */
function rig(o: {
  engine: "fast" | "best" | "live";
  stream?: ReturnType<typeof stubStream> | null;
  secure?: boolean;
}) {
  const t = tempDir("akou-dict-live-");
  cleanups.push(t.cleanup);
  const log = new DictationLog(t.dir);
  cleanups.push(() => log.close());
  const sent: AppToHelper[] = [];
  const partials: PreviewPartial[] = [];
  const previews: number[] = [];
  let decodes = 0;
  const engine: DictationEngine = {
    name: o.engine,
    decode: async () => {
      decodes++;
      return decoded(DECODED);
    },
  };
  const s = new DictationSession({
    log,
    engine: () => engine,
    send: (c) => sent.push(c),
    bindings: () => ({
      hotkey: "RightCommand",
      draft: "",
      fixLast: "",
      pasteLast: "",
      activation: "hold-or-toggle",
    }),
    now: () => Date.now(),
    preview: () => async (samples) => {
      previews.push(samples.length);
      return decoded("a re-decoded partial");
    },
    onPartial: (p) => partials.push(p),
    stream: (onText) => (o.stream ? o.stream.open(onText) : null),
  });
  s.onMessage({
    type: "ready",
    protocol: "akou-dictate/1",
    version: "1",
    grants: { mic: "granted", accessibility: "granted" },
    backend: "fake",
    swallow_keys: true,
  });
  s.onMessage({
    type: "session.started",
    id: "1",
    target: o.secure ? { ...TARGET, field: "secure" } : TARGET,
    capture_ns: "0",
  });
  let n = 0;
  const feed = async (seconds: number) => {
    for (let i = 0; i < seconds * 10; i++) {
      const p: Packet = {
        ch: "mic",
        zeroFilled: false,
        captureNs: 0n,
        fileSeconds: n++ / 10,
        samples: new Float32Array(CAPTURE_RATE / 10).fill(0.1),
      };
      s.onPacket(p);
      await new Promise((res) => setTimeout(res, 0));
    }
  };
  const end = async (reason: "release" | "cancel" = "release") => {
    s.onMessage({ type: "session.ended", id: "1", reason });
    if (reason === "cancel") {
      await until(() => log.items().length > 0, 5000, "the cancel");
      return;
    }
    await until(() => sent.some((c) => c.type === "insert"), 5000, "the insert");
  };
  const insert = () => sent.find((c) => c.type === "insert") as { text: string } | undefined;
  return { s, log, partials, previews, feed, end, insert, decodes: () => decodes };
}

describe("DC-E7: the words as you speak come from the stream", () => {
  test("the stream's words are the partials, whole, and nothing is decoded again", async () => {
    const stream = stubStream();
    const r = rig({ engine: "fast", stream });
    await r.feed(1);
    expect(r.partials.at(-1)).toEqual({ text: STREAMED, language: null });
    // Every packet reached the stream; no preview decode ran.
    expect(stream.st.pushed).toBe(10);
    expect(r.previews).toEqual([]);
  });

  test("with no streaming model the preview decodes again, as before", async () => {
    const r = rig({ engine: "fast", stream: null });
    await r.feed(1);
    expect(r.previews.length).toBeGreaterThan(0);
    expect(r.partials.at(-1)?.text).toBe("a re-decoded partial");
  });

  test("a stream that could not open falls back to decoding again", async () => {
    const stream = stubStream({ failed: true });
    const r = rig({ engine: "fast", stream });
    await r.feed(1);
    expect(r.previews.length).toBeGreaterThan(0);
  });

  test("a password field's session opens no stream (DC-N8)", async () => {
    const stream = stubStream();
    const r = rig({ engine: "live", stream, secure: true });
    await r.feed(1);
    expect(stream.st.pushed).toBe(0);
    expect(r.partials).toEqual([]);
  });

  test("a cancelled session drops its stream", async () => {
    const stream = stubStream();
    const r = rig({ engine: "live", stream });
    await r.feed(1);
    await r.end("cancel");
    expect(stream.st).toMatchObject({ finished: 0, cancelled: 1 });
  });
});

describe("DC-E7: dictation.final picks the source of the inserted text", () => {
  test("live inserts the stream's own words at the release, with no decode of the buffer", async () => {
    const stream = stubStream();
    const r = rig({ engine: "live", stream });
    await r.feed(1);
    await r.end();
    expect(r.insert()?.text).toBe(STREAMED);
    expect(r.decodes()).toBe(0);
    expect(stream.st).toMatchObject({ finished: 1, cancelled: 0 });
    expect(r.log.items()[0]).toMatchObject({ text: STREAMED, engine: "live" });
  });

  for (const engine of ["fast", "best"] as const) {
    test(`${engine === "fast" ? "parakeet" : "qwen"} inserts the engine's decode, and the stream is let go`, async () => {
      const stream = stubStream();
      const r = rig({ engine, stream });
      await r.feed(1);
      await r.end();
      expect(r.insert()?.text).toBe(DECODED);
      expect(r.decodes()).toBe(1);
      expect(stream.st).toMatchObject({ finished: 0, cancelled: 1 });
    });
  }

  test("live with no stream at the press decodes the buffer on the live engine itself", async () => {
    const r = rig({ engine: "live", stream: null });
    await r.feed(1);
    await r.end();
    expect(r.insert()?.text).toBe(DECODED);
    expect(r.decodes()).toBe(1);
  });

  test("the rule: auto follows dictation.final; fast, best and remote win; live waits for its model", () => {
    const at = (setting: string, final: string, liveReady = true) =>
      resolveDictationEngine({
        setting,
        accelerator: "metal",
        bestReady: true,
        final,
        liveReady,
      });
    expect(at("auto", "live").engine).toBe("live");
    expect(at("auto", "qwen").engine).toBe("best");
    // parakeet is Parakeet, even where Qwen runs on a GPU and is downloaded.
    expect(at("auto", "parakeet")).toMatchObject({ engine: "fast", wanted: null });
    // A caller that passes no dictation.final keeps auto's pick by the machine.
    expect(
      resolveDictationEngine({ setting: "auto", accelerator: "metal", bestReady: true }).engine,
    ).toBe("best");
    expect(at("fast", "live").engine).toBe("fast");
    expect(at("best", "live").engine).toBe("best");
    expect(at("remote", "live").engine).toBe("remote");
    expect(at("auto", "live", false)).toMatchObject({
      engine: "fast",
      wanted: "live",
      verdict: LIVE_MISSING_VERDICT,
      download: false,
    });
    expect(["fast", "best", "live", "remote", null].map((e) => finalOf(e))).toEqual([
      "parakeet",
      "qwen",
      "live",
      "remote",
      null,
    ]);
  });
});

describe("DC-E7: the stream's words", () => {
  const tok = (text: string, t: number): LiveToken => ({ text, t, conf: 0.9 });

  test("tokens become words: a leading space starts one, and each ends where the next starts", () => {
    expect(
      tokenWords([tok(" hel", 0.1), tok("lo", 0.3), tok(" there", 0.6), tok(".", 0.8)]),
    ).toEqual([
      { w: "hello", s: 0.1, e: 0.6, c: 0.9 },
      { w: "there.", s: 0.6, e: 0.6, c: 0.9 },
    ]);
  });

  /**
   * A fake stream on the Worker: it hears one token per push and one more at the flush, and is
   * lost when `lost` settles.
   */
  function fakeOpen(
    lost: Promise<Error> = new Promise(() => {}),
  ): (onWords: (t: LiveToken[]) => void) => DictationStream {
    return (onWords) => {
      let n = 0;
      return {
        opened: Promise.resolve({ engine: "nemotron-en-560", lang: "en", ms: 0 }),
        lost,
        push: () => onWords([tok(` w${n++}`, n)]),
        finish: async () => onWords([tok(" last", 99)]),
        cancel: () => {},
      };
    };
  }

  test("a stream lost after it opened stops being ok, so the preview decodes again", async () => {
    let lose!: (e: Error) => void;
    const w = new LiveWords(
      fakeOpen(
        new Promise<Error>((res) => {
          lose = res;
        }),
      ),
      () => {},
    );
    await Promise.resolve();
    expect(w.ok()).toBe(true);
    lose(new Error("the recognizer failed"));
    await until(() => !w.ok(), 1000, "the stream lost");
  });

  test("LiveWords sends the whole text so far, and finishes with every word", async () => {
    const seen: string[] = [];
    const w = new LiveWords(fakeOpen(), (t) => seen.push(t));
    w.push(new Float32Array(10));
    w.push(new Float32Array(10));
    expect(seen).toEqual(["w0", "w0 w1"]);
    const d = await w.finish();
    expect(d).toMatchObject({ text: "w0 w1 last", engine: "live", model: "nemotron-en-560" });
    expect(d.language).toBe("en");
  });

  test("a whole buffer streams in one-second pieces and comes back as one decode", async () => {
    const d = await liveDecode(fakeOpen(), new Float32Array(CAPTURE_RATE * 3));
    expect(d.text).toBe("w0 w1 w2 last");
  });
});

describe("DC-E7: the live Worker shares its streaming model", () => {
  const noSpeakers = { centroids: [], merges: [], unmerged: [], ids: [] };

  test("with no call it loads the one asked for; a call's engine that hears the dictation is shared", async () => {
    const models = new FakeModels();
    const p = new LivePipeline(models, {}, () => {});
    const got = p.openDictation(1, { engine: "nemotron-en-560", lang: "en" }, ["en"], false);
    expect(got.engine).toBe("nemotron-en-560");
    const said = p.dictationAudio(1, speak(["hello"]));
    const tail = p.closeDictation(1, true);
    expect([...said, ...tail].map((t) => t.text.trim())).toEqual(["hello"]);
    // A call on the many-language model: the dictation streams on it, and nothing else loads.
    await p.beginCall({ ...noSpeakers, live: { engine: "nemotron-3.5-560", lang: "auto" } });
    const shared = p.openDictation(2, { engine: "nemotron-en-560", lang: "en" }, ["en"], true);
    expect(shared).toEqual({ engine: "nemotron-3.5-560", lang: "en" });
    expect(models.loads["nemotron-en-560"]).toBe(1);
    expect(models.loads["nemotron-3.5-560"]).toBe(1);
    p.closeDictation(2, false);
    p.stop();
  });

  test("a call's engine that does not hear the dictation is kept, and the dictation refused", async () => {
    const models = new FakeModels();
    const p = new LivePipeline(models, {}, () => {});
    await p.beginCall({ ...noSpeakers, live: { engine: "nemotron-en-560", lang: "en" } });
    expect(() =>
      p.openDictation(1, { engine: "nemotron-3.5-1120", lang: "es" }, ["es"], true),
    ).toThrow(/a call runs nemotron-en-560/);
    // Once the call has ended the dictation may load its own.
    expect(
      p.openDictation(1, { engine: "nemotron-3.5-1120", lang: "es" }, ["es"], false).engine,
    ).toBe("nemotron-3.5-1120");
    p.stop();
  });

  test("the warm-up loads the recognizer and the streaming model, never a call's in its place", async () => {
    const models = new FakeModels();
    const p = new LivePipeline(models, {}, () => {});
    p.warmDictation({ engine: "nemotron-en-560", lang: "en" }, false);
    expect(models.loads).toMatchObject({ "fake-parakeet": 1, "nemotron-en-560": 1 });
    // Again: nothing loads twice.
    p.warmDictation({ engine: "nemotron-en-560", lang: "en" }, false);
    expect(models.loads).toMatchObject({ "fake-parakeet": 1, "nemotron-en-560": 1 });
    // A call on another engine runs: the warm-up leaves it be.
    await p.beginCall({ ...noSpeakers, live: { engine: "nemotron-3.5-560", lang: "auto" } });
    p.warmDictation({ engine: "nemotron-3.5-1120", lang: "es" }, true);
    expect(models.loads["nemotron-3.5-1120"]).toBeUndefined();
    expect(models.loads["nemotron-3.5-560"]).toBe(1);
    p.stop();
  });

  test("through the host: words come as the audio does, and the flush brings the last", async () => {
    const asr = new LiveAsr(
      {
        models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
        inThread: true,
      },
      () => undefined,
    );
    cleanups.push(() => asr.close());
    await asr.ready;
    const words: string[] = [];
    const s = asr.openDictation({ engine: "nemotron-en-560", lang: "en" }, ["en"], (t) =>
      words.push(...t.map((x) => x.text.trim())),
    );
    expect(await s.opened).toMatchObject({ engine: "nemotron-en-560", lang: "en" });
    s.push(speak(["hello", "world"]));
    await s.finish();
    expect(words).toEqual(["hello", "world"]);
    // Finished, it is gone: a second finish is refused.
    await expect(s.finish()).rejects.toThrow();
  });

  test("through the host: a stream whose audio fails is lost, says why, and takes no more audio", async () => {
    const asr = new LiveAsr(
      {
        models: {
          kind: "module",
          path: FAKE_MODELS,
          model: "fake-parakeet",
          options: { livePushFails: true },
        },
        inThread: true,
      },
      () => undefined,
    );
    cleanups.push(() => asr.close());
    await asr.ready;
    const s = asr.openDictation({ engine: "nemotron-en-560", lang: "en" }, ["en"], () => {});
    await s.opened;
    s.push(speak(["hello"]));
    // Without the Worker's reply the host keeps the stream, and `lost` never settles.
    const lost = await Promise.race([s.lost, Bun.sleep(2000).then(() => null)]);
    expect(lost?.message).toMatch(/decode failed/);
    // Gone on both sides: a finish is refused rather than waiting on a stream nobody serves, and
    // the Worker closed its stream.
    await expect(s.finish()).rejects.toThrow(/not open/);
    const engine = (created.at(-1) as FakeModels).liveEngines.find(
      (e) => e.id === "nemotron-en-560",
    );
    expect(engine?.streams.map((x) => x.closed)).toEqual([true]);
  });

  test("through the host: a stream open when the recognizer goes away is lost, and says why", async () => {
    const asr = new LiveAsr(
      {
        models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
        inThread: true,
      },
      () => undefined,
    );
    await asr.ready;
    const s = asr.openDictation({ engine: "nemotron-en-560", lang: "en" }, ["en"], () => {});
    await s.opened;
    await asr.close();
    expect((await s.lost).message).toMatch(/closed/);
  });
});
