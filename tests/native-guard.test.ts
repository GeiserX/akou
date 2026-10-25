/**
 * A Worker is never terminated inside a native model load (#408): Bun 1.3.13 through at least
 * 1.4.4 aborts the whole process when it is (oven-sh/bun#45252). `native-guard.ts` defers the
 * terminate until the Worker parks in JS after the load.
 *
 * The last case needs Parakeet and the VAD in the models folder (`AKOU_MODELS_DIR`, else the
 * app's); without them it is skipped. CI's `server-macos` job runs it with the models pulled.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultModelsDir, MODELS, modelFile, RECOGNIZER } from "../src/main/asr/models.ts";
import {
  inNativeLoad,
  NATIVE_PARKED,
  type NativeFlag,
  nativeFlag,
  nativeLoad,
  nativeLoadAsync,
  type Stoppable,
  stopWorker,
} from "../src/main/asr/native-guard.ts";
import { tempDir } from "./helpers.ts";

/** A Worker that counts its terminates and lets the test send it messages and errors. */
class FakeWorker implements Stoppable {
  terminated = 0;
  private readonly on: Record<"message" | "error", ((e: MessageEvent) => void)[]> = {
    message: [],
    error: [],
  };
  terminate(): void {
    this.terminated++;
  }
  addEventListener(type: "message" | "error", fn: (e: MessageEvent) => void): void {
    this.on[type].push(fn);
  }
  post(data: unknown): void {
    for (const fn of this.on.message) fn({ data } as MessageEvent);
  }
  fail(): void {
    for (const fn of this.on.error) fn({} as MessageEvent);
  }
}

class Parked extends Error {}
const park = (): never => {
  throw new Parked();
};

type Stop = (w: Stoppable, f: NativeFlag) => unknown;
const bareTerminate: Stop = (w) => w.terminate();

/** A stop asked while the Worker is inside a load: terminates counted during it and after it. */
function stopDuringLoad(stop: Stop) {
  const w = new FakeWorker();
  const f = nativeFlag();
  let during = -1;
  let parked = false;
  try {
    nativeLoad(
      () => {
        expect(inNativeLoad(f)).toBe(true);
        stop(w, f);
        // The Worker's other replies arrive while it loads; none of them is a parked Worker.
        w.post({ type: "progress", stage: "transcribe", done_s: 0, total_s: 3 });
        w.post({ type: "log", level: "info", msg: "loading" });
        during = w.terminated;
        return "recognizer";
      },
      f,
      park,
    );
  } catch (e) {
    parked = e instanceof Parked;
  }
  const beforeParked = w.terminated;
  w.post({ type: NATIVE_PARKED });
  return { during, parked, beforeParked, after: w.terminated, w };
}

describe("[bun#45252] a Worker is never terminated inside a native load", () => {
  test("outside every load the Worker is terminated at once", () => {
    const w = new FakeWorker();
    expect(stopWorker(w, nativeFlag())).toBe(true);
    expect(w.terminated).toBe(1);
  });

  test("inside a load it is not terminated until it parks after the load, then once", () => {
    const r = stopDuringLoad(stopWorker);
    expect(r.during).toBe(0);
    expect(r.parked).toBe(true);
    expect(r.beforeParked).toBe(0);
    expect(r.after).toBe(1);
    r.w.post({ type: NATIVE_PARKED });
    r.w.fail();
    expect(r.w.terminated).toBe(1);
  });

  test("positive control: a bare terminate in its place is caught terminating inside the load", () => {
    const r = stopDuringLoad(bareTerminate);
    expect(r.during).toBe(1);
    // Nothing set the stop bit, so the Worker never parks either.
    expect(r.parked).toBe(false);
  });

  test("a stop asked before a load starts skips the load and parks", () => {
    const f = nativeFlag();
    expect(stopWorker(new FakeWorker(), f)).toBe(true);
    let ran = false;
    expect(() =>
      nativeLoad(
        () => {
          ran = true;
        },
        f,
        park,
      ),
    ).toThrow(Parked);
    expect(ran).toBe(false);
    expect(inNativeLoad(f)).toBe(false);
  });

  test("a load that throws while a stop waits still parks, and the count goes back to zero", () => {
    const w = new FakeWorker();
    const f = nativeFlag();
    expect(() =>
      nativeLoad(
        () => {
          stopWorker(w, f);
          throw new Error("no such model file");
        },
        f,
        park,
      ),
    ).toThrow(Parked);
    expect(inNativeLoad(f)).toBe(false);
    expect(w.terminated).toBe(0);
  });

  test("a Worker that errors while a stop waits is terminated", () => {
    const w = new FakeWorker();
    const f = nativeFlag();
    Atomics.add(f, 0, 1);
    expect(stopWorker(w, f)).toBe(false);
    w.fail();
    expect(w.terminated).toBe(1);
  });

  test("without a flag (in-thread, tests) a load just runs", () => {
    expect(nativeLoad(() => 42, null, park)).toBe(42);
  });
});

