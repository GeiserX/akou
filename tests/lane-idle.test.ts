/**
 * The dictation lane's Worker lets its model go when idle, like the queue's Workers do: an
 * interactive job loads Qwen and its llama-server into a lane Worker; after
 * `server.model_idle_minutes` with no job, that Worker and its llama-server go, and the server
 * is back near its baseline. `server.dictation_slots` defaults to 1, so every server has the lane.
 *
 * The positive control is the queue's Worker on the same rig: it goes after the idle minutes
 * (akou-5an.104), so the rig and the clock are sound.
 *
 * The idle minutes themselves are capped at a day: a config.json from before, holding a week,
 * still boots, on the default.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { buildSettings, resolvePaths } from "../src/main/config/schema.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";
import { asKey, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const NOTE = monoWav(concat(silence(0.3), speak(["hello", "world"]), silence(0.4)));

function starts(log: string): number {
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l && "argv" in JSON.parse(l)).length;
}

interface Rig {
  rig: AppRig;
  key: Key;
  log: string;
  clock: { t: number };
  done(): Promise<void>;
}

async function laneRig(slots: number): Promise<Rig> {
  const t = tempDir("akou-lane-idle-");
  const log = join(t.dir, "llama.log");
  const clock = { t: Date.UTC(2026, 9, 24, 12) };
  const rig = await appRig({
    settings: {
      ...SERVER,
      "asr.llamaServer": [process.execPath, FAKE_LLAMA, "--fake-log", log],
      "server.dictation_slots": slots,
    },
    jobs: {
      now: () => clock.t,
      decode: async (path, signal) => readUploadAudio(path, { signal }),
    },
  });
  const key = await newKey(rig, "archive");
  return {
    rig,
    key,
    log,
    clock,
    done: async () => {
      await rig.close();
      t.cleanup();
    },
  };
}

async function ended(r: Rig, id: string): Promise<void> {
  const a = await asKey(r.rig, r.key.key, "GET", `/jobs/${id}?wait=30`);
  expect(`${a.body.status} ${a.body.error?.message ?? ""}`).toBe("done ");
}

function llamaPid(r: Rig): number {
  const line = r.rig.logs.find((l) => / ready on port /.test(l.msg))?.msg as string;
  const pid = Number(/llama-server (\d+) ready/.exec(line)?.[1]);
  expect(pid).toBeGreaterThan(0);
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  return !r.stdout.toString().trim().startsWith("Z");
}

describe("the dictation lane's idle Worker lets its model go", () => {
  let r: Rig;
  afterEach(async () => r.done());

  test("positive control: a queued best job's Worker and llama-server go after the idle minutes", async () => {
    r = await laneRig(1);
    const s = await submit(r.rig, r.key.key, NOTE, { preset: "best" });
    expect(s.status).toBe(202);
    await ended(r, s.body.id as string);
    expect(starts(r.log)).toBe(1);
    expect(r.rig.app.jobs()?.loaded()).toEqual([QWEN_ASR]);
    const pid = llamaPid(r);
    r.clock.t += 11 * 60_000;
    r.rig.app.jobs()?.releaseIdle();
    expect(r.rig.app.jobs()?.loaded()).toEqual([]);
    await until(() => !alive(pid), 10_000, "llama-server to stop");
    expect(r.rig.logs.some((l) => l.msg.includes(`${QWEN_ASR} unloaded after 10 min`))).toBe(true);
  });

  test("an interactive best job's lane Worker and llama-server go after the idle minutes", async () => {
    r = await laneRig(1);
    const s = await submit(r.rig, r.key.key, NOTE, { preset: "best", interactive: "true" });
    expect(s.status).toBe(202);
    await ended(r, s.body.id as string);
    expect(starts(r.log)).toBe(1);
    expect(r.rig.app.jobs()?.loaded()).toEqual([QWEN_ASR]);
    const pid = llamaPid(r);
    // Before the idle period ends, the lane keeps its model (a dictation is answered warm).
    r.clock.t += 9 * 60_000;
    r.rig.app.jobs()?.releaseIdle();
    expect(r.rig.app.jobs()?.loaded()).toEqual([QWEN_ASR]);
    expect(alive(pid)).toBe(true);
    // After it, the lane Worker goes like the queue's: the model, the child process, the memory.
    r.clock.t += 2 * 60_000;
    r.rig.app.jobs()?.releaseIdle();
    expect(r.rig.app.jobs()?.loaded()).toEqual([]);
    await until(() => !alive(pid), 10_000, "the lane's llama-server to stop");
    expect(r.rig.logs.some((l) => l.msg.includes(`${QWEN_ASR} unloaded after 10 min`))).toBe(true);
  });
});

describe("the idle minutes are capped at a day", () => {
  test("a week in config.json is refused with a message and the default is used; a day is taken", () => {
    const paths = resolvePaths({ AKOU_HOME: "/t" });
    const week = buildSettings(
      paths,
      { "server.model_idle_minutes": 10080, "asr.modelIdleMinutes": 10080 },
      {},
    );
    expect(week.settings["server.model_idle_minutes"]).toBe(10);
    expect(week.settings["asr.modelIdleMinutes"]).toBe(5);
    expect(week.issues.map((i) => i.message)).toEqual([
      "server.model_idle_minutes: 10080 is out of range (0 to 1440); using the default",
      "asr.modelIdleMinutes: 10080 is out of range (0 to 1440); using the default",
    ]);
    // Positive control: the cap itself is still a valid value.
    const day = buildSettings(
      paths,
      { "server.model_idle_minutes": 1440, "asr.modelIdleMinutes": 1440 },
      {},
    );
    expect(day.issues).toEqual([]);
    expect(day.settings["server.model_idle_minutes"]).toBe(1440);
    expect(day.settings["asr.modelIdleMinutes"]).toBe(1440);
  });
});
