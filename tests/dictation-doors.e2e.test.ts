/**
 * The dictation doors through a whole app (docs/ux/DICTATION.md DC-G1, DC-G3, DC-H2, DC-R4): the
 * live session driven over the API and the CLI as the tray and a compositor binding drive it,
 * `GET /v1/dictation`, deleting dictations, and the remote's Test. The app runs the fake helper
 * (`session.start`, `session.stop`, `session.cancel`) and the fake engine; nothing opens a device,
 * presses a key or touches the clipboard: the fake inserter writes what it would have inserted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
      fallback: null,
      remote: null,
      grants: { mic: "granted", accessibility: "granted" },
      backend: "fake",
      swallow_keys: true,
    });
  });

  test("off: enabled false, state off, no grants", async () => {
    const r = await rig({ "dictation.enabled": false });
    const res = await r.api("GET", "/dictation");
    expect(res.body).toMatchObject({ enabled: false, state: "off", grants: null });
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
