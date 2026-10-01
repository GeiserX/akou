/**
 * How far a final pass is, through the whole app: while the pass runs, `GET /status` lists it in
 * `finals[]` with the call's length and the model, `last.final` says running, `GET /calls/{id}`
 * has `final.progress`, and `akou status` prints a `Final:` line; once it is done, the figures go
 * and the line says ready with the model. The recognizer is the fake of asr-fake.ts, slowed on
 * every decode, so the pass is seen half way: one channel decoded, the other not yet.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { type AppRig, appRig, FAKE_MODELS, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

let rig: AppRig;
const home = tempDir("akou-final-progress-");

beforeAll(async () => {
  const wav = speechWav(home.dir);
  rig = await appRig({
    helperArgs: ["--wav", wav],
    // In a Worker, so the slow decodes hold the pass, not the API.
    asrInThread: false,
    models: {
      kind: "module",
      path: FAKE_MODELS,
      model: "fake-parakeet",
      options: { slowMs: 2500 },
    },
    finalAudio: ({ parts }) => ({
      kind: "wav",
      files: Object.fromEntries(parts.map((p) => [p, wav])),
    }),
  });
  await until(() => rig.app.recognizer() === "ready", 20_000, "the recognizer");
});

afterAll(async () => {
  await rig?.close();
  home.cleanup();
});

describe("a final pass's progress", () => {
  test("running: in the status, the call and akou status; done: the figures go and the line says ready", async () => {
    const id = await rig.startCall({});
    await until(
      async () => (await rig.app.events(id, 0)).some((e: LogEvent) => e.type === "seg"),
      20_000,
      "a line",
    );
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    // Inside the pass: the mic channel decoded, the call channel's piece still decoding.
    const inside = (f?: { done_s: number; total_s: number }) =>
      f !== undefined && f.done_s > 0 && f.done_s < f.total_s;
    await until(
      async () => inside((await rig.api("GET", "/status")).body.finals?.[0]),
      30_000,
      "a figure inside the pass",
    );
    const st = (await rig.api("GET", "/status")).body;
    expect(st.finals).toEqual([
      { call: id, done_s: expect.any(Number), total_s: expect.any(Number), model: "fake-parakeet" },
    ]);
    expect(st.last.final).toMatchObject({ state: "running", model: "fake-parakeet" });
    expect((await rig.api("GET", `/calls/${id}`)).body.final.progress).toMatchObject({
      model: "fake-parakeet",
    });
    const cli = rigCli(rig);
    expect((await cli(["status"])).out).toMatch(/Final: running, \d+ of \d+ s/);

    await until(
      async () => (await rig.app.events(id, 0)).some((e: LogEvent) => e.type === "final.done"),
      30_000,
      "final.done",
    );
    await until(
      async () => (await rig.api("GET", "/status")).body.finals.length === 0,
      5_000,
      "the figures to go",
    );
    expect((await rig.api("GET", `/calls/${id}`)).body.final).toMatchObject({
      state: "done",
      model: "fake-parakeet",
      progress: null,
    });
    expect((await cli(["status"])).out).toContain("Final: ready (");
    const json = JSON.parse((await cli(["status", "--json"])).out);
    expect(json.last.final).toMatchObject({ state: "done", done_s: null, total_s: null });
  });
});
