/**
 * PG-S5 (docs/ux/PROGRAMMABILITY.md section 4): `akou wait [CALL] --for final.done|enhanced|exported
 * [--timeout 30m]` blocks until the stage and exits 0, exits 70 when the stage failed and 124 on
 * timeout. Driven through the CLI against a headless app with the fake helper and a fake final
 * pass whose words differ from the live ones, so the final layer is visible in `akou show`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageAfter } from "../src/main/cli/commands/wait.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;

let rig: AppRig;
let dir: { dir: string; cleanup: () => void };
let akou: ReturnType<typeof rigCli>;
/** Calls whose final pass is made to fail: its audio file does not exist. */
const failing = new Set<string>();

beforeAll(async () => {
  dir = tempDir();
  const mic = concat(silence(0.3), speak(["hello", "world"]), silence(2));
  const call = concat(silence(1.1), speak(["ok", "great"], { voice: 2 }), silence(1.2));
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
  const wav = join(dir.dir, "speech.wav");
  writeFileSync(wav, stereoWav(pad(mic), pad(call)));
  rig = await appRig({
    helperArgs: ["--wav", wav],
    finalAudio: ({ id, parts }) =>
      failing.has(id)
        ? {
            kind: "wav",
            files: Object.fromEntries(parts.map((p) => [p, join(dir.dir, "gone.wav")])),
          }
        : {
            kind: "module",
            path: FAKE_MODELS,
            options: {
              parts: Object.fromEntries(
                parts.map((p) => [
                  p,
                  {
                    mic: concat(silence(0.3), speak(["thanks", "meeting", "today"]), silence(1)),
                    call: concat(silence(1.8), speak(["yes", "build"], { voice: 2 }), silence(0.5)),
                  },
                ]),
              ),
            },
          },
  });
  akou = rigCli(rig);
});

afterAll(async () => {
  await rig?.close();
  dir?.cleanup();
});

/** Starts a call and waits until the live recognizer has written a line. */
async function liveCall(): Promise<string> {
  const id = await rig.startCall({ title: "Wait test" });
  await until(
    async () => (await rig.api("GET", `/calls/${id}/transcript`)).body.lines.length > 0,
    10_000,
    "a live line",
  );
  return id;
}

describe("[PG-S5] akou wait", () => {
  test(
    "`akou stop && akou wait --for final.done && akou show last` prints the final layer",
    async () => {
      const id = await liveCall();
      const live = await akou(["show", "last"]);
      expect(live.out).toContain("hello world");
      expect((await akou(["stop"])).code).toBe(0);
      const t0 = Date.now();
      const w = await akou(["wait", "--for", "final.done"]);
      expect([w.code, w.err]).toEqual([0, ""]);
      expect(w.out).toBe(`${id}: final.done`);
      expect(Date.now() - t0).toBeLessThan(15_000);
      const show = await akou(["show", "last"]);
      expect(show.code).toBe(0);
      expect(show.out).toContain("thanks meeting today");
      expect(show.out).not.toContain("hello world");
      // Reached already: a second wait returns at once, and --json says which event.
      const again = await akou(["wait", id, "--for", "final.done", "--json"]);
      expect(again.code).toBe(0);
      expect(again.json).toMatchObject({ call: id, stage: "final.done", state: "done" });
      expect(again.json.event.type).toBe("final.done");
    },
    LONG,
  );

  test(
    "a forced final-pass failure exits 70 and names the step",
    async () => {
      const id = await liveCall();
      failing.add(id);
      expect((await akou(["stop"])).code).toBe(0);
      const w = await akou(["wait", "--for", "final.done", "--timeout", "15s"]);
      expect(w.code).toBe(70);
      expect(w.err).toMatch(/^akou wait: the final pass failed at \S+: /);
      expect((await rig.api("GET", `/calls/${id}`)).body.final.state).toBe("failed");
    },
    LONG,
  );

  test(
    "a stage that never comes exits 124 at the timeout; one reached later exits 0",
    async () => {
      // No export.dir and no notes: neither stage comes on its own.
      const t0 = Date.now();
      const ex = await akou(["wait", "last", "--for", "exported", "--timeout", "1s"]);
      expect(ex.code).toBe(124);
      expect(ex.err).toContain("no exported for");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
      expect(Date.now() - t0).toBeLessThan(10_000);
      const en = await akou(["wait", "--for", "enhanced", "--timeout", "1s", "--json"]);
      expect(en.code).toBe(124);
      expect(en.json).toMatchObject({ stage: "enhanced", state: "timeout" });
      // Notes written while it waits end the wait with 0.
      const last = (await rig.api("GET", "/calls/last")).body;
      const waiting = akou(["wait", "--for", "enhanced", "--timeout", "20s"]);
      await new Promise((r) => setTimeout(r, 300));
      const seg = (await rig.api("GET", `/calls/${last.id}/transcript`)).body.lines[0].id;
      const put = await rig.api("PUT", `/calls/${last.id}/enhanced`, {
        markdown: `- The team met [#${seg}]`,
        coversSeq: last.cursor,
      });
      expect(put.status).toBe(200);
      const done = await waiting;
      expect([done.code, done.out]).toEqual([0, `${last.id}: enhanced`]);
    },
    LONG,
  );

  test("usage: --for is required and must name a stage", async () => {
    expect((await akou(["wait"])).code).toBe(64);
    const bad = await akou(["wait", "--for", "final"]);
    expect(bad.code).toBe(64);
    expect(bad.err).toContain("final.done, enhanced, exported");
    expect((await akou(["wait", "--for", "final.done", "--timeout", "soon"])).code).toBe(64);
    expect((await akou(["wait", "no-such-call", "--for", "final.done"])).code).not.toBe(0);
  });

  test("stageAfter: a re-run of the final pass waits again; a failed call fails every stage", () => {
    const pending = { state: "pending" } as const;
    const done = stageAfter("final.done", pending, [{ type: "final.done" }]);
    expect(done.state).toBe("done");
    expect(stageAfter("final.done", done, [{ type: "final.started" }]).state).toBe("pending");
    expect(stageAfter("final.done", pending, [{ type: "final.failed" }]).state).toBe("failed");
    for (const s of ["final.done", "enhanced", "exported"] as const) {
      expect(stageAfter(s, pending, [{ type: "call.failed" }]).state).toBe("failed");
    }
    // Positive control: other stages' events do not end a wait.
    expect(stageAfter("exported", pending, [{ type: "final.done" }, { type: "enhanced" }])).toEqual(
      pending,
    );
    expect(stageAfter("enhanced", pending, [{ type: "export.done" }]).state).toBe("pending");
    expect(stageAfter("exported", pending, [{ type: "export.done" }]).state).toBe("done");
  });
});
