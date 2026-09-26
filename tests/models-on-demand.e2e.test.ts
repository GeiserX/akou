/**
 * Models on demand in server mode (docs/ux/SERVER.md section 12), end to end through the real API:
 * a request's `model` over `server.default_model` over the hardware's choice (SV-S1), a missing
 * model fetched while its jobs wait (SV-M1), the size cap (SV-M2), a download that never succeeds
 * (SV-M3), the ledger and the worker that lets go (SV-M4), and the sweep (SV-M5). The catalog is
 * a loopback registry of tiny stand-in files named after the real recognizer and helpers, plus two
 * test recognizers; the engine is the fake one, which runs whichever recognizer id it is handed.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { DAY_MS, USAGE_FILE } from "../src/main/server/model-store.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav, RATE } from "./fixtures/audio.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const B = "test-recognizer-b";
const C = "test-recognizer-c";
const T = Date.UTC(2026, 8, 1, 12, 0, 0);

function clip(words: string[], seconds: number): Uint8Array {
  const speech = concat(silence(0.4), speak(words));
  return monoWav(concat(speech, silence(Math.max(0, seconds - speech.length / RATE))));
}
const NOTE = clip(["hello", "world"], 3);

let reg: ModelRegistry;
let catalog: ModelSpecEntry[];

beforeAll(() => {
  reg = modelRegistry();
  catalog = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry(B, ["b.onnx"]),
    reg.entry(C, ["c.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
  ];
});

afterAll(() => reg.stop());

function entry(id: string): ModelSpecEntry {
  return catalog.find((m) => m.id === id) as ModelSpecEntry;
}

interface Rig extends AppRig {
  models: string;
  clock: { t: number };
  key: string;
  done(): Promise<void>;
}

/** A server whose models folder holds `installed`, with a `jobs` key. */
async function serverRig(
  installed: string[],
  settings: Record<string, unknown> = {},
  jobs: { decode?: (p: string, s: AbortSignal) => Promise<Float32Array> } = {},
): Promise<Rig> {
  const t = tempDir("akou-models-e2e-");
  const models = join(t.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const id of installed) reg.install(models, entry(id));
  const clock = { t: T };
  const rig = await appRig({
    modelRegistry: catalog,
    settings: {
      "server.enabled": true,
      "api.bind": "127.0.0.1",
      "asr.modelsDir": models,
      ...settings,
    },
    jobs: {
      now: () => clock.t,
      modelStore: { retryMs: [5, 5, 5], freeBytes: () => 1e12 },
      ...jobs,
    },
  });
  const r = await cli({ ...process.env, ...rig.env }, [
    "keys",
    "create",
    "--name",
    "archive",
    "--scope",
    "jobs",
    "--callback-host",
    "127.0.0.1",
    "--json",
  ]);
  expect(r.code).toBe(0);
  return {
    ...rig,
    models,
    clock,
    key: r.json.key,
    done: async () => {
      await rig.close();
      t.cleanup();
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
type Body = any;

async function submit(
  rig: Rig,
  fields: Record<string, string>,
): Promise<{ status: number; body: Body }> {
  const form = new FormData();
  form.append("file", new Blob([NOTE], { type: "audio/wav" }), "note.ogg");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${rig.key}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function get(rig: Rig, path: string): Promise<{ status: number; body: Body }> {
  const res = await fetch(`http://127.0.0.1:${rig.port}${path}`, {
    headers: { authorization: `Bearer ${rig.key}` },
  });
  return { status: res.status, body: await res.json() };
}

async function ended(rig: Rig, id: string): Promise<Body> {
  const j = await get(rig, `/v1/jobs/${id}?wait=30`);
  expect(["done", "failed"]).toContain(j.body.status);
  return j.body;
}

async function setting(rig: Rig, key: string, value: unknown): Promise<void> {
  const r = await rig.api("PATCH", "/config", { [key]: value });
  expect([r.status, r.text]).toEqual([200, r.text]);
}

function hits(name: string): number {
  return reg.hits.get(name) ?? 0;
}

describe("[SV-S1] the request's model, then server.default_model, then the hardware's choice", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await serverRig([RECOGNIZER, B, "silero-vad", NEMOTRON]);
  });
  afterAll(async () => rig.done());

  test("preset auto runs the server default; model A overrides it; auto falls to fast; nope is 422", async () => {
    await setting(rig, "server.default_model", B);
    const byDefault = await submit(rig, { preset: "auto", language: "auto" });
    expect(byDefault.status).toBe(202);
    expect(byDefault.body).toMatchObject({ model: B, model_source: "server_default" });
    const d = await ended(rig, byDefault.body.id);
    expect(d).toMatchObject({ status: "done", model: B, model_source: "server_default" });
    const result = await get(rig, `/v1/jobs/${byDefault.body.id}/result`);
    expect(result.body.engine.models[0]).toBe(B);

    const asked = await submit(rig, { preset: "auto", model: RECOGNIZER });
    expect(await ended(rig, asked.body.id)).toMatchObject({
      status: "done",
      model: RECOGNIZER,
      model_source: "request",
    });
    expect((await get(rig, `/v1/jobs/${asked.body.id}/result`)).body.engine.models[0]).toBe(
      RECOGNIZER,
    );

    await setting(rig, "server.default_model", "auto");
    const hw = await submit(rig, { preset: "auto" });
    expect(await ended(rig, hw.body.id)).toMatchObject({
      model: RECOGNIZER,
      preset: "fast",
      model_source: "hardware",
    });

    const nope = await submit(rig, { model: "nope" });
    expect(nope.status).toBe(422);
    expect(nope.body).toMatchObject({ error: "unknown_model", field: "model" });
  });

  test("exactly the archive's fields still answer 202", async () => {
    const receiver = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 204 }),
    });
    try {
      const r = await submit(rig, {
        preset: "auto",
        language: "auto",
        metadata: '{"content_hash": "abc"}',
        callback_url: `http://127.0.0.1:${receiver.port}/api/transcriptions/callback`,
      });
      expect(r.status).toBe(202);
      await ended(rig, r.body.id);
    } finally {
      receiver.stop(true);
    }
  });

  test("a bad server.default_model is refused at PATCH /v1/config", async () => {
    const r = await rig.api("PATCH", "/config", { "server.default_model": "../etc" });
    expect(r.status).toBe(400);
    expect(r.text).toContain("server.default_model");
  });

  test("the OpenAI door: whisper-1 falls through to the server default, an engine id wins", async () => {
    await setting(rig, "server.default_model", B);
    const post = async (model: string) => {
      const form = new FormData();
      form.append("file", new Blob([NOTE], { type: "audio/wav" }), "note.wav");
      form.append("model", model);
      const res = await fetch(`http://127.0.0.1:${rig.port}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${rig.key}` },
        body: form,
      });
      expect(res.status).toBe(200);
      await res.text();
    };
    const ran = () =>
      rig.logs.filter((l) => l.msg.startsWith("job.done")).map((l) => l.msg.split(" model ")[1]);
    await post("whisper-1");
    expect(ran().at(-1)).toBe(B);
    await post(RECOGNIZER);
    expect(ran().at(-1)).toBe(RECOGNIZER);
    await setting(rig, "server.default_model", "auto");
  });
});

