/**
 * The final pass's model through the whole app (`asr.final.model`, `akou finalize --model`): a
 * call ends and its pass runs Qwen, `auto`'s choice once Qwen is downloaded, even on a machine
 * with no GPU; `--model parakeet` and `--model qwen` override one run each, and Qwen's name reaches
 * `final.done`, `GET /calls/{id}` and `akou status`; while it runs, `GET /status` has how far it is.
 * A model that is not a final model is refused, and so is Qwen when it is not downloaded. On Qwen
 * the pass runs with Parakeet's files gone. On `fusion` (the setting, `akou finalize --model` or the
 * call's own `--final`) the pass fuses the `fusion` preset's engines that are downloaded and names
 * the rest in `final.done`.
 * Qwen is the fake llama-server (`asr.llamaServer`), the recognizer the fake of asr-fake.ts.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FinalDone, LogEvent, Seg } from "../src/core/log/events.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import {
  type ModelSpecEntry,
  modelFile,
  NEMOTRON,
  RECOGNIZER,
  WHISPER_LARGE_V3,
} from "../src/main/asr/models.ts";
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
    // A fusion engine, the test module's fake Whisper; nothing else runs it.
    { ...reg.entry(WHISPER_LARGE_V3, ["w.gguf"]), onDemand: true } as ModelSpecEntry,
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
      // Slow to answer its health check (4 s), so the pass is seen starting and running.
      "asr.llamaServer": [
        process.execPath,
        FAKE_LLAMA,
        "--fake-log",
        llamaLog,
        "--fake-loading-ms",
        "4000",
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
    // Running: `GET /status` has how far it is and on which model, and so does the call. The
    // fake llama-server answers its health check after 4 s, so the pass sits on "starting".
    await until(
      async () => (await rig.api("GET", "/status")).body.finals?.[0]?.step === "starting",
      15_000,
      "the pass to start Qwen",
    );
    const st = await rig.api("GET", "/status");
    expect(st.body.finals).toEqual([
      {
        call: id,
        done_s: expect.any(Number),
        total_s: expect.any(Number),
        model: QWEN_ASR,
        step: "starting",
        waiting: null,
      },
    ]);
    expect((await cli(["status"])).out).toContain("Final: starting Qwen");
    expect(st.body.last.final).toMatchObject({ state: "running", model: QWEN_ASR });
    expect((await rig.api("GET", `/calls/${id}`)).body.final.progress).toMatchObject({
      model: QWEN_ASR,
    });

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
      expect(para.body.message).toContain("Parakeet cannot run this pass");
      expect(para.body.message).toContain("Parakeet is not downloaded");
      // Nothing started for it.
      expect((await dones(id)).length).toBe(5);
      expect((await rig.api("GET", "/status")).body.finals).toEqual([]);
    } finally {
      renameSync(`${dir}.away`, dir);
    }
  });

  test("with neither model on disk no pass starts, and the answer says why", async () => {
    const qwen = dirname(modelFile(models, QWEN_ASR, "q.gguf"));
    const para = dirname(modelFile(models, RECOGNIZER, "a.onnx"));
    renameSync(qwen, `${qwen}.away`);
    renameSync(para, `${para}.away`);
    try {
      const r = await rig.api("POST", "/calls/last/finalize", { force: true });
      expect(r.status).toBe(501);
      expect(r.body.message).toContain("no model can run the final pass");
    } finally {
      renameSync(`${qwen}.away`, qwen);
      renameSync(`${para}.away`, para);
    }
  });

  test("one Qwen pass at a time: a second waits for the first, says so, then runs", async () => {
    const first = (await rig.api("GET", "/calls/last")).body.id as string;
    const second = await rig.startCall({});
    await until(
      async () => (await rig.app.events(second, 0)).some((e) => e.type === "seg"),
      15_000,
      "a line",
    );
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await dones(second)).length === 1, 30_000, "its own pass");
    const before = (await dones(first)).length;
    const a = await rig.api("POST", `/calls/${first}/finalize`, { force: true, model: "qwen" });
    const b = await rig.api("POST", `/calls/${second}/finalize`, { force: true, model: "qwen" });
    expect([a.status, b.status]).toEqual([202, 202]);
    // The fake llama-server takes 4 s to answer its health check, so the first is still on it.
    const st = (await rig.api("GET", "/status")).body;
    const waiting = st.finals.find((f: { call: string }) => f.call === second);
    expect(waiting).toMatchObject({ waiting: first, model: QWEN_ASR });
    expect((await rigCli(rig)(["status"])).out).toContain(
      `Final: waiting for the pass on ${first} (Qwen)`,
    );
    await until(async () => (await dones(first)).length === before + 1, 30_000, "the first");
    await until(async () => (await dones(second)).length === 2, 30_000, "the second, after it");
    // The second pass began its work (its `vocab.used`) only once the first had written its end.
    const firstEnd = (await dones(first)).at(-1)?.t as number;
    const secondWork = (await rig.app.events(second, 0)).findLast((e) => e.type === "vocab.used")
      ?.t as number;
    expect(secondWork).toBeGreaterThanOrEqual(firstEnd);
    expect((await dones(second)).at(-1)?.model).toBe(QWEN_ASR);
  });
});

describe("[ASR-6] a call's final pass on fusion (asr.final.model, akou start --final)", () => {
  const ALL = `rover-conf(${QWEN_ASR},${WHISPER_LARGE_V3},${RECOGNIZER})`;
  const finalSegs = async (id: string) => {
    const finals = new Map<string, Seg>();
    for (const e of await rig.app.events(id, 0))
      if (e.type === "seg" && e.id.startsWith("f")) finals.set(e.id, e as Seg);
    return [...finals.values()].filter((x) => x.text !== null);
  };

  test("the setting runs the fusion preset's engines over the call and names them; GET /models and akou status say so", async () => {
    const id = (await rig.api("GET", "/calls/last")).body.id as string;
    expect((await rig.api("PATCH", "/config", { "asr.final.model": "fusion" })).status).toBe(200);
    try {
      expect((await rig.api("GET", "/models")).body.final).toMatchObject({
        setting: "fusion",
        next: ALL,
      });
      const before = (await dones(id)).length;
      const r = await rig.api("POST", `/calls/${id}/finalize`, { force: true });
      expect([r.status, r.body.model]).toEqual([202, ALL]);
      await until(async () => (await dones(id)).length === before + 1, 30_000, "the fused pass");
      expect((await dones(id)).at(-1)).toMatchObject({
        model: ALL,
        engines: [QWEN_ASR, WHISPER_LARGE_V3, RECOGNIZER],
        dropped: [],
      });
      const current = await finalSegs(id);
      expect(current.length).toBeGreaterThan(0);
      expect(current.every((x) => x.model === ALL)).toBe(true);
      expect((await rigCli(rig)(["status"])).out).toContain("Final: ready (Qwen + Whisper + ");
    } finally {
      await rig.api("PATCH", "/config", { "asr.final.model": "auto" });
    }
  });

  test("an engine of the list that is not downloaded is left out and named; with none downloaded fusion is refused", async () => {
    const id = (await rig.api("GET", "/calls/last")).body.id as string;
    const w = dirname(modelFile(models, WHISPER_LARGE_V3, "w.gguf"));
    renameSync(w, `${w}.away`);
    try {
      const before = (await dones(id)).length;
      const r = await rig.api("POST", `/calls/${id}/finalize`, { force: true, model: "fusion" });
      expect(r.status).toBe(202);
      await until(async () => (await dones(id)).length === before + 1, 30_000, "the pass");
      const done = (await dones(id)).at(-1) as FinalDone;
      expect(done).toMatchObject({
        model: `rover-conf(${QWEN_ASR},${RECOGNIZER})`,
        engines: [QWEN_ASR, RECOGNIZER],
      });
      expect(done.dropped).toEqual([
        {
          engine: WHISPER_LARGE_V3,
          reason: expect.stringContaining("not downloaded"),
          units: null,
        },
      ]);
      // With Qwen and Parakeet gone too, nothing of the list can run: refused, never replaced.
      const q = dirname(modelFile(models, QWEN_ASR, "q.gguf"));
      const p = dirname(modelFile(models, RECOGNIZER, "a.onnx"));
      renameSync(q, `${q}.away`);
      renameSync(p, `${p}.away`);
      try {
        const none = await rig.api("POST", `/calls/${id}/finalize`, {
          force: true,
          model: "fusion",
        });
        expect(none.status).toBe(501);
        expect(none.body.message).toContain("fusion cannot run this pass");
      } finally {
        renameSync(`${q}.away`, q);
        renameSync(`${p}.away`, p);
      }
    } finally {
      renameSync(`${w}.away`, w);
    }
  });

  test("a call's own final (POST /calls final, akou start --final) beats the setting and stays in its log", async () => {
    const bad = await rig.api("POST", "/calls", { final: "whisper" });
    expect([bad.status, bad.body.field]).toEqual([422, "final"]);
    const id = await rig.startCall({ final: "fusion" });
    expect((await rig.app.events(id, 0))[0]).toMatchObject({
      type: "call.created",
      final: "fusion",
    });
    await until(
      async () => (await rig.app.events(id, 0)).some((e) => e.type === "seg"),
      15_000,
      "a line",
    );
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await dones(id)).length === 1, 30_000, "its pass");
    // The setting is `auto` (Qwen alone); the call asked for fusion.
    expect((await dones(id))[0]).toMatchObject({
      model: ALL,
      engines: [QWEN_ASR, WHISPER_LARGE_V3, RECOGNIZER],
    });
    // A short name is saved as the model's id.
    const two = await rig.startCall({ final: "parakeet" });
    expect((await rig.app.events(two, 0))[0]).toMatchObject({ final: RECOGNIZER });
    await until(
      async () => (await rig.app.events(two, 0)).some((e) => e.type === "seg"),
      15_000,
      "a line",
    );
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await dones(two)).length === 1, 30_000, "the second call's pass");
    expect((await dones(two))[0]?.model).toBe("fake-parakeet");
    expect((await dones(two))[0]).not.toHaveProperty("engines");
  });
});
