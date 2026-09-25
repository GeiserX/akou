/**
 * Live speaker labels from a stream diarizer (live-worker.ts with `asr.diarizer` nemotron) against
 * the fake one in tests/fixtures/asr-fake.ts, which decides in steps with a look-ahead the way
 * Nemotron does live: the pipeline alone, then through the host into a real call's log.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LogEvent, Seg } from "../src/core/log/events.ts";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import {
  type CallAccess,
  LiveAsr,
  type LiveOut,
  LivePipeline,
  STREAM_FLUSH_MS,
} from "../src/main/asr/live-worker.ts";
import { CallManager } from "../src/main/call/manager.ts";
import { ManualClock, ofType, ScriptedEngine } from "./capture-helpers.ts";
import { concat, FakeModels, type FakeOptions, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { TZ, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");
const NEMO: FakeOptions = { diarizer: "nemotron" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type SegOut = Extract<LiveOut, { type: "seg" }>;

function pipeline(o: FakeOptions = NEMO) {
  const models = new FakeModels(o);
  const out: LiveOut[] = [];
  const p = new LivePipeline(
    models,
    {},
    (x) => out.push(x),
    () => 0,
  );
  const segs = () => out.filter((x): x is SegOut => x.type === "seg");
  return { models, out, p, segs, spk: () => segs().map((s) => `${s.ch}:${s.spk}`) };
}

function feed(p: LivePipeline, part: number, ch: "mic" | "call", audio: Float32Array) {
  for (let at = 0; at < audio.length; at += 320) {
    p.audio(part, ch, at, audio.subarray(at, Math.min(audio.length, at + 320)));
  }
}

/** Voice `v` says a few words (about 1.5 s: long enough to embed), then 1 s of silence. */
const says = (v: number, words = ["we", "should", "move", "the"]) =>
  concat(speak(words, { voice: v }), silence(1));

