/**
 * The live transcript (live-worker.ts) against the deterministic fake engines
 * (tests/fixtures/asr-fake.ts): the pipeline on its own, the host writing to a real call's log
 * through a scripted capture session and a manual clock, and once through a real Worker thread.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LogEvent, Seg } from "../src/core/log/events.ts";
import { PROVISIONAL_TTL_MS } from "../src/core/log/fold.ts";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import {
  type CallAccess,
  LiveAsr,
  type LiveOut,
  LivePipeline,
  type VocabSource,
} from "../src/main/asr/live-worker.ts";
import { MIN_SPAN_SECONDS, padSpan, prepareSpan } from "../src/main/asr/pad.ts";
import { CallManager } from "../src/main/call/manager.ts";
import { buildDecodeList, type DecodeList } from "../src/main/vocab/decode-list.ts";
import type { MergedEntry } from "../src/main/vocab/files.ts";
import {
  flush,
  logOf,
  ManualClock,
  ofType,
  ScriptedEngine,
  types,
  until,
} from "./capture-helpers.ts";
import {
  concat,
  created,
  FakeModels,
  FakeRecognizer,
  RATE,
  silence,
  speak,
} from "./fixtures/asr-fake.ts";
import { TZ, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

// ---------------------------------------------------------------------------
// The pipeline alone

function pipeline(o: ConstructorParameters<typeof FakeModels>[0] = {}, live = {}) {
  const models = new FakeModels(o);
  const out: LiveOut[] = [];
  const p = new LivePipeline(
    models,
    live,
    (x) => out.push(x),
    () => 0,
  );
  return { models, out, p, segs: () => out.filter((x) => x.type === "seg") };
}

function feed(p: LivePipeline, ch: "mic" | "call", audio: Float32Array, sizes: number[] = [320]) {
  let at = 0;
  let k = 0;
  while (at < audio.length) {
    const n = Math.min(sizes[k++ % sizes.length] as number, audio.length - at);
    p.audio(1, ch, at, audio.subarray(at, at + n));
    at += n;
  }
}

const list = (names: string[], model = "fake-parakeet"): DecodeList =>
  buildDecodeList({ model, callVocab: [], names, files: [] });

describe("segmenting", () => {
  test("a segment closes after 0.7 s without speech; a shorter pause stays one segment", () => {
    const { p, segs } = pipeline();
    const a = concat(
      silence(0.5),
      speak(["hello", "world"]),
      silence(0.4),
      speak(["we", "should"]),
      silence(1),
      speak(["move", "the", "build"]),
      silence(1),
    );
    feed(p, "call", a);
    p.endPart(1);
    expect(segs().map((s) => (s.type === "seg" ? s.text : ""))).toEqual([
      "hello world we should",
      "move the build",
    ]);
  });

  test("unbroken speech is cut at the 12 s window, and nothing is lost at the cut", () => {
    const words = Array.from({ length: 40 }, (_, i) => (i % 2 ? "deploy" : "today"));
    const { p, segs } = pipeline();
    feed(p, "call", concat(silence(0.3), speak(words, { gapSeconds: 0.1 }), silence(1)));
    p.endPart(1);
    const s = segs().filter((x) => x.type === "seg") as Extract<LiveOut, { type: "seg" }>[];
    expect(s.length).toBe(2);
    expect((s[0] as { a1: number; a0: number }).a1 - (s[0] as { a0: number }).a0).toBeCloseTo(
      12,
      1,
    );
    const said = s.flatMap((x) => x.text.split(" "));
    // A word cut in half by the forced cut is heard on one side of it, never lost from both.
    expect(said.length).toBeGreaterThanOrEqual(40);
  });

  test("the window must exceed the pause", () => {
    expect(() => pipeline({}, { segmentPause: 2, segmentWindow: 2 })).toThrow(/exceed/);
  });

  test("[T1.11] A chunk fed twice: every sample is fed exactly once, whatever the chunking", () => {
    const a = concat(silence(0.4), speak(["hello", "world", "thanks"]), silence(1));
    const one = pipeline();
    feed(one.p, "call", a, [320]);
    const two = pipeline();
    feed(two.p, "call", a, [7777, 13, 512, 4096]);
    // A chunk sent again at the same position (a retried post) is not fed a second time.
    const three = pipeline();
    three.p.audio(1, "call", 0, a.subarray(0, 16000));
    three.p.audio(1, "call", 0, a.subarray(0, 16000));
    three.p.audio(1, "call", 8000, a.subarray(8000, a.length));
    const texts = (x: ReturnType<typeof pipeline>) =>
      x.out.filter((o) => o.type === "seg").map((o) => (o.type === "seg" ? o.text : ""));
    expect(texts(two)).toEqual(texts(one));
    expect(texts(three)).toEqual(texts(one));
    const last = (x: ReturnType<typeof pipeline>) =>
      x.out.filter((o) => o.type === "progress").at(-1);
    expect(last(two)).toMatchObject({ pos: a.length });
    expect(last(three)).toMatchObject({ pos: a.length });
    // Positive control: the same chunk fed as new audio does double the words.
    const dup = pipeline();
    dup.p.audio(1, "call", 0, a.subarray(0, 16000));
    dup.p.audio(1, "call", 16000, a.subarray(0, 16000));
    dup.p.audio(1, "call", 32000, a.subarray(16000));
    expect(texts(dup)).not.toEqual(texts(one));
  });
});

describe("[T1.9, T4.19] Short spans lose their words", () => {
  test("padding adds zeros after the speech up to 0.5 s and never touches the input", () => {
    const yes = speak(["yes"], { wordSeconds: 0.2, gapSeconds: 0 });
    const padded = padSpan(yes);
    expect(padded.length).toBe(MIN_SPAN_SECONDS * RATE);
    expect(Array.from(padded.subarray(0, yes.length))).toEqual(Array.from(yes));
    expect(padded.subarray(yes.length).every((x) => x === 0)).toBe(true);
    const long = silence(1);
    expect(padSpan(long)).toBe(long);
    const quiet = Float32Array.from([0.01, -0.02]);
    const g = prepareSpan(quiet);
    expect(quiet[1]).toBeCloseTo(-0.02, 6);
    // At most +20 dB, never attenuated.
    expect(g[1]).toBeCloseTo(-0.2, 5);
    expect(prepareSpan(Float32Array.from([0.9]))[0]).toBeCloseTo(0.9, 5);
  });

  test("a 0.2 s 'yes' on the live path is transcribed; unpadded, the engine drops it", () => {
    const yes = speak(["yes"], { wordSeconds: 0.2, gapSeconds: 0 });
    // No pre-roll or post-roll, so the span the VAD gives is the short word alone.
    const { p, segs, models } = pipeline({}, { preRoll: 0, postRoll: 0 });
    feed(p, "mic", concat(silence(1), yes, silence(1.5)));
    p.endPart(1);
    expect(segs()).toMatchObject([{ type: "seg", ch: "mic", spk: "you", text: "yes" }]);
    // Positive control: the same span, unpadded, straight to the engine.
    expect(new FakeRecognizer("fake-parakeet", {}).decode(yes).text).toBe("");
    expect(models.calls.every((c) => c.samples >= MIN_SPAN_SECONDS * RATE)).toBe(true);
  });
});

describe("hotwords", () => {
  test("[decision] A mid-call add applies forward: the next stream carries the word", () => {
    const { p, segs, models } = pipeline();
    p.setDecodeList(list([]), 1);
    feed(p, "call", concat(silence(0.3), speak(["deploy", "to", "hetzner"]), silence(1)));
    p.setDecodeList(list(["Hetzner"]), 2);
    const later = concat(speak(["deploy", "to", "hetzner"]), silence(1));
    const start = Math.round(0.3 * RATE) + speak(["deploy", "to", "hetzner"]).length + RATE;
    let at = 0;
    while (at < later.length) {
      p.audio(1, "call", start + at, later.subarray(at, at + 320));
      at += 320;
    }
    p.endPart(1);
    expect(segs().map((s) => (s.type === "seg" ? s.text : ""))).toEqual([
      "deploy to hetzna",
      "deploy to Hetzner",
    ]);
    const last = models.calls.at(-1);
    expect(last?.hotwords).toBe("Hetzner");
    expect(models.calls[0]?.hotwords).toBeUndefined();
  });

  test("[spike] Hotwords to a non-transducer model kill the process: no argument ever reaches it", () => {
    const { p, models, out } = pipeline({ model: "fake-moonshine" });
    // A list built for a transducer reaches a Moonshine pipeline (the workspace switched models):
    // the pipeline itself must keep it from the stream.
    p.setDecodeList(list(["Hetzner", "Kubernetes"]), 1);
    feed(p, "call", concat(silence(0.3), speak(["deploy", "to", "hetzner"]), silence(1)));
    p.endPart(1);
    expect(models.calls.length).toBeGreaterThan(0);
    expect(models.calls.every((c) => c.args === 0)).toBe(true);
    expect(out.filter((o) => o.type === "log" && o.level === "error")).toEqual([]);
    // Positive control: a list reaching this model is exactly the call that kills the process.
    expect(() => new FakeRecognizer("fake-moonshine", {}).decode(silence(1), "Hetzner")).toThrow(
      /Only transducer/,
    );
  });

  test("[T4.18, F1.7] Models loaded twice: once per run across two channels and three parts", () => {
    const { p, models } = pipeline();
    p.setDecodeList(list(["Hetzner"]), 1);
    for (const part of [1, 2, 3]) {
      const a = concat(
        silence(0.3),
        speak(["hello", "world", "we", "should"], { voice: 1 }),
        silence(1),
      );
      for (const ch of ["mic", "call"] as const) {
        for (let at = 0; at < a.length; at += 320) p.audio(part, ch, at, a.subarray(at, at + 320));
      }
      p.endPart(part);
    }
    expect(models.loads).toEqual({ "fake-vad": 2, "fake-parakeet": 1, "fake-embedding": 1 });
  });
});

describe("[T4.32] Relabel wastes a transcription", () => {
  test("an unmerge, like a name or a merge, runs no recognizer", () => {
    const { p, models } = pipeline();
    feed(p, "call", concat(silence(0.3), speak(["hello", "world", "we", "should"]), silence(1)));
    const before = models.calls.length;
    p.unmerge("c2", "c1");
    expect(models.calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The host, writing to a real call's log

interface Rig {
  clock: ManualClock;
  engine: ScriptedEngine;
  mgr: CallManager;
  asr: LiveAsr;
  events: LogEvent[];
  logs: { level: string; msg: string }[];
  models: () => FakeModels;
}

function rig(
  o: {
    fake?: ConstructorParameters<typeof FakeModels>[0];
    model?: string;
    vocab?: VocabSource;
    root?: string;
    inThread?: boolean;
    flushMs?: number;
  } = {},
): Rig {
  const root =
    o.root ??
    (() => {
      const t = tempDir();
      cleanups.push(t.cleanup);
      return t.dir;
    })();
  const clock = new ManualClock();
  const engine = new ScriptedEngine(clock);
  const events: LogEvent[] = [];
  const logs: Rig["logs"] = [];
  const spec: ModelSpec = {
    kind: "module",
    path: FAKE,
    model: o.model ?? "fake-parakeet",
    options: o.fake ?? {},
  };
  let asr: LiveAsr | null = null;
  const mgr = new CallManager({
    root,
    engine,
    clock,
    tz: TZ,
    user: "Ana",
    budgets: { stallMs: 1e12, flushMs: o.flushMs ?? 60_000 },
    onEvent: (id, e) => {
      events.push(e);
      asr?.onEvent(id, e);
    },
    onPacket: (id, part, p, ingest) => asr?.onPacket(id, part, p, ingest),
    beforeEnd: (id) => asr?.flush(id) ?? Promise.resolve(),
  });
  asr = new LiveAsr(
    {
      models: spec,
      inThread: o.inThread ?? true,
      clock,
      vocab: o.vocab ? () => o.vocab as VocabSource : undefined,
      onLog: (level, msg) => logs.push({ level, msg }),
    },
    (id) => mgr.controller(id) as CallAccess | undefined,
  );
  const a = asr;
  cleanups.push(async () => {
    await mgr.quit();
    await a.close();
  });
  return { clock, engine, mgr, asr, events, logs, models: () => created.at(-1) as FakeModels };
}

async function startCall(r: Rig) {
  await r.asr.ready;
  r.engine.onStart = (s) => s.capturing();
  const res = await r.mgr.start({ workspace: "work", title: "Sync" });
  if (!res.ok) throw new Error(res.error);
  r.engine.onStart = null;
  return res;
}

/** Lets the in-thread Worker side drain its queue. */
async function settle(_r: Rig, what: () => boolean, ms = 5000) {
  await until(
    async () => {
      await flush();
      return what();
    },
    ms,
    "the live pipeline",
  );
}

