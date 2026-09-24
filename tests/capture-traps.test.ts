/**
 * Capture and call traps against a real child process: `scripts/fake-helper.ts` speaking
 * `akou-capture/1`, spawned, stopped and killed through `AkouCaptureEngine` exactly as the app
 * spawns the Rust helper. The scenarios live in tests/capture-scenarios.ts, which
 * tests/capture-rust.e2e.test.ts runs against the Rust helper too.
 */

import { describe, expect, test } from "bun:test";
import { akouCaptureDialect, ChildCaptureSession } from "../src/main/capture/helper.ts";
import {
  captureTrapScenarios,
  fakeHelper,
  LONG,
  rig,
  useRigCleanups,
} from "./capture-scenarios.ts";

useRigCleanups();
captureTrapScenarios(fakeHelper);

describe("a helper that is not a helper", () => {
  test(
    "a helper that writes garbage on stdout is killed; the start fails, nothing is trusted",
    async () => {
      const script =
        "process.stdout.write('not a packet stream at all, just text'); await Bun.sleep(30000);";
      const r = rig(fakeHelper, () => ({}), { coldStartMs: 1_500 }, [
        process.execPath,
        "-e",
        script,
      ]);
      const res = await r.mgr.start({ workspace: "work" });
      expect(res).toMatchObject({ ok: false, status: 503, stage: "open" });
      if (res.ok) throw new Error("unreachable");
      expect(res.error).toContain("protocol error");
    },
    LONG,
  );
});

describe("a helper's last stderr line", () => {
  /**
   * A helper that exits at once while a process it started still holds its stderr and writes the
   * `stopped` line `delayMs` later: the exit is noticed before the pipe has drained.
   */
  function lateStopped(delayMs: number) {
    const line = JSON.stringify({ type: "stopped", file_seconds: 7.5, reason: "stop" });
    const grandchild = `setTimeout(() => process.stderr.write(${JSON.stringify(`${line}\n`)}), ${delayMs})`;
    const child = [
      'const { spawn } = require("node:child_process");',
      `const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "ignore", "inherit"], detached: true });`,
      "g.unref();",
      "process.exit(0);",
    ].join("\n");
    const session = new ChildCaptureSession(
      { argv: [process.execPath, "-e", child] },
      { packet: () => {}, message: () => {}, exit: () => {} },
      akouCaptureDialect,
    );
    const t0 = performance.now();
    return session.exited.then((exit) => ({ exit, ms: performance.now() - t0 }));
  }

  test(
    "a `stopped` line written just after the helper exits is still read",
    async () => {
      const { exit } = await lateStopped(100);
      expect(exit.code).toBe(0);
      expect(exit.stopped).toEqual({ fileSeconds: 7.5, reason: "stop" });
    },
    LONG,
  );

  test(
    "positive control: a pipe held open for long never delays the exit past the drain grace",
    async () => {
      const { exit, ms } = await lateStopped(5_000);
      expect(exit.stopped).toBeUndefined();
      expect(ms).toBeLessThan(3_000);
    },
    LONG,
  );
});
