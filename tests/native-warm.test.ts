/**
 * TRAPS "A Worker's first native load stops the main thread": on Windows the recognizer Worker
 * first loads sherpa-onnx-node in a child process, so its own load is warm and the main thread
 * never waits on the loader lock (src/main/asr/native-warm.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WARM_TIMEOUT_MS, warmNativeLoad } from "../src/main/asr/native-warm.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "addon-load-stall.ts");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("[G2] a Worker's first native load leaves the main thread running", () => {
  test("off Windows nothing is spawned; on Windows the addon loads first in a child of this runtime", () => {
    const calls: { cmd: string; args: string[]; o: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], o: unknown) =>
      calls.push({ cmd, args, o: o as Record<string, unknown> });
    for (const platform of ["darwin", "linux"]) {
      expect(warmNativeLoad("C:\\a\\b.node", { platform, spawn })).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(warmNativeLoad("C:\\a\\b.node", { platform: "win32", spawn, execPath: "bun.exe" })).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("bun.exe");
    expect(calls[0]?.args).toEqual(["-e", 'require("C:\\\\a\\\\b.node")']);
    expect(calls[0]?.o).toMatchObject({ stdio: "ignore", timeout: WARM_TIMEOUT_MS });
    expect(calls[0]?.o.env).toMatchObject({ BUN_BE_BUN: "1" });
  });

  // The first load of a freshly written DLL is the slow one, so every run gets its own copy of the
  // addon's files, as after an install. On a Windows runner a cold load took 0.1 to 1.7 s, and the
  // main thread waited that long in 111 of 120 runs; with the child first, 0 of 120 (worst 15 ms).
  test("on fresh copies of the addon, the main thread never waits 50 ms; without the child it does", () => {
    if (process.platform !== "win32") {
      expect(warmNativeLoad("x")).toBe(false);
      return;
    }
    const pkg = dirname(createRequire(import.meta.url).resolve("sherpa-onnx-win-x64/package.json"));
    // On the system drive, where an app is installed: the check points TEMP at the runner's faster
    // D: drive, where a first load is too quick to show the stall.
    const base = join(process.env.LOCALAPPDATA ?? tmpdir(), "Temp");
    const run = (warm: boolean) => {
      const dir = mkdtempSync(join(base, "akou-native-"));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      cpSync(pkg, dir, { recursive: true });
      const r = spawnSync(
        process.execPath,
        [FIXTURE, join(dir, "sherpa-onnx.node"), warm ? "1" : "0"],
        {
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as {
        maxGapMs: number;
        loadMs: number;
      };
    };
    for (let i = 0; i < 3; i++) expect(run(true).maxGapMs).toBeLessThan(50);
    // Positive control: the same first load with no child stops the main thread at least once in
    // five fresh copies (each did 9 times in 10 on a runner).
    const cold = Array.from({ length: 5 }, () => run(false));
    expect(Math.max(...cold.map((r) => r.maxGapMs))).toBeGreaterThanOrEqual(50);
  }, 180_000);
});
