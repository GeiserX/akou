/**
 * A fix reaches the final pass (docs/DESIGN.md section 5.4, "A fix on a line"): the learned term is
 * in the decode list the pass is given, and the heard-to-term pair applies to the final lines, so
 * the same mishearing in the final transcript reads corrected; a line's own rewording reads on the
 * final line that covers it. The pass runs as the desktop's does by default, Parakeet decoding
 * greedy, which takes no hotwords: the pair is what corrects the text there.
 */

import { describe, expect, test } from "bun:test";
import type { EventDraft, LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { runFinalPass } from "../src/main/asr/finalize-worker.ts";
import { callDecodeList } from "../src/main/asr/live-worker.ts";
import { concat, FakeModels, MemoryAudio, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { LogBuilder, T0 } from "./helpers.ts";

function fixedCall(fixes: boolean): LogEvent[] {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.seg({ id: "l000001", ch: "mic", spk: "you", a0: 0, a1: 3, w0: T0, text: "deploy to hetzna" });
  b.seg({ id: "l000002", ch: "call", spk: "c1", a0: 0, a1: 3, w0: T0, text: "we should move" });
  if (fixes) {
    // What `POST /calls/{id}/fix` writes: the term for the whole call, the rewording for its line.
    b.add({
      type: "vocab.add",
      id: "v0005",
      rev: 1,
      term: "Hetzner",
      heard: ["hetzna"],
      by: "user",
    });
    b.add({
      type: "vocab.add",
      id: "v0006",
      rev: 1,
      term: "could",
      heard: ["should"],
      by: "user",
      segs: ["l000002"],
      nth: 0,
      decode: false,
    });
  }
  b.partEnded(1, "stop", 4);
  b.add({ type: "call.ended", reason: "stop" });
  return b.events;
}

async function finalText(events: LogEvent[]) {
  const view = fold(events);
  const decode = callDecodeList(view, "fake-parakeet");
  const mic = concat(silence(0.3), speak(["deploy", "to", "hetzner"]), silence(0.6));
  const call = concat(silence(0.3), speak(["we", "should", "move"], { voice: 2 }), silence(0.6));
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, silence((n - x.length) / RATE));
  const out: EventDraft[] = [];
  await runFinalPass(
    { events, audio: new MemoryAudio({ 1: { mic: pad(mic), call: pad(call) } }), decode, pid: 1 },
    new FakeModels({ greedy: true }),
    (d) => out.push(d),
  );
  const b = new LogBuilder();
  for (const e of events) b.add(e, e.t);
  for (const d of out) b.add(d);
  const after = fold(b.events);
  return {
    decode: decode.entries.map((e) => e.term),
    raw: after.lines("final").map((l) => l.raw),
    best: after.lines("best").map((l) => [l.ch, l.text]),
  };
}

describe("the final pass uses every correction of the call", () => {
  test("the learned term is in its decode list, and its output reads the pairs", async () => {
    const r = await finalText(fixedCall(true));
    expect(r.decode).toEqual(["Hetzner"]);
    // The recognizer's own words stay in the log...
    expect(r.raw).toEqual(["deploy to hetzna", "we should move"]);
    // ...and the final transcript reads them corrected.
    expect(r.best).toEqual([
      ["mic", "deploy to Hetzner"],
      ["call", "we could move"],
    ]);
    // Positive control: without the fix the final transcript keeps the mishearing.
    const plain = await finalText(fixedCall(false));
    expect(plain.best).toEqual([
      ["mic", "deploy to hetzna"],
      ["call", "we should move"],
    ]);
  });
});
