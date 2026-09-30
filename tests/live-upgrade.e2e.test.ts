/**
 * The second pass through the whole app (ASR-7, akou-chp.23, `asr.review.*`): a call with Qwen's
 * review writes each streaming line, then Qwen's one rewrite of it at the next review (every second
 * here, every `asr.review.everySeconds` in the app), and the Qwen server it started stops when the
 * call ends; with Parakeet's, the live Worker's own recognizer rewrites it. A call's own `review` and `reviewEvery` (`POST /calls`, `akou start --review
 * --review-every`) reach it. The config file starts with the old `asr.live` `upgrade`, read as
 * Nemotron with Qwen's review. Qwen is the fake
 * llama-server (`asr.llamaServer`), the recognizer and the streaming engine the fakes of
 * asr-fake.ts, and the catalog a loopback registry of tiny files: nothing is downloaded and no
 * model loads.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LogEvent, Seg } from "../src/core/log/events.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import {
  MODELS,
  type ModelSpecEntry,
  modelFile,
  NEMOTRON,
  RECOGNIZER,
} from "../src/main/asr/models.ts";
import { type AppRig, appRig, FAKE_MODELS, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const STREAM = "nemotron-en-560";
/** The fake recognizer's name: what the live Worker's recognizer writes. */
const RECOGNIZER_MODEL = "fake-parakeet";
const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");

let reg: ModelRegistry;
let rig: AppRig;
const home = tempDir("akou-live-upgrade-");
const llamaLog = join(home.dir, "llama.log");

beforeAll(async () => {
  reg = modelRegistry();
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    { ...reg.entry(STREAM, ["s.onnx"]), onDemand: true } as ModelSpecEntry,
    { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
  ];
  const models = join(home.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const m of catalog) reg.install(models, m);
  // Qwen's real file names too, empty (the fake llama-server reads none): dictation's `best`
  // looks for them.
  for (const f of MODELS.find((m) => m.id === QWEN_ASR)?.files ?? []) {
    const path = modelFile(models, QWEN_ASR, f.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  rig = await appRig({
    modelRegistry: catalog,
    models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
    helperArgs: ["--wav", speechWav(home.dir)],
    liveReviewEveryMs: 1000,
    settings: {
      "asr.modelsDir": models,
      "asr.languages": ["en"],
      // The old value: Nemotron with Qwen's review.
      "asr.live": "upgrade",
      // An own llama-server needs no downloaded build.
      "asr.llamaServer": [process.execPath, FAKE_LLAMA, "--fake-log", llamaLog],
      "asr.accelerator": "cpu",
    },
  });
  await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
});

afterAll(async () => {
  await rig?.close();
  reg?.stop();
  home.cleanup();
});

/** The fake llama-server's starts (`argv`, `pid`) and requests (`body`). */
function llama(): Record<string, unknown>[] {
  return existsSync(llamaLog)
    ? readFileSync(llamaLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("[ASR-7] a call with Qwen's second pass", () => {
  test("each line is written by the stream, then rewritten once by Qwen; Qwen stops with the call", async () => {
    const id = await rig.startCall({});
    const status = async () => (await rig.api("GET", "/status")).body.live;
    await until(async () => (await status())?.setup != null, 10_000, "the live setup");
    expect(await status()).toMatchObject({
      setup: "nemotron",
      engine: STREAM,
      review: { model: "qwen", everySeconds: 60 },
    });
    const segs = async () =>
      (await rig.app.events(id, 0)).filter((e: LogEvent): e is Seg => e.type === "seg");
    await until(
      async () => (await segs()).filter((s) => s.model === QWEN_ASR).length >= 2,
      30_000,
      "both lines rewritten",
    );
    const stop = await rig.api("POST", "/calls/live/stop");
    expect(stop.status).toBe(200);
    await until(async () => (await status()) === null, 10_000, "the call's end");
    const all = await segs();
    // Per line, its revisions in order and the model of each.
    const byLine = new Map<string, string[]>();
    for (const s of all) byLine.set(s.id, [...(byLine.get(s.id) ?? []), `${s.rev} ${s.model}`]);
    const rewritten = [...byLine.values()].filter((r) => r.includes(`2 ${QWEN_ASR}`));
    expect(rewritten.length).toBeGreaterThanOrEqual(2);
    // Every line has the stream's words and at most Qwen's rewrite: no other revision.
    const allowed = [[`1 ${STREAM}`], [`1 ${STREAM}`, `2 ${QWEN_ASR}`]];
    for (const r of byLine.values()) expect(allowed).toContainEqual(r);
    // Qwen heard the lines: a review carries every utterance closed since the last one.
    expect(llama().filter((x) => x.body !== undefined).length).toBeGreaterThanOrEqual(1);
    // The server the upgrade started is gone once the call has ended: the final pass needs the GPU.
    const pids = llama().flatMap((x) => (typeof x.pid === "number" ? [x.pid] : []));
    expect(pids.length).toBeGreaterThan(0);
    await until(() => pids.every((p) => !alive(p)), 10_000, "the upgrade's Qwen to stop");
  });
});

describe("[ASR-7] one Qwen for the upgrade and dictation", () => {
  test("with dictation keeping Qwen warm, the upgrade sends its lines there and starts no server of its own", async () => {
    const started = () => llama().filter((x) => x.argv !== undefined).length;
    const before = started();
    const on = await rig.api("PATCH", "/config", {
      "dictation.engine": "best",
      "dictation.enabled": true,
    });
    expect(on.status).toBe(200);
    await until(() => started() === before + 1, 10_000, "dictation's warm Qwen");
    const requests = () => llama().filter((x) => x.body !== undefined).length;
    const asked = requests();
    const id = await rig.startCall({});
    const segs = async () =>
      (await rig.app.events(id, 0)).filter((e: LogEvent): e is Seg => e.type === "seg");
    await until(
      async () => (await segs()).filter((s) => s.model === QWEN_ASR).length >= 2,
      30_000,
      "both lines rewritten",
    );
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(
      async () => (await rig.api("GET", "/status")).body.live === null,
      10_000,
      "the end",
    );
    expect(requests()).toBeGreaterThanOrEqual(asked + 1);
    // Control: the count above is of starts, and dictation's is the only one since.
    expect(started()).toBe(before + 1);
    const pid = llama().findLast((x) => x.argv !== undefined)?.pid as number;
    expect(alive(pid)).toBe(true);
    await rig.api("PATCH", "/config", { "dictation.enabled": false });
    await until(() => !alive(pid), 10_000, "dictation's Qwen to stop");
  });
});

describe("[ASR-7] a call's own second pass", () => {
  test("POST /calls review and reviewEvery, and akou start --review --review-every, reach the call and its status", async () => {
    const status = async () => (await rig.api("GET", "/status")).body.live;
    await rig.api("PATCH", "/config", { "asr.review.model": "none" });
    await rig.startCall({ review: "qwen", reviewEvery: 120 });
    await until(async () => (await status())?.setup != null, 10_000, "the live setup");
    expect((await status()).review).toEqual({ model: "qwen", everySeconds: 120 });
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await status()) === null, 10_000, "the call's end");
    // The setting says none: a call that names nothing runs none.
    await rig.startCall({});
    await until(async () => (await status())?.setup != null, 10_000, "the live setup");
    expect((await status()).review).toBeNull();
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await status()) === null, 10_000, "the call's end");
    const cli = rigCli(rig);
    const started = await cli(["start", "--review", "qwen", "--review-every", "300", "--json"]);
    expect(started.code).toBe(0);
    await until(async () => (await status())?.setup != null, 10_000, "the live setup");
    expect((await cli(["status"])).out).toContain(
      `live model nemotron (${STREAM}), second pass qwen every 300 s`,
    );
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await status()) === null, 10_000, "the call's end");
  });
});

