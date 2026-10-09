/**
 * The dictation doors through a whole app (docs/ux/DICTATION.md DC-G1, DC-G3, DC-H2, DC-R4): the
 * live session driven over the API and the CLI as the tray and a compositor binding drive it,
 * `GET /v1/dictation`, deleting dictations, and the remote's Test. The app runs the fake helper
 * (`session.start`, `session.stop`, `session.cancel`) and the fake engine; nothing opens a device,
 * presses a key or touches the clipboard: the fake inserter writes what it would have inserted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dictationLatency } from "../src/main/dictation/latency.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cli, rigCli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function scratch(): string {
  const t = tempDir("akou-dict-doors-");
  cleanups.push(t.cleanup);
  return t.dir;
}

interface Rig extends AppRig {
  commands: string;
  inserted: string;
}

/** An app with dictation on, over the fake helper with "hello" on the mic from the start. */
async function rig(settings: Record<string, unknown> = {}, extra: string[] = []): Promise<Rig> {
  const dir = scratch();
  const wav = join(dir, "mic.wav");
  writeFileSync(wav, monoWav(concat(speak(["hello"]), silence(3))));
  const commands = join(dir, "commands.jsonl");
  const inserted = join(dir, "inserted.jsonl");
  const r = await appRig({
    helperArgs: ["--wav", wav, "--commands-log", commands, "--inserter-log", inserted, ...extra],
    settings: { "dictation.enabled": true, ...settings },
  });
  cleanups.push(() => r.close());
  if (settings["dictation.enabled"] !== false) {
    await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
  }
  return { ...r, commands, inserted };
}

const items = async (r: AppRig) => (await r.api("GET", "/dictations")).body.items;

describe("DC-G1: GET /v1/dictation", () => {
  test("on: the state, the engine and what the helper reports", async () => {
    const r = await rig();
    const res = await r.api("GET", "/dictation");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      state: "idle",
      engine: "fast",
      // The default, live, waits for a streaming model; until one is on disk, Parakeet (DC-E7).
      verdict: "fast: no streaming model is downloaded for live",
      final: "parakeet",
      live: null,
      loading: false,
      fallback: null,
      remote: null,
      grants: { mic: "granted", accessibility: "granted" },
      lost: [],
      backend: "fake",
      swallow_keys: true,
      latency: dictationLatency(),
      // A retry can use only the engines whose model is here: fast's.
      engines: ["fast"],
    });
  });

  test("off: enabled false, state off, and the grants a probe of the helper reads (DC-U2)", async () => {
    const r = await rig({ "dictation.enabled": false }, ["--grants", "mic"]);
    const res = await r.api("GET", "/dictation");
    expect(res.body).toMatchObject({
      enabled: false,
      state: "off",
      grants: { mic: "granted", accessibility: "denied" },
    });
    // The probe started no helper: dictation is still off and no key is taken.
    expect(r.app.dictation()?.status()).toMatchObject({ enabled: false, state: "off" });
    expect(existsSync(r.commands)).toBe(false);
  });

  test("the remote engine shows its fallback and standing", async () => {
    const r = await rig({
      "dictation.engine": "remote",
      "dictation.remote.url": "http://127.0.0.1:9",
    });
    const res = await r.api("GET", "/dictation");
    expect(res.body).toMatchObject({
      engine: "remote",
      fallback: "local",
      remote: { url: "http://127.0.0.1:9", down: false, failures: 0 },
    });
  });
});