const segs = (events: LogEvent[]) => ofType(events, "seg") as Seg[];

describe("the host writes the live layer", () => {
  test("segments land with l-ids, seq, both channels, `you` on the mic and wall times from the anchors", async () => {
    const r = rig();
    await startCall(r);
    const started = ofType(r.events, "part.started")[0];
    const mic = concat(silence(0.5), speak(["hello", "world"]), silence(3));
    const call = concat(silence(2), speak(["we", "should", "move"], { voice: 3 }), silence(1.2));
    r.engine.last.play(mic, call);
    await r.mgr.stop();
    const s = segs(r.events);
    expect(s.map((x) => [x.id, x.ch, x.spk, x.text])).toEqual([
      ["l000001", "mic", "you", "hello world"],
      ["l000002", "call", "c1", "we should move"],
    ]);
    const first = s[0] as Seg;
    expect(first.layer).toBe("live");
    expect(first.model).toBe("fake-parakeet");
    expect(first.w0).toBe(Math.round((started?.wallStart as number) + (first.a0 as number) * 1000));
    // Every segment is written before the call ends: flush runs before call.ended.
    const endedSeq = ofType(r.events, "call.ended")[0]?.seq as number;
    expect(s.every((x) => x.seq < endedSeq)).toBe(true);
  });

  test("an utterance still open at Stop is written before call.ended", async () => {
    const r = rig();
    await startCall(r);
    const call = concat(silence(0.3), speak(["deploy", "the", "build"], { voice: 1 }));
    r.engine.last.play(silence(call.length / RATE), call);
    await r.mgr.stop();
    const s = segs(r.events);
    expect(s.map((x) => x.text)).toEqual(["deploy the build"]);
    const types = r.events.map((e) => e.type);
    expect(types.lastIndexOf("seg")).toBeLessThan(types.indexOf("call.ended"));
  });

  test("[T2.52] Clock drifts by paused time: a line after a 5-minute pause has the right w0", async () => {
    const r = rig();
    await startCall(r);
    r.engine.last.play(silence(1), silence(1));
    r.mgr.pause();
    await r.clock.advance(5 * 60_000);
    r.mgr.resume();
    const resume = ofType(r.events, "resume")[0];
    r.engine.last.play(
      silence(3),
      concat(silence(0.5), speak(["great"], { voice: 2 }), silence(1.5)),
    );
    await r.mgr.stop();
    const s = segs(r.events)[0] as Seg;
    expect(s.text).toBe("great");
    // w0 is the resume's wall time plus the audio after it, not the part start plus the file time.
    const expected = (resume?.wall as number) + ((s.a0 as number) - (resume?.a as number)) * 1000;
    expect(s.w0).toBe(Math.round(expected));
    const started = ofType(r.events, "part.started")[0];
    expect(s.w0).toBeGreaterThan((started?.wallStart as number) + 5 * 60_000);
  });

  test("[design] Provisional lines are never in the log and expire after 3 s", async () => {
    const r = rig();
    await startCall(r);
    const words = ["we", "should", "move", "the", "build", "to", "the", "new", "box"];
    const call = concat(silence(0.3), speak(words, { voice: 1 }));
    r.engine.last.play(silence(call.length / RATE), call);
    const view = r.mgr.live()?.view;
    await settle(r, () => (view?.provisional.current(r.clock.now()).length ?? 0) > 0);
    const shown = view?.provisional.current(r.clock.now())[0];
    expect(shown?.ch).toBe("call");
    expect(words.join(" ").startsWith(shown?.text ?? "x")).toBe(true);
    await r.clock.advance(PROVISIONAL_TTL_MS);
    expect(view?.provisional.current(r.clock.now())).toEqual([]);
    await r.mgr.stop();
    // The log holds the committed line only.
    expect(segs(r.events).map((x) => x.text)).toEqual([words.join(" ")]);
    expect(JSON.stringify(r.events)).not.toContain("provisional");
  });

  test("[T3.8] Capture priority under load: a backlog writes asr.lag, the audio is untouched", async () => {
    const r = rig();
    await startCall(r);
    // 40 s arrive at once: the recognizer falls behind and then catches up.
    const words = concat(
      ...Array.from({ length: 20 }, () => concat(speak(["ok", "great"]), silence(1.3))),
    );
    r.engine.last.play(words, words);
    const ingest = r.mgr.live()?.current?.ingest;
    expect(ingest?.pos.call).toBe(words.length);
    // Written when the backlog crosses 10 s and 30 s, not on every packet.
    const lag = ofType(r.events, "asr.lag").map((e) => e.seconds);
    expect(lag).toHaveLength(2);
    expect(lag[0]).toBeGreaterThanOrEqual(10);
    expect(lag[1]).toBeGreaterThanOrEqual(30);
    // And once more when it recovers.
    await settle(r, () => ofType(r.events, "asr.lag").length >= 3);
    expect(ofType(r.events, "asr.lag").at(-1)?.seconds).toBeLessThanOrEqual(10);
    await r.mgr.stop();
    expect(segs(r.events).length).toBe(40);
  });

  test("a recognizer that keeps up writes no asr.lag", async () => {
    const r = rig();
    await startCall(r);
    for (let i = 0; i < 5; i++) {
      r.engine.last.play(speak(["ok"]), speak(["ok"]));
      await settle(r, () => true);
    }
    await r.mgr.stop();
    expect(ofType(r.events, "asr.lag")).toEqual([]);
  });
});

