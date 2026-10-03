/**
 * SV-S2: the server's own defaults for language and speaker labels, used when a request has no
 * opinion. Telegram-Archive sends `language: auto` and never sends `diarize`, so these two
 * settings are how akou's owner decides for it. A request that names a language, or sends
 * `diarize` at all, still wins.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type AppRig, appRig } from "./api-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { asKey, clip, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

let rig: AppRig;
let key: Key;

const NOTE = clip(["hello", "world"], 3);
const TWO = monoWav(
  concat(
    silence(0.4),
    speak(["hello", "world"]),
    silence(0.8),
    speak(["ok", "great"], { voice: 2 }),
    silence(0.6),
  ),
);

beforeAll(async () => {
  rig = await appRig({ settings: SERVER });
  key = await newKey(rig, "archive");
});

afterAll(async () => {
  await rig?.close();
});

async function done(fields: Record<string, string>, file = NOTE) {
  const s = await submit(rig, key.key, file, fields);
  expect(s.status).toBe(202);
  const j = await asKey(rig, key.key, "GET", `/jobs/${s.body.id}?wait=60`);
  expect(j.body.status).toBe("done");
  const r = await asKey(rig, key.key, "GET", `/jobs/${s.body.id}/result`);
  return { job: j.body, result: r.body };
}

function speakers(result: { segments: { speaker: string | null }[] }): Set<string | null> {
  return new Set(result.segments.map((s) => s.speaker));
}

describe("SV-S2: server defaults for language and speaker labels", () => {
  test("server.default_language fills in for `auto` and for no language; a named one wins", async () => {
    const set = await rig.api("PATCH", "/config", { "server.default_language": "es" });
    expect(set.status).toBe(200);
    expect((await done({ language: "auto" })).job.language).toBe("es");
    expect((await done({})).job.language).toBe("es");
    expect((await done({ language: "en" })).job.language).toBe("en");
    // Positive control: back at `auto`, the job asks for detection.
    await rig.api("PATCH", "/config", { "server.default_language": "auto" });
    expect((await done({ language: "auto" })).job.language).toBe("auto");
  });

  test("server.default_diarize labels speakers when the request has no diarize field; diarize: false stays false", async () => {
    // Positive control first: with the default off, no labels.
    expect(speakers((await done({}, TWO)).result).has(null)).toBe(true);
    const set = await rig.api("PATCH", "/config", { "server.default_diarize": true });
    expect(set.status).toBe(200);
    const on = await done({}, TWO);
    expect(on.job.diarize).toBe(true);
    expect(speakers(on.result).size).toBe(2);
    expect(speakers(on.result).has(null)).toBe(false);
    const off = await done({ diarize: "false" }, TWO);
    expect(off.job.diarize).toBe(false);
    expect(speakers(off.result).has(null)).toBe(true);
    await rig.api("PATCH", "/config", { "server.default_diarize": false });
  });

  test("[akou-5an.97] GET /v1/server reports server.default_diarize, and follows a change", async () => {
    const reported = async () => (await rig.api("GET", "/server")).body.default_diarize;
    expect(await reported()).toBe(false);
    await rig.api("PATCH", "/config", { "server.default_diarize": true });
    try {
      expect(await reported()).toBe(true);
    } finally {
      await rig.api("PATCH", "/config", { "server.default_diarize": false });
    }
  });

  test("an invalid language tag is refused by PATCH /v1/config and nothing changes", async () => {
    const bad = await rig.api("PATCH", "/config", { "server.default_language": "not a tag" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_setting");
    expect(bad.body.message).toContain("server.default_language");
    const cfg = await rig.api("GET", "/config");
    expect(cfg.body.settings["server.default_language"]).toBe("auto");
    expect(cfg.body.settings["server.default_diarize"]).toBe(false);
  });
});

describe("SV-K1: the auto preset in GET /v1/server", () => {
  const auto = async () =>
    ((await rig.api("GET", "/server")).body.presets as { name: string }[]).find(
      (p) => p.name === "auto",
    );

  test("it names what it resolves to, and is available when that is", async () => {
    // A job on auto runs fast here, so auto is available and says fast.
    expect(await auto()).toMatchObject({ available: true, resolves_to: "fast" });
    const job = await done({ preset: "auto" });
    expect(job.job.preset).toBe("fast");
    try {
      // server.default_model moves it: auto then runs best, and is available exactly when best is.
      await rig.api("PATCH", "/config", { "server.default_model": "best" });
      const presets = (await rig.api("GET", "/server")).body.presets as {
        name: string;
        available: boolean;
      }[];
      const best = presets.find((p) => p.name === "best");
      expect(await auto()).toMatchObject({ available: best?.available, resolves_to: "best" });
      // Positive control: a default that refuses every job (an unbuilt preset) leaves auto
      // unavailable, resolving to nothing.
      await rig.api("PATCH", "/config", { "server.default_model": "lite" });
      expect(await auto()).toMatchObject({ available: false, resolves_to: null });
    } finally {
      await rig.api("PATCH", "/config", {
        "server.default_model": "auto",
      });
    }
  });
});
