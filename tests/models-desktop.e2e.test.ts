/**
 * The Models page's routes and the unused-days sweep in the desktop app, not only in server mode
 * (docs/ux/SERVER.md SV-M6, DESKTOP.md DK-E2): `GET /models` lists every catalog model with its
 * kind, scores and deletion date, `POST /models/pull {model}` fetches one on purpose, `DELETE
 * /models/{id}` removes one, and the hourly sweep deletes a model unused for
 * `server.models_unused_days` while the app's own set, what the recognizer holds and a download in
 * flight stay. The clock is injected; the catalog is a loopback registry of tiny files named after
 * the real models, so the real scores apply and nothing is downloaded from the network.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { DAY_MS } from "../src/main/server/model-store.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const PYANNOTE = "pyannote-segmentation-3.0";
/** A recognizer fetched on demand only, so it is never part of the app's own set. */
const EXTRA = "test-recognizer-extra";
const T = Date.UTC(2026, 8, 1, 12, 0, 0);
/** Longer than the fake decode of the pass's audio takes, and longer than that audio. */
const DIARIZE_MS = 2000;
const iso = (t: number) => new Date(t).toISOString();

let reg: ModelRegistry;
let catalog: ModelSpecEntry[];

beforeAll(() => {
  reg = modelRegistry();
  catalog = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    reg.entry(PYANNOTE, ["seg.onnx"]),
    { ...reg.entry(EXTRA, ["x.onnx"]), onDemand: true } as ModelSpecEntry,
  ];
});

afterAll(() => reg.stop());

function entry(id: string): ModelSpecEntry {
  return catalog.find((m) => m.id === id) as ModelSpecEntry;
}

// biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
type Body = any;

interface Rig extends AppRig {
  models: string;
  clock: { t: number };
  done(): Promise<void>;
}

/** The desktop app (no `server.enabled`) whose models folder holds `installed`. */
async function desktopRig(installed: string[]): Promise<Rig> {
  const t = tempDir("akou-models-desktop-");
  const models = join(t.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const id of installed) reg.install(models, entry(id));
  const clock = { t: T };
  // The final pass hears one word per channel, so it decodes and has a speed to report.
  const heard = () => concat(silence(0.4), speak(["hello"]), silence(0.4));
  const rig = await appRig({
    modelRegistry: catalog,
    // Slow speaker labels, which the recognizer's measured speed must leave out.
    models: {
      kind: "module",
      path: FAKE_MODELS,
      model: "fake-parakeet",
      options: { diarizeMs: DIARIZE_MS },
    },
    settings: { "asr.modelsDir": models, "asr.diarizer": "nemotron" },
    jobs: { now: () => clock.t, modelStore: { retryMs: [5, 5, 5], freeBytes: () => 1e12 } },
    finalAudio: ({ parts }) => ({
      kind: "module",
      path: FAKE_MODELS,
      options: {
        parts: Object.fromEntries(parts.map((p) => [p, { mic: heard(), call: heard() }])),
      },
    }),
  });
  return {
    ...rig,
    models,
    clock,
    done: async () => {
      await rig.close();
      t.cleanup();
    },
  };
}

async function listed(rig: Rig): Promise<Record<string, Body>> {
  const r = await rig.api("GET", "/models");
  expect(r.status).toBe(200);
  return Object.fromEntries((r.body as Body).models.map((m: Body) => [m.id, m]));
}

const onDisk = (rig: Rig, id: string) => existsSync(join(rig.models, id));

