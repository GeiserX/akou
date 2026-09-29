/**
 * The in-call upgrade (docs/research/asr-architecture.md section 3.2, ASR-7): on the `upgrade`
 * setup each streaming line is rewritten once during the call, by Qwen, as a new revision of the
 * same `seg`. The streaming engine, the recognizer and Qwen are fakes (tests/fixtures/asr-fake.ts
 * and a scripted `LineUpgrader`); nothing here loads a model or starts a server.
 */

import { afterEach, describe, expect, test } from "bun:test";
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
  UPGRADE_QUEUE_MAX,
} from "../src/main/asr/live-worker.ts";
import { splitToLines, UTTERANCE_MAX_SECONDS } from "../src/main/asr/upgrade.ts";
import { CallManager } from "../src/main/call/manager.ts";
import { CallQuery } from "../src/main/query/context.ts";
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
    signal: AbortSignal;
    glossary: readonly string[];
    answer: (h: Hypothesis) => void;
    fail: (e: Error) => void;
  }[] = [];

  decode(
    samples: Float32Array,
    o: { glossary: readonly string[]; signal: AbortSignal },
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

async function rig(qwen: LineUpgrader | null) {
  const t = tempDir();
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
  const spec: ModelSpec = { kind: "module", path: FAKE, model: "fake-parakeet", options: {} };
  asr = new LiveAsr(
    {
      models: spec,
      inThread: true,
      clock,
      liveEngine: () => LIVE,
      upgrade: () => qwen,
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
  return { mgr, id, events, segs, logs, play, view: () => mgr.controller(id)?.view };
}

/** `id rev model text` per revision, in log order. */
const revisions = (segs: readonly Seg[]) =>
  segs.map((s) => `${s.id} ${s.rev} ${s.model ?? "-"} ${s.text ?? "-"}`);

describe("[ASR-7] the host writes Qwen's rewrite as each line's one revision", () => {
  test("revision order under a slow Qwen: the stream, then Qwen's words, and nothing between", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([
      ["we", "should", "move", "the", "build"],
      ["to", "the", "new", "box"],
    ]);
    await until(() => qwen.asked.length === 1, 5000, "the first line at Qwen");
    // Qwen decodes one utterance at a time: the second waits behind the first, with its line
    // written by the stream and no revision yet.
    await until(() => r.segs().length === 2, 5000, "both stream lines");
    await Bun.sleep(50);
    expect(qwen.asked.length).toBe(1);
    expect(revisions(r.segs())).toEqual([
      "l000001 1 fake-nemotron we should move the build",
      "l000002 1 fake-nemotron to the new box",
    ]);
    qwen.asked[0]?.answer(qwenSays("we should move the built"));
    await until(() => qwen.asked.length === 2, 5000, "the second line at Qwen");
    qwen.asked[1]?.answer(qwenSays("to the news box"));
    await until(() => r.segs().length === 4, 5000, "Qwen's rewrites");
    expect(revisions(r.segs()).slice(2)).toEqual([
      "l000001 2 fake-qwen we should move the built",
      "l000002 2 fake-qwen to the news box",
    ]);
    await r.mgr.stop();
    // One rewrite per line, ever.
    expect(r.segs().length).toBe(4);
  });

  test("an utterance of two lines: Qwen's words are cut back into the lines they belong to", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play(
      [
        ["we", "should", "move", "the", "build"],
        ["to", "the", "new", "box"],
      ],
      0.8,
    );
    await until(() => qwen.asked.length === 1, 5000, "the utterance at Qwen");
    qwen.asked[0]?.answer(qwenSays("we should move the built to the new box"));
    await until(() => r.segs().length === 4, 5000, "Qwen's rewrites");
    expect(revisions(r.segs())).toEqual([
      "l000001 1 fake-nemotron we should move the build",
      "l000002 1 fake-nemotron to the new box",
      "l000001 2 fake-qwen we should move the built",
      "l000002 2 fake-qwen to the new box",
    ]);
    await r.mgr.stop();
  });

  test("a Qwen answer that arrives after call.ended is dropped, and the request was given up", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([["deploy", "the", "build"]]);
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
    await until(() => qwen.asked.length === 1, 5000, "the line at Qwen");
    qwen.asked[0]?.answer(qwenSays("deploy the built"));
    await until(() => r.segs().length === 2, 5000, "Qwen's rewrite");
    await r.mgr.stop();
    expect(revisions(r.segs()).at(-1)).toBe("l000001 2 fake-qwen deploy the built");
  });

  test("a line a person edited keeps their text; Qwen hearing nothing leaves the stream's words; a failure changes nothing", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([["deploy", "the", "build"], ["thanks"], ["ok"], ["great"]]);
    await until(() => qwen.asked.length === 1, 5000, "the first line at Qwen");
    const c = r.mgr.controller(r.id);
    c?.record({ type: "seg", id: "l000001", rev: 2, text: "deploy the bill", by: "user" });
    qwen.asked[0]?.answer(qwenSays("deploy the built"));
    await until(() => qwen.asked.length === 2, 5000, "the second line at Qwen");
    qwen.asked[1]?.answer(qwenSays(""));
    await until(() => qwen.asked.length === 3, 5000, "the third line at Qwen");
    qwen.asked[2]?.fail(new Error("llama-server is unavailable"));
    await until(() => qwen.asked.length === 4, 5000, "the fourth line at Qwen");
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

  test(`at most ${UPGRADE_QUEUE_MAX} utterances wait for Qwen; past that the oldest keeps the streaming text`, async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    const words = ["yes", "no", "hello", "world", "thanks", "meeting", "today", "ok", "great"];
    r.play(words.map((w) => [w]));
    await until(() => r.segs().length === words.length, 5000, "every stream line");
    await until(
      () => r.logs.filter((l) => l.includes("Qwen is behind")).length === 2,
      5000,
      "the two let go",
    );
    // One utterance is at Qwen; of the eight behind it, the two oldest were let go.
    expect(r.logs.find((l) => l.includes("Qwen is behind"))).toContain("keep the streaming text");
    for (let i = 0; i < 1 + UPGRADE_QUEUE_MAX; i++) {
      await until(() => qwen.asked.length === i + 1, 5000, `line ${i + 1} at Qwen`);
      qwen.asked[i]?.answer(qwenSays(""));
    }
    await until(() => qwen.asked.length === 1 + UPGRADE_QUEUE_MAX, 5000, "the queue drained");
    await Bun.sleep(20);
    expect(qwen.asked.length).toBe(1 + UPGRADE_QUEUE_MAX);
    await r.mgr.stop();
  });
});

describe("[ASR-7] a line reads as its highest revision", () => {
  test("the view, a read and a pack's lines carry the model of the highest revision, not an edit mark", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([["deploy", "the", "build"]]);
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
