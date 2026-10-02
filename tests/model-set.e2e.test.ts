/**
 * A Mac that runs Nemotron live and Qwen after the call, with no Parakeet on disk (model-set.ts), in
 * the real app: its models are ready, a call starts, the download card offers nothing, and Parakeet
 * is a model like any other, listed with Download and, once here, removable. Naming Parakeet for the
 * final pass makes it needed again. The catalog is a loopback registry of tiny files named after
 * the real models; the recognizer is the fake one, and nothing is downloaded from the network.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Probe } from "../src/main/asr/accelerator.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { MODELS, type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { type AppRig, appRig, NO_GPU, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const BUILD = "llama-server-b11200-darwin-arm64-metal";
const LIVE = "nemotron-3.5-560";
/** Every model the Mac keeps: the helpers, Nemotron, Qwen and its llama-server. */
const KEPT = ["silero-vad", NEMOTRON, "titanet-small", LIVE, QWEN_ASR, BUILD];

// biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
type Body = any;

let reg: ModelRegistry;
let catalog: ModelSpecEntry[];
let rig: AppRig;
let models: string;
const home = tempDir("akou-model-set-");

beforeAll(async () => {
  reg = modelRegistry();
  const ids = [RECOGNIZER, ...KEPT, "pyannote-segmentation-3.0"];
  // The real entries (what each serves, which are fetched on demand), with tiny files.
  catalog = ids.map(
    (id) =>
      ({
        ...(MODELS.find((m) => m.id === id) as ModelSpecEntry),
        files: reg.entry(id, [`${id}.bin`]).files,
      }) as ModelSpecEntry,
  );
  models = join(home.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const m of catalog.filter((x) => KEPT.includes(x.id))) reg.install(models, m);
  rig = await appRig({
    modelRegistry: catalog,
    settings: {
      "asr.modelsDir": models,
      "asr.diarizer": "nemotron",
      "asr.languages": ["en", "es"],
    },
    // An Apple silicon Mac with 24 GB: room for Qwen.
    accelerator: { probe: { ...(NO_GPU.probe as Probe), platform: "darwin-arm64" } },
    memoryGb: 24,
    jobs: { modelStore: { retryMs: [5, 5, 5], freeBytes: () => 1e12 } },
  });
});

afterAll(async () => {
  await rig?.close();
  reg?.stop();
  home.cleanup();
});