describe("calls that overlap or outlive their end", () => {
  test("[T0.9] a call started while the last one is still stopping: the last one's open line lands before its call.ended", async () => {
    const r = rig();
    const a = await startCall(r);
    const said = concat(silence(0.3), speak(["deploy", "the", "build"], { voice: 1 }));
    r.engine.last.play(silence(said.length / RATE), said);
    // A hung teardown: A's stop takes the whole 5 s budget.
    r.engine.last.hangOnStop = true;
    const stopA = r.mgr.stop(a.call);
    await r.clock.advance(1_000);
    const b = await startCall(r);
    const other = concat(silence(0.3), speak(["new", "box"], { voice: 2 }), silence(1));
    r.engine.last.play(silence(other.length / RATE), other);
    await r.clock.advance(4_000);
    expect((await stopA).ok).toBe(true);
    await r.mgr.stop(b.call);
    const aLog = await logOf(a.folder);
    const aTypes = aLog.map((e) => e.type);
    expect(segs(aLog).map((x) => x.text)).toEqual(["deploy the build"]);
    expect(aTypes.lastIndexOf("seg")).toBeLessThan(aTypes.indexOf("call.ended"));
    // B is untouched: its own line, its own speaker numbering.
    const bLog = await logOf(b.folder);
    expect(segs(bLog).map((x) => [x.id, x.text])).toEqual([["l000001", "new box"]]);
  });

  test("a live result that arrives after call.ended is dropped, never written after the end", async () => {
    const r = rig({ inThread: false, fake: { slowMs: 300 }, flushMs: 100 });
    const a = await startCall(r);
    const said = concat(silence(0.3), speak(["deploy", "the", "build"], { voice: 1 }), silence(1));
    r.engine.last.play(silence(said.length / RATE), said);
    // The final pass holds the writer from the moment of Stop.
    const release = r.mgr.live()?.holdWriter();
    const stop = r.mgr.stop();
    // The flush budget runs out while the slow recognizer is still working.
    await r.clock.advance(100);
    expect((await stop).ok).toBe(true);
    await until(
      async () => {
        await flush();
        return (
          r.logs.some((l) => /call has ended/.test(l.msg)) ||
          r.events.findLast((e) => e.type !== "call.ended")?.type === "seg" ||
          types(r.events).indexOf("call.ended") < types(r.events).length - 1
        );
      },
      15_000,
      "the late live result",
    );
    release?.();
    const t = types(await logOf(a.folder));
    expect(t.at(-1)).toBe("call.ended");
  }, 30_000);
});