describe("[DK-E2, SV-M6] the desktop app lists, pulls and deletes one model at a time", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await desktopRig([RECOGNIZER, "silero-vad", NEMOTRON, PYANNOTE]);
    await until(() => rig.app.recognizer() === "ready", 5000, "the recognizer");
  });
  afterAll(async () => rig.done());

  test("GET /models: every catalog model with its kind, scores, last use and deletion date", async () => {
    const m = await listed(rig);
    expect(Object.keys(m).sort()).toEqual(catalog.map((x) => x.id).sort());
    // The app's own set is the default and in use: never deleted, no date.
    expect(m[RECOGNIZER]).toMatchObject({
      kind: "speech",
      state: "ready",
      default: true,
      in_use: true,
      evicts_at: null,
      last_used_at: iso(T),
      accuracy: { score: 77, metric: "wer" },
      speed: { score: 83, metric: "rtfx" },
      // The app's recognizer is fixed: no setting makes another one the default.
      set_default: null,
    });
    expect(m[NEMOTRON]).toMatchObject({ kind: "speakers", default: true, evicts_at: null });
    // The other diarizer is not the app's: it has a date, and a setting that makes it the default.
    expect(m[PYANNOTE]).toMatchObject({
      kind: "speakers",
      default: false,
      in_use: false,
      evicts_at: iso(T + 30 * DAY_MS),
      accuracy: { score: 41, metric: "der" },
      speed: { score: null },
      set_default: { key: "asr.diarizer", value: "embeddings" },
    });
    expect(m[PYANNOTE].speed.not_measured).toContain("no speed figure");
    expect(m["silero-vad"]).toMatchObject({ kind: "helper", accuracy: { score: null } });
    expect(m[EXTRA]).toMatchObject({ state: "missing", evicts_at: null, last_used_at: null });
  });

  test("POST /models/pull {model} fetches that model, even with server.auto_download off", async () => {
    const off = await rig.api("PATCH", "/config", { "server.auto_download": false });
    expect(off.status).toBe(200);
    const r = await rig.api("POST", "/models/pull", { model: EXTRA });
    expect([r.status, (r.body as Body).id]).toEqual([202, EXTRA]);
    await until(async () => (await listed(rig))[EXTRA].state === "ready", 5000, "the model");
    expect(onDisk(rig, EXTRA)).toBe(true);
    const unknown = await rig.api("POST", "/models/pull", { model: "nope" });
    expect([unknown.status, (unknown.body as Body).error]).toEqual([422, "unknown_model"]);
  });

  test("DELETE /models/{id}: 409 model_in_use for the app's own set, 200 for another", async () => {
    for (const id of [RECOGNIZER, NEMOTRON, "silero-vad"]) {
      const d = await rig.api("DELETE", `/models/${id}`);
      expect([id, d.status, (d.body as Body).error]).toEqual([id, 409, "model_in_use"]);
      expect(onDisk(rig, id)).toBe(true);
    }
    const d = await rig.api("DELETE", `/models/${EXTRA}`);
    expect([d.status, d.body]).toEqual([200, { id: EXTRA, deleted: true, bytes: 4096 }]);
    expect(onDisk(rig, EXTRA)).toBe(false);
    expect(rig.logs.filter((l) => l.msg.startsWith(`model.deleted ${EXTRA}`)).length).toBe(1);
    expect((await rig.api("DELETE", `/models/${EXTRA}`)).status).toBe(404);
  });

  test("[DK-E4] a finished final pass is this machine's measured speed for the recognizer", async () => {
    // Before any pass, nothing is measured: the check below can fail.
    expect((await listed(rig))[RECOGNIZER].measured).toBeNull();
    const id = await rig.startCall();
    await rig.api("POST", "/calls/live/stop");
    await until(
      async () => (await rig.api("GET", `/calls/${id}`)).body.final.state === "done",
      10_000,
      "the final pass",
    );
    await until(
      async () => (await listed(rig))[RECOGNIZER].measured !== null,
      5000,
      "the measured speed",
    );
    const m = (await listed(rig))[RECOGNIZER].measured;
    expect(m.runs).toBe(1);
    expect(m.rtf).toBeGreaterThan(0);
    // Decode time alone: the 2 s of speaker labels over under 2 s of audio would read above 1.
    expect(m.rtf).toBeLessThan(1);
  });

  test("akou models delete asks the running app, and says why it refuses", async () => {
    const pulled = await rig.api("POST", "/models/pull", { model: EXTRA });
    expect(pulled.status).toBe(202);
    await until(async () => (await listed(rig))[EXTRA].state === "ready", 5000, "the model");
    const env = { ...process.env, ...rig.env };
    const ok = await cli(env, ["models", "delete", EXTRA]);
    expect([ok.code, ok.out]).toEqual([0, `Deleted ${EXTRA}: 5 KB freed`]);
    expect(onDisk(rig, EXTRA)).toBe(false);
    const refused = await cli(env, ["models", "delete", RECOGNIZER]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("default model's set");
  });
});

