/**
 * DC-E1: a dictation's buffer decoded on the live Worker's already loaded recognizer, in spans of
 * at most 30 s, against the deterministic fake engines (tests/fixtures/asr-fake.ts). Timings are
 * the nightly's (DC-T3); these tests assert behaviour only.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import { DEFAULT_FINAL } from "../src/main/asr/finalize-worker.ts";
import {
  DICTATION_SPAN_SECONDS,
  type FromWorker,
  LiveAsr,
  WorkerSide,
} from "../src/main/asr/live-worker.ts";
import { until } from "./capture-helpers.ts";
import { concat, created, type FakeModels, RATE, silence, speak } from "./fixtures/asr-fake.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");
const SPEC: ModelSpec = { kind: "module", path: FAKE, model: "fake-parakeet", options: {} };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function asr(o: { inThread?: boolean; spec?: ModelSpec } = {}): LiveAsr {
  const a = new LiveAsr({ models: o.spec ?? SPEC, inThread: o.inThread ?? true }, () => undefined);
  cleanups.push(() => a.close());
  return a;
}

/** Words at the given seconds of a clip `seconds` long, silence between. */
function wordsAt(seconds: number, at: [string, number][]): Float32Array {
  const out = silence(seconds);
  for (const [w, s] of at) out.set(speak([w]), Math.round(s * RATE));
  return out;
}

describe("DC-E1: decode on the live Worker", () => {
  test("a generated 3 s clip comes back as its word", async () => {
    const a = asr();
    const d = await a.decode(concat(silence(0.8), speak(["hello"]), silence(1.9)));
    expect(d.text).toBe("hello");
    expect(d.model).toBe("fake-parakeet");
    expect(d.spans).toBe(1);
  });

  test("a 70 s clip is decoded as three spans and all three words come back in order", async () => {
    const a = asr();
    const d = await a.decode(
      wordsAt(70, [
        ["deploy", 1],
        ["kubernetes", 34],
        ["thanks", 66],
      ]),
    );
    expect(d.spans).toBe(3);
    expect(d.text).toBe("deploy kubernetis thanks");
  });

  test("a dictation span is the final pass's longest span", () => {
    expect(DICTATION_SPAN_SECONDS).toBe(DEFAULT_FINAL.maxSpanSeconds);
  });

  test("70 s of unbroken speech is cut into spans of at most 30 s, and no word is lost", async () => {
    const words = Array.from({ length: 200 }, (_, i) => (i % 2 ? "deploy" : "today"));
    const clip = speak(words, { gapSeconds: 0.1 });
    expect(clip.length / RATE).toBeGreaterThan(69);
    const a = asr();
    const d = await a.decode(clip);
    const m = created.at(-1) as FakeModels;
    // Every span the recognizer saw is at most 30 s, so one decode never holds the Worker longer.
    const longest = Math.max(...m.calls.map((c) => c.samples));
    expect(longest).toBeLessThanOrEqual(DICTATION_SPAN_SECONDS * RATE);
    expect(d.spans).toBeGreaterThanOrEqual(3);
    // A word cut in half at a forced cut is heard on one side of it, never lost from both.
    expect(d.text.split(" ").length).toBeGreaterThanOrEqual(words.length);
  });

  test("a dictation reuses the loaded recognizer: the model loads once", async () => {
    const a = asr();
    await a.ready;
    await a.decode(concat(silence(0.3), speak(["hello"]), silence(0.5)));
    await a.decode(concat(silence(0.3), speak(["world"]), silence(0.5)));
    const m = created.at(-1) as FakeModels;
    expect(m.loads["fake-parakeet"]).toBe(1);
    expect(m.calls.length).toBe(2);
  });

  test("a decode sent while the model loads waits for it and keeps the audio", async () => {
    const a = asr();
    // Sent before `ready`: the Worker takes it after `init`.
    const d = await a.decode(concat(silence(0.3), speak(["thanks"]), silence(0.5)));
    expect(d.text).toBe("thanks");
  });

  test("a call's next segment is transcribed between two spans, never after all of them", async () => {
    const replies: FromWorker[] = [];
    const side = new WorkerSide((m) => replies.push(m));
    cleanups.push(() => side.close());
    side.handle({ type: "init", models: SPEC, live: {} });
    side.handle({ type: "call", id: "c1", centroids: [], merges: [], unmerged: [], ids: [] });
    side.handle({ type: "decode-list", list: null, version: 1 });
    side.handle({
      type: "decode",
      token: 7,
      samples: wordsAt(70, [
        ["deploy", 1],
        ["kubernetes", 34],
        ["thanks", 66],
      ]),
    });
    // The call's audio arrives while the dictation is decoding: a segment that closes on a pause.
    const mic = concat(silence(0.4), speak(["hello", "world"]), silence(1.2));
    // Not live: no provisional re-decodes, so every recognizer call is a span or the segment.
    side.handle({ type: "audio", part: 1, ch: "mic", start: 0, samples: mic, live: false });
    await until(() => replies.some((r) => r.type === "decoded"), 10_000, "the decode");
    const decoded = replies.find((r) => r.type === "decoded");
    expect(decoded).toMatchObject({ token: 7, text: "deploy kubernetis thanks", spans: 3 });
    // The recognizer's calls in order: the call's segment is longer than any one-word span.
    const m = created.at(-1) as FakeModels;
    const seg = m.calls.findIndex((c) => c.samples > RATE);
    expect(m.calls.length).toBe(4);
    expect(seg).toBeGreaterThan(0);
    expect(seg).toBeLessThan(3);
    const segAt = replies.findIndex((r) => r.type === "seg");
    expect(segAt).toBeGreaterThanOrEqual(0);
    expect(segAt).toBeLessThan(replies.indexOf(decoded as FromWorker));
  });

  test("the decode crosses a real Worker thread, and the caller keeps its buffer", async () => {
    const a = asr({ inThread: false });
    const clip = concat(silence(0.3), speak(["great"]), silence(0.5));
    const n = clip.length;
    const d = await a.decode(clip);
    expect(d.text).toBe("great");
    // The Worker got a transferred copy: the caller's samples are not detached.
    expect(clip.length).toBe(n);
  });

  test("a decode on a closed recognizer is refused, not left waiting", async () => {
    const a = asr();
    await a.close();
    await expect(a.decode(silence(1))).rejects.toThrow(/closed/);
  });
});
