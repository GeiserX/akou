/**
 * ASR-6 on a call (akou-chp.6): a call's final pass on `fusion` runs the engines through the same
 * `runEngines` a fusion job runs, over every piece of every part and channel, and writes the lines
 * from the fused words. `final.done` names the engines that decoded and the ones left out: by the
 * host (not downloaded), over the memory budget, or down during the pass.
 */

import { describe, expect, test } from "bun:test";
import type { EventDraft, LogEvent, Seg } from "../src/core/log/events.ts";
import type { FinalEngine, Hypothesis } from "../src/main/asr/engine.ts";
import { type FusionPass, runFinalPass } from "../src/main/asr/finalize-worker.ts";
import {
  concat,
  createEngine,
  FakeModels,
  MemoryAudio,
  silence,
  speak,
} from "./fixtures/asr-fake.ts";
import { LogBuilder, T0 } from "./helpers.ts";

/** A call log with the given parts, 10 minutes apart. */
function callLog(parts: number[]): LogEvent[] {
  const b = new LogBuilder();
  b.created();
  for (const p of parts) {
    b.partStarted(p, T0 + (p - 1) * 600_000);
    b.partEnded(p, p === parts.at(-1) ? "stop" : "restart");
  }
  b.add({ type: "call.ended", reason: "stop" });
  return b.events;
}

/** Two parts, each with a line on the mic and one on the call channel. */
function twoParts() {
  const part = (a: string[], b: string[]) => {
    const mic = concat(silence(0.4), speak(a), silence(2.6));
    const call = concat(silence(1.8), speak(b, { voice: 2 }), silence(1.2));
    const n = Math.max(mic.length, call.length);
    return {
      mic: concat(mic, silence((n - mic.length) / 16000)),
      call: concat(call, silence((n - call.length) / 16000)),
    };
  };
  return {
    1: part(["hello", "world"], ["ok", "great"]),
    2: part(["we", "should"], ["hello", "great"]),
  };
}

/**
 * A fake engine over the fake recognizer: `edit` changes its words (one engine mishearing), `crashAt`
 * makes its n-th decode a fatal error (the engine went down), `memoryMb` its budget estimate.
 */
function engine(
  id: string,
  o: { edit?: (w: string) => string; crashAt?: number; memoryMb?: number; conf?: number } = {},
): FinalEngine & { decodes: number } {
  const inner = createEngine({}, id);
  const e = {
    id,
    features: { ...inner.features, confidence: true },
    decodes: 0,
    ...(o.memoryMb === undefined ? {} : { memoryMb: o.memoryMb }),
    load: () => inner.load(),
    unload: () => inner.unload(),
    decode: async (u: Parameters<FinalEngine["decode"]>[0]): Promise<Hypothesis> => {
      e.decodes++;
      if (o.crashAt !== undefined && e.decodes >= o.crashAt)
        throw Object.assign(new Error(`${id} went down`), { fatal: true });
      const h = await inner.decode(u);
      const words = h.words.map((w) => ({
        ...w,
        w: o.edit ? o.edit(w.w) : w.w,
        conf: o.conf ?? 0.9,
      }));
      return { ...h, words, text: words.map((w) => w.w).join(" ") };
    },
  };
  return e;
}

async function run(fusion: FusionPass, parts = twoParts()) {
  const out: EventDraft[] = [];
  const result = await runFinalPass(
    {
      events: callLog(Object.keys(parts).map(Number)),
      audio: new MemoryAudio(parts),
      decode: null,
      pid: 1,
    },
    new FakeModels(),
    (d) => out.push(d),
    () => {},
    fusion,
  );
  const segs = out.filter((d) => d.type === "seg" && d.text !== null) as Omit<Seg, "seq" | "t">[];
  const done = out.find((d) => d.type === "final.done") as Extract<
    EventDraft,
    { type: "final.done" }
  >;
  return { out, result, segs, done };
}

