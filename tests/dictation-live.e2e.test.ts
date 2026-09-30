/**
 * DC-E7 through a whole app (docs/ux/DICTATION.md): with a streaming model on disk, a dictation's
 * words as you speak come from its stream on the live Worker, and `dictation.final` `live` inserts
 * those words. The app runs the fake helper with "hello" on the mic, the fake recognizer and the
 * fake streaming engine; nothing opens a device, presses a key or touches the clipboard.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSpecEntry } from "../src/main/asr/models.ts";
import { NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const STREAM = "nemotron-en-560";
/** What the fake mic says: its length decides how long a dictation records. */
const SPEECH = speak(["hello", "world"]);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * An app with dictation on (unless `off`), English only, and the streaming model on disk when
 * `stream`; `models` are the fake models' options (`loadMs`: a slow recognizer load), on the
 * recognizer's own Worker when `worker`.
 */
async function rig(o: {
  stream: boolean;
  final?: string;
  off?: boolean;
  models?: Record<string, unknown>;
  worker?: boolean;
}): Promise<AppRig> {
  const home = tempDir("akou-dict-live-e2e-");
  cleanups.push(home.cleanup);
  const reg = modelRegistry();
  cleanups.push(() => reg.stop());
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    { ...reg.entry(STREAM, ["s.onnx"]), onDemand: true } as ModelSpecEntry,
  ];
  const models = join(home.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const m of catalog.slice(0, o.stream ? 4 : 3)) reg.install(models, m);
  const wav = join(home.dir, "mic.wav");
  writeFileSync(wav, monoWav(concat(SPEECH, silence(3))));
  const r = await appRig({
    modelRegistry: catalog,
    models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: o.models ?? {} },
    helperArgs: ["--wav", wav],
    ...(o.worker ? { asrInThread: false } : {}),
    settings: {
      "asr.modelsDir": models,
      "asr.languages": ["en"],
      "dictation.enabled": !o.off,
      ...(o.final ? { "dictation.final": o.final } : {}),
    },
  });
  cleanups.push(() => r.close());
  if (!o.off)
    await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
  return r;
}

/**
 * One dictation over the API, with a follower asking for the words as you speak, so the session
 * opens its stream. The fake helper's door session records for as long as it lasts in real time
 * and sends all of its audio at the stop, just before the session ends: the words the stream gives
 * then may land after the end, so the partials are the unit tests' (tests/dictation-live.test.ts),
 * and this checks what is inserted.
 */
async function dictate(r: AppRig): Promise<void> {
  const svc = r.app.dictation();
  if (!svc) throw new Error("no dictation");
  cleanups.push(svc.follow(() => {}, { partials: () => true }));
  expect((await r.api("POST", "/dictation/start")).status).toBe(200);
  // Recording time is audio here: the whole speech, and a second more for the engine's chunk.
  await Bun.sleep((SPEECH.length / 16_000) * 1000 + 1000);
  expect((await r.api("POST", "/dictation/stop")).status).toBe(200);
  await until(
    async () => (await r.api("GET", "/dictations")).body.items[0]?.state === "inserted",
    10_000,
    "the insert",
  );
}

describe("DC-E7: the streaming model through the app", () => {
  test("live is the default: with the streaming model on disk, its words go in", async () => {
    const r = await rig({ stream: true });
    expect((await r.api("GET", "/dictation")).body).toMatchObject({
      live: STREAM,
      final: "live",
      engine: "live",
    });
    await dictate(r);
    const id = (await r.api("GET", "/dictations")).body.items[0].id;
    expect((await r.api("GET", `/dictations/${id}`)).body).toMatchObject({
      text: "hello world",
      engine: "live",
      model: STREAM,
    });
  });

  test("parakeet, with the streaming model on disk, still decodes the whole recording", async () => {
    const r = await rig({ stream: true, final: "parakeet" });
    const st = (await r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({ live: STREAM, final: "parakeet", engine: "fast" });
    await dictate(r);
    const item = (await r.api("GET", "/dictations")).body.items[0];
    expect(item).toMatchObject({ text: "hello world", engine: "fast" });
  });

  test("positive control: with no streaming model, the default inserts through Parakeet", async () => {
    const r = await rig({ stream: false });
    const st = (await r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({ live: null, final: "parakeet", engine: "fast" });
    await dictate(r);
    const item = (await r.api("GET", "/dictations")).body.items[0];
    expect(item).toMatchObject({ text: "hello world", engine: "fast" });
  });
});

describe("DC-E7: dictation's models load first at launch", () => {
  /** The Worker's model loads, by model, as `GET /v1/status` reports them. */
  const loads = async (r: AppRig): Promise<Record<string, number>> =>
    (await r.api("GET", "/status")).body.asr.loads;

  test("with dictation on, Parakeet and the streaming model are loaded before any press", async () => {
    const r = await rig({ stream: true });
    await until(
      async () => (await r.api("GET", "/dictation")).body.loading === false,
      10_000,
      "the models loaded",
    );
    expect(await loads(r)).toMatchObject({ "fake-parakeet": 1, [STREAM]: 1 });
  });

  test("positive control: with dictation off, neither loads until something needs it", async () => {
    const r = await rig({ stream: true, off: true });
    await until(
      async () => (await r.api("GET", "/status")).body.asr.state === "ready",
      10_000,
      "the recognizer started",
    );
    const got = await loads(r);
    expect(got["fake-parakeet"]).toBeUndefined();
    expect(got[STREAM]).toBeUndefined();
  });

  test("a press while they load is kept: the status says loading, and the words go in", async () => {
    // On its own Worker, as in the app: the slow load holds that thread, not the app's.
    const r = await rig({ stream: true, models: { loadMs: 4000 }, worker: true });
    // What the pill reads at the release, for its `loading model` line.
    expect((await r.api("GET", "/dictation")).body.loading).toBe(true);
    await dictate(r);
    const id = (await r.api("GET", "/dictations")).body.items[0].id;
    expect((await r.api("GET", `/dictations/${id}`)).body).toMatchObject({
      text: "hello world",
      engine: "live",
    });
    expect((await r.api("GET", "/dictation")).body.loading).toBe(false);
  });
});
