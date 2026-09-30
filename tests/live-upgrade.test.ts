/**
 * The second pass (docs/research/asr-architecture.md section 3.2, ASR-7, `asr.review.*`): with a
 * second pass on, each streaming line is rewritten once during the call, by Qwen or Parakeet, as a
 * new revision of the same `seg`, in a review every `asr.review.everySeconds` of the utterances
 * closed since the last one. The streaming engine, the recognizer and Qwen are fakes
 * (tests/fixtures/asr-fake.ts and a scripted `LineUpgrader`); nothing here loads a model or starts
 * a server.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent, Seg } from "../src/core/log/events.ts";
import type { Hypothesis, ModelSpec } from "../src/main/asr/engine.ts";
import type { LiveChoice } from "../src/main/asr/live-engines.ts";
import {
  type CallAccess,
  type LineUpgrader,
  LiveAsr,
  type LiveOut,
  LivePipeline,
  REVIEW_BEHIND_MAX,
  REVIEW_READ_WAIT_MS,
  REVIEW_STALL_MAX_MS,
  recognizerReviewer,
} from "../src/main/asr/live-worker.ts";
import {
  joinUtterances,
  REVIEW_CAP_MAX_SECONDS,
  REVIEW_CAP_SECONDS,
  REVIEW_EVERY_SECONDS,
  REVIEW_GAP_SECONDS,
  reviewBatches,
  reviewCap,
  splitToLines,
  UTTERANCE_MAX_SECONDS,
} from "../src/main/asr/upgrade.ts";
import { CallManager } from "../src/main/call/manager.ts";
import { CallQuery } from "../src/main/query/context.ts";
import { buildDecodeList } from "../src/main/vocab/decode-list.ts";
import { ManualClock, ofType, ScriptedEngine, until } from "./capture-helpers.ts";
import { concat, FakeModels, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { TZ, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");
const LIVE: LiveChoice = { engine: "fake-nemotron", lang: "en" };
const noSpeakers = { centroids: [], merges: [], unmerged: [], ids: [] };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

// ---------------------------------------------------------------------------
// The Worker: each closed utterance goes to the host, and no recognizer decodes it

function pipeline(o: ConstructorParameters<typeof FakeModels>[0] = {}) {
  const models = new FakeModels(o);
  const out: LiveOut[] = [];
  const p = new LivePipeline(
    models,
    {},
    (x) => out.push(x),
    () => 0,
  );
  return { models, out, p };
}

function feed(p: LivePipeline, ch: "mic" | "call", audio: Float32Array, part = 1) {
  for (let at = 0; at < audio.length; at += 1600) {
    p.audio(part, ch, at, audio.subarray(at, Math.min(audio.length, at + 1600)));
  }
}

/**
 * Two lines, cut at a 0.8 s gap between words: the next word came before the stream went quiet
 * (1.8 s after the last word), so they are one utterance.
 */
const twoLines = (gap = 0.8) =>
  concat(
    silence(0.5),
    speak(["we", "should", "move", "the", "build"], { voice: 1 }),
    silence(gap),
    speak(["to", "the", "new", "box"], { voice: 4 }),
    silence(2.5),
  );

/** The outputs that matter here, in order: `seg <key> <model>` and `upgrade <keys>`. */
function trail(out: readonly LiveOut[]): string[] {
  return out.flatMap((x) =>
    x.type === "seg"
      ? [`seg ${x.key} ${x.model}`]
      : x.type === "upgrade"
        ? [`upgrade ${x.keys.join(",")}`]
        : [],
  );
}

describe("[ASR-7] lines cut back from utterances", () => {
  test("each word goes to the line of the stream word it aligns with", () => {
    const lines = ["we should", "move the build"];
    expect(splitToLines(lines, "we should move the built.".split(" "))).toEqual([
      "we should",
      "move the built.",
    ]);
    // A word the stream did not have goes with the word before it.
    expect(splitToLines(lines, "we should really move the build".split(" "))).toEqual([
      "we should really",
      "move the build",
    ]);
    // Before any stream word: the first line. A line whose words all went gets none.
    expect(splitToLines(["um", "move it"], ["so", "move", "it"])).toEqual(["so", "move it"]);
    expect(splitToLines(["um", "move it"], ["move", "it"])).toEqual(["", "move it"]);
    // Punctuation and case do not move a word to another line.
    expect(splitToLines(["Hello,", "World"], ["hello", "world."])).toEqual(["hello", "world."]);
  });
});

