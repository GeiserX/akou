/**
 * `asr.warmAtStart` (#378) as the app runs it: the memory it reads, and the load the entry point
 * asks for once the window and the tray are up. The policy itself (thresholds, the minute check, a
 * call during the load) is tested on the live Worker in `asr-live.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import {
  availableMemory,
  fromMeminfo,
  fromStatusLevel,
  WARM_MIN_FREE,
} from "../src/main/asr/start-warm.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";

const GB = 1024 ** 3;

describe("the memory asr.warmAtStart reads", () => {
  test("[T4.36] on macOS it is the kernel's available memory, not os.freemem's free pages", () => {
    // `sysctl -n kern.memorystatus_level` on a 24 GB Mac whose os.freemem() read 0.19 GB.
    expect(fromStatusLevel("38\n", 24 * GB)).toBeCloseTo(0.38 * 24 * GB, 0);
    expect(fromStatusLevel("", 24 * GB)).toBeNull();
    expect(fromStatusLevel("0\n", 24 * GB)).toBeNull();
    const meminfo =
      "MemTotal:       16314564 kB\nMemFree:          412300 kB\nMemAvailable:    9876544 kB\n";
    expect(fromMeminfo(meminfo)).toBe(9876544 * 1024);
    expect(fromMeminfo("MemFree: 412300 kB\n")).toBeNull();
    // This machine: the figure its own platform gives, read here the same way.
    const here = availableMemory();
    if (process.platform === "darwin") {
      const level = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.memorystatus_level"]);
      const want = fromStatusLevel(level.stdout.toString(), totalmem()) as number;
      expect(Math.abs(here - want)).toBeLessThan(0.02 * totalmem());
    } else if (process.platform === "linux") {
      const want = fromMeminfo(readFileSync("/proc/meminfo", "utf8")) as number;
      expect(Math.abs(here - want)).toBeLessThan(0.02 * totalmem());
    } else {
      expect(Math.abs(here - freemem())).toBeLessThan(0.02 * totalmem());
    }
  });
});

describe("the app loads the live recognizer at start", () => {
  let rig: AppRig | null = null;
  afterEach(async () => {
    await rig?.close();
    rig = null;
  });

  type Status = { asr?: { loads?: Record<string, number> } };
  const parakeet = async (r: AppRig) =>
    ((await r.api("GET", "/status")).body as Status).asr?.loads?.["fake-parakeet"] ?? 0;

  test("asked by the entry point with 8 GB available, it loads Parakeet and logs the RSS around it", async () => {
    const r = await appRig({ availableMemory: () => 8 * GB });
    rig = r;
    // Nothing loads it before the entry point asks.
    expect(await parakeet(r)).toBe(0);
    r.app.warmAtStart();
    await until(async () => (await parakeet(r)) === 1, 5000, "the load at start");
    await until(
      () =>
        r.logs.some((l) => /^asr: the live recognizer loaded at start in \d+ ms, RSS /.test(l.msg)),
      5000,
      "the RSS line",
    );
    // Asked again (models that landed later ask too): nothing loads twice.
    r.app.warmAtStart();
    expect(await parakeet(r)).toBe(1);
  });

  test("with less than 4 GB available, auto loads nothing and says why", async () => {
    const r = await appRig({ availableMemory: () => WARM_MIN_FREE / 2 });
    rig = r;
    r.app.warmAtStart();
    expect(r.logs.map((l) => l.msg)).toContain(
      "asr: the live recognizer is not loaded at start: 2.0 GB of memory available, under 4.0 GB",
    );
    expect(await parakeet(r)).toBe(0);
  });
});
