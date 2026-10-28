/**
 * A server with no speech engine (#436): the single-file `akou` CLI, which `bun build --compile`
 * builds without sherpa-onnx's native addon or the recognizer Workers, starts `akou serve` with
 * `noEngine`. It must say so up front instead of taking work it can never run: `/healthz` is 503
 * with `models_ready: false` and the reason, a job or a live session is refused at once with
 * `no_engine`, and the live recognizer never starts, so there is no Worker to die and respawn.
 * The compiled binary itself is checked the same way by `scripts/smoke-cli.ts`.
 *
 * Every refusal has its positive control: the same server with the engine takes the same requests.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { FinalAudioSpec } from "../src/main/asr/finalize-worker.ts";
import { NO_ENGINE_REASON } from "../src/main/cli/commands/serve.ts";
import { type AppRig, appRig, FAKE_MODELS, rawRequest } from "./api-helpers.ts";
import { logOf, until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";
import { clip, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function rig(noEngine: boolean): Promise<AppRig> {
  const r = await appRig({ settings: SERVER, ...(noEngine ? { noEngine: NO_ENGINE_REASON } : {}) });
  cleanups.push(() => r.close());
  return r;
}

async function health(r: AppRig) {
  const res = await fetch(`http://127.0.0.1:${r.port}/healthz`);
  return {
    status: res.status,
    body: (await res.json()) as { ok: boolean; models_ready: boolean; reason?: string },
  };
}

const UPGRADE = {
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-version": "13",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
};

async function openLive(r: AppRig, key: string) {
  return rawRequest(r.port, {
    method: "GET",
    path: "/v1/live",
    headers: { ...UPGRADE, authorization: `Bearer ${key}` },
  });
}

async function openai(r: AppRig, key: string) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(clip(["hello"], 1))], { type: "audio/wav" }),
    "a.wav",
  );
  form.append("model", "whisper-1");
  return fetch(`http://127.0.0.1:${r.port}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
}

describe("[#436] akou serve with no speech engine", () => {
  test("the reason names the image and the checkout command", () => {
    expect(NO_ENGINE_REASON).toContain("drumsergio/akou");
    expect(NO_ENGINE_REASON).toContain("bun src/main/cli/cli.ts serve");
  });

  test("/healthz is 503 with models_ready false and the reason; with the engine it is 200 and ready", async () => {
    const none = await rig(true);
    const h = await health(none);
    expect(h.status).toBe(503);
    expect(h.body.ok).toBe(false);
    expect(h.body.models_ready).toBe(false);
    expect(h.body.reason).toBe(NO_ENGINE_REASON);
    // Positive control: the same server with the engine is ready and says no reason.
    const engine = await rig(false);
    await until(async () => (await health(engine)).status === 200, 15_000, "healthz 200");
    const ok = await health(engine);
    expect(ok.body.models_ready).toBe(true);
    expect(ok.body.reason).toBeUndefined();
  });

  test("the live recognizer never starts: no Worker to die and respawn", async () => {
    const none = await rig(true);
    // `loading` is set the moment the live recognizer is made; with no engine it is never made.
    expect(none.app.recognizer()).toBe("unavailable");
    await Bun.sleep(200);
    expect(none.app.recognizer()).toBe("unavailable");
    expect(none.logs.some((l) => /live ASR worker died/.test(l.msg))).toBe(false);
    // Positive control: with the engine it loads.
    const engine = await rig(false);
    await until(() => engine.app.recognizer() === "ready", 15_000, "recognizer ready");
  });

  test("POST /v1/jobs is refused at once with 503 no_engine and no job is kept; with the engine it is 202", async () => {
    const none = await rig(true);
    const k = await newKey(none, "no-engine");
    const r = await submit(none, k.key, clip(["hello", "world"], 2));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("no_engine");
    expect(r.body.message).toBe(NO_ENGINE_REASON);
    const list = await fetch(`http://127.0.0.1:${none.port}/v1/jobs`, {
      headers: { authorization: `Bearer ${k.key}` },
    });
    expect(((await list.json()) as { jobs: unknown[] }).jobs).toEqual([]);
    // The OpenAI door is the same queue and is refused the same way.
    const o = await openai(none, k.key);
    expect(o.status).toBe(503);
    expect(((await o.json()) as { error: string }).error).toBe("no_engine");
    // Positive control: the same submit to a server with the engine is accepted.
    const engine = await rig(false);
    const ek = await newKey(engine, "engine");
    expect((await submit(engine, ek.key, clip(["hello", "world"], 2))).status).toBe(202);
  });

  test("GET /v1/live is refused before the upgrade with 503 no_engine; with the engine the socket opens", async () => {
    const none = await rig(true);
    const k = await newKey(none, "live-none");
    const r = await openLive(none, k.key);
    expect(r.status).toBe(503);
    const body = JSON.parse(r.body) as { error: string; message: string };
    expect(body.error).toBe("no_engine");
    expect(body.message).toBe(NO_ENGINE_REASON);
    // Positive control: with the engine the same request is upgraded and the socket opens.
    const engine = await rig(false);
    const ek = await newKey(engine, "live-engine");
    const ws = new WebSocket(`ws://127.0.0.1:${engine.port}/v1/live`, {
      headers: { authorization: `Bearer ${ek.key}` },
    } as unknown as string[]);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
    });
    ws.close();
    expect(opened).toBe(true);
  });

  test("the final-pass catch-up at start runs no Worker for an ended call; with the engine it runs", async () => {
    const home = tempDir("akou-noengine-final-");
    cleanups.push(async () => home.cleanup());
    // Unreadable for the first app, so its call ends with no final layer for the next start.
    let readable = false;
    const heard = () => concat(silence(0.4), speak(["hello"]), silence(0.4));
    const audio = ({ parts }: { parts: number[] }): FinalAudioSpec | null =>
      readable
        ? {
            kind: "module",
            path: FAKE_MODELS,
            options: {
              parts: Object.fromEntries(parts.map((p) => [p, { mic: heard(), call: heard() }])),
            },
          }
        : null;
    const first = await appRig({ home: home.dir, finalAudio: audio });
    const id = await first.startCall({ title: "Ended" });
    await first.api("POST", "/calls/live/stop");
    await until(
      async () => (await first.api("GET", `/calls/${id}`)).body.state === "ended",
      10_000,
      "the call ended",
    );
    expect((await first.api("GET", `/calls/${id}`)).body.final.state).toBe("failed");
    await first.close();
    readable = true;
    const models = { kind: "module" as const, path: FAKE_MODELS, model: "fake-parakeet" };
    const started = async (r: AppRig) =>
      (await logOf((await r.api("GET", `/calls/${id}`)).body.folder)).filter(
        (e) => e.type === "final.started",
      ).length;
    const none = await appRig({
      home: home.dir,
      finalAudio: audio,
      models,
      noEngine: NO_ENGINE_REASON,
    });
    const before = await started(none);
    // The catch-up runs behind the API: the positive control below finishes its pass in this time.
    await Bun.sleep(3_000);
    expect(await started(none)).toBe(before);
    expect((await none.api("GET", `/calls/${id}`)).body.final.state).toBe("failed");
    await none.close();
    // Positive control: the same start with the engine runs the pass to its end.
    const engine = await appRig({ home: home.dir, finalAudio: audio, models });
    cleanups.push(() => engine.close());
    await until(
      async () => (await engine.api("GET", `/calls/${id}`)).body.final.state === "done",
      20_000,
      "the catch-up pass with the engine",
    );
  });
});