describe("[ASR-7] a minute's utterances in requests for Qwen", () => {
  const utt = (seconds: number, id: string) => ({ id, samples: new Float32Array(seconds * RATE) });

  test(`whole utterances, at most ${REVIEW_CAP_SECONDS} s of audio a request, in order`, () => {
    const us = [utt(30, "a"), utt(30, "b"), utt(25, "c"), utt(10, "d"), utt(2, "e")];
    const ids = (bs: { id: string }[][]) => bs.map((b) => b.map((u) => u.id).join(""));
    // 30 + 30 + 25 = 85 fits; 85 + 10 does not, so d starts the next request.
    expect(ids(reviewBatches(us))).toEqual(["abc", "de"]);
    for (const b of reviewBatches(us)) {
      expect(b.reduce((a, u) => a + u.samples.length, 0) / RATE).toBeLessThanOrEqual(
        REVIEW_CAP_SECONDS,
      );
    }
    // Exactly at the cap is one request; an utterance never splits, even one past the cap alone.
    expect(ids(reviewBatches([utt(45, "a"), utt(45, "b")]))).toEqual(["ab"]);
    const long = reviewBatches([utt(10, "a"), utt(95, "b"), utt(1, "c")]);
    expect(ids(long)).toEqual(["a", "b", "c"]);
    expect(long[1]?.[0]?.samples.length).toBe(95 * RATE);
    expect(reviewBatches([])).toEqual([]);
  });

  test("a request's audio is its utterances in order, with a short silence between", () => {
    const a = new Float32Array([0.1, 0.2]);
    const b = new Float32Array([0.3]);
    const gap = Math.round(REVIEW_GAP_SECONDS * RATE);
    const j = joinUtterances([a, b]);
    expect(j.length).toBe(3 + gap);
    expect([j[0], j[1], j[2], j[2 + gap]].map((x) => Math.round((x as number) * 10))).toEqual([
      1, 2, 0, 3,
    ]);
    // One utterance goes as it is.
    expect(joinUtterances([a])).toBe(a);
  });
});

describe("[ASR-7] the Worker hands each closed utterance to Qwen", () => {
  test("the lines up to a stop of the speaker are one utterance, sent after its last line", async () => {
    const { p, out } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE, upgrade: true });
    feed(p, "mic", twoLines());
    await p.endPart(1);
    expect(trail(out)).toEqual(["seg 1 fake-nemotron", "seg 2 fake-nemotron", "upgrade 1,2"]);
    const u = out.find((x) => x.type === "upgrade");
    expect(u?.lines).toEqual(["we should move the build", "to the new box"]);
    // The audio Qwen gets is the utterance's, gained and padded.
    const segs = out.filter((x) => x.type === "seg");
    const span = (segs[1]?.a1 as number) - (segs[0]?.a0 as number);
    expect(u?.samples.length).toBeGreaterThanOrEqual(Math.round(span * RATE));
  });

  test("Qwen's rewrite is the only one: the recognizer, loaded for the call, decodes nothing of the stream's lines", async () => {
    const { p, out, models } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE, upgrade: true });
    // The app loads the recognizer with the call's decode list, on every setup.
    p.setDecodeList(null, 0);
    feed(p, "mic", twoLines(2.5));
    await p.endPart(1);
    expect(trail(out)).toEqual([
      "seg 1 fake-nemotron",
      "upgrade 1",
      "seg 2 fake-nemotron",
      "upgrade 2",
    ]);
    expect(models.recognizers.length).toBe(1);
    expect(models.recognizers.flatMap((r) => r.calls)).toEqual([]);
  });

  test("a stop between the lines makes two utterances", async () => {
    const { p, out } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE, upgrade: true });
    feed(p, "mic", twoLines(2.5));
    await p.endPart(1);
    expect(trail(out)).toEqual([
      "seg 1 fake-nemotron",
      "upgrade 1",
      "seg 2 fake-nemotron",
      "upgrade 2",
    ]);
  });

  test(`an utterance ends at ${UTTERANCE_MAX_SECONDS} s even while the speaker goes on`, async () => {
    const { p, out } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE, upgrade: true });
    const said: Float32Array[] = [silence(0.3)];
    // 26 lines 0.8 s apart, 37 s with no stop.
    for (let i = 0; i < 26; i++) said.push(speak(["hello", "world"]), silence(0.8));
    feed(p, "mic", concat(...said, silence(2.5)));
    await p.endPart(1);
    const ups = out.filter((x) => x.type === "upgrade");
    expect(ups.length).toBeGreaterThanOrEqual(2);
    for (const u of ups) {
      expect(u.samples.length / RATE).toBeLessThan(UTTERANCE_MAX_SECONDS + 3);
    }
    expect(ups.flatMap((u) => u.keys)).toEqual(
      out.flatMap((x) => (x.type === "seg" ? [x.key as number] : [])),
    );
  });

  test("without the upgrade setup, or without a streaming engine, no line is rewritten", async () => {
    const plain = pipeline();
    await plain.p.beginCall({ ...noSpeakers, live: LIVE });
    feed(plain.p, "mic", twoLines());
    await plain.p.endPart(1);
    expect(trail(plain.out)).toEqual(["seg 1 fake-nemotron", "seg 2 fake-nemotron"]);
    // Without a stream there are no stream lines to rewrite: asking for the upgrade changes nothing.
    const windows = pipeline();
    await windows.p.beginCall({ ...noSpeakers, upgrade: true });
    feed(windows.p, "mic", twoLines());
    await windows.p.endPart(1);
    expect(trail(windows.out).every((x) => x.startsWith("seg "))).toBe(true);
  });

  test("an utterance whose last line waits for its speaker label is sent right after it, never before", async () => {
    // A diarizer that decides 6 s behind the audio: each line waits for its label.
    const { p, out } = pipeline({ diarizer: "nemotron", streamStep: 4, streamLookahead: 2 });
    await p.beginCall({ ...noSpeakers, live: LIVE, upgrade: true });
    feed(p, "call", twoLines());
    await p.endPart(1);
    expect(trail(out)).toEqual(["seg 1 fake-nemotron", "seg 2 fake-nemotron", "upgrade 1,2"]);
    const segs = out.filter((x) => x.type === "seg");
    expect(segs.map((s) => s.spk)).toEqual(["c1", "c2"]);
  });
});