describe("the decode list and vocab.used", () => {
  const entry = (term: string, confirmed = true): MergedEntry => ({
    term,
    heard: [],
    source: "user",
    confirmed,
    added_at: "2026-09-01",
    scope: "workspace",
    file: "work.yaml",
  });

  test("[spike] The decode list is long: 100 file entries give 24 in vocab.used; unconfirmed never", async () => {
    const entries = [
      entry("Unconfirmedword", false),
      ...Array.from({ length: 100 }, (_, i) => entry(`Term${i}`)),
    ];
    const r = rig({ vocab: { entries, files: [{ path: "work.yaml", sha256: "ab".repeat(32) }] } });
    await startCall(r);
    r.engine.last.play(silence(1), silence(1));
    await settle(r, () => ofType(r.events, "vocab.used").length > 0);
    const used = ofType(r.events, "vocab.used")[0];
    expect(used?.entries.length).toBe(24);
    expect(used?.entries).not.toContain("Unconfirmedword");
    expect(used?.files).toEqual(["work.yaml"]);
    expect(r.logs.some((l) => /kept the first 24/.test(l.msg))).toBe(true);
  });

  test("[spike] Hotwords that silently do nothing: an unencodable word is logged and absent from vocab.used", async () => {
    const r = rig({
      fake: { unencodable: ["Kubernetes"] },
      vocab: { entries: [entry("Kubernetes"), entry("Hetzner")], files: [] },
    });
    await startCall(r);
    r.engine.last.play(silence(1), silence(1));
    await settle(r, () => ofType(r.events, "vocab.used").length > 0);
    expect(ofType(r.events, "vocab.used")[0]?.entries).toEqual(["Hetzner"]);
    expect(r.logs).toContainEqual({
      level: "error",
      msg: 'hotword "Kubernetes" dropped: pieces not in the model: <unk>',
    });
  });

  test("a vocab.add mid-call writes a new vocab.used and biases the next segment", async () => {
    const r = rig();
    await startCall(r);
    const say = concat(silence(0.3), speak(["deploy", "to", "hetzner"], { voice: 1 }), silence(1));
    r.engine.last.play(silence(say.length / RATE), say);
    await settle(r, () => segs(r.events).length === 1);
    r.mgr.live()?.record({
      type: "vocab.add",
      id: "v1",
      rev: 1,
      term: "Hetzner",
      heard: ["hetzna"],
      by: "user",
    });
    r.engine.last.play(silence(say.length / RATE), say);
    await r.mgr.stop();
    expect(segs(r.events).map((s) => s.text)).toEqual(["deploy to hetzna", "deploy to Hetzner"]);
    expect(ofType(r.events, "vocab.used").map((v) => v.entries)).toEqual([[], ["Hetzner"]]);
  });
});