describe("labels from the stream", () => {
  test("two voices on the call channel get two labels; the mic stays you", async () => {
    const { p, spk, models } = pipeline();
    feed(p, 1, "call", concat(silence(0.3), says(1), says(5), says(1)));
    feed(p, 1, "mic", concat(silence(0.3), says(0)));
    await p.endPart(1);
    expect(spk().filter((s) => s.startsWith("call"))).toEqual(["call:c1", "call:c2", "call:c1"]);
    expect(spk().filter((s) => s.startsWith("mic"))).toEqual(["mic:you"]);
    // The model does the labelling; embeddings only feed the centroids.
    expect(models.loads["fake-nemotron"]).toBe(1);
    expect(models.streams[0]?.resets).toBe(0);
  });

  test("a call line waits until the model has decided all of it, then lands in order", async () => {
    // A slow step (4 s): the second line closes long before the model reaches its end.
    const { p, segs } = pipeline({ ...NEMO, streamStep: 4, streamLookahead: 0.5 });
    feed(p, 1, "call", concat(silence(0.3), says(1), says(5)));
    // Positive control for the wait: both lines are closed, so without it both would be out.
    const early = segs().length;
    expect(early).toBeLessThan(2);
    await p.endPart(1);
    expect(segs().map((s) => s.spk)).toEqual(["c1", "c2"]);
    expect(segs().map((s) => s.a0)).toEqual([...segs().map((s) => s.a0)].sort((a, b) => a - b));
  });

  test("a line longer than one model step is labelled by all of it, not by its last seconds", async () => {
    // One line: voice 1 for ten words (3.7 s), a breath under the pause, voice 5 for three words
    // (1.1 s). Then voice 1 alone. The model decides the first line in three steps (1.68 s each).
    const long = ["we", "should", "move", "the", "build", "to", "new", "box", "thanks", "meeting"];
    const audio = concat(
      silence(0.3),
      speak(long, { voice: 1 }),
      silence(0.3),
      speak(["yes", "no", "ok"], { voice: 5 }),
      silence(1.5),
      says(1, ["hello", "world", "today", "deploy"]),
    );
    const { p, segs } = pipeline();
    feed(p, 1, "call", audio);
    await p.endPart(1);
    const [first] = segs();
    // Positive control for the setup: the first line spans more than one step and its look-ahead,
    // so turns were reported (and could be forgotten) before it closed.
    expect((first as SegOut).a1 - (first as SegOut).a0).toBeGreaterThan(1.68 + 0.32 + 1);
    expect(first?.text).toContain("meeting yes");
    expect(segs().map((s) => s.spk)).toEqual(["c1", "c1"]);
  });

  test("[T2.48] a new part continues the stream: a voice keeps its label across parts", async () => {
    const { p, spk, models } = pipeline();
    feed(p, 1, "call", concat(silence(0.3), says(1), says(5)));
    await p.endPart(1);
    // Part 2 opens with the second voice.
    feed(p, 2, "call", concat(silence(0.3), says(5), says(1)));
    await p.endPart(2);
    expect(spk()).toEqual(["call:c1", "call:c2", "call:c2", "call:c1"]);
    expect(models.streams.length).toBe(1);
    expect(models.streams[0]?.resets).toBe(0);

    // Positive control: a stream that starts at part 2 numbers that voice first.
    const fresh = pipeline();
    feed(fresh.p, 2, "call", concat(silence(0.3), says(5), says(1)));
    await fresh.p.endPart(2);
    expect(fresh.spk()).toEqual(["call:c1", "call:c2"]);
  });

  test("[T2.48, T3.10] a stream that starts over takes the call's labels back by centroid", async () => {
    const first = pipeline();
    feed(first.p, 1, "call", concat(silence(0.3), says(1), says(5)));
    await first.p.endPart(1);
    const centroids = first.out
      .filter((o) => o.type === "centroid")
      .map((o) => o as { spk: string; vec: string });
    expect(centroids.map((c) => c.spk).sort()).toEqual(["c1", "c2"]);

    // The next app run: a new pipeline and a new stream, the call's speakers from its log.
    const next = pipeline();
    await next.p.beginCall({ centroids, ids: ["c1", "c2"] });
    feed(next.p, 2, "call", concat(silence(0.3), says(5), says(1), says(3)));
    await next.p.endPart(2);
    expect(next.spk()).toEqual(["call:c2", "call:c1", "call:c3"]);

    // A known voice whose first line after the restart is too short to embed is not renumbered:
    // that line is c?, and the voice takes its label back on its first line long enough to match.
    const short = pipeline();
    await short.p.beginCall({ centroids, ids: ["c1", "c2"] });
    feed(
      short.p,
      2,
      "call",
      concat(silence(0.3), speak(["yes"], { voice: 5 }), silence(1), says(5), says(1)),
    );
    await short.p.endPart(2);
    expect(short.spk()).toEqual(["call:c?", "call:c2", "call:c1"]);
    // Control: with nothing to match against (no centroids), a short first line takes the next
    // number at once, as before.
    const none = pipeline();
    await none.p.beginCall({ centroids: [], ids: [] });
    feed(
      none.p,
      2,
      "call",
      concat(silence(0.3), speak(["yes"], { voice: 5 }), silence(1), says(5)),
    );
    await none.p.endPart(2);
    expect(none.spk()).toEqual(["call:c1", "call:c1"]);

    // Positive control: without the centroids the same voices get new numbers, never old ones.
    const blind = pipeline();
    await blind.p.beginCall({ centroids: [], ids: ["c1", "c2"] });
    feed(blind.p, 2, "call", concat(silence(0.3), says(5), says(1)));
    await blind.p.endPart(2);
    expect(blind.spk()).toEqual(["call:c3", "call:c4"]);
  });

  test("a new call resets the stream and waits for the last call's labels first", async () => {
    const { p, out, models } = pipeline({ ...NEMO, streamStep: 4, streamLookahead: 0.5 });
    feed(p, 1, "call", concat(silence(0.3), says(1), says(5)));
    await p.beginCall({ centroids: [], ids: [] });
    const labelled = out.filter((o): o is SegOut => o.type === "seg").map((s) => s.spk);
    expect(labelled).toEqual(["c1", "c2"]);
    expect(models.streams[0]?.resets).toBe(1);
    feed(p, 1, "call", concat(silence(0.3), says(5)));
    await p.endPart(1);
    // Numbered afresh in the new call.
    expect(out.filter((o): o is SegOut => o.type === "seg").at(-1)?.spk).toBe("c1");
  });
});