// ---------------------------------------------------------------------------
// The host: revisions in the call's log

/** Qwen as a test drives it: each line waits until the test answers it. */
class SlowQwen implements LineUpgrader {
  readonly asked: {
    samples: Float32Array;
    parts: readonly Float32Array[];
    signal: AbortSignal;
    glossary: readonly string[];
    answer: (h: Hypothesis) => void;
    fail: (e: Error) => void;
  }[] = [];

  decode(
    samples: Float32Array,
    o: { glossary: readonly string[]; signal: AbortSignal; parts: readonly Float32Array[] },
  ): Promise<Hypothesis> {
    return new Promise((answer, fail) => this.asked.push({ samples, ...o, answer, fail }));
  }
}

/** Qwen's hypothesis of an utterance. */
function qwenSays(text: string): Hypothesis {
  return {
    engine: "fake-qwen",
    text,
    words: text
      .split(" ")
      .filter((w) => w)
      .map((w) => ({ w, conf: 0.6 })),
    lang: "en",
    ms: 10,
  };
}

async function rig(
  qwen: LineUpgrader | null,
  o: {
    everySeconds?: number;
    name?: string;
    /** The reviewer is Parakeet on this rig's own Worker, as the app wires it. */
    parakeet?: (review: LiveAsr["review"]) => LineUpgrader;
  } = {},
) {
  const every = o.everySeconds ?? REVIEW_EVERY_SECONDS;
  const t = tempDir();
  const decodesFile = join(t.dir, "decodes.log");
  cleanups.push(t.cleanup);
  const clock = new ManualClock();
  const engine = new ScriptedEngine(clock);
  const events: LogEvent[] = [];
  const logs: string[] = [];
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
  const spec: ModelSpec = {
    kind: "module",
    path: FAKE,
    model: "fake-parakeet",
    options: { decodesFile },
  };
  const own = (): LineUpgrader | null =>
    o.parakeet ? o.parakeet((parts, signal) => (asr as LiveAsr).review(parts, signal)) : qwen;
  asr = new LiveAsr(
    {
      models: spec,
      inThread: true,
      clock,
      liveEngine: () => LIVE,
      review: () => {
        const reviewer = own();
        return reviewer ? { name: o.name ?? "Qwen", reviewer, everySeconds: every } : null;
      },
      onLog: (_level, msg) => logs.push(msg),
    },
    (id) => mgr.controller(id) as CallAccess | undefined,
  );
  const a = asr;
  cleanups.push(async () => {
    await mgr.quit();
    await a.close();
  });
  await a.ready;
  engine.onStart = (s) => s.capturing();
  const res = await mgr.start({ workspace: "work", title: "upgrade" });
  if (!res.ok) throw new Error(res.error);
  engine.onStart = null;
  const id = res.call;
  const segs = () => ofType(events, "seg") as Seg[];
  /** Each group of words one utterance; a `gap` of 0.8 s makes them lines of one utterance. */
  const play = (words: string[][], gap = 2.5) => {
    const parts: Float32Array[] = [silence(0.5)];
    // The stream closes a line and ends the utterance 1.8 s after the last word: it went quiet.
    for (const w of words) parts.push(speak(w), silence(gap));
    parts.push(silence(2.5));
    const audio = concat(...parts);
    engine.last.play(audio, silence(audio.length / RATE));
  };
  /** Moves the clock one interval (or `ms`) on, for the next review. */
  const minute = (ms = every * 1000) => clock.advance(ms);
  /** The recognizer's decodes so far, each its sample count. */
  const decodes = () =>
    existsSync(decodesFile)
      ? readFileSync(decodesFile, "utf8").trim().split("\n").filter(Boolean).map(Number)
      : [];
  return {
    mgr,
    id,
    events,
    segs,
    logs,
    play,
    minute,
    clock,
    decodes,
    asr: a,
    view: () => mgr.controller(id)?.view,
  };
}

/** `id rev model text` per revision, in log order. */
const revisions = (segs: readonly Seg[]) =>
  segs.map((s) => `${s.id} ${s.rev} ${s.model ?? "-"} ${s.text ?? "-"}`);