describe("speakers through the log", () => {
  test("[T2.48, T3.10] a name given in part 1 renders for the same voice in the next app run", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const r1 = rig({ root: t.dir });
    const res = await startCall(r1);
    const voice = concat(
      silence(0.3),
      speak(["we", "should", "move", "the", "build"], { voice: 4 }),
      silence(1),
    );
    r1.engine.last.play(silence(voice.length / RATE), voice);
    await settle(r1, () => segs(r1.events).length === 1);
    expect(segs(r1.events)[0]?.spk).toBe("c1");
    r1.mgr.live()?.record({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
    await r1.mgr.stop();
    expect(ofType(r1.events, "speaker.centroid").map((c) => c.spk)).toContain("c1");
    await r1.asr.close();

    // A new app run (new manager, new Worker) restarts the call as part 2.
    const r2 = rig({ root: t.dir });
    await r2.asr.ready;
    r2.engine.onStart = (s) => s.capturing();
    const again = await r2.mgr.restart(res.call);
    expect(again.ok).toBe(true);
    const other = concat(silence(0.3), speak(["new", "box", "today"], { voice: 6 }), silence(1));
    r2.engine.last.play(silence(voice.length / RATE), voice);
    r2.engine.last.play(silence(other.length / RATE), other);
    await r2.mgr.stop();
    const s2 = segs(r2.events);
    expect(s2.map((s) => s.spk)).toEqual(["c1", "c2"]);
    const view = r2.mgr.controller(res.call)?.view;
    expect(view?.speakerLabel("c1")).toBe("Ben");
    expect(view?.speakerLabel("c2")).toBe("Speaker 2");
  });

  test("a result for another call is dropped, never written into the current one", async () => {
    const r = rig();
    await startCall(r);
    r.engine.last.play(silence(0.5), silence(0.5));
    await settle(r, () => true);
    const before = r.events.length;
    (r.asr as unknown as { onWorker(m: unknown): void }).onWorker({
      type: "seg",
      call: "01OLDCALL",
      part: 1,
      ch: "call",
      a0: 0,
      a1: 1,
      text: "late",
      spk: "c1",
      model: "fake-parakeet",
    });
    expect(r.events.length).toBe(before);
  });
});

describe("the real Worker thread", () => {
  test("a live-asr Worker that dies is replaced: the call still restarts its helper and later lines are transcribed", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const r = rig({ inThread: false, fake: { crashOnceFile: join(t.dir, "crashed") } });
    const a = await startCall(r);
    const first = concat(silence(0.3), speak(["hello", "world"], { voice: 1 }), silence(1));
    r.engine.last.play(silence(first.length / RATE), first);
    await until(
      async () => {
        await flush();
        return r.logs.some((l) => l.msg.includes("simulated worker crash"));
      },
      10_000,
      "the Worker crash in the app log",
    );
    // Audio keeps arriving while the Worker is dead or being replaced; nothing throws into the call.
    r.engine.last.play(silence(1), silence(1));
    // The helper exits: the automatic restart still happens.
    r.engine.onStart = (s) => s.capturing();
    r.engine.last.exit(70);
    await r.mgr.controller(a.call)?.idle();
    expect(ofType(r.events, "part.started").map((e) => e.part)).toEqual([1, 2]);
    expect(r.mgr.live()?.id).toBe(a.call);
    // The replacement Worker transcribes what comes next.
    const next = concat(silence(0.3), speak(["new", "box", "today"], { voice: 2 }), silence(1));
    r.engine.last.play(silence(next.length / RATE), next);
    await until(
      async () => {
        await flush();
        return segs(r.events).some((x) => x.text === "new box today");
      },
      10_000,
      "a line from the replacement Worker",
    );
    await r.mgr.stop();
    expect(r.logs.some((l) => l.level === "error" && /live ASR worker/.test(l.msg))).toBe(true);
    // A later call in the same app run is transcribed too.
    const b = await startCall(r);
    r.engine.last.play(silence(first.length / RATE), first);
    await r.mgr.stop(b.call);
    expect(segs(await logOf(b.folder)).map((x) => x.text)).toEqual(["hello world"]);
  }, 40_000);

  test("[T1.45] Harmless engine noise on stderr goes to the app log, and segments reach the log", async () => {
    const r = rig({ inThread: false, fake: { noisy: true } });
    await startCall(r);
    const call = concat(silence(0.3), speak(["hello", "world"], { voice: 1 }), silence(1));
    r.engine.last.play(silence(call.length / RATE), call);
    await until(
      async () => {
        await flush();
        return r.logs.some((l) => l.msg.includes("fake-engine: harmless warning"));
      },
      10_000,
      "the engine warning in the app log",
    );
    await r.mgr.stop();
    expect(segs(r.events).map((s) => s.text)).toEqual(["hello world"]);
    expect(r.logs.find((l) => l.msg.includes("fake-engine"))?.level).toBe("warn");
    expect(r.asr.loads["fake-parakeet"]).toBe(1);
  }, 20_000);
});