describe("[bun#45252 / transcribe-cpp] a load that resolves later", () => {
  /** A slow model load, settled by the test, and the models it disposed. */
  function slowLoad() {
    let settle: (m: { id: number }) => void = () => {};
    const disposed: number[] = [];
    const load = () => new Promise<{ id: number }>((r) => (settle = r));
    return {
      load,
      disposed,
      dispose: (m: { id: number }) => disposed.push(m.id),
      settle: (id: number) => settle({ id }),
    };
  }

  test("an async load counted on the flag; a stop during it disposes the model and parks", async () => {
    const f = nativeFlag();
    const w = new FakeWorker();
    const l = slowLoad();
    const p = nativeLoadAsync(l.load, l.dispose, f, park);
    // Counted across the await: a stop now waits for the park instead of terminating inside it.
    expect(inNativeLoad(f)).toBe(true);
    expect(stopWorker(w, f)).toBe(false);
    expect(w.terminated).toBe(0);
    l.settle(7);
    await expect(p).rejects.toBeInstanceOf(Parked);
    expect(l.disposed).toEqual([7]);
    expect(inNativeLoad(f)).toBe(false);
  });

  test("positive control: a bare await of the load is not counted and never disposes", async () => {
    const f = nativeFlag();
    const w = new FakeWorker();
    const l = slowLoad();
    const p = l.load();
    expect(inNativeLoad(f)).toBe(false);
    // The host terminates at once, inside the load, and the model it then gets is never freed.
    expect(stopWorker(w, f)).toBe(true);
    l.settle(7);
    await p;
    expect(l.disposed).toEqual([]);
  });

  test("with no stop the model is returned and kept; without a flag a load just runs", async () => {
    const f = nativeFlag();
    const l = slowLoad();
    const p = nativeLoadAsync(l.load, l.dispose, f, park);
    l.settle(3);
    expect(await p).toEqual({ id: 3 });
    expect(l.disposed).toEqual([]);
    expect(inNativeLoad(f)).toBe(false);
    const m = slowLoad();
    const q = nativeLoadAsync(m.load, m.dispose, null, park);
    m.settle(4);
    expect(await q).toEqual({ id: 4 });
  });
});

const DIR = defaultModelsDir();
const READY = [RECOGNIZER, "silero-vad"].every((id) =>
  (MODELS.find((m) => m.id === id)?.files ?? [{ name: "missing" }]).every((f) =>
    existsSync(modelFile(DIR, id, f.name)),
  ),
);

describe("[bun#45252] a job cancelled inside Parakeet's load", () => {
  test.skipIf(!READY)(
    "300 ms into the load, the job rejects at once and the process outlives the load (skipped without Parakeet and the VAD in the models folder)",
    () => {
      const t = tempDir("akou-cancel-load-");
      try {
        const r = Bun.spawnSync(
          [
            process.execPath,
            join(import.meta.dir, "fixtures", "cancel-during-load.ts"),
            DIR,
            t.dir,
            join(import.meta.dir, "fixtures", "two-voices.wav"),
            "300",
          ],
          { stdout: "pipe", stderr: "pipe", timeout: 120_000 },
        );
        const out = `${r.stdout.toString()}${r.stderr.toString()}`;
        expect(out).toContain("cancelled 300 ms into a load; the job rejected: cancelled");
        expect(out).toContain("alive after the load returned");
        expect(out).not.toContain("NAPI FATAL ERROR");
        expect(r.exitCode).toBe(0);
      } finally {
        t.cleanup();
      }
    },
    130_000,
  );
});