describe("[ASR-7] the host writes Qwen's review as each line's one revision", () => {
  test("nothing goes to Qwen before the minute; then the minute's utterances go in one request and its words are cut back into every line", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([
      ["we", "should", "move", "the", "build"],
      ["to", "the", "new", "box"],
    ]);
    await until(() => r.segs().length === 2, 5000, "both stream lines");
    await Bun.sleep(50);
    await r.clock.advance(REVIEW_EVERY_SECONDS * 1000 - 1000);
    expect(qwen.asked.length).toBe(0);
    await r.minute(1000);
    await until(() => qwen.asked.length === 1, 5000, "the minute's review at Qwen");
    // Two utterances in one request: both audios and the silence between them.
    const spans = r.segs().reduce((a, s) => a + ((s.a1 ?? 0) - (s.a0 ?? 0)), 0);
    expect(qwen.asked[0]?.samples.length).toBeGreaterThan(Math.round(spans * RATE));
    expect(revisions(r.segs())).toEqual([
      "l000001 1 fake-nemotron we should move the build",
      "l000002 1 fake-nemotron to the new box",
    ]);
    qwen.asked[0]?.answer(qwenSays("we should move the built to the news box"));
    await until(() => r.segs().length === 4, 5000, "Qwen's rewrites");
    expect(revisions(r.segs()).slice(2)).toEqual([
      "l000001 2 fake-qwen we should move the built",
      "l000002 2 fake-qwen to the news box",
    ]);
    await r.mgr.stop();
    // One rewrite per line, ever, and one request for the minute.
    expect(r.segs().length).toBe(4);
    expect(qwen.asked.length).toBe(1);
  });

  test("a Qwen answer that arrives after call.ended is dropped, and the request was given up", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([["deploy", "the", "build"]]);
    await until(() => r.segs().length === 1, 5000, "the stream line");
    await r.minute();
    await until(() => qwen.asked.length === 1, 5000, "the line at Qwen");
    const asked = qwen.asked[0];
    // The final pass holds the call's writer open past call.ended, as in the app.
    const release = r.mgr.live()?.holdWriter();
    await r.mgr.stop();
    expect(asked?.signal.aborted).toBe(true);
    // A Qwen that ignores the abort and answers anyway writes nothing.
    asked?.answer(qwenSays("deploy the built"));
    await until(() => r.logs.some((l) => l.includes("dropped")), 5000, "the drop");
    release?.();
    const ended = r.events.findIndex((e) => e.type === "call.ended");
    expect(ended).toBeGreaterThan(0);
    expect(r.events.slice(ended + 1).filter((e) => e.type === "seg")).toEqual([]);
    expect(revisions(r.segs())).toEqual(["l000001 1 fake-nemotron deploy the build"]);
  });

  test("control: the same answer before the call ends is written", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([["deploy", "the", "build"]]);
    await until(() => r.segs().length === 1, 5000, "the stream line");
    await r.minute();
    await until(() => qwen.asked.length === 1, 5000, "the line at Qwen");
    qwen.asked[0]?.answer(qwenSays("deploy the built"));
    await until(() => r.segs().length === 2, 5000, "Qwen's rewrite");
    await r.mgr.stop();
    expect(revisions(r.segs()).at(-1)).toBe("l000001 2 fake-qwen deploy the built");
  });

  test("utterances the call ends on before their minute are never sent", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([["deploy", "the", "build"]]);
    await until(() => r.segs().length === 1, 5000, "the stream line");
    await r.mgr.stop();
    await r.minute();
    expect(qwen.asked.length).toBe(0);
  });

  test("a line a person fixed a word on keeps the fix: the review does not revise it, and the fold still reads the fix", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([
      ["we", "should", "move", "the", "build"],
      ["to", "the", "new", "box"],
    ]);
    await until(() => r.segs().length === 2, 5000, "both stream lines");
    await Bun.sleep(50);
    // The Fix dialog's word fix: a line-scoped pair, not a seg revision (`by` stays unset).
    r.mgr.controller(r.id)?.record({
      type: "vocab.add",
      id: "v0001",
      rev: 1,
      term: "could",
      heard: ["should"],
      segs: ["l000001"],
      nth: 0,
      decode: false,
      by: "user",
    });
    expect(r.view()?.resolve("l000001")?.text).toBe("we could move the build");
    await r.minute();
    await until(() => qwen.asked.length === 1, 5000, "the review at Qwen");
    qwen.asked[0]?.answer(qwenSays("we shall move the built to the news box"));
    await until(() => r.view()?.segment("l000002")?.rev === 2, 5000, "the unfixed line's rewrite");
    await Bun.sleep(50);
    await r.mgr.stop();
    // The fixed line has no revision from the review, and still reads the person's word.
    expect(r.view()?.segment("l000001")?.rev).toBe(1);
    expect(r.view()?.resolve("l000001")?.text).toBe("we could move the build");
    expect(r.view()?.resolve("l000002")?.text).toBe("to the news box");
  });

  test("a line a person edited keeps their text; Qwen hearing nothing leaves the stream's words; a failure changes nothing", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    /** One line, then its minute: `segs` stream and edit events so far, `n` reviews so far. */
    const review = async (words: string[], segs: number, n: number) => {
      r.play([words]);
      await until(() => r.segs().length === segs, 5000, `line of review ${n}`);
      await Bun.sleep(20);
      await r.minute();
      await until(() => qwen.asked.length === n, 5000, `review ${n} at Qwen`);
    };
    await review(["deploy", "the", "build"], 1, 1);
    const c = r.mgr.controller(r.id);
    c?.record({ type: "seg", id: "l000001", rev: 2, text: "deploy the bill", by: "user" });
    qwen.asked[0]?.answer(qwenSays("deploy the built"));
    await review(["thanks"], 3, 2);
    qwen.asked[1]?.answer(qwenSays(""));
    await review(["ok"], 4, 3);
    qwen.asked[2]?.fail(new Error("llama-server is unavailable"));
    await review(["great"], 5, 4);
    // Control: a line Qwen does answer is rewritten.
    qwen.asked[3]?.answer(qwenSays("great."));
    await until(() => r.logs.some((l) => l.includes("Qwen failed")), 5000, "the failure log");
    await until(() => r.view()?.segment("l000004")?.rev === 2, 5000, "the control's rewrite");
    await r.mgr.stop();
    const view = r.view();
    expect(
      ["l000001", "l000002", "l000003", "l000004"].map((id) => {
        const s = view?.segment(id);
        return [s?.text, s?.model, s?.rev];
      }),
    ).toEqual([
      ["deploy the bill", "fake-nemotron", 2],
      ["thanks", "fake-nemotron", 1],
      ["ok", "fake-nemotron", 1],
      ["great.", "fake-qwen", 2],
    ]);
    expect(r.logs.find((l) => l.includes("Qwen failed"))).toContain("keep the streaming text");
  });

  test("a review still waiting when the next minute's is due is skipped: its lines keep the streaming text, and the new one goes", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    // About 110 s with no stop: utterances end at 30 s, and they fill more than one request.
    const said: string[][] = [];
    for (let i = 0; i < 75; i++) said.push(["hello", "world"]);
    r.play(said, 0.8);
    await until(() => r.segs().length === 75, 20_000, "every stream line");
    await Bun.sleep(50);
    await r.minute();
    await until(() => qwen.asked.length === 1, 5000, "the first request at Qwen");
    const first = qwen.asked[0]?.samples.length as number;
    expect(first / RATE).toBeLessThanOrEqual(REVIEW_CAP_SECONDS + 1);
    // The next minute comes while the first request is still at Qwen and the second waits.
    r.play([["thanks"]]);
    await until(() => r.segs().length === 76, 5000, "the next line");
    await Bun.sleep(20);
    await r.minute();
    await until(() => r.logs.some((l) => l.includes("Qwen is behind")), 5000, "the skip");
    expect(r.logs.find((l) => l.includes("Qwen is behind"))).toContain("keep the streaming text");
    qwen.asked[0]?.answer(qwenSays(""));
    await until(() => qwen.asked.length === 2, 5000, "the new minute at Qwen");
    // The request after the first is the new minute's one line, not the skipped one.
    qwen.asked[1]?.answer(qwenSays("thanks."));
    await until(() => r.view()?.segment("l000076")?.rev === 2, 5000, "the new line's rewrite");
    // Caught up: the next minute is reviewed as usual.
    r.play([["ok"]]);
    await until(() => r.segs().length === 78, 5000, "one more line");
    await Bun.sleep(20);
    await r.minute();
    await until(() => qwen.asked.length === 3, 5000, "the next minute at Qwen");
    // Behind again, once: the minutes behind were counted afresh after catching up, so it stays on.
    r.play([["great"]]);
    await until(() => r.segs().length === 79, 5000, "a last line");
    await Bun.sleep(20);
    await r.minute();
    expect(r.logs.some((l) => l.includes("did not keep up"))).toBe(false);
    await r.mgr.stop();
    const skipped = r.segs().filter((s) => s.id !== "l000076" && s.model === "fake-qwen");
    expect(skipped).toEqual([]);
  });

  test(`a Qwen ${REVIEW_BEHIND_MAX} minutes in a row behind is off for the rest of the call, and says so`, async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    const minute = async (words: string[], n: number) => {
      r.play([words]);
      await until(() => r.segs().length === n, 5000, `line ${n}`);
      await Bun.sleep(20);
      await r.minute();
    };
    await minute(["deploy", "the", "build"], 1);
    await until(() => qwen.asked.length === 1, 5000, "the first review at Qwen");
    // Qwen never answers the first review.
    await minute(["thanks"], 2);
    expect(r.logs.some((l) => l.includes("did not keep up"))).toBe(false);
    await minute(["ok"], 3);
    await until(() => r.logs.some((l) => l.includes("did not keep up")), 5000, "the switch off");
    expect(r.logs.find((l) => l.includes("did not keep up"))).toContain(
      "the rest of the call keeps the streaming text",
    );
    qwen.asked[0]?.answer(qwenSays("deploy the built"));
    await minute(["great"], 5);
    await r.minute();
    await r.mgr.stop();
    // Nothing after the first request went to Qwen.
    expect(qwen.asked.length).toBe(1);
  });
});

