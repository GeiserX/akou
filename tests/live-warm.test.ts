/**
 * Server mode loads the streaming model a live client opens at start (`warmLive`), so the first
 * session does not wait for it. That load counts as a use: with no live client, the model goes
 * after `asr.modelIdleMinutes` like any other, instead of being held until the first session.
 * The positive control is the same server before its idle time is up: the model is still held.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelSpecEntry } from "../src/main/asr/models.ts";
import { NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { ManualClock, until } from "./capture-helpers.ts";
import { modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";
import { SERVER } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const MULTI = "nemotron-3.5-560";
const UNLOADED = "asr: models unloaded after 1 min with no call or dictation";
const MIN = 60_000;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A server with the fake recognizer and the multilingual streaming model on disk. */
async function serverRig(clock: ManualClock): Promise<AppRig> {
  const home = tempDir("akou-live-warm-");
  cleanups.push(home.cleanup);
  const reg = modelRegistry();
  cleanups.push(() => reg.stop());
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    { ...reg.entry(MULTI, ["m.onnx"]), onDemand: true } as ModelSpecEntry,
  ];
  const dir = join(home.dir, "models");
  mkdirSync(dir, { recursive: true });
  for (const m of catalog) reg.install(dir, m);
  const r = await appRig({
    modelRegistry: catalog,
    clock,
    settings: { ...SERVER, "asr.modelsDir": dir, "asr.modelIdleMinutes": 1 },
  });
  cleanups.push(() => r.close());
  return r;
}

describe("server mode: the streaming model loaded at start goes when no live client comes", () => {
  test("loaded at start, still held before the idle minute, let go after it with no session", async () => {
    const clock = new ManualClock();
    const r = await serverRig(clock);
    await until(() => (r.app.asr?.loads[MULTI] ?? 0) >= 1, 10_000, "the start warm-up");
    // Positive control: inside the idle time the warm model stays, ready for a first session.
    await clock.advance(30_000);
    expect(r.logs.some((l) => l.msg === UNLOADED)).toBe(false);
    await clock.advance(MIN);
    await until(() => r.logs.some((l) => l.msg === UNLOADED), 10_000, "the idle unload");
  });
});