describe("DC-G1: the live session over the API", () => {
  test("start, then stop: the audio is transcribed and inserted where it began", async () => {
    const r = await rig();
    const start = await r.api("POST", "/dictation/start");
    expect(start.status).toBe(200);
    expect(start.body).toEqual({ state: "listening" });
    // The fake's mic runs in real time from the start: let "hello" be spoken before the stop.
    await Bun.sleep(1000);
    const stop = await r.api("POST", "/dictation/stop");
    expect(stop.status).toBe(200);
    await until(() => lines(r.inserted).length === 1, 10_000, "the insert");
    expect(lines(r.inserted)[0]).toMatchObject({ type: "insert", text: "hello" });
    const kinds = lines(r.commands).map((c) => c.type);
    expect(kinds).toContain("session.start");
    expect(kinds).toContain("session.stop");
    await until(async () => (await items(r))[0]?.state === "inserted", 5000, "the item");
    expect((await items(r))[0]).toMatchObject({ text: "hello", by: "user" });
  });

  test("cancel: nothing is inserted and history keeps it as cancelled", async () => {
    const r = await rig();
    expect((await r.api("POST", "/dictation/start")).status).toBe(200);
    const cancel = await r.api("POST", "/dictation/cancel");
    expect(cancel.status).toBe(200);
    await until(async () => (await items(r)).length === 1, 5000, "the item");
    expect((await items(r))[0]?.state).toBe("cancelled");
    expect(lines(r.inserted)).toEqual([]);
  });

  test("refusals: stop with nothing listening, a second start, and dictation off", async () => {
    const r = await rig();
    expect((await r.api("POST", "/dictation/stop")).body.error).toBe("not_dictating");
    expect((await r.api("POST", "/dictation/cancel")).body.error).toBe("not_dictating");
    expect((await r.api("POST", "/dictation/start")).status).toBe(200);
    const again = await r.api("POST", "/dictation/start");
    expect([again.status, again.body.error]).toEqual([409, "dictation_busy"]);
    const off = await rig({ "dictation.enabled": false });
    const res = await off.api("POST", "/dictation/start");
    expect([res.status, res.body.error]).toEqual([409, "dictation_off"]);
  });

  test("a start the helper drops is a 409, never a 200 that says idle", async () => {
    const r = await rig({}, ["--deaf-start"]);
    const res = await r.api("POST", "/dictation/start");
    expect([res.status, res.body.error]).toEqual([409, "dictation_busy"]);
    expect(res.body.message).toContain("did not start");
    expect(lines(r.commands).map((c) => c.type)).toContain("session.start");
  });
});

describe("DC-G3: akou dictate start|stop|toggle|cancel", () => {
  test("toggle twice makes one session", async () => {
    const r = await rig();
    const run = rigCli(r);
    const first = await run(["dictate", "toggle"]);
    expect([first.code, first.out]).toEqual([0, "dictation listening"]);
    const second = await run(["dictate", "toggle", "--json"]);
    expect(second.code).toBe(0);
    expect(second.json.state).not.toBe("listening");
    await until(async () => (await items(r)).length === 1, 5000, "the dictation");
    await Bun.sleep(200);
    expect(await items(r)).toHaveLength(1);
    const starts = lines(r.commands).filter((c) => c.type === "session.start");
    expect(starts).toHaveLength(1);
  });

  test("start --language forces the session into it, as the pill's chip does (akou-5v8)", async () => {
    const r = await rig();
    const run = rigCli(r);
    const start = await run(["dictate", "start", "--language", "es"]);
    expect([start.code, start.out]).toEqual([0, "dictation listening"]);
    // The pill reads the session's language from here, and shows it as chosen.
    expect(r.app.dictation()?.languageChoice().chosen).toBe("es");
    await Bun.sleep(1000);
    expect((await run(["dictate", "stop"])).code).toBe(0);
    await until(async () => (await items(r))[0]?.state === "inserted", 10_000, "the insert");
    // The decode was asked for es; the fake engine is fast, which picks its own, so it says it
    // did not force it. Without a language the item carries no language_forced at all.
    expect((await items(r))[0].language_forced).toBe(false);
    expect(r.app.dictation()?.languageChoice().chosen).toBeNull();
    const plain = await rig();
    expect((await plain.api("POST", "/dictation/start")).status).toBe(200);
    expect(plain.app.dictation()?.languageChoice().chosen).toBeNull();
    await Bun.sleep(1000);
    expect((await plain.api("POST", "/dictation/stop")).status).toBe(200);
    await until(async () => (await items(plain))[0]?.state === "inserted", 10_000, "the insert");
    expect((await items(plain))[0].language_forced).toBeUndefined();
  }, 30_000);

  test("--language is refused on stop and cancel, and a tag that is not one is a 422", async () => {
    const r = await rig();
    const run = rigCli(r);
    const stop = await run(["dictate", "stop", "--language", "es"]);
    expect(stop.code).toBe(64);
    expect(stop.err).toContain("--language goes with start or toggle");
    const bad = await r.api("POST", "/dictation/start", { language: "not a tag" });
    expect([bad.status, bad.body.error]).toEqual([422, "bad_field"]);
    expect(r.app.dictation()?.status().state).toBe("idle");
  });

  test("with dictation.enabled false, start exits 78 naming the setting", async () => {
    const r = await rig({ "dictation.enabled": false });
    const run = await rigCli(r)(["dictate", "start"]);
    expect(run.code).toBe(78);
    expect(run.err).toContain("dictation.enabled");
  });

  test("with the app down, exit 69 and no launch", async () => {
    const run = await cli({ ...process.env, AKOU_HOME: scratch() }, ["dictate", "start"]);
    expect(run.code).toBe(69);
    expect(run.err).toContain("not running");
  });
});