describe("[SV-M1, SV-M2, SV-M3] a missing model is downloaded while its jobs wait", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await serverRig([RECOGNIZER, "silero-vad", NEMOTRON]);
  });
  afterAll(async () => rig.done());

  test("two jobs on a missing model: 202, waiting_for grows, one download, a present model's job passes them", async () => {
    const health = async () => {
      const r = await fetch(`http://127.0.0.1:${rig.port}/healthz`);
      return {
        status: r.status,
        ready: ((await r.json()) as { models_ready: boolean }).models_ready,
      };
    };
    const before = await health();
    expect(before.status).toBe(200);
    const release = reg.hold("b.onnx", 1024);
    const hitsBefore = hits("b.onnx");
    try {
      const one = await submit(rig, { model: B });
      const two = await submit(rig, { model: B });
      expect([one.status, two.status]).toEqual([202, 202]);
      await until(
        async () => (await get(rig, `/v1/jobs/${one.body.id}`)).body.waiting_for?.bytes === 1024,
        5000,
        "the first bytes",
      );
      const waiting = await get(rig, `/v1/jobs/${two.body.id}`);
      expect(waiting.body).toMatchObject({
        status: "queued",
        model: B,
        waiting_for: { model: B, bytes: 1024, total: 4096 },
      });
      expect(await health()).toEqual(before);

      // A job on a model on disk runs past them, in its own order.
      const three = await submit(rig, { model: RECOGNIZER });
      expect((await ended(rig, three.body.id)).status).toBe("done");
      expect((await get(rig, `/v1/jobs/${one.body.id}`)).body.status).toBe("queued");
      expect(await health()).toEqual(before);

      release();
      for (const j of [one, two]) {
        const end = await ended(rig, j.body.id);
        expect(end).toMatchObject({ status: "done", model: B });
        expect(end.waiting_for).toBeUndefined();
      }
      expect(hits("b.onnx") - hitsBefore).toBe(1);
      expect(await health()).toEqual(before);
    } finally {
      release();
    }
  });

  test("over server.models_max_gb: 409 preset_unavailable, reason models_max_gb, nothing fetched", async () => {
    const before = hits("c.onnx");
    await setting(rig, "server.models_max_gb", 1e-9);
    const r = await submit(rig, { model: C });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      error: "preset_unavailable",
      reason: "models_max_gb",
      model: C,
      bytes: 4096,
    });
    expect(hits("c.onnx")).toBe(before);
    await setting(rig, "server.models_max_gb", 40);
  });

  test("with server.auto_download off, a missing model is 409 preset_unavailable with the pull line", async () => {
    await setting(rig, "server.auto_download", false);
    const r = await submit(rig, { model: C });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      error: "preset_unavailable",
      model: C,
      run: `akou models pull ${C}`,
    });
    await setting(rig, "server.auto_download", true);
  });

  test("a download that keeps failing ends its job failed with model_download_failed, once on the feed", async () => {
    reg.failNext("c.onnx", Number.POSITIVE_INFINITY);
    const before = hits("c.onnx");
    try {
      const r = await submit(rig, { model: C });
      expect(r.status).toBe(202);
      const end = await ended(rig, r.body.id);
      expect(end.status).toBe("failed");
      expect(end.error.code).toBe("model_download_failed");
      expect(end.error.message).toContain(C);
      expect(end.error.message).toContain("HTTP 500");
      expect(hits("c.onnx") - before).toBe(4);
      const feed = await get(rig, "/v1/events");
      const mine = feed.body.events.filter((e: Body) => e.job_id === r.body.id);
      expect(mine.map((e: Body) => e.type)).toEqual(["transcription.failed"]);
      expect(mine[0].data.error.code).toBe("model_download_failed");
      // A later submit starts a fresh download.
      reg.failNext("c.onnx", 0);
      const again = await submit(rig, { model: C });
      expect((await ended(rig, again.body.id)).status).toBe("done");
    } finally {
      reg.failNext("c.onnx", 0);
    }
  });
});

