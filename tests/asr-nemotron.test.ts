/**
 * akou's side of `akou-diarize/1` (nemotron.ts) against a fake helper (tests/fixtures/
 * fake-diarize.ts) that speaks the protocol with no model: framing, the final pass's turns, the
 * live stream's steps, the reset fence, and a helper that fails in each way it can.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpeakerTurn } from "../src/main/asr/engine.ts";
import {
  type DiarizeHelperSpec,
  frame,
  NemotronDiarizer,
  NemotronStream,
  parseLine,
} from "../src/main/asr/nemotron.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-diarize.ts");
const RATE = 16000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function spec(extra: string[] = [], model?: string): Omit<DiarizeHelperSpec, "mode"> {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const file = model ?? join(t.dir, "model.onnx");
  if (!model) writeFileSync(file, "");
  return { command: [process.execPath, FAKE, ...extra], model: file, threads: 1 };
}

/** `seconds` at a level: 0.1 is speaker 0 to the fake, 0.5 speaker 1, 0 nobody. */
function tone(seconds: number, level: number): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = level * Math.sin((2 * Math.PI * 440 * i) / RATE) * Math.SQRT2;
  return out;
}

function cat(...xs: Float32Array[]): Float32Array {
  const out = new Float32Array(xs.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

describe("the wire", () => {
  test("a frame is kind, u32 little-endian length, then f32 little-endian samples", () => {
    const f = frame("a", Float32Array.from([1, -0.5]));
    expect([...f.subarray(0, 5)]).toEqual([0x61, 8, 0, 0, 0]);
    const v = new DataView(f.buffer);
    expect(v.getFloat32(5, true)).toBe(1);
    expect(v.getFloat32(9, true)).toBe(-0.5);
    expect([...frame("f")]).toEqual([0x66, 0, 0, 0, 0]);
    expect([...frame("r")]).toEqual([0x72, 0, 0, 0, 0]);
  });

  test("only protocol lines parse; anything else is refused", () => {
    expect(parseLine('{"type":"turn","spk":1,"start":0,"end":160}')).toEqual({
      type: "turn",
      spk: 1,
      start: 0,
      end: 160,
    });
    expect(parseLine('{"type":"decided","at":26880}')).toEqual({ type: "decided", at: 26880 });
    expect(parseLine('{"type":"reset"}')).toEqual({ type: "reset" });
    expect(parseLine('{"type":"turn","spk":"1","start":0,"end":1}')).toBeNull();
    expect(parseLine('{"type":"decided"}')).toBeNull();
    expect(parseLine("not json")).toBeNull();
    expect(parseLine('{"type":"surprise"}')).toBeNull();
  });
});

describe("the final pass's diarizer", () => {
  test("the whole stream in, smoothed turns in seconds out, one helper per pass", async () => {
    let loads = 0;
    const d = new NemotronDiarizer(spec(), () => loads++);
    const audio = cat(tone(2, 0.1), tone(1, 0), tone(1.5, 0.5), tone(0.3, 0), tone(1, 0.5));
    const turns = await d.process(audio);
    expect(loads).toBe(1);
    expect(turns.map((t) => t.speaker)).toEqual([0, 1]);
    expect(turns[0]?.start).toBeCloseTo(0, 2);
    expect(turns[0]?.end).toBeCloseTo(2, 2);
    // The 0.3 s gap inside speaker 1 is joined (smoothTurns), as the pass will cut there.
    expect(turns[1]?.start).toBeCloseTo(3, 2);
    expect(turns[1]?.end).toBeCloseTo(5.8, 2);
  });

  test("more than one frame of audio (over 65 s) arrives whole", async () => {
    const d = new NemotronDiarizer(spec());
    const turns = await d.process(cat(tone(70, 0.1), tone(1, 0), tone(2, 0.5)));
    expect(turns.map((t) => [t.speaker, Math.round(t.start), Math.round(t.end)])).toEqual([
      [0, 0, 70],
      [1, 71, 73],
    ]);
  }, 30_000);

  test("a model that will not load rejects with the helper's own words", async () => {
    const d = new NemotronDiarizer(spec([], join("/nonexistent", "model.onnx")));
    await expect(d.process(tone(1, 0.1))).rejects.toThrow(/cannot load/);
  });

  test("a helper that crashes mid-pass rejects; it never hangs the pass", async () => {
    const d = new NemotronDiarizer(spec(["--die-after", "1"]));
    await expect(d.process(tone(3, 0.1))).rejects.toThrow(/exited with code 70/);
  });

  test("a program that does not exist is an error, not a hang", async () => {
    const d = new NemotronDiarizer({
      command: ["/nonexistent/akou-diarize"],
      model: "m",
      threads: 1,
    });
    await expect(d.process(tone(1, 0.1))).rejects.toThrow();
  });
});

describe("the live stream", () => {
  function listen() {
    const got: { turns: SpeakerTurn[]; decided: number[]; dead: string[] } = {
      turns: [],
      decided: [],
      dead: [],
    };
    return {
      got,
      listener: {
        turns: (t: readonly SpeakerTurn[], at: number) => {
          got.turns.push(...t);
          got.decided.push(at);
        },
        dead: (e: string) => got.dead.push(e),
      },
    };
  }

  test("steps are decided as their look-ahead arrives; a flush decides the rest", async () => {
    const { got, listener } = listen();
    const s = new NemotronStream(spec(), listener);
    cleanups.push(() => s.close());
    s.push(tone(1.5, 0.1));
    s.push(tone(1, 0.5));
    await until(async () => got.decided.length > 0, 5000, "a decided step");
    expect(got.decided[0]).toBe(Math.round(1.68 * RATE));
    await s.flush();
    expect(got.decided.at(-1)).toBe(2.5 * RATE);
    expect(got.turns.map((t) => t.speaker)).toEqual([0, 1, 1]);
    // The stream goes on after a flush: positions keep counting.
    s.push(tone(2.5, 0.1));
    await s.flush();
    expect(got.decided.at(-1)).toBe(5 * RATE);
  });

  test("a reset is fenced: turns about the old stream never reach the new one", async () => {
    const { got, listener } = listen();
    const s = new NemotronStream(spec(), listener);
    cleanups.push(() => s.close());
    // Enough for a step, and the reset sent before any answer can be read.
    s.push(tone(3, 0.5));
    s.reset();
    s.push(tone(3, 0.1));
    await s.flush();
    expect(got.turns.every((t) => t.speaker === 0)).toBe(true);
    expect(got.turns[0]?.start).toBe(0);

    // Positive control: without the reset, the old stream's speaker-1 step is reported.
    const c = listen();
    const s2 = new NemotronStream(spec(), c.listener);
    cleanups.push(() => s2.close());
    s2.push(tone(3, 0.5));
    s2.push(tone(3, 0.1));
    await s2.flush();
    expect(c.got.turns.some((t) => t.speaker === 1)).toBe(true);
  });

  test("a helper that dies tells the listener once, and a later flush rejects", async () => {
    const { got, listener } = listen();
    const s = new NemotronStream(spec(["--die-after", "1"]), listener);
    s.push(tone(2, 0.1));
    await until(async () => got.dead.length > 0, 5000, "the death");
    s.push(tone(1, 0.1));
    await expect(s.flush()).rejects.toThrow(/exited with code 70/);
    expect(got.dead.length).toBe(1);
  });

  test("a helper that writes something else is stopped as dead", async () => {
    const { got, listener } = listen();
    const s = new NemotronStream(spec(["--garbage"]), listener);
    s.push(tone(1, 0.1));
    await until(async () => got.dead.length > 0, 5000, "the refusal");
    expect(got.dead[0]).toMatch(/not akou-diarize\/1/);
  });

  test("closing ends the helper without calling it dead", async () => {
    const { got, listener } = listen();
    const s = new NemotronStream(spec(), listener);
    s.push(tone(1, 0.1));
    await s.flush();
    s.close();
    await Bun.sleep(300);
    expect(got.dead).toEqual([]);
  });
});