describe("DC-H2: deleting dictations", () => {
  async function clip(r: AppRig): Promise<string> {
    const path = join(scratch(), "clip.wav");
    writeFileSync(path, monoWav(concat(silence(0.6), speak(["thanks"]), silence(1))));
    const run = await rigCli(r)(["dictate", path, "--json"]);
    expect(run.code).toBe(0);
    return run.json.id;
  }

  test("DELETE one: gone from the list and the log, a tombstone left; a second DELETE is 404", async () => {
    const r = await rig({ "dictation.enabled": false });
    const a = await clip(r);
    const b = await clip(r);
    const del = await r.api("DELETE", `/dictations/${a}`);
    expect([del.status, del.body]).toEqual([200, { id: a, deleted: true }]);
    expect((await items(r)).map((i: { id: string }) => i.id)).toEqual([b]);
    expect((await r.api("GET", `/dictations/${a}`)).status).toBe(404);
    expect((await r.api("DELETE", `/dictations/${a}`)).status).toBe(404);
    const log = readFileSync(join(r.home, ".config", "akou", "dictation", "events.jsonl"), "utf8");
    const ofA = log
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.id === a);
    expect(ofA.map((e) => e.type)).toEqual(["dictation.deleted"]);
  });

  test("DELETE all leaves only tombstones", async () => {
    const r = await rig({ "dictation.enabled": false });
    await clip(r);
    await clip(r);
    const del = await r.api("DELETE", "/dictations");
    expect(del.body).toEqual({ deleted: 2 });
    expect(await items(r)).toEqual([]);
    const log = readFileSync(join(r.home, ".config", "akou", "dictation", "events.jsonl"), "utf8");
    const types = new Set(
      log
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).type),
    );
    expect([...types]).toEqual(["dictation.deleted"]);
    expect(log).not.toContain("thanks");
  });

  test("akou dictations list, show and delete", async () => {
    const r = await rig({ "dictation.enabled": false });
    const id = await clip(r);
    const run = rigCli(r);
    const list = await run(["dictations", "list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain(id);
    expect(list.out).toContain("thanks");
    expect((await run(["dictations", "list", "-q", "nothing"])).out).toBe("No dictations");
    expect((await run(["dictations", "list", "--since", "1h", "--json"])).json.items).toHaveLength(
      1,
    );
    expect((await run(["dictations", "show", id, "--json"])).json).toMatchObject({
      id,
      text: "thanks",
    });
    const del = await run(["dictations", "delete", id]);
    expect([del.code, del.out]).toEqual([0, `dictation ${id} deleted`]);
    expect((await run(["dictations", "show", id])).code).toBe(64);
    expect((await run(["dictations", "delete"])).code).toBe(64);
  });
});