describe("[ASR-7] a call with Parakeet's second pass", () => {
  test("each line is written by the stream, then rewritten once by the recognizer the live Worker holds; no Qwen starts", async () => {
    const r = await rig.api("PATCH", "/config", {
      "asr.review.model": "parakeet",
      "dictation.enabled": false,
    });
    expect(r.status).toBe(200);
    const started = () => llama().filter((x) => x.argv !== undefined).length;
    const before = started();
    const id = await rig.startCall({});
    const status = async () => (await rig.api("GET", "/status")).body.live;
    await until(async () => (await status())?.setup != null, 10_000, "the live setup");
    expect((await status()).review).toEqual({ model: "parakeet", everySeconds: 60 });
    const segs = async () =>
      (await rig.app.events(id, 0)).filter((e: LogEvent): e is Seg => e.type === "seg");
    await until(
      async () => (await segs()).filter((s) => s.model === RECOGNIZER_MODEL).length >= 2,
      30_000,
      "both lines rewritten",
    );
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await status()) === null, 10_000, "the call's end");
    const byLine = new Map<string, string[]>();
    for (const s of await segs())
      byLine.set(s.id, [...(byLine.get(s.id) ?? []), `${s.rev} ${s.model}`]);
    const allowed = [[`1 ${STREAM}`], [`1 ${STREAM}`, `2 ${RECOGNIZER_MODEL}`]];
    for (const l of byLine.values()) expect(allowed).toContainEqual(l);
    expect(started()).toBe(before);
  });
});

describe("[ASR-7] review before a read, through the app", () => {
  test("GET transcript and POST context say how many lines are unreviewed with a pass on; review=skip and Off say nothing", async () => {
    await rig.api("PATCH", "/config", { "asr.review.model": "qwen", "dictation.enabled": false });
    const id = await rig.startCall({});
    const status = async () => (await rig.api("GET", "/status")).body.live;
    await until(async () => (await status())?.setup != null, 10_000, "the live setup");
    const segs = async () =>
      (await rig.app.events(id, 0)).filter((e: LogEvent): e is Seg => e.type === "seg");
    await until(async () => (await segs()).length >= 2, 15_000, "the lines");
    const read = await rig.api("GET", `/calls/${id}/transcript?format=json`);
    expect(read.status).toBe(200);
    expect(typeof read.body.unreviewed).toBe("number");
    const ctx = await rig.api("POST", `/calls/${id}/context`, { question: "what was said?" });
    expect(typeof ctx.body.unreviewed).toBe("number");
    const skip = await rig.api("GET", `/calls/${id}/transcript?format=json&review=skip`);
    expect("unreviewed" in skip.body).toBe(false);
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await status()) === null, 10_000, "the call's end");
    // Ended: the final pass owns it, and a read says nothing of a second pass.
    const after = await rig.api("GET", `/calls/${id}/transcript?format=json`);
    expect("unreviewed" in after.body).toBe(false);
    // Off: nothing either.
    await rig.api("PATCH", "/config", { "asr.review.model": "none" });
    const off = await rig.startCall({});
    await until(async () => (await status())?.setup != null, 10_000, "the live setup");
    const r = await rig.api("GET", `/calls/${off}/transcript?format=json`);
    expect("unreviewed" in r.body).toBe(false);
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await status()) === null, 10_000, "the call's end");
  });
});
