/**
 * How far a final pass is (DESIGN 3.3 item 7): the pass reports seconds of the call covered as it
 * decodes, moving inside a one-part call, never through the log; and `akou status` says it in its
 * `Final:` line, with the model, for a pass running, failed, or ended within the hour.
 */

import { describe, expect, test } from "bun:test";
import type { EventDraft, LogEvent } from "../src/core/log/events.ts";
import { runFinalPass } from "../src/main/asr/finalize-worker.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { RECOGNIZER } from "../src/main/asr/models.ts";
import { FINAL_NEWS_MS, finalLines } from "../src/main/cli/commands/calls.ts";
import { concat, FakeModels, MemoryAudio, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { LogBuilder, T0 } from "./helpers.ts";

function ended(): LogEvent[] {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.partEnded(1, "stop");
  b.add({ type: "call.ended", reason: "stop" });
  return b.events;
}

/** 60 s of one part: words early and late on both channels, so the pass has several pieces. */
function audio(): MemoryAudio {
  const mic = concat(silence(1), speak(["hello", "world"]), silence(30), speak(["thanks"]));
  const call = concat(silence(12), speak(["ok", "great"], { voice: 2 }), silence(30));
  const pad = (x: Float32Array) => concat(x, silence(60 - x.length / RATE));
  return new MemoryAudio({ 1: { mic: pad(mic), call: pad(call) } });
}

describe("how far a final pass is", () => {
  test("seconds of the call, from 0 to the whole call, moving inside the one part; nothing logged", async () => {
    const out: EventDraft[] = [];
    const moved: [number, number][] = [];
    const r = await runFinalPass(
      {
        events: ended(),
        audio: audio(),
        decode: null,
        pid: 1,
        progress: (d, t) => moved.push([d, t]),
      },
      new FakeModels(),
      (d) => out.push(d),
    );
    expect(r.ok).toBe(true);
    const total = 60;
    expect(moved[0]).toEqual([0, total]);
    expect(moved.at(-1)?.[0]).toBeCloseTo(total, 3);
    for (const [, t] of moved) expect(t).toBeCloseTo(total, 3);
    const done = moved.map(([d]) => d);
    expect(done).toEqual([...done].sort((a, b) => a - b));
    // Figures strictly inside the pass, not just its start and end: a one-part call counted in
    // parts would sit at "0 of 1 part" until the end.
    expect(moved.filter(([d]) => d > 1 && d < total - 1).length).toBeGreaterThanOrEqual(2);
    // The log gets the model, never the figures.
    expect(out.find((d) => d.type === "final.started")).toMatchObject({ model: "fake-parakeet" });
    expect(out.at(-1)).toMatchObject({ type: "final.done", model: "fake-parakeet" });
    expect(out.map((d) => d.type)).not.toContain("final.progress");
  });
});

describe("akou status: the Final line", () => {
  const NOW = T0 + 10 * 3_600_000;
  const status = (final: Record<string, unknown> | null, finals: unknown[] = []) => ({
    app: { startedAt: NOW - 1000, uptimeMs: 1000 },
    last: { call: "c2", title: "Sync", state: "ended", endedAt: NOW - 5000, final },
    finals,
  });
  const base = { skipped: 0, warning: null, error: null, endedAt: null };

  test("running, with how far and the model", () => {
    const running = {
      ...base,
      state: "running",
      model: QWEN_ASR,
      done_s: 37 * 60 + 5,
      total_s: 152 * 60,
    };
    expect(
      finalLines(status(running, [{ call: "c2", done_s: 2225, total_s: 9120, model: QWEN_ASR }])),
    ).toEqual(["Final: running, 37 of 152 min (Qwen)"]);
    // Before decoding moves: the step, and a pass waiting behind another Qwen pass.
    const step = (more: Record<string, unknown>) =>
      finalLines(status({ ...running, done_s: 0, ...more }));
    expect(step({ step: "starting" })).toEqual(["Final: starting Qwen"]);
    expect(step({ step: "speakers" })).toEqual(["Final: labelling speakers (Qwen)"]);
    expect(step({ waiting: "c1" })).toEqual(["Final: waiting for the pass on c1 (Qwen)"]);
  });

  test("ready or failed within the hour; an older pass is no news; another call's pass is named", () => {
    const done = (ago: number) => ({
      ...base,
      state: "done",
      model: RECOGNIZER,
      skipped: 1,
      endedAt: NOW - ago,
    });
    expect(finalLines(status(done(30 * 60_000)))).toEqual([
      "Final: ready (Parakeet), 1 span skipped",
    ]);
    expect(finalLines(status(done(FINAL_NEWS_MS + 60_000)))).toEqual([]);
    const failed = {
      ...base,
      state: "failed",
      model: QWEN_ASR,
      error: "llama-server exited",
      endedAt: NOW - 3 * FINAL_NEWS_MS,
    };
    expect(finalLines(status(failed))).toEqual(["Final: failed (Qwen: llama-server exited)"]);
    expect(
      finalLines(
        status({ ...base, state: "none", model: null }, [
          { call: "c1", done_s: 90, total_s: 600, model: QWEN_ASR },
        ]),
      ),
    ).toEqual(["Final of c1: running, 1 of 10 min (Qwen)"]);
  });
});