describe("[DK-E2, SV-M5] the unused-days sweep runs in the desktop app too", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await desktopRig([RECOGNIZER, "silero-vad", NEMOTRON, PYANNOTE, EXTRA]);
    await until(() => rig.app.recognizer() === "ready", 5000, "the recognizer");
  });
  afterAll(async () => rig.done());

  test("the sweep at start dates every model and deletes nothing", async () => {
    const m = await listed(rig);
    for (const id of [RECOGNIZER, "silero-vad", NEMOTRON, PYANNOTE, EXTRA]) {
      expect([id, m[id].last_used_at]).toEqual([id, iso(T)]);
      expect(onDisk(rig, id)).toBe(true);
    }
  });

  test("31 days on: the unused models go, logged; the app's own set stays", () => {
    rig.clock.t = T + 31 * DAY_MS;
    rig.app.sweepModels();
    expect(onDisk(rig, PYANNOTE)).toBe(false);
    expect(onDisk(rig, EXTRA)).toBe(false);
    for (const id of [RECOGNIZER, "silero-vad", NEMOTRON]) {
      expect([id, onDisk(rig, id)]).toEqual([id, true]);
    }
    const lines = rig.logs.filter((l) => l.msg.startsWith("model.evicted")).map((l) => l.msg);
    expect(lines.sort()).toEqual(
      [
        `model.evicted ${EXTRA} last_used_at ${iso(T)} bytes_freed 4096`,
        `model.evicted ${PYANNOTE} last_used_at ${iso(T)} bytes_freed 4096`,
      ].sort(),
    );
  });

  test("a model downloading is never swept, however old its folder", async () => {
    const release = reg.hold("x.onnx", 100);
    try {
      expect((await rig.api("POST", "/models/pull", { model: EXTRA })).status).toBe(202);
      await until(() => onDisk(rig, EXTRA), 5000, "the download's folder");
      // The first sweep that sees the folder dates it; 400 days on, only the download keeps it.
      rig.app.sweepModels();
      rig.clock.t += 400 * DAY_MS;
      rig.app.sweepModels();
      expect(onDisk(rig, EXTRA)).toBe(true);
      expect((await listed(rig))[EXTRA].state).toBe("downloading");
    } finally {
      release();
    }
    await until(async () => (await listed(rig))[EXTRA].state === "ready", 5000, "the model");
  });

  test("with server.models_unused_days at 0 nothing is deleted", async () => {
    expect((await rig.api("PATCH", "/config", { "server.models_unused_days": 0 })).status).toBe(
      200,
    );
    rig.clock.t += 400 * DAY_MS;
    rig.app.sweepModels();
    expect(onDisk(rig, EXTRA)).toBe(true);
    expect((await listed(rig))[EXTRA].evicts_at).toBeNull();
  });

  test("positive control: without the app's protections the sweep would delete its recognizer", async () => {
    expect((await rig.api("PATCH", "/config", { "server.models_unused_days": 30 })).status).toBe(
      200,
    );
    // The same store and clock, with nothing held: what the app's own set is saved from.
    // biome-ignore lint/suspicious/noExplicitAny: the store is private to the app on purpose.
    const shelf = (rig.app as any).shelf as { sweep(p: ReadonlySet<string>): { id: string }[] };
    const gone = shelf.sweep(new Set()).map((e) => e.id);
    expect(gone).toContain(RECOGNIZER);
    expect(onDisk(rig, RECOGNIZER)).toBe(false);
  });
});
