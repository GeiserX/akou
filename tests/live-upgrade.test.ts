/**
 * The in-call upgrade (docs/research/asr-architecture.md section 3.2, ASR-7): on the `upgrade`
 * setup each streaming line is rewritten during the call, first by Parakeet and then by the
 * confidence vote of Qwen and Parakeet, as new revisions of the same `seg`. The streaming engine,
 * the recognizer and Qwen are fakes (tests/fixtures/asr-fake.ts and a scripted `LineUpgrader`);
 * nothing here loads a model or starts a server.
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
// The Worker: Parakeet's rewrite of each streaming line

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

const twoLines = () =>
  concat(
    silence(0.5),
    speak(["we", "should", "move", "the", "build"], { voice: 1 }),
    silence(1.5),
    speak(["to", "the", "new", "box"], { voice: 4 }),
    silence(2),
  );

/** The outputs that matter here, in order: `seg <key> <model>` and `upgrade <key> <model>`. */
function trail(out: readonly LiveOut[]): string[] {
  return out.flatMap((x) =>
    x.type === "seg"
      ? [`seg ${x.key} ${x.model}`]
      : x.type === "upgrade"
        ? [`upgrade ${x.key} ${x.model}`]
        : [],
  );
}

describe("[ASR-7] Parakeet rewrites each streaming line in the Worker", () => {
  test("each written line is followed by Parakeet's decode of its audio, keyed to it", async () => {
    const { p, out } = pipeline();
    await p.beginCall({ ...noSpeakers, live: LIVE, upgrade: true });
    feed(p, "mic", twoLines());
    await p.endPart(1);
    expect(trail(out)).toEqual([
      "seg 1 fake-nemotron",
      "upgrade 1 fake-parakeet",
      "seg 2 fake-nemotron",
      "upgrade 2 fake-parakeet",
    ]);
    const ups = out.filter((x) => x.type === "upgrade");
    expect(ups.map((u) => u.text)).toEqual(["we should move the build", "to the new box"]);
    // The audio Qwen gets next is the line's, gained and padded as Parakeet took it.
    const segs = out.filter((x) => x.type === "seg");
    for (const [i, u] of ups.entries()) {
      const s = segs[i] as { a0: number; a1: number };
      expect(u.samples.length).toBeGreaterThanOrEqual(Math.round((s.a1 - s.a0) * RATE));
    }
  });

  test("without the upgrade setup, or without a streaming engine, no line is rewritten", async () => {
    const plain = pipeline();
    await plain.p.beginCall({ ...noSpeakers, live: LIVE });
    feed(plain.p, "mic", twoLines());
    await plain.p.endPart(1);
    expect(trail(plain.out)).toEqual(["seg 1 fake-nemotron", "seg 2 fake-nemotron"]);
    // Parakeet's own windows are already Parakeet's: asking for the upgrade there changes nothing.
    const windows = pipeline();
    await windows.p.beginCall({ ...noSpeakers, upgrade: true });
    feed(windows.p, "mic", twoLines());
    await windows.p.endPart(1);
    expect(trail(windows.out).every((x) => x.startsWith("seg "))).toBe(true);
  });

  test("a call line held for its speaker label gets its rewrite right after it, never before", async () => {
    // A diarizer that decides 6 s behind the audio: each line waits for its label.
    const { p, out } = pipeline({ diarizer: "nemotron", streamStep: 4, streamLookahead: 2 });
    await p.beginCall({ ...noSpeakers, live: LIVE, upgrade: true });
    feed(p, "call", twoLines());
    await p.endPart(1);
    expect(trail(out)).toEqual([
      "seg 1 fake-nemotron",
      "upgrade 1 fake-parakeet",
      "seg 2 fake-nemotron",
      "upgrade 2 fake-parakeet",
    ]);
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

/** Qwen's hypothesis: `text` with every word at `conf`, except `sure` words at 0.95. */
function qwenSays(text: string, sure: readonly string[] = [], conf = 0.6): Hypothesis {
  return {
    engine: "fake-qwen",
    text,
    words: text
      .split(" ")
      .filter((w) => w)
      .map((w) => ({ w, conf: sure.includes(w) ? 0.95 : conf })),
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
  const play = (words: string[][]) => {
    const parts: Float32Array[] = [silence(0.5)];
    // A streaming line closes once its last word is decided and the pause has passed: 1.9 s.
    for (const w of words) parts.push(speak(w), silence(2.2));
    const audio = concat(...parts);
    engine.last.play(audio, silence(audio.length / RATE));
  };
  return { mgr, id, events, segs, logs, play, view: () => mgr.controller(id)?.view };
}

/** `id rev model text` per revision, in log order. */
const revisions = (segs: readonly Seg[]) =>
  segs.map((s) => `${s.id} ${s.rev} ${s.model ?? "-"} ${s.text ?? "-"}`);

describe("[ASR-7] the host writes each line's upgrades as revisions", () => {
  test("revision order under a slow Qwen: stream, then Parakeet, then the vote of Qwen and Parakeet", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([
      ["we", "should", "move", "the", "build"],
      ["to", "the", "new", "box"],
    ]);
    await until(() => qwen.asked.length === 1, 5000, "the first line at Qwen");
    // Qwen decodes one line at a time: the second waits behind the first.
    await until(() => r.segs().length === 4, 5000, "both lines and their Parakeet revisions");
    expect(qwen.asked.length).toBe(1);
    expect(revisions(r.segs())).toEqual([
      "l000001 1 fake-nemotron we should move the build",
      "l000001 2 fake-parakeet we should move the build",
      "l000002 1 fake-nemotron to the new box",
      "l000002 2 fake-parakeet to the new box",
    ]);
    // Qwen hears "built", surer than Parakeet's unscored "build" (default 0.7): the vote takes it.
    qwen.asked[0]?.answer(qwenSays("we should move the built", ["built"]));
    await until(() => qwen.asked.length === 2, 5000, "the second line at Qwen");
    // Qwen's unsure "news" loses to Parakeet's "new".
    qwen.asked[1]?.answer(qwenSays("to the news box", [], 0.4));
    await until(() => r.segs().length === 6, 5000, "the votes");
    expect(revisions(r.segs()).slice(4)).toEqual([
      "l000001 3 rover-conf(fake-qwen,fake-parakeet) we should move the built",
      "l000002 3 rover-conf(fake-qwen,fake-parakeet) to the new box",
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
    asked?.answer(qwenSays("deploy the built", ["built"]));
    await until(() => r.logs.some((l) => l.includes("dropped")), 5000, "the drop");
    release?.();
    const ended = r.events.findIndex((e) => e.type === "call.ended");
    expect(ended).toBeGreaterThan(0);
    expect(r.events.slice(ended + 1).filter((e) => e.type === "seg")).toEqual([]);
    expect(revisions(r.segs())).toEqual([
      "l000001 1 fake-nemotron deploy the build",
      "l000001 2 fake-parakeet deploy the build",
    ]);
  });

  test("control: the same answer before the call ends is written", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([["deploy", "the", "build"]]);
    await until(() => qwen.asked.length === 1, 5000, "the line at Qwen");
    qwen.asked[0]?.answer(qwenSays("deploy the built", ["built"]));
    await until(() => r.segs().length === 3, 5000, "the vote");
    await r.mgr.stop();
    expect(revisions(r.segs()).at(-1)).toBe(
      "l000001 3 rover-conf(fake-qwen,fake-parakeet) deploy the built",
    );
  });

  test("a line a person edited keeps their text; Qwen hearing nothing does not erase Parakeet's words; a failure changes nothing", async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    r.play([["deploy", "the", "build"], ["thanks"], ["ok"]]);
    await until(() => qwen.asked.length === 1, 5000, "the first line at Qwen");
    const c = r.mgr.controller(r.id);
    c?.record({ type: "seg", id: "l000001", rev: 3, text: "deploy the bill", by: "user" });
    qwen.asked[0]?.answer(qwenSays("deploy the built", ["built"]));
    await until(() => qwen.asked.length === 2, 5000, "the second line at Qwen");
    qwen.asked[1]?.answer(qwenSays("", []));
    await until(() => qwen.asked.length === 3, 5000, "the third line at Qwen");
    qwen.asked[2]?.fail(new Error("llama-server is unavailable"));
    await until(() => r.logs.some((l) => l.includes("Qwen failed")), 5000, "the failure log");
    await r.mgr.stop();
    const view = r.view();
    expect(
      ["l000001", "l000002", "l000003"].map((id) => {
        const s = view?.segment(id);
        return [s?.text, s?.model, s?.rev];
      }),
    ).toEqual([
      ["deploy the bill", "fake-parakeet", 3],
      ["thanks", "rover-conf(fake-qwen,fake-parakeet)", 3],
      ["ok", "fake-parakeet", 2],
    ]);
  });

  test(`at most ${UPGRADE_QUEUE_MAX} lines wait for Qwen; past that the oldest keeps Parakeet's text`, async () => {
    const qwen = new SlowQwen();
    const r = await rig(qwen);
    const words = ["yes", "no", "hello", "world", "thanks", "meeting", "today", "ok", "great"];
    r.play(words.map((w) => [w]));
    await until(() => r.segs().length === words.length * 2, 5000, "every line and its Parakeet");
    // One line is at Qwen; of the eight behind it, the two oldest were let go.
    expect(r.logs.filter((l) => l.includes("Qwen is behind")).length).toBe(2);
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
      ["l000001", "fake-parakeet", 2, false],
    ]);
    qwen.asked[0]?.answer(qwenSays("deploy the built", ["built"]));
    await until(() => r.segs().length === 3, 5000, "the vote");
    // A reader following the call gets the line again, with the model that wrote it now.
    const again = q.read(first.cursor, Date.now());
    expect(again.lines.map((l) => [l.id, l.text, l.model, l.rev, l.edited])).toEqual([
      ["l000001", "deploy the built", "rover-conf(fake-qwen,fake-parakeet)", 3, false],
    ]);
    // A person's edit is still an edit.
    r.mgr.controller(r.id)?.record({
      type: "seg",
      id: "l000001",
      rev: 4,
      text: "deploy the bill",
      by: "user",
    });
    expect(view.resolve("l000001")?.edited).toBe(true);
    await r.mgr.stop();
  });
});