/** A dictation clip sent to `POST /v1/dictations` on one engine. */
async function dictate(r: AppRig, engine: string): Promise<{ status: number; body: Body }> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([monoWav(concat(silence(0.6), speak(["hello"]), silence(1)))]),
    "c.wav",
  );
  form.append("engine", engine);
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations`, {
    method: "POST",
    headers: { authorization: `Bearer ${r.token}`, "x-akou-client": "test" },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

const listed = async (): Promise<Record<string, Body>> =>
  Object.fromEntries(
    ((await rig.api("GET", "/models")).body as Body).models.map((m: Body) => [m.id, m]),
  );

describe("Nemotron live and Qwen after the call: no Parakeet needed", () => {
  test("the models are ready without Parakeet, the download card offers nothing, and a call starts", async () => {
    const m = (await rig.api("GET", "/models")).body as Body;
    expect(m.state).toBe("ready");
    const rows = await listed();
    expect(rows[RECOGNIZER].state).toBe("missing");
    expect(rows[RECOGNIZER].default).toBe(false);
    for (const id of KEPT) expect(`${id}: ${rows[id].default}`).toBe(`${id}: true`);
    // Nothing to pull: the set is here.
    const pull = await rig.api("POST", "/models/pull", {});
    expect([pull.status, (pull.body as Body).state]).toEqual([200, "ready"]);
    expect(reg.hits.get(`${RECOGNIZER}.bin`) ?? 0).toBe(0);
    const call = await rig.api("POST", "/calls", { title: "no parakeet" });
    expect(call.status).toBeLessThan(300);
    await rig.api("POST", "/calls/live/stop");
  });

  test("dictation's fast engine is Parakeet: without it, a fast dictation is refused in plain words, never decoded on missing files", async () => {
    const fast = await dictate(rig, "fast");
    expect([fast.status, fast.body.error]).toEqual([503, "models_missing"]);
  });

  test("GET /dictation lists the engines a retry can use: fast is not one without Parakeet", async () => {
    const engines = ((await rig.api("GET", "/dictation")).body as Body).engines as string[];
    expect(engines).not.toContain("fast");
    // Nemotron is here, so the streaming engine is.
    expect(engines).toContain("live");
  });

  test("Parakeet is a model like any other: Download fetches it, and Remove deletes it", async () => {
    const got = await rig.api("POST", "/models/pull", { model: RECOGNIZER });
    expect(got.status).toBeLessThan(300);
    const deadline = Date.now() + 10_000;
    while ((await listed())[RECOGNIZER].state !== "ready" && Date.now() < deadline)
      await Bun.sleep(50);
    expect((await listed())[RECOGNIZER]).toMatchObject({ state: "ready", default: false });
    // Positive control: with Parakeet here, fast dictates, and a retry can use it.
    const fast = await dictate(rig, "fast");
    expect([fast.status, fast.body.engine]).toEqual([200, "fast"]);
    expect(((await rig.api("GET", "/dictation")).body as Body).engines).toContain("fast");
    const del = await rig.api("DELETE", `/models/${RECOGNIZER}`);
    expect(del.status).toBe(200);
    expect(existsSync(join(models, RECOGNIZER))).toBe(false);
    // Positive control: a model a setup uses is still kept.
    const kept = await rig.api("DELETE", `/models/${QWEN_ASR}`);
    expect([kept.status, (kept.body as Body).error]).toEqual([409, "model_in_use"]);
  });

  test("naming Parakeet for the live lines needs it again; named for the final pass, Qwen writes until it is here", async () => {
    await rig.api("PATCH", "/config", { "asr.live": "parakeet" });
    try {
      expect(((await rig.api("GET", "/models")).body as Body).state).toBe("missing");
      expect((await listed())[RECOGNIZER].default).toBe(true);
      const call = await rig.api("POST", "/calls", { title: "needs parakeet" });
      expect([call.status, (call.body as Body).error]).toEqual([503, "models_missing"]);
    } finally {
      await rig.api("PATCH", "/config", { "asr.live": "auto" });
    }
    await rig.api("PATCH", "/config", { "asr.final.model": RECOGNIZER });
    try {
      const m = (await rig.api("GET", "/models")).body as Body;
      expect(m.state).toBe("ready");
      expect(m.final).toEqual({
        setting: RECOGNIZER,
        named: RECOGNIZER,
        next: QWEN_ASR,
        engines: [],
      });
    } finally {
      await rig.api("PATCH", "/config", { "asr.final.model": "auto" });
    }
    expect(((await rig.api("GET", "/models")).body as Body).state).toBe("ready");
  });
});

describe("a final pass on Qwen with no Parakeet ever downloaded", () => {
  const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
  const box = tempDir("akou-model-set-final-");
  let reg2: ModelRegistry;
  let r: AppRig;
  let dir: string;

  beforeAll(async () => {
    reg2 = modelRegistry();
    const ids = [RECOGNIZER, "silero-vad", NEMOTRON, "titanet-small", LIVE, QWEN_ASR];
    const cat = ids.map(
      (id) =>
        ({
          ...(MODELS.find((m) => m.id === id) as ModelSpecEntry),
          files: reg2.entry(id, [`${id}.bin`]).files,
        }) as ModelSpecEntry,
    );
    dir = join(box.dir, "models");
    mkdirSync(dir, { recursive: true });
    for (const m of cat.filter((x) => x.id !== RECOGNIZER)) reg2.install(dir, m);
    const wav = speechWav(box.dir);
    r = await appRig({
      modelRegistry: cat,
      helperArgs: ["--wav", wav],
      finalAudio: ({ parts }) => ({
        kind: "wav",
        files: Object.fromEntries(parts.map((p) => [p, wav])),
      }),
      settings: {
        "asr.modelsDir": dir,
        "asr.diarizer": "nemotron",
        "asr.languages": ["en", "es"],
        "asr.llamaServer": [process.execPath, FAKE_LLAMA, "--fake-log", join(box.dir, "llama.log")],
      },
    });
    await until(() => r.app.recognizer() === "ready", 10_000, "the recognizer");
  });

  afterAll(async () => {
    await r?.close();
    reg2?.stop();
    box.cleanup();
  });

  const dones = async (id: string) =>
    (await r.app.events(id, 0)).filter((e) => e.type === "final.done") as { model?: string }[];

  test("a call ends and its pass runs Qwen to the end; an old call reruns on Qwen with the live model gone too", async () => {
    expect(existsSync(join(dir, RECOGNIZER))).toBe(false);
    const id = await r.startCall({});
    await until(
      async () => (await r.app.events(id, 0)).some((e) => e.type === "seg"),
      15_000,
      "a line",
    );
    expect((await r.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await dones(id)).length === 1, 30_000, "the final.done");
    expect((await dones(id))[0]?.model).toBe(QWEN_ASR);
    await until(
      async () => (await r.api("GET", `/calls/${id}`)).body.final?.state === "done",
      10_000,
      "the call's final state",
    );
    // A pass needs no live model: with Nemotron gone as well, the old call reruns on Qwen.
    const live = join(dir, LIVE);
    renameSync(live, `${live}.away`);
    try {
      let again = await r.api("POST", "/calls/last/finalize", { force: true, model: "qwen" });
      await until(
        async () => {
          if (again.status !== 409) return true;
          again = await r.api("POST", "/calls/last/finalize", { force: true, model: "qwen" });
          return false;
        },
        10_000,
        "the last pass to settle",
      );
      expect([again.status, again.body.model]).toEqual([202, QWEN_ASR]);
      await until(async () => (await dones(id)).length === 2, 30_000, "the rerun's final.done");
      expect((await dones(id))[1]?.model).toBe(QWEN_ASR);
      // Control: Parakeet named for a run, with no Parakeet here, is refused, not started.
      const para = await r.api("POST", "/calls/last/finalize", { force: true, model: "parakeet" });
      expect(para.status).toBe(501);
      expect(para.body.message).toContain("not downloaded");
    } finally {
      renameSync(`${live}.away`, live);
    }
  });
});