describe("[SV-M4, SV-M5] the ledger, the worker that lets go, and the sweep", () => {
  let rig: Rig;
  let open = () => {};
  let held: Promise<void> = Promise.resolve();
  beforeAll(async () => {
    rig = await serverRig(
      [RECOGNIZER, B, C, "silero-vad", NEMOTRON],
      {},
      {
        decode: async (path, signal) => {
          await held;
          return readUploadAudio(path, { signal });
        },
      },
    );
  });
  afterAll(async () => rig.done());

  function ledger(): Record<string, string> {
    return JSON.parse(readFileSync(join(rig.models, USAGE_FILE), "utf8"));
  }

  test("the first sweep dates every model on disk and deletes nothing", () => {
    const l = ledger();
    for (const id of [RECOGNIZER, B, C, "silero-vad", NEMOTRON]) {
      expect(l[id]).toBe(new Date(T).toISOString());
      expect(existsSync(join(rig.models, id))).toBe(true);
    }
  });

  test("a job on a non-default model moves its last use to the job's end, and no worker keeps it", async () => {
    rig.clock.t = T + DAY_MS;
    const j = await submit(rig, { model: B });
    await ended(rig, j.body.id);
    expect(ledger()[B]).toBe(new Date(T + DAY_MS).toISOString());
    await until(() => rig.app.jobs()?.workerModel() === null, 5000, "the worker to close");
    // Positive control: a job on the default keeps its worker.
    const d = await submit(rig, { preset: "auto" });
    await ended(rig, d.body.id);
    expect(rig.app.jobs()?.workerModel()).toBe(RECOGNIZER);
  });

  test("31 days on: the unused model goes with one model.evicted line; the default and a queued job's stay", async () => {
    // Jobs submitted now are younger than server.retain_days when the sweep runs.
    rig.clock.t = T + DAY_MS + 31 * DAY_MS;
    // C waits behind a held job on the default, so a queued job needs it during the sweep.
    held = new Promise<void>((r) => {
      open = r;
    });
    const running = await submit(rig, { preset: "auto" });
    await until(
      async () => (await get(rig, `/v1/jobs/${running.body.id}`)).body.status === "running",
      5000,
      "the held job to run",
    );
    const queued = await submit(rig, { model: C });
    rig.app.jobs()?.sweep();
    expect(existsSync(join(rig.models, B))).toBe(false);
    for (const id of [RECOGNIZER, C, "silero-vad", NEMOTRON]) {
      expect(existsSync(join(rig.models, id))).toBe(true);
    }
    const lines = rig.logs.filter((l) => l.msg.startsWith("model.evicted"));
    expect(lines.map((l) => l.msg)).toEqual([
      `model.evicted ${B} last_used_at ${new Date(T + DAY_MS).toISOString()} bytes_freed 4096`,
    ]);
    open();
    expect((await ended(rig, queued.body.id)).status).toBe("done");
    expect((await ended(rig, running.body.id)).status).toBe("done");

    // With the setting at 0 nothing more goes, however old.
    await setting(rig, "server.models_unused_days", 0);
    rig.clock.t += 400 * DAY_MS;
    rig.app.jobs()?.sweep();
    expect(existsSync(join(rig.models, C))).toBe(true);

    // A job naming the deleted model fetches it again.
    await setting(rig, "server.models_unused_days", 30);
    const again = await submit(rig, { model: B });
    expect(again.status).toBe(202);
    expect((await ended(rig, again.body.id)).status).toBe("done");
    expect(existsSync(join(rig.models, B, "b.onnx"))).toBe(true);
  });
});

