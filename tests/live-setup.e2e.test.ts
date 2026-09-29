/**
 * The live setup through the whole app (akou-chp.23): `asr.live` set over `PATCH /config` starts
 * the next call on that setup, a call's own `live` (`POST /calls`, `akou start --live`) overrides
 * it for that call only, a running call keeps its setup, and `GET /status`, `akou status` and
 * `GET /models` name it. Every setup runs on the fake recognizer and the fake streaming engine
 * (tests/fixtures/asr-fake.ts), so each line's `model` says which path wrote it; the catalog is a
 * loopback registry of tiny files named after the real models, and nothing is downloaded.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent, Seg } from "../src/core/log/events.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { type AppRig, appRig, FAKE_MODELS, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const STREAM = "nemotron-en-560";

let reg: ModelRegistry;
let rig: AppRig;
const home = tempDir("akou-live-setup-");

beforeAll(async () => {
  reg = modelRegistry();
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    { ...reg.entry(STREAM, ["s.onnx"]), onDemand: true } as ModelSpecEntry,
    // Qwen is fetched on demand only and is not here: the upgrade setup cannot run.
    { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
  ];
  const models = join(home.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const m of catalog.slice(0, 4)) reg.install(models, m);
  rig = await appRig({
    modelRegistry: catalog,
    models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
    helperArgs: ["--wav", speechWav(home.dir)],
    settings: {
      "asr.modelsDir": models,
      "asr.diarizer": "nemotron",
      "asr.languages": ["en"],
    },
  });
  await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
});

afterAll(async () => {
  await rig?.close();
  reg?.stop();
  home.cleanup();
});

// biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
type Body = any;

async function liveStatus(): Promise<Body> {
  return (await rig.api("GET", "/status")).body.live;
}

/**
 * Runs one call until its first lines are written, and returns the setup the status named and the
 * models that wrote its lines. `during` runs once the call has chosen its setup.
 */
async function oneCall(
  body: Record<string, unknown> = {},
  during: () => Promise<void> = async () => {},
): Promise<{
  setup: string;
  engine: string | null;
  models: (string | undefined)[];
  rewritten: number;
}> {
  const id = await rig.startCall(body);
  await until(async () => (await liveStatus())?.setup != null, 10_000, "the live setup");
  const live = await liveStatus();
  await during();
  const segs = async () =>
    (await rig.app.events(id, 0)).filter((e: LogEvent): e is Seg => e.type === "seg");
  await until(async () => (await segs()).length >= 2, 15_000, "the call's lines");
  const stop = await rig.api("POST", "/calls/live/stop");
  expect(stop.status).toBe(200);
  await until(async () => (await liveStatus()) === null, 10_000, "the call's end");
  return {
    setup: live.setup,
    engine: live.engine,
    models: [...new Set((await segs()).map((s) => s.model))],
    // A line's words written again (a later revision carrying `text`) would be words taken back.
    rewritten: (await segs()).filter((s) => s.rev > 1 && s.text !== undefined).length,
  };
}

async function setLive(value: string): Promise<void> {
  const r = await rig.api("PATCH", "/config", { "asr.live": value });
  expect(r.status).toBe(200);
}

describe("[akou-chp.23] asr.live starts the next call on that setup", () => {
  test("parakeet, nemotron, and auto (no upgrade models here: nemotron)", async () => {
    await setLive("parakeet");
    expect(await oneCall()).toEqual({
      setup: "parakeet",
      engine: null,
      models: ["fake-parakeet"],
      rewritten: 0,
    });
    await setLive("nemotron");
    expect(await oneCall()).toEqual({
      setup: "nemotron",
      engine: STREAM,
      models: [STREAM],
      rewritten: 0,
    });
    await setLive("auto");
    expect(await oneCall()).toEqual({
      setup: "nemotron",
      engine: STREAM,
      models: [STREAM],
      rewritten: 0,
    });
  });

  test("upgrade, not runnable here, starts the call on nemotron and says why in the log", async () => {
    await setLive("upgrade");
    expect(await oneCall()).toEqual({
      setup: "nemotron",
      engine: STREAM,
      models: [STREAM],
      rewritten: 0,
    });
    expect(rig.logs.some((l) => /runs the nemotron live setup .*upgrade setup/.test(l.msg))).toBe(
      true,
    );
  });

  test("a call's own live overrides the setting for that call only, and keeps its setup when the setting changes", async () => {
    await setLive("nemotron");
    // Changed mid-call: this call keeps what it started with.
    const own = await oneCall({ live: "parakeet" }, () => setLive("nemotron"));
    expect(own).toEqual({
      setup: "parakeet",
      engine: null,
      models: ["fake-parakeet"],
      rewritten: 0,
    });
    const kept = await oneCall({}, () => setLive("parakeet"));
    expect(kept).toEqual({
      setup: "nemotron",
      engine: STREAM,
      models: [STREAM],
      rewritten: 0,
    });
    // The change applies from the next call.
    expect((await oneCall()).setup).toBe("parakeet");
  });

  test("akou start --live nemotron overrides for one call, and akou status names it", async () => {
    await setLive("parakeet");
    const cli = rigCli(rig);
    const bad = await cli(["start", "--live", "voxtral"]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("live is one of auto, parakeet, nemotron, upgrade");
    const started = await cli(["start", "--live", "nemotron", "--json"]);
    expect(started.code).toBe(0);
    await until(async () => (await liveStatus())?.setup != null, 10_000, "the live setup");
    const st = await cli(["status"]);
    expect(st.out).toContain(`live setup nemotron (${STREAM})`);
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await liveStatus()) === null, 10_000, "the call's end");
  });

  test("POST /calls refuses a live that is not a setup, and starts nothing", async () => {
    const r = await rig.api("POST", "/calls", { workspace: "work", live: "voxtral" });
    expect([r.status, r.body.error, r.body.field]).toEqual([422, "bad_field", "live"]);
    expect(await liveStatus()).toBeNull();
  });
});

describe("[akou-chp.23] GET /models lists the live setups", () => {
  test("the four setups, the next call's marked, the missing model named", async () => {
    await setLive("auto");
    const r = await rig.api("GET", "/models");
    const live = r.body.live;
    expect([live.setting, live.next, live.running]).toEqual(["auto", "nemotron", null]);
    const by = Object.fromEntries(live.setups.map((s: Body) => [s.id, s]));
    expect(Object.keys(by)).toEqual(["parakeet", "nemotron", "upgrade", "voxtral"]);
    expect(by.nemotron).toMatchObject({
      selected: true,
      models: [{ id: STREAM, state: "ready" }],
      accuracy: { score: 62, metric: "call-wer" },
    });
    expect(by.upgrade.models).toContainEqual({ id: QWEN_ASR, state: "missing" });
    expect(by.voxtral.unavailable).toBeTruthy();
    // The streaming model the next call runs is the app's: never swept, never deleted.
    const row = r.body.models.find((m: Body) => m.id === STREAM);
    expect(row).toMatchObject({ default: true, state: "ready" });
  });
});