describe("[ASR-6] a call's final pass on fusion", () => {
  test("three engines decode every piece of both parts and channels; lines and final.done name the fusion", async () => {
    const [a, b, c] = [engine("qa"), engine("wb"), engine("pc")];
    const r = await run({ engines: [a, b, c], fuser: "rover-conf" });
    expect(r.result.ok).toBe(true);
    expect(r.segs.map((s) => [s.part, s.ch, s.text])).toEqual([
      [1, "mic", "hello world"],
      [1, "call", "ok great"],
      [2, "mic", "we should"],
      [2, "call", "hello great"],
    ]);
    expect(r.segs.every((s) => s.model === "rover-conf(qa,wb,pc)")).toBe(true);
    expect([a.decodes, b.decodes, c.decodes]).toEqual([4, 4, 4]);
    expect(r.done).toMatchObject({
      model: "rover-conf(qa,wb,pc)",
      engines: ["qa", "wb", "pc"],
      dropped: [],
    });
    expect(r.result.model).toBe("rover-conf(qa,wb,pc)");
    expect(r.out.filter((d) => d.type === "final.part.done").length).toBe(2);
  });

  test("[positive control] the vote: two engines outvote the first one's wrong word; under first the wrong word stays", async () => {
    const wrong = () => engine("qa", { edit: (w) => (w === "great" ? "grate" : w) });
    const voted = await run({
      engines: [wrong(), engine("wb"), engine("pc")],
      fuser: "rover-conf",
    });
    expect(voted.segs.map((s) => s.text)).toContain("ok great");
    const first = await run({ engines: [wrong(), engine("wb"), engine("pc")], fuser: "first" });
    expect(first.segs.map((s) => s.text)).toContain("ok grate");
  });

  test("an engine that goes down mid-pass is dropped, the rest finish, and final.done says so", async () => {
    const r = await run({
      engines: [engine("qa"), engine("wb", { crashAt: 3 }), engine("pc")],
      fuser: "rover-conf",
    });
    expect(r.result.ok).toBe(true);
    expect(r.segs.length).toBe(4);
    expect(r.done.engines).toEqual(["qa", "wb", "pc"]);
    expect(r.done.dropped).toEqual([{ engine: "wb", reason: "wb went down", units: 2 }]);
  });

  test("an engine over the memory budget never loads; positive control: with no budget it runs", async () => {
    const big = () => engine("wb", { memoryMb: 5000 });
    const over = await run({
      engines: [engine("qa", { memoryMb: 3000 }), big(), engine("pc")],
      fuser: "rover-conf",
      memoryBudgetMb: 4000,
    });
    expect(over.done.engines).toEqual(["qa", "pc"]);
    expect(over.done.model).toBe("rover-conf(qa,pc)");
    expect(over.done.dropped?.[0]).toMatchObject({ engine: "wb", units: null });
    expect(over.done.dropped?.[0]?.reason).toContain("over the memory budget of 4000 MB");
    const all = await run({
      engines: [engine("qa", { memoryMb: 3000 }), big(), engine("pc")],
      fuser: "rover-conf",
    });
    expect(all.done.engines).toEqual(["qa", "wb", "pc"]);
  });

  test("engines the host left out (not downloaded) come first in final.done's dropped", async () => {
    const away = {
      engine: "whisper-large-v3",
      reason: "not downloaded (whisper-large-v3)",
      units: null,
    };
    const r = await run({
      engines: [engine("qa"), engine("pc")],
      fuser: "rover-conf",
      dropped: [away],
    });
    expect(r.done).toMatchObject({
      model: "rover-conf(qa,pc)",
      engines: ["qa", "pc"],
      dropped: [away],
    });
  });

  test("the last engine going down fails the pass, as one engine always did", async () => {
    const r = await run({ engines: [engine("qa", { crashAt: 1 })], fuser: "rover-conf" });
    expect(r.result.ok).toBe(false);
    expect(r.out.some((d) => d.type === "final.failed")).toBe(true);
    expect(r.out.some((d) => d.type === "final.done")).toBe(false);
  });
});