describe("[ASR-7] a line reads as its highest revision", () => {
  test("the view, a read and a pack's lines carry the model of the highest revision, not an edit mark", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([["deploy", "the", "build"]]);
    await until(() => r.segs().length === 1, 5000, "the stream line");
    await r.minute();
    await until(() => qwen.asked.length === 1, 5000, "the line at Qwen");
    const view = r.view();
    if (!view) throw new Error("no view");
    const q = new CallQuery(view);
    const first = q.read(0, Date.now());
    expect(first.lines.map((l) => [l.id, l.model, l.rev, l.edited])).toEqual([
      ["l000001", "fake-nemotron", 1, false],
    ]);
    qwen.asked[0]?.answer(qwenSays("deploy the built"));
    await until(() => r.segs().length === 2, 5000, "Qwen's rewrite");
    // A reader following the call gets the line again, with the model that wrote it now.
    const again = q.read(first.cursor, Date.now());
    expect(again.lines.map((l) => [l.id, l.text, l.model, l.rev, l.edited])).toEqual([
      ["l000001", "deploy the built", "fake-qwen", 2, false],
    ]);
    // A person's edit is still an edit.
    r.mgr.controller(r.id)?.record({
      type: "seg",
      id: "l000001",
      rev: 3,
      text: "deploy the bill",
      by: "user",
    });
    expect(view.resolve("l000001")?.edited).toBe(true);
    await r.mgr.stop();
  });
});

