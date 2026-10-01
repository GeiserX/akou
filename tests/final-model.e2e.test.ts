/**
 * The final pass's model through the whole app (`asr.final.model`, `akou finalize --model`): a
 * call ends and its pass runs Qwen, `auto`'s choice once Qwen is downloaded, even on a machine
 * with no GPU; `--model parakeet` and `--model qwen` override one run each, and Qwen's name reaches
 * `final.done`, `GET /calls/{id}` and `akou status`; while it runs, `GET /status` has how far it is.
 * A model that is not a final model is refused, and so is Qwen when it is not downloaded. On Qwen
 * the pass runs with Parakeet's files gone.
 * Qwen is the fake llama-server (`asr.llamaServer`), the recognizer the fake of asr-fake.ts.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FinalDone, LogEvent, Seg } from "../src/core/log/events.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, modelFile, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { type AppRig, appRig, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");

let reg: ModelRegistry;
let rig: AppRig;
let models: string;
const home = tempDir("akou-final-model-");
const llamaLog = join(home.dir, "llama.log");

beforeAll(async () => {
  reg = modelRegistry();
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
  ];
  models = join(home.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const m of catalog) reg.install(models, m);
  const wav = speechWav(home.dir);
  rig = await appRig({
    modelRegistry: catalog,
    helperArgs: ["--wav", wav],
    // The pass reads the helper's own WAV for every part.
    finalAudio: ({ parts }) => ({
      kind: "wav",
      files: Object.fromEntries(parts.map((p) => [p, wav])),
    }),
    settings: {
      "asr.modelsDir": models,
      "asr.languages": ["en"],
      // Slow to answer its health check, so the pass is seen running.
      "asr.llamaServer": [
        process.execPath,
        FAKE_LLAMA,
        "--fake-log",
        llamaLog,
        "--fake-loading-ms",
        "1500",
      ],
    },
  });
  await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
});

afterAll(async () => {
  await rig?.close();
  reg?.stop();
  home.cleanup();
});

const requests = () =>
  existsSync(llamaLog)
    ? readFileSync(llamaLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { body?: unknown })
        .filter((l) => l.body !== undefined).length
    : 0;

async function dones(id: string): Promise<FinalDone[]> {
  return (await rig.app.events(id, 0)).filter(
    (e: LogEvent): e is FinalDone => e.type === "final.done",
  );
}

describe("the final pass's model", () => {
  test("Qwen by default once it is downloaded, on a machine with no GPU; --model overrides one run", async () => {
    const id = await rig.startCall({});
    await until(
      async () => (await rig.app.events(id, 0)).some((e) => e.type === "seg"),
      15_000,
      "a line",
    );
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await dones(id)).length === 1, 30_000, "the first final.done");
    // `auto`, and the rig has no GPU: Qwen all the same.
    expect((await dones(id))[0]?.model).toBe(QWEN_ASR);
    expect(requests()).toBeGreaterThan(0);

    const cli = rigCli(rig);
    const para = await cli(["finalize", "last", "--force", "--model", "parakeet"]);
    expect(para.code).toBe(0);
    expect(para.out).toContain(`Final pass started for ${id} on `);
    await until(async () => (await dones(id)).length === 2, 30_000, "Parakeet's final.done");
    expect((await dones(id))[1]?.model).toBe("fake-parakeet");
    expect((await cli(["status"])).out).toContain("Final: ready (");

    const run = await cli(["finalize", "last", "--force", "--model", "qwen"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`Final pass started for ${id} on Qwen`);
    // Running: `GET /status` has how far it is and on which model, and so does the call.
    const st = await rig.api("GET", "/status");
    expect(st.body.finals).toEqual([
      { call: id, done_s: expect.any(Number), total_s: expect.any(Number), model: QWEN_ASR },
    ]);
    expect(st.body.last.final).toMatchObject({ state: "running", model: QWEN_ASR });
    expect((await rig.api("GET", `/calls/${id}`)).body.final.progress).toMatchObject({
      model: QWEN_ASR,
    });
    expect((await cli(["status"])).out).toContain("Final: running");

    await until(async () => (await dones(id)).length === 3, 30_000, "Qwen's final.done");
    expect((await dones(id))[2]?.model).toBe(QWEN_ASR);
    const events = await rig.app.events(id, 0);
    const finals = new Map<string, Seg>();
    for (const e of events)
      if (e.type === "seg" && e.id.startsWith("f")) finals.set(e.id, e as Seg);
    const current = [...finals.values()].filter((s) => s.text !== null);
    expect(current.length).toBeGreaterThan(0);
    expect(current.every((s) => s.model === QWEN_ASR)).toBe(true);
    const detail = (await rig.api("GET", `/calls/${id}`)).body.final;
    expect(detail).toMatchObject({ state: "done", model: QWEN_ASR, progress: null });
    const after = await rig.api("GET", "/status");
    expect(after.body.finals).toEqual([]);
    expect((await cli(["status"])).out).toContain("Final: ready (Qwen)");
    const json = JSON.parse((await cli(["status", "--json"])).out);
    expect(json.last.final).toMatchObject({ state: "done", model: QWEN_ASR, done_s: null });
  });

  test("a model that is not a final model is refused; Qwen that is not downloaded is refused, not replaced", async () => {
    const bad = await rig.api("POST", "/calls/last/finalize", { force: true, model: "whisper" });
    expect(bad.status).toBe(422);
    const dir = dirname(modelFile(models, QWEN_ASR, "q.gguf"));
    renameSync(dir, `${dir}.away`);
    try {
      const missing = await rig.api("POST", "/calls/last/finalize", { force: true, model: "qwen" });
      expect(missing.status).toBe(501);
      expect(missing.body.message).toContain("Qwen cannot run this pass");
    } finally {
      renameSync(`${dir}.away`, dir);
    }
    // Control: the same request with Qwen back is taken.
    const ok = await rig.api("POST", "/calls/last/finalize", { force: true, model: "qwen" });
    expect(ok.status).toBe(202);
    expect(ok.body.model).toBe(QWEN_ASR);
    const id = ok.body.call as string;
    await until(async () => (await dones(id)).length === 4, 30_000, "the fourth pass");
  });

  test("on Qwen the pass needs no Parakeet on disk; Parakeet asked for without its files is refused", async () => {
    const dir = dirname(modelFile(models, RECOGNIZER, "a.onnx"));
    renameSync(dir, `${dir}.away`);
    try {
      // Right after the last pass's final.done, while its llama-server may still be stopping: the
      // app waits for it instead of answering 409 final_running.
      const qwen = await rig.api("POST", "/calls/last/finalize", { force: true });
      expect(qwen.status).toBe(202);
      expect(qwen.body.model).toBe(QWEN_ASR);
      const id = qwen.body.call as string;
      await until(async () => (await dones(id)).length === 5, 30_000, "a pass with no Parakeet");
      expect((await dones(id))[4]?.model).toBe(QWEN_ASR);
      // Control: Parakeet by name, with its files gone, cannot run.
      const para = await rig.api("POST", "/calls/last/finalize", {
        force: true,
        model: "parakeet",
      });
      expect(para.status).toBe(501);
      expect(para.body.message).toContain("not downloaded");
    } finally {
      renameSync(`${dir}.away`, dir);
    }
  });
});