describe("a diarizer that fails costs labels, never lines", () => {
  test("a diarizer that dies is restarted at most three times; every line still lands", async () => {
    const { p, segs, out, models } = pipeline({ ...NEMO, streamDiesAfter: 2 });
    const words = [1, 5, 1, 5, 1, 5, 1, 5].map((v) => says(v));
    feed(p, 1, "call", concat(silence(0.3), ...words));
    await p.endPart(1);
    expect(segs().length).toBe(words.length);
    expect(segs().every((s) => s.text === "we should move the")).toBe(true);
    expect(models.streams.length).toBe(3);
    const errors = out.filter((o) => o.type === "log" && o.level === "error");
    expect(errors.length).toBe(3);
    expect(segs().at(-1)?.spk).toBe("c?");
  });

  test("a diarizer that never answers: the part end waits a bounded time, then the lines land as c?", async () => {
    const { p, segs, out } = pipeline({ ...NEMO, streamStuck: true });
    feed(p, 1, "call", concat(silence(0.3), says(1)));
    expect(segs().length).toBe(0);
    const t0 = performance.now();
    await p.endPart(1);
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(STREAM_FLUSH_MS - 50);
    expect(took).toBeLessThan(STREAM_FLUSH_MS + 2000);
    expect(segs().map((s) => s.spk)).toEqual(["c?"]);
    expect(out.some((o) => o.type === "log" && /did not come/.test(o.msg))).toBe(true);
  }, 10_000);

  test("without a stream diarizer (embeddings) nothing waits and clusters label the call", () => {
    const { p, segs } = pipeline({});
    feed(p, 1, "call", concat(silence(0.3), says(1), says(5)));
    // Synchronous: no stream, so the part end needs no await.
    void p.endPart(1);
    expect(segs().map((s) => s.spk)).toEqual(["c1", "c2"]);
  });
});

describe("through the host into the log", () => {
  function rig(fake: FakeOptions) {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const clock = new ManualClock();
    const engine = new ScriptedEngine(clock);
    const events: LogEvent[] = [];
    const spec: ModelSpec = { kind: "module", path: FAKE, model: "fake-parakeet", options: fake };
    let asr: LiveAsr | null = null;
    const mgr = new CallManager({
      root: t.dir,
      engine,
      clock,
      tz: TZ,
      user: "Ana",
      budgets: { stallMs: 1e12, flushMs: 60_000 },
      onEvent: (id, e) => {
        events.push(e);
        asr?.onEvent(id, e);
      },
      onPacket: (id, part, pk, ingest) => asr?.onPacket(id, part, pk, ingest),
      beforeEnd: (id) => asr?.flush(id) ?? Promise.resolve(),
    });
    asr = new LiveAsr(
      { models: spec, inThread: true, clock },
      (id) => mgr.controller(id) as CallAccess | undefined,
    );
    const a = asr;
    cleanups.push(async () => {
      await mgr.quit();
      await a.close();
    });
    return { engine, mgr, asr: a, events };
  }

  test("every call line is in the log before call.ended, labelled by the stream", async () => {
    const r = rig(NEMO);
    await r.asr.ready;
    r.engine.onStart = (s) => s.capturing();
    const res = await r.mgr.start({ workspace: "work", title: "Sync" });
    if (!res.ok) throw new Error(res.error);
    const call = concat(silence(0.3), says(1), says(5));
    r.engine.last.play(silence(call.length / RATE), call);
    await r.mgr.stop();
    const segs = ofType(r.events, "seg") as Seg[];
    expect(segs.map((s) => s.spk)).toEqual(["c1", "c2"]);
    const ended = r.events.findIndex((e) => e.type === "call.ended");
    const lastSeg = r.events.findLastIndex((e) => e.type === "seg");
    expect(lastSeg).toBeLessThan(ended);
    expect(
      ofType(r.events, "speaker.centroid")
        .map((c) => c.spk)
        .sort(),
    ).toEqual(["c1", "c2"]);
    expect(ofType(r.events, "speaker.merge")).toEqual([]);
  });
});
