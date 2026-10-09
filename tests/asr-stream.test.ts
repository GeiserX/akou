/**
 * Live speaker labels from a stream diarizer (live-worker.ts with `asr.diarizer` nemotron) against
 * the fake one in tests/fixtures/asr-fake.ts, which decides in steps with a look-ahead the way
 * Nemotron does live: the pipeline alone, then through the host into a real call's log.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LogEvent, Seg } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
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
import {
  concat,
  FakeModels,
  type FakeOptions,
  labelled,
  RATE,
  silence,
  speak,
} from "./fixtures/asr-fake.ts";
import { TZ, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");
const NEMO: FakeOptions = { diarizer: "nemotron" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type SegOut = Extract<LiveOut, { type: "seg" }>;
type LabelOut = Extract<LiveOut, { type: "label" }>;

function pipeline(o: FakeOptions = NEMO) {
  const models = new FakeModels(o);
  const out: LiveOut[] = [];
  const p = new LivePipeline(
    models,
    {},
    (x) => out.push(x),
    () => 0,
  );
  // Each line with the speaker the log ends up with: its own, or the label decided after it.
  const segs = () => labelled(out);
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

  test("[G6] a call line lands as c? when it closes; its speaker follows as a label, in order", async () => {
    // A slow step (4 s): the second line closes long before the model reaches its end.
    const { p, out, segs } = pipeline({ ...NEMO, streamStep: 4, streamLookahead: 0.5 });
    feed(p, 1, "call", concat(silence(0.3), says(1), says(5)));
    // Both lines are closed, so both are out, undecided and marked as waiting for their speaker.
    const early = out.filter((x): x is SegOut => x.type === "seg");
    expect(early.map((s) => [s.spk, s.held])).toEqual([
      ["c?", true],
      ["c?", true],
    ]);
    // Positive control for the labels: the model has not decided the second line yet.
    expect(out.filter((x) => x.type === "label").length).toBeLessThan(2);
    await p.endPart(1);
    const labels = out.filter((x): x is LabelOut => x.type === "label");
    expect(labels.map((l) => [l.key, l.spk])).toEqual([
      [early[0]?.key as number, "c1"],
      [early[1]?.key as number, "c2"],
    ]);
    // A label never adds a line.
    expect(segs().map((s) => s.spk)).toEqual(["c1", "c2"]);
    expect(segs().map((s) => s.a0)).toEqual([...segs().map((s) => s.a0)].sort((a, b) => a - b));
  });

  test("[G6] a call line commits within 1.5 s of its end while a slow diarizer decides its speaker", async () => {
    // A diarizer that decides 4 s steps with 0.5 s of look-ahead: about 2.7 s after the first
    // line ends, past the 1.5 s the committed line has (ROADMAP G6).
    const models = new FakeModels({ ...NEMO, streamStep: 4, streamLookahead: 0.5 });
    const at: { x: LiveOut; fed: number }[] = [];
    let fed = 0;
    const p = new LivePipeline(
      models,
      {},
      (x) => at.push({ x, fed }),
      () => 0,
    );
    const words = ["we", "should", "move", "the"];
    const a = speak(words, { voice: 1 });
    const b = speak(words, { voice: 5 });
    const lead = silence(0.3);
    const gap = silence(1);
    const audio = concat(lead, a, gap, b, silence(4));
    // Where each utterance's speech ends (its last sample above -40 dBFS), in samples of the part.
    const sound = (x: Float32Array) => {
      for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i] ?? 0) > 0.01) return i + 1;
      return 0;
    };
    const ends = [lead.length + sound(a), lead.length + a.length + gap.length + sound(b)];
    for (let i = 0; i < audio.length; i += 320) {
      fed = Math.min(audio.length, i + 320);
      p.audio(1, "call", i, audio.subarray(i, fed));
    }
    await p.endPart(1);
    const lines = at.filter((o) => o.x.type === "seg");
    expect(lines.length).toBe(2);
    // Committed: when the line's `seg` came out, seconds after its speech ended.
    const committed = lines.map((o, i) => (o.fed - (ends[i] as number)) / RATE);
    // Decided: when the line first had a speaker other than c?, as its own `spk` or a label.
    const decided = lines.map((o, i) => {
      const s = o.x as SegOut;
      const d =
        s.spk !== "c?"
          ? o
          : at.find((l) => l.x.type === "label" && l.x.key === s.key && l.x.spk !== "c?");
      return d ? (d.fed - (ends[i] as number)) / RATE : null;
    });
    // Positive control: the diarizer really is slow, so a line held for it would miss 1.5 s.
    expect(decided[0]).toBeGreaterThan(1.5);
    for (const c of committed) expect(c).toBeLessThanOrEqual(1.5);
    expect(labelled(at.map((o) => o.x)).map((s) => s.spk)).toEqual(["c1", "c2"]);
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
    const { p, segs, models } = pipeline({ ...NEMO, streamStep: 4, streamLookahead: 0.5 });
    feed(p, 1, "call", concat(silence(0.3), says(1), says(5)));
    await p.beginCall({ centroids: [], ids: [] });
    expect(segs().map((s) => s.spk)).toEqual(["c1", "c2"]);
    expect(models.streams[0]?.resets).toBe(1);
    feed(p, 1, "call", concat(silence(0.3), says(5)));
    await p.endPart(1);
    // Numbered afresh in the new call.
    expect(segs().at(-1)?.spk).toBe("c1");
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

  test("a diarizer that never answers: the line lands at once, the part end waits a bounded time for its speaker, then it stays c?", async () => {
    const { p, segs, out } = pipeline({ ...NEMO, streamStuck: true });
    feed(p, 1, "call", concat(silence(0.3), says(1)));
    expect(segs().map((s) => s.spk)).toEqual(["c?"]);
    const t0 = performance.now();
    await p.endPart(1);
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(STREAM_FLUSH_MS - 50);
    expect(took).toBeLessThan(STREAM_FLUSH_MS + 2000);
    expect(segs().map((s) => s.spk)).toEqual(["c?"]);
    expect(out.some((o) => o.type === "log" && /did not come/.test(o.msg))).toBe(true);
  }, 10_000);

  test("without a stream diarizer (embeddings) nothing waits and clusters label the call", () => {
    const { p, segs, out } = pipeline({});
    feed(p, 1, "call", concat(silence(0.3), says(1), says(5)));
    // Synchronous: no stream, so the part end needs no await.
    void p.endPart(1);
    expect(segs().map((s) => s.spk)).toEqual(["c1", "c2"]);
    // Labelled as they land: nothing waits for a speaker.
    expect(out.some((x) => x.type === "label")).toBe(false);
    expect(out.some((x) => x.type === "seg" && x.held)).toBe(false);
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

  test("[G6] every call line is in the log before call.ended, written as c? and labelled by its next revision", async () => {
    const r = rig(NEMO);
    await r.asr.ready;
    r.engine.onStart = (s) => s.capturing();
    const res = await r.mgr.start({ workspace: "work", title: "Sync" });
    if (!res.ok) throw new Error(res.error);
    const call = concat(silence(0.3), says(1), says(5));
    r.engine.last.play(silence(call.length / RATE), call);
    await r.mgr.stop();
    const segs = ofType(r.events, "seg") as Seg[];
    const firsts = segs.filter((s) => s.rev === 1);
    expect(firsts.map((s) => s.spk)).toEqual(["c?", "c?"]);
    // The decided speaker is the same line's next revision, carrying the speaker alone.
    const later = segs.filter((s) => s.rev > 1);
    expect(later.map((s) => [s.id, s.rev, s.spk])).toEqual([
      [firsts[0]?.id, 2, "c1"],
      [firsts[1]?.id, 2, "c2"],
    ]);
    expect(
      later.every((s) => s.text === undefined && s.a0 === undefined && s.by === undefined),
    ).toBe(true);
    // Two utterances, two lines: the revision relabels a line, never adds one.
    expect(
      fold(r.events)
        .lines("live")
        .map((l) => [l.text, l.spk]),
    ).toEqual([
      ["we should move the", "c1"],
      ["we should move the", "c2"],
    ]);
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

  test("[G6] a speaker a person gave a line before the diarizer decided it is kept", async () => {
    const r = rig(NEMO);
    await r.asr.ready;
    r.engine.onStart = (s) => s.capturing();
    const res = await r.mgr.start({ workspace: "work", title: "Sync" });
    if (!res.ok) throw new Error(res.error);
    // Audio makes the host take the call; silence gives the Worker nothing to write.
    r.engine.last.play(silence(0.5), silence(0.5));
    const host = r.asr as unknown as { onWorker(m: unknown): void };
    const line = (key: number, a0: number) =>
      host.onWorker({
        type: "seg",
        call: res.call,
        part: 1,
        ch: "call",
        a0,
        a1: a0 + 1,
        text: `line ${key}`,
        spk: "c?",
        model: "fake-parakeet",
        key,
        held: true,
      });
    line(9001, 1);
    line(9002, 3);
    line(9003, 5);
    const ids = (ofType(r.events, "seg") as Seg[]).map((s) => s.id);
    expect(ids.length).toBe(3);
    // A person says who spoke the first line while the diarizer is still deciding.
    r.mgr.live()?.record({ type: "seg", id: ids[0] as string, rev: 2, spk: "c7", by: "user" });
    host.onWorker({ type: "label", call: res.call, key: 9001, spk: "c1" });
    // Positive control: the same label on a line nobody touched is written.
    host.onWorker({ type: "label", call: res.call, key: 9002, spk: "c1" });
    // Undecided stays c?, with nothing written; a key the host never gave a line writes nothing.
    host.onWorker({ type: "label", call: res.call, key: 9003, spk: "c?" });
    host.onWorker({ type: "label", call: res.call, key: 9999, spk: "c3" });
    const view = r.mgr.controller(res.call)?.view;
    expect(ids.map((id) => view?.segment(id)?.spk)).toEqual(["c7", "c1", "c?"]);
    const revisions = (ofType(r.events, "seg") as Seg[])
      .filter((s) => s.rev > 1)
      .map((s) => [s.id, s.spk, s.by]);
    expect(revisions).toEqual([
      [ids[0], "c7", "user"],
      [ids[1], "c1", undefined],
    ]);
    await r.mgr.stop();
  });
});
