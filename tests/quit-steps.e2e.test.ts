/**
 * The quit always finishes (#351, docs/TRAPS.md "A quit that stops on one step").
 *
 * On Linux, `akou quit` after a hotkey stop once logged `quitting`, then the call's `ended`, and
 * nothing more: no `quit` line, `runtime.json` left behind, the app alive. Two things made that
 * possible, and each test below goes red on the code before the fix:
 *
 * - A call still stopping when the quit began (its live recognizer still flushing) was not waited
 *   for: the quit closed the recognizer under it, and the call ended in the middle of the teardown.
 * - Every step of the teardown was awaited with no deadline and no guard. Inside ElectroBun an
 *   error that nobody handles is only printed, so one step that threw or never settled left the
 *   app running with its `runtime.json`, and nothing in `app.log` said which.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { LogEvent } from "../src/core/log/events.ts";
import { realClock, withDeadline } from "../src/main/capture/engine.ts";
import type { WindowShell } from "../src/main/index.ts";
import { appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";

const LONG = 30_000;
/** Each step's budget in these tests; the real one is seconds. */
const STEP_MS = 200;
/** What a quit gets here before the test calls it hung, well under the test's own timeout. */
const QUIT_BOUND_MS = 5_000;

const quitWithin = async (quit: Promise<void>): Promise<"quit" | "hung"> => {
  const r = await withDeadline(realClock, quit, QUIT_BOUND_MS);
  return r.ok ? "quit" : "hung";
};

describe("[T2.51] Quit untested / A quit that stops on one step (#351)", () => {
  test(
    "a call still stopping when the quit begins ends before the live recognizer is closed",
    async () => {
      const rig = await appRig();
      try {
        await until(() => rig.app.recognizer() === "ready", 20_000, "the recognizer");
        const id = await rig.startCall();
        const asr = rig.app.asr;
        if (!asr) throw new Error("the rig has no live recognizer");
        // The live recognizer's flush before `call.ended` answers only when the test says so.
        let release = () => {};
        const held = new Promise<void>((r) => {
          release = r;
        });
        asr.flush = () => held;
        const ended = async () =>
          (await rig.app.events(id, 0)).some((e: LogEvent) => e.type === "call.ended");
        let endedAtClose: boolean | null = null;
        const close = asr.close.bind(asr);
        asr.close = async () => {
          endedAtClose = await ended();
          return close();
        };
        // The hotkey's stop: the shell calls the manager and does not wait for the quit.
        const stopping = rig.app.manager.stop(id);
        await until(
          async () => (await rig.app.events(id, 0)).some((e: LogEvent) => e.type === "part.ended"),
          10_000,
          "the part to end",
        );
        expect(await ended()).toBe(false);
        const quit = rig.app.quit();
        setTimeout(release, 300);
        expect(await quitWithin(quit)).toBe("quit");
        expect((await stopping).ok).toBe(true);
        // The call ended on its own flush, and the recognizer was closed after it.
        expect(endedAtClose === true).toBe(true);
      } finally {
        await rig.close();
      }
    },
    LONG,
  );

  test(
    "a step that never settles is logged by name and the quit finishes without it",
    async () => {
      const never = () => new Promise<void>(() => {});
      // Positive control: the fixture's close really never settles.
      expect((await withDeadline(realClock, never(), STEP_MS)).ok).toBe(false);
      const shell: WindowShell = { show: () => {}, close: never };
      const rig = await appRig({ window: async () => shell, quitStepMs: STEP_MS });
      await rig.app.openWindow();
      const runtime = rig.app.runtimeFile;
      expect(existsSync(runtime)).toBe(true);
      const r = await quitWithin(rig.app.quit());
      expect(r).toBe("quit");
      expect(existsSync(runtime)).toBe(false);
      expect(
        rig.logs.some((l) => l.level === "warn" && /quit: the window .*did not finish/.test(l.msg)),
      ).toBe(true);
      if (r === "quit") await rig.close();
    },
    LONG,
  );

  test(
    "a step that throws is logged by name and the quit still removes runtime.json and ends",
    async () => {
      const rig = await appRig({ quitStepMs: STEP_MS });
      const server = rig.app.server;
      if (!server) throw new Error("the rig has no API server");
      const stop = server.stop.bind(server);
      server.stop = async () => {
        await stop();
        throw new Error("the listener failed on purpose");
      };
      const runtime = rig.app.runtimeFile;
      const quit = rig.app.quit();
      // An unhandled rejection would leave the quit half done: the test sees it as hung.
      const r = await quitWithin(quit.catch(() => new Promise<void>(() => {})));
      expect(r).toBe("quit");
      expect(existsSync(runtime)).toBe(false);
      expect((await withDeadline(realClock, rig.app.closed, STEP_MS)).ok).toBe(true);
      expect(
        rig.logs.some(
          (l) => l.level === "warn" && /quit: the API .*the listener failed on purpose/.test(l.msg),
        ),
      ).toBe(true);
      if (r === "quit") await rig.close();
    },
    LONG,
  );
});