describe("[ASR-7] the interval the second pass reviews at (asr.review.everySeconds)", () => {
  test("a request's audio cap follows the interval: an interval and a half, at most the ceiling", () => {
    expect(reviewCap(REVIEW_EVERY_SECONDS)).toBe(REVIEW_CAP_SECONDS);
    expect(reviewCap(30)).toBe(45);
    expect(reviewCap(120)).toBe(180);
    expect(reviewCap(300)).toBe(REVIEW_CAP_MAX_SECONDS);
    expect(reviewCap(600)).toBe(REVIEW_CAP_MAX_SECONDS);
  });

  test("every 2 minutes: nothing at the first minute, one review at the second, whole utterances up to its cap", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen, { everySeconds: 120 });
    // About 110 s with no stop: more than the default minute's 90 s cap, under 2 minutes' 180 s.
    const said: string[][] = [];
    for (let i = 0; i < 75; i++) said.push(["hello", "world"]);
    r.play(said, 0.8);
    await until(() => r.segs().length === 75, 20_000, "every stream line");
    await Bun.sleep(50);
    await r.clock.advance(60_000);
    await Bun.sleep(20);
    expect(qwen.asked.length).toBe(0);
    await r.clock.advance(60_000);
    await until(() => qwen.asked.length === 1, 5000, "the review at 2 minutes");
    await Bun.sleep(20);
    // One request, longer than a minute's cap allows: the interval's own cap applies.
    expect(qwen.asked.length).toBe(1);
    const seconds = (qwen.asked[0]?.samples.length as number) / RATE;
    expect(seconds).toBeGreaterThan(REVIEW_CAP_SECONDS);
    expect(seconds).toBeLessThanOrEqual(reviewCap(120) + 1);
    qwen.asked[0]?.answer(qwenSays(""));
    await r.mgr.stop();
  });
});

