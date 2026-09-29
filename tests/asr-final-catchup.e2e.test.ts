/**
 * The final pass's catch-up at start (DESIGN 3.3): every ended call with no final layer gets its
 * pass, one at a time. Each pass loads its own models, so a backlog run side by side would hold
 * them all at once; SV-P10 made every recorded call readable, so the first start after it meets
 * every past call at once.
 */

import { afterAll, expect, test } from "bun:test";
import type { FinalAudioSpec } from "../src/main/asr/finalize-worker.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { logOf, until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";

const home = tempDir("akou-catchup-");
let rig: AppRig | undefined;
afterAll(async () => {
  await rig?.close();
  home.cleanup();
});

/** Readable only once `readable` is set: the first app records calls it cannot finalize. */
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

test("a start with three unfinalized calls runs their passes one at a time, and all of them", async () => {
  const first = await appRig({ home: home.dir, finalAudio: audio });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = await first.startCall({ title: `Call ${i + 1}` });
    await first.api("POST", "/calls/live/stop");
    await until(
      async () => (await first.api("GET", `/calls/${id}`)).body.state === "ended",
      10_000,
      "the call ended",
    );
    ids.push(id);
  }
  // The pass could not read them: failed, so the next start runs it again.
  for (const id of ids)
    expect((await first.api("GET", `/calls/${id}`)).body.final.state).toBe("failed");
  await first.close();

  readable = true;
  // Slow speaker labels keep each pass running long enough for an overlap to show.
  rig = await appRig({
    home: home.dir,
    finalAudio: audio,
    models: {
      kind: "module",
      path: FAKE_MODELS,
      model: "fake-parakeet",
      options: { diarizeMs: 700 },
    },
  });
  const r = rig;
  await until(
    async () => {
      const states = await Promise.all(
        ids.map(async (id) => (await r.api("GET", `/calls/${id}`)).body.final.state as string),
      );
      return states.every((s) => s === "done");
    },
    30_000,
    "every catch-up pass",
  );
  // Each call's catch-up pass, from its final.started to its final.done, in the log.
  const spans = await Promise.all(
    ids.map(async (id) => {
      const events = await logOf((await r.api("GET", `/calls/${id}`)).body.folder);
      const started = events.filter((e) => e.type === "final.started").at(-1)?.t as number;
      const done = events.filter((e) => e.type === "final.done").at(-1)?.t as number;
      return { started, done };
    }),
  );
  spans.sort((x, y) => x.started - y.started);
  // No pass starts before the one before it is done.
  for (let i = 1; i < spans.length; i++)
    expect(spans[i]?.started).toBeGreaterThanOrEqual(spans[i - 1]?.done as number);
}, 60_000);