describe("[SV-M6] one model at a time: list, pull and delete", () => {
  let rig: Rig;
  const iso = (t: number) => new Date(t).toISOString();
  beforeAll(async () => {
    rig = await serverRig([RECOGNIZER, B, "silero-vad", NEMOTRON]);
  });
  afterAll(async () => rig.done());

  async function listed(): Promise<Record<string, Body>> {
    const r = await rig.api("GET", "/models");
    expect(r.status).toBe(200);
    return Object.fromEntries((r.body as Body).models.map((m: Body) => [m.id, m]));
  }

  test("GET /models lists every catalog model: state, size, last use, deletion date, default, in use", async () => {
    const r = await rig.api("GET", "/models");
    // Today's fields stay beside the list.
    expect(r.body).toMatchObject({ dir: rig.models });
    const m = await listed();
    expect(Object.keys(m).sort()).toEqual(catalog.map((x) => x.id).sort());
    expect(m[B]).toEqual({
      id: B,
      state: "ready",
      bytes: 4096,
      size: 4096,
      last_used_at: iso(T),
      evicts_at: iso(T + 30 * DAY_MS),
      default: false,
      in_use: false,
    });
    expect(m[RECOGNIZER]).toMatchObject({ state: "ready", default: true, evicts_at: null });
    expect(m["silero-vad"]).toMatchObject({ default: true, evicts_at: null });
    expect(m[C]).toEqual({
      id: C,
      state: "missing",
      bytes: 0,
      size: 4096,
      last_used_at: null,
      evicts_at: null,
      default: false,
      in_use: false,
    });
  });

  test("POST /models/pull with a model fetches that model only", async () => {
    const names = ["a.onnx", "b.onnx", "c.onnx", "vad.onnx", "diar.onnx"];
    const before = Object.fromEntries(names.map((n) => [n, hits(n)]));
    const r = await rig.api("POST", "/models/pull", { model: C });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ id: C });
    await until(async () => (await listed())[C].state === "ready", 5000, "C on disk");
    expect(Object.fromEntries(names.map((n) => [n, hits(n)]))).toEqual({
      ...before,
      "c.onnx": (before["c.onnx"] as number) + 1,
    });
    expect((await rig.api("POST", "/models/pull", { model: C })).status).toBe(200);
    const unknown = await rig.api("POST", "/models/pull", { model: "nope" });
    expect([unknown.status, (unknown.body as Body).error]).toEqual([422, "unknown_model"]);
  });

  test("DELETE /models/{id} removes an unused model, logged; 409 model_in_use for the default's set", async () => {
    const r = await rig.api("DELETE", `/models/${B}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: B, deleted: true, bytes: 4096 });
    expect(existsSync(join(rig.models, B))).toBe(false);
    expect((await listed())[B]).toMatchObject({ state: "missing", last_used_at: null });
    expect(rig.logs.filter((l) => l.msg.startsWith(`model.deleted ${B}`)).length).toBe(1);
    for (const id of [RECOGNIZER, "silero-vad"]) {
      const d = await rig.api("DELETE", `/models/${id}`);
      expect([d.status, (d.body as Body).error]).toEqual([409, "model_in_use"]);
      expect(existsSync(join(rig.models, id))).toBe(true);
    }
    expect((await rig.api("DELETE", "/models/nope")).status).toBe(404);
  });
});