describe("[ASR-7] Parakeet as the second pass", () => {
  test("the host hands it each utterance alone, writes its words as the lines' one revision, keeps an edit, and names it in the log", async () => {
    const parakeet = new SlowQwen();
    const r = await rig(parakeet, { name: "Parakeet" });
    r.play([
      ["we", "should", "move", "the", "build"],
      ["to", "the", "new", "box"],
    ]);
    await until(() => r.segs().length === 2, 5000, "both stream lines");
    await Bun.sleep(50);
    r.mgr.controller(r.id)?.record({
      type: "seg",
      id: "l000002",
      rev: 2,
      text: "to the new books",
      by: "user",
    });
    await r.minute();
    await until(() => parakeet.asked.length === 1, 5000, "the review at Parakeet");
    const asked = parakeet.asked[0];
    // Each utterance alone, and the same audio joined for a reviewer that takes it whole.
    expect(asked?.parts.length).toBe(2);
    expect(asked?.samples).toEqual(joinUtterances(asked?.parts ?? []));
    asked?.answer({
      ...qwenSays("we should move the built to the news box"),
      engine: "fake-parakeet",
    });
    await until(() => r.view()?.segment("l000001")?.rev === 2, 5000, "Parakeet's rewrite");
    await r.mgr.stop();
    expect(revisions(r.segs())).toEqual([
      "l000001 1 fake-nemotron we should move the build",
      "l000002 1 fake-nemotron to the new box",
      "l000002 2 - to the new books",
      "l000001 2 fake-parakeet we should move the built",
    ]);
  });

  test("a Parakeet that falls behind is named in the log, and goes off like Qwen", async () => {
    const parakeet = new SlowQwen();
    const r = await rig(parakeet, { name: "Parakeet" });
    const minute = async (words: string[], n: number) => {
      r.play([words]);
      await until(() => r.segs().length === n, 5000, `line ${n}`);
      await Bun.sleep(20);
      await r.minute();
    };
    await minute(["deploy", "the", "build"], 1);
    await until(() => parakeet.asked.length === 1, 5000, "the first review");
    await minute(["thanks"], 2);
    await minute(["ok"], 3);
    await until(
      () => r.logs.some((l) => l.includes("Parakeet did not keep up")),
      5000,
      "the switch off",
    );
    await r.mgr.stop();
    expect(parakeet.asked.length).toBe(1);
  });

  test("a review through the Worker comes back as one answer, each utterance decoded in turn", async () => {
    const spec: ModelSpec = { kind: "module", path: FAKE, model: "fake-parakeet", options: {} };
    const asr = new LiveAsr({ models: spec, inThread: true }, () => undefined);
    cleanups.push(() => asr.close());
    await asr.ready;
    const utt = (w: string[]) => concat(silence(0.3), speak(w), silence(0.5));
    const d = await asr.review([utt(["deploy", "the", "build"]), utt(["thanks"])]);
    expect([d.text, d.spans, d.model]).toEqual(["deploy the build thanks", 2, "fake-parakeet"]);
    expect(d.words.map((w) => w.w)).toEqual([]);
  });

  test("under greedy decoding, the default, the Worker decodes the utterance with no hotwords and does not throw", async () => {
    const { p, models } = pipeline({ greedy: true });
    p.setDecodeList(
      buildDecodeList({ model: "fake-parakeet", callVocab: [], names: ["Hetzner"], files: [] }),
      1,
    );
    const r = p.decodeUtterance(
      concat(silence(0.3), speak(["deploy", "to", "hetzner"]), silence(0.5)),
    );
    expect(r.text).toBe("deploy to hetzna");
    expect(models.calls.at(-1)?.hotwords).toBeUndefined();
  });

  test("the Worker decodes each utterance of a review alone, with the call's word list as hotwords when the decoding takes them (beam)", async () => {
    const { p, models } = pipeline();
    p.setDecodeList(
      buildDecodeList({ model: "fake-parakeet", callVocab: [], names: ["Hetzner"], files: [] }),
      1,
    );
    const r = p.decodeUtterance(
      concat(silence(0.3), speak(["deploy", "to", "hetzner"]), silence(0.5)),
    );
    expect(r.text).toBe("deploy to Hetzner");
    expect(r.model).toBe("fake-parakeet");
    expect(models.calls.at(-1)?.hotwords).toBe("Hetzner");
    // Control: with no list the engine hears it as it sounds.
    p.setDecodeList(null, 2);
    expect(
      p.decodeUtterance(concat(silence(0.3), speak(["deploy", "to", "hetzner"]), silence(0.5)))
        .text,
    ).toBe("deploy to hetzna");
  });

  test("as the app wires it, the Worker decodes each utterance of a review alone, never the joined audio", async () => {
    const r = await rig(null, { name: "Parakeet", parakeet: recognizerReviewer });
    r.play([
      ["we", "should", "move", "the", "build"],
      ["to", "the", "new", "box"],
    ]);
    await until(() => r.segs().length === 2, 5000, "both stream lines");
    await Bun.sleep(50);
    const before = r.decodes().length;
    await r.minute();
    await until(() => r.view()?.segment("l000002")?.rev === 2, 5000, "the review's rewrite");
    // Two utterances in the minute: two decodes, each no longer than one utterance.
    const decoded = r.decodes().slice(before);
    expect(decoded.length).toBe(2);
    await r.mgr.stop();
  });

  test("a decode that held the live lines too long turns Parakeet's pass off for the call, and says so", async () => {
    let asked = 0;
    const slow = () =>
      recognizerReviewer(async (parts) => {
        asked++;
        return {
          text: parts.map(() => "x").join(" "),
          words: [],
          language: null,
          model: "fake-parakeet",
          ms: REVIEW_STALL_MAX_MS + 500,
          spans: parts.length,
          slowest: REVIEW_STALL_MAX_MS + 500,
        };
      });
    const r = await rig(null, { name: "Parakeet", parakeet: slow });
    r.play([["deploy", "the", "build"]]);
    await until(() => r.segs().length === 1, 5000, "the line");
    await Bun.sleep(20);
    await r.minute();
    await until(() => r.logs.some((l) => l.includes("off for the rest of the call")), 5000, "off");
    expect(r.logs.find((l) => l.includes("off for the rest"))).toContain("holding the live lines");
    r.play([["thanks"]]);
    await until(() => r.segs().length === 2, 5000, "the next line");
    await Bun.sleep(20);
    await r.minute();
    await r.mgr.stop();
    // Nothing was written from the slow review, and nothing was asked after it.
    expect(asked).toBe(1);
    expect(r.segs().every((x) => x.rev === 1)).toBe(true);
  });

  test("at call.ended the Worker decodes no more of a review in flight", async () => {
    const spec: ModelSpec = { kind: "module", path: FAKE, model: "fake-parakeet", options: {} };
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, "decodes.log");
    const asr = new LiveAsr(
      { models: { ...spec, options: { decodesFile: file } }, inThread: true },
      () => undefined,
    );
    cleanups.push(() => asr.close());
    await asr.ready;
    const utt = (w: string[]) => concat(silence(0.3), speak(w), silence(0.5));
    const ended = new AbortController();
    const parts = [utt(["deploy"]), utt(["the"]), utt(["build"]), utt(["thanks"])];
    const answer = asr.review(parts, ended.signal);
    ended.abort();
    await expect(answer).rejects.toThrow("given up");
    await Bun.sleep(100);
    const n = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
    // The first utterance may already be decoding; none after it is.
    expect(n).toBeLessThanOrEqual(1);
  });
});

