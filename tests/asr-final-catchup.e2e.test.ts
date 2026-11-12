/**
 * The final pass's catch-up at start (DESIGN 3.3): every ended call with no final layer gets its
 * pass, one at a time. Each pass loads its own models, so a backlog run side by side would hold
 * them all at once; SV-P10 made every recorded call readable, so the first start after it meets
 * every past call at once.
 */

import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_FILE } from "../src/core/log/writer.ts";
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

const home2 = tempDir("akou-catchup-failed-");
let rig2: AppRig | undefined;
afterAll(async () => {
  await rig2?.close();
  home2.cleanup();
});

test("[FN-1] a call whose last pass failed runs after a call that never had one, and still runs", async () => {
  let open = false;
  const audio2 = ({ parts }: { parts: number[] }): FinalAudioSpec | null =>
    open
      ? {
          kind: "module",
          path: FAKE_MODELS,
          options: {
            parts: Object.fromEntries(parts.map((p) => [p, { mic: heard(), call: heard() }])),
          },
        }
      : null;
  const first = await appRig({ home: home2.dir, finalAudio: audio2 });
  const record = async (title: string) => {
    const id = await first.startCall({ title });
    await first.api("POST", "/calls/live/stop");
    await until(
      async () => (await first.api("GET", `/calls/${id}`)).body.final.state === "failed",
      10_000,
      "the call's pass failed",
    );
    return { id, folder: (await first.api("GET", `/calls/${id}`)).body.folder as string };
  };
  // The older call: akou went away as it ended, so its log stops at call.ended, with no pass.
  const never = await record("Never finalized");
  // The newer one, which the start meets first, failed its pass.
  const retried = await record("Failed before");
  await first.close();
  const file = join(never.folder, EVENTS_FILE);
  const lines = readFileSync(file, "utf8").split("\n");
  const end = lines.findIndex((l) => l.includes('"type":"call.ended"'));
  expect(end).toBeGreaterThan(0);
  writeFileSync(file, `${lines.slice(0, end + 1).join("\n")}\n`);
  expect((await logOf(never.folder)).some((e) => e.type.startsWith("final."))).toBe(false);
  expect((await logOf(retried.folder)).some((e) => e.type === "final.failed")).toBe(true);

  open = true;
  // Slow speaker labels keep each pass running long enough for the order to show.
  rig2 = await appRig({
    home: home2.dir,
    finalAudio: audio2,
    models: {
      kind: "module",
      path: FAKE_MODELS,
      model: "fake-parakeet",
      options: { diarizeMs: 300 },
    },
  });
  const r = rig2;
  await until(
    async () => {
      const states = await Promise.all(
        [never, retried].map(
          async (c) => (await r.api("GET", `/calls/${c.id}`)).body.final.state as string,
        ),
      );
      return states.every((s) => s === "done");
    },
    30_000,
    "both catch-up passes",
  );
  const startedAt = async (folder: string) =>
    (await logOf(folder)).filter((e) => e.type === "final.started").at(-1)?.t as number;
  // The call with no pass went first, though the start met the failed one first.
  expect(await startedAt(never.folder)).toBeLessThan(await startedAt(retried.folder));
}, 60_000);