describe("DC-G1, DC-G3: a dictation's audio and Retry over the API and the CLI", () => {
  const audioDir = (r: AppRig) => join(r.home, ".config", "akou", "dictation", "audio");
  const audioFiles = (r: AppRig) =>
    existsSync(audioDir(r)) ? readdirSync(audioDir(r)).sort() : [];

  // A spoken dictation runs the fake helper in real time: past bun's 5 s default on a slow runner.
  const SPOKEN_MS = 30_000;

  /**
   * Waits for a dictation's audio to be on disk. The app writes it off the dictation's thread, so
   * it can land after the insert (akou-9uk); `GET /dictations/:id/audio` answers once that write
   * has ended, the way a user's request does. Throws with the API's error when none was kept.
   */
  async function audioWritten(r: Rig, id: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations/${id}/audio`, {
      headers: { authorization: `Bearer ${r.token}` },
    });
    if (res.status === 200) return void (await res.body?.cancel());
    throw new Error(
      `no audio written for ${id}: ${res.status} ${((await res.json()) as { error?: string }).error}`,
    );
  }

  /** A spoken dictation through the API's start and stop, inserted by the fake, its audio written. */
  async function spoken(r: Rig): Promise<string> {
    expect((await r.api("POST", "/dictation/start")).status).toBe(200);
    // The fake's mic runs in real time from the start: let "hello" be spoken before the stop.
    await Bun.sleep(1000);
    expect((await r.api("POST", "/dictation/stop")).status).toBe(200);
    await until(async () => (await items(r))[0]?.state === "inserted", 10_000, "the insert");
    const id = (await items(r))[0].id;
    await audioWritten(r, id);
    return id;
  }

  test(
    "GET audio gives the kept WAV; retry decodes it again; the CLI prints the retry",
    async () => {
      const r = await rig();
      const id = await spoken(r);
      const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations/${id}/audio`, {
        headers: { authorization: `Bearer ${r.token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/wav");
      const wav = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
      expect(wav.length).toBe(statSync(join(audioDir(r), `${id}.wav`)).size);
      const retry = await r.api("POST", `/dictations/${id}/retry`, { engine: "fast" });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ id, text: "hello", engine: "fast" });
      // Without a language the answer says none was asked (positive control for the next one).
      expect(retry.body.language_forced).toBeUndefined();
      const run = await rigCli(r)(["dictations", "retry", id, "--engine", "fast"]);
      expect([run.code, run.out]).toEqual([0, "hello"]);
      // A language reaches the decode; fast picks its own, so the answer says it was not forced.
      const es = await rigCli(r)([
        "dictations",
        "retry",
        id,
        "--engine",
        "fast",
        "--language",
        "es",
        "--json",
      ]);
      expect([es.code, es.json?.language_forced]).toEqual([0, false]);
      // Neither retry changed the dictation.
      expect((await r.api("GET", `/dictations/${id}`)).body).toMatchObject({
        state: "inserted",
        text: "hello",
      });
    },
    SPOKEN_MS,
  );

  test(
    "refusals: no such dictation, a clip with no audio kept, a bad engine",
    async () => {
      const r = await rig();
      const path = join(scratch(), "clip.wav");
      writeFileSync(path, monoWav(concat(silence(0.6), speak(["thanks"]), silence(1))));
      const clip = (await rigCli(r)(["dictate", path, "--json"])).json.id;
      const none = await r.api("POST", "/dictations/dnone/retry", { engine: "fast" });
      expect([none.status, none.body.error]).toEqual([404, "not_found"]);
      const noAudio = await r.api("POST", `/dictations/${clip}/retry`, { engine: "fast" });
      expect([noAudio.status, noAudio.body.error]).toEqual([404, "no_audio"]);
      const get = await r.api("GET", `/dictations/${clip}/audio`);
      expect([get.status, get.body.error]).toEqual([404, "no_audio"]);
      const bad = await r.api("POST", `/dictations/${clip}/retry`, { engine: "nope" });
      expect([bad.status, bad.body.error]).toEqual([422, "bad_field"]);
      const remote = await r.api("POST", `/dictations/${clip}/retry`, { engine: "remote" });
      expect([remote.status, remote.body.error]).toEqual([422, "bad_field"]);
      const lang = await r.api("POST", `/dictations/${clip}/retry`, {
        engine: "fast",
        language: "spanish please",
      });
      expect([lang.status, lang.body.error, lang.body.field]).toEqual([
        422,
        "bad_field",
        "language",
      ]);
      const cli = await rigCli(r)(["dictations", "retry", clip]);
      expect(cli.code).toBe(64);
      expect(cli.err).toContain("--engine");
    },
    SPOKEN_MS,
  );

  test(
    "DELETE one leaves no audio file",
    async () => {
      const r = await rig();
      const id = await spoken(r);
      expect(audioFiles(r)).toEqual([`${id}.wav`]);
      expect((await r.api("DELETE", `/dictations/${id}`)).status).toBe(200);
      expect(audioFiles(r)).toEqual([]);
    },
    SPOKEN_MS,
  );

  test(
    "DELETE all leaves no audio files",
    async () => {
      const r = await rig();
      await spoken(r);
      expect(audioFiles(r)).toHaveLength(1);
      expect((await r.api("DELETE", "/dictations")).body).toEqual({ deleted: 1 });
      expect(audioFiles(r)).toEqual([]);
    },
    SPOKEN_MS,
  );

  test(
    "[akou-9uk] the audio is on disk once spoken() returns, even when it lands seconds after the insert",
    async () => {
      // The fake helper's encode fails after 3 s, so the WAV is written well after the insert.
      const r = await rig({}, ["--encode-delay", "3000"]);
      const id = await spoken(r);
      expect(audioFiles(r)).toEqual([`${id}.wav`]);
      expect((await r.api("DELETE", "/dictations")).body).toEqual({ deleted: 1 });
      expect(audioFiles(r)).toEqual([]);
    },
    SPOKEN_MS,
  );

  test("positive control: the wait for the audio fails for a dictation with none written", async () => {
    const r = await rig();
    // A clip sent to the app: akou keeps no copy of it.
    const path = join(scratch(), "clip.wav");
    writeFileSync(path, monoWav(concat(silence(0.6), speak(["thanks"]), silence(1))));
    const clip = (await rigCli(r)(["dictate", path, "--json"])).json.id;
    await expect(audioWritten(r, clip)).rejects.toThrow(
      `no audio written for ${clip}: 404 no_audio`,
    );
    expect(audioFiles(r)).toEqual([]);
  });

  test(
    "turning dictation.keepAudio off deletes the audio of finished dictations at once",
    async () => {
      const r = await rig();
      const id = await spoken(r);
      expect(audioFiles(r)).toEqual([`${id}.wav`]);
      const patch = await r.api("PATCH", "/config", { "dictation.keepAudio": false });
      expect(patch.status).toBe(200);
      expect(audioFiles(r)).toEqual([]);
      expect((await r.api("GET", `/dictations/${id}`)).body.text).toBe("hello");
    },
    SPOKEN_MS,
  );
});

describe("DC-R4: GET /v1/dictation/remote-test and akou dictate --remote-test", () => {
  /** A loopback akou server that knows one key. */
  function remote(key: string) {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/server") {
          return Response.json({
            name: "akou",
            mode: "server",
            capabilities: { interactive: true },
            dictation: { engine: "best" },
            accelerator: { active: "metal" },
          });
        }
        if (path === "/v1/keys/me") {
          return req.headers.get("authorization") === `Bearer ${key}`
            ? Response.json({ id: "key_1", scope: "jobs" })
            : Response.json({ error: "unauthorized", message: "bad key" }, { status: 401 });
        }
        return new Response("no", { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));
    return `http://127.0.0.1:${server.port}`;
  }

  test("the right key: ok, the engine and accelerator there; the key never in the answer", async () => {
    const key = "k-right-000";
    const r = await rig({ "dictation.remote.url": remote(key), "dictation.remote.key": key });
    const res = await r.api("GET", "/dictation/remote-test");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, engine: "best", accelerator: "metal" });
    expect(JSON.stringify(res.body)).not.toContain(key);
    const run = await rigCli(r)(["dictate", "--remote-test"]);
    expect(run.code).toBe(0);
    expect(run.out).toStartWith("ok, best on metal");
  });

  test("a wrong key: ok false with 401, exit 69, the key never shown", async () => {
    const key = "k-wrong-000";
    const r = await rig({
      "dictation.remote.url": remote("k-right-000"),
      "dictation.remote.key": key,
    });
    const res = await r.api("GET", "/dictation/remote-test");
    expect(res.body).toMatchObject({ ok: false, status: 401 });
    expect(JSON.stringify(res.body)).not.toContain(key);
    expect((await rigCli(r)(["dictate", "--remote-test"])).code).toBe(69);
  });

  test("no URL set: 409 no_remote", async () => {
    const r = await rig();
    const res = await r.api("GET", "/dictation/remote-test");
    expect([res.status, res.body.error]).toEqual([409, "no_remote"]);
  });
});