describe("[ASR-7] review before a read: an agent reads lines the second pass has corrected", () => {
  /** Two utterances closed, and no review due yet. */
  const two = async (qwen: LineUpgrader | null) => {
    const r = await rig(qwen);
    r.play([
      ["we", "should", "move", "the", "build"],
      ["to", "the", "new", "box"],
    ]);
    await until(() => r.segs().length === 2, 5000, "both stream lines");
    await Bun.sleep(50);
    return r;
  };

  test("a read runs the pass over what has closed, before the timer, and answers once the lines are corrected", async () => {
    const qwen = new SlowQwen();
    const r = await two(qwen);
    const read = r.asr.reviewForRead(r.id);
    await until(() => qwen.asked.length === 1, 5000, "the read's review");
    qwen.asked[0]?.answer(qwenSays("we should move the built to the news box"));
    expect(await read).toEqual({ unreviewed: 0 });
    expect(r.view()?.segment("l000001")?.text).toBe("we should move the built");
    // The timer finds nothing left: a read right after costs nothing either.
    await r.minute();
    expect(await r.asr.reviewForRead(r.id)).toEqual({ unreviewed: 0 });
    expect(qwen.asked.length).toBe(1);
    await r.mgr.stop();
  });

  test(`the wait is bounded: past ${REVIEW_READ_WAIT_MS / 1000} s the read answers with how many lines are still unreviewed`, async () => {
    const qwen = new SlowQwen();
    const r = await two(qwen);
    let answered = null as { unreviewed: number } | null;
    const read = r.asr.reviewForRead(r.id).then((x) => {
      answered = x;
    });
    await until(() => qwen.asked.length === 1, 5000, "the read's review");
    await r.clock.advance(REVIEW_READ_WAIT_MS - 1000);
    await Bun.sleep(20);
    expect(answered).toBeNull();
    await r.clock.advance(1000);
    await read;
    expect(answered).toEqual({ unreviewed: 2 });
    qwen.asked[0]?.answer(qwenSays(""));
    await r.mgr.stop();
  });

  test("two reads at once share one pass", async () => {
    const qwen = new SlowQwen();
    const r = await two(qwen);
    const a = r.asr.reviewForRead(r.id);
    const b = r.asr.reviewForRead(r.id);
    await until(() => qwen.asked.length === 1, 5000, "the review");
    await Bun.sleep(50);
    expect(qwen.asked.length).toBe(1);
    qwen.asked[0]?.answer(qwenSays("we should move the built to the news box"));
    expect(await Promise.all([a, b])).toEqual([{ unreviewed: 0 }, { unreviewed: 0 }]);
    await r.mgr.stop();
  });

  test("with the second pass Off, a read reviews nothing and says nothing", async () => {
    const r = await two(null);
    expect(await r.asr.reviewForRead(r.id)).toBeNull();
    expect(r.segs().every((x) => x.rev === 1)).toBe(true);
    await r.mgr.stop();
  });

  test("after call.ended a read reviews nothing: the final pass owns the call", async () => {
    const qwen = new SlowQwen();
    const r = await two(qwen);
    await r.mgr.stop();
    expect(await r.asr.reviewForRead(r.id)).toBeNull();
    expect(qwen.asked.length).toBe(0);
  });

  test("a read with more than the cap pending reviews the newest cap's worth, and leaves the rest to the timer", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    // About 110 s of speech closed and no review yet: more than a minute's 90 s cap.
    const said: string[][] = [];
    for (let i = 0; i < 75; i++) said.push(["hello", "world"]);
    r.play(said, 0.8);
    await until(() => r.segs().length === 75, 20_000, "every stream line");
    await Bun.sleep(50);
    const read = r.asr.reviewForRead(r.id);
    await until(() => qwen.asked.length === 1, 5000, "the read's review");
    await Bun.sleep(50);
    // One request, the newest ones, within the cap; nothing else asked yet.
    expect(qwen.asked.length).toBe(1);
    expect((qwen.asked[0]?.samples.length as number) / RATE).toBeLessThanOrEqual(
      REVIEW_CAP_SECONDS + 1,
    );
    qwen.asked[0]?.answer(qwenSays(""));
    const got = await read;
    expect(got?.unreviewed).toBeGreaterThan(0);
    // The timer takes the older ones.
    await r.minute();
    await until(() => qwen.asked.length === 2, 5000, "the timer's review");
    qwen.asked[1]?.answer(qwenSays(""));
    await r.mgr.stop();
  });

  test("a line a person fixed a word on keeps the fix through a read's pass", async () => {
    const qwen = new SlowQwen();
    const r = await two(qwen);
    r.mgr.controller(r.id)?.record({
      type: "vocab.add",
      id: "v0001",
      rev: 1,
      term: "could",
      heard: ["should"],
      segs: ["l000001"],
      nth: 0,
      decode: false,
      by: "user",
    });
    const read = r.asr.reviewForRead(r.id);
    await until(() => qwen.asked.length === 1, 5000, "the read's review");
    qwen.asked[0]?.answer(qwenSays("we shall move the built to the news box"));
    await read;
    expect(r.view()?.resolve("l000001")?.text).toBe("we could move the build");
    await r.mgr.stop();
  });
});
