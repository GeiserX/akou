/**
 * A Mac that runs Nemotron live and Qwen after the call, with no Parakeet on disk (model-set.ts), in
 * the real app: its models are ready, a call starts, the download card offers nothing, and Parakeet
 * is a model like any other, listed with Download and, once here, removable. Naming Parakeet for the
 * final pass makes it needed again. The catalog is a loopback registry of tiny files named after
 * the real models; the recognizer is the fake one, and nothing is downloaded from the network.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Probe } from "../src/main/asr/accelerator.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { MODELS, type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { type AppRig, appRig, NO_GPU } from "./api-helpers.ts";
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

  test("Parakeet is a model like any other: Download fetches it, and Remove deletes it", async () => {
    const got = await rig.api("POST", "/models/pull", { model: RECOGNIZER });
    expect(got.status).toBeLessThan(300);
    const deadline = Date.now() + 10_000;
    while ((await listed())[RECOGNIZER].state !== "ready" && Date.now() < deadline)
      await Bun.sleep(50);
    expect((await listed())[RECOGNIZER]).toMatchObject({ state: "ready", default: false });
    const del = await rig.api("DELETE", `/models/${RECOGNIZER}`);
    expect(del.status).toBe(200);
    expect(existsSync(join(models, RECOGNIZER))).toBe(false);
    // Positive control: a model a setup uses is still kept.
    const kept = await rig.api("DELETE", `/models/${QWEN_ASR}`);
    expect([kept.status, (kept.body as Body).error]).toEqual([409, "model_in_use"]);
  });

  test("naming Parakeet for the final pass needs it again: not ready, and a call is refused until it is here", async () => {
    await rig.api("PATCH", "/config", { "asr.final.model": RECOGNIZER });
    try {
      expect(((await rig.api("GET", "/models")).body as Body).state).toBe("missing");
      expect((await listed())[RECOGNIZER].default).toBe(true);
      const call = await rig.api("POST", "/calls", { title: "needs parakeet" });
      expect([call.status, (call.body as Body).error]).toEqual([503, "models_missing"]);
    } finally {
      await rig.api("PATCH", "/config", { "asr.final.model": "auto" });
    }
    expect(((await rig.api("GET", "/models")).body as Body).state).toBe("ready");
  });
});
