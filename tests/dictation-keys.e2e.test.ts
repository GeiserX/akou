/**
 * The dictation settings through a whole app (DC-A7, DC-G4, the owner's rule on the remote's URL):
 * a changed key reaches the helper from the door that changed it, and one the helper refuses comes
 * back as that door's error with the old key still working; the remote key is a secret set from
 * stdin and used by the next remote dictation; the remote's URL is written by the window only.
 * The app runs the fake helper and the fake engine; nothing opens a device or presses a key.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import { runCli } from "../src/main/cli/cli.ts";
import { Bridge } from "../src/main/window/bridge.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
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
  const t = tempDir("akou-dict-keys-");
  cleanups.push(t.cleanup);
  return t.dir;
}

async function rig(o: Parameters<typeof appRig>[0]): Promise<AppRig> {
  const r = await appRig(o);
  cleanups.push(() => r.close());
  return r;
}

interface Helper {
  args: string[];
  commands: string;
  inserted: string;
  tap: string;
}

/**
 * The fake helper with "hello" on the mic from 1.0 s and `key` held from 0.9 s to 2.0 s, played
 * only after the second `rebind`: the first binds at start, the second is the test's change.
 */
function helper(key: string, extra: string[] = []): Helper {
  const dir = scratch();
  const wav = join(dir, "mic.wav");
  writeFileSync(wav, monoWav(concat(silence(1), speak(["hello"]), silence(3))));
  const keys = join(dir, "keys.jsonl");
  const script: KeyInput[] = [
    { at: 900, key, down: true },
    { at: 2000, key, down: false },
  ];
  writeFileSync(keys, script.map((k) => JSON.stringify(k)).join("\n"));
  const h = {
    commands: join(dir, "commands.jsonl"),
    inserted: join(dir, "inserted.jsonl"),
    tap: join(dir, "tap.jsonl"),
  };
  return {
    ...h,
    args: [
      "--wav",
      wav,
      "--keys",
      keys,
      "--play-after-rebinds",
      "2",
      "--commands-log",
      h.commands,
      "--inserter-log",
      h.inserted,
      "--tap-log",
      h.tap,
      ...extra,
    ],
  };
}

const DICTATING = {
  "dictation.enabled": true,
  "dictation.hotkey": "RightCommand",
  "dictation.activation": "hold",
};

async function ready(r: AppRig): Promise<void> {
  await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper to be ready");
}

const rebinds = (h: Helper) =>
  lines(h.commands)
    .filter((c) => c.type === "rebind")
    .map((c) => c.hotkey);

describe("DC-A7: a changed dictation key applies at once from any door", () => {
  test("PATCH /config rebinds the helper, and a press of the new key dictates", async () => {
    const h = helper("RightShift");
    const r = await rig({ helperArgs: h.args, settings: DICTATING });
    await ready(r);
    const res = await r.api("PATCH", "/config", { "dictation.hotkey": "RightShift" });
    expect(res.status).toBe(200);
    expect(rebinds(h)).toEqual(["RightCommand", "RightShift"]);
    await until(() => lines(h.inserted).length === 1, 10_000, "the new key's dictation");
    expect(lines(h.inserted)[0]).toMatchObject({ type: "insert", text: "hello" });
  });

  test("the window's door rebinds the same way", async () => {
    const h = helper("RightShift");
    const r = await rig({ helperArgs: h.args, settings: DICTATING });
    await ready(r);
    const res = await new Bridge(r.app).json("PATCH", "/config", {
      "dictation.hotkey": "RightShift",
    });
    expect(res.status).toBe(200);
    expect(rebinds(h)).toEqual(["RightCommand", "RightShift"]);
  });

  test("a key the helper refuses is that door's error, and the old key still dictates", async () => {
    const h = helper("RightCommand", ["--refuse-hotkey", "RightShift"]);
    const r = await rig({ helperArgs: h.args, settings: DICTATING });
    await ready(r);
    const res = await r.api("PATCH", "/config", { "dictation.hotkey": "RightShift" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "bad_setting" });
    expect(res.body.message).toContain("cannot bind RightShift");
    const cfg = await r.api("GET", "/config");
    expect(cfg.body.settings["dictation.hotkey"]).toBe("RightCommand");
    await until(() => lines(h.inserted).length === 1, 10_000, "the old key's dictation");
    expect(lines(h.inserted)[0]).toMatchObject({ text: "hello" });
  });

  test("fix last's default follows the dictation key", async () => {
    const h = helper("RightShift");
    const r = await rig({ helperArgs: h.args, settings: DICTATING });
    await ready(r);
    await r.api("PATCH", "/config", { "dictation.hotkey": "RightControl" });
    const sent = lines(h.commands).filter((c) => c.type === "rebind");
    expect(sent.map((c) => c.fixLast)).toEqual(["Shift+RightCommand", "Shift+RightControl"]);
  });
});

describe("DC-U8: pausing other media reaches the helper", () => {
  test("the helper gets dictation.muteMedia after ready, and again when PATCH /config changes it", async () => {
    const h = helper("RightShift");
    const r = await rig({ helperArgs: h.args, settings: DICTATING });
    await ready(r);
    const media = () =>
      lines(h.commands)
        .filter((c) => c.type === "pause_media")
        .map((c) => c.on);
    await until(() => media().length === 1, 5000, "pause_media after ready");
    expect((await r.api("PATCH", "/config", { "dictation.muteMedia": true })).status).toBe(200);
    await until(() => media().length === 2, 5000, "pause_media on the change");
    // Negative control: a change of another setting sends nothing more.
    await r.api("PATCH", "/config", { "dictation.sendAlways": true });
    await Bun.sleep(200);
    expect(media()).toEqual([false, true]);
  });
});

/** A remote akou on loopback that answers every dictation and records its bearer. */
function remote(): { url: string; bearers: string[] } {
  const bearers: string[] = [];
  const srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      bearers.push(req.headers.get("authorization") ?? "");
      return Response.json({ text: "from the remote", language: "en", words: [] });
    },
  });
  cleanups.push(() => srv.stop(true));
  return { url: `http://127.0.0.1:${srv.port}`, bearers };
}

async function upload(r: AppRig): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  const wav = monoWav(concat(silence(0.5), speak(["hello"]), silence(1)));
  form.append("file", new Blob([wav]), "clip.wav");
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations`, {
    method: "POST",
    headers: { authorization: `Bearer ${r.token}` },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function setFromStdin(r: AppRig, key: string, value: string): Promise<number> {
  return runCli(
    ["config", "set", key, "-"],
    {
      env: { ...process.env, ...r.env },
      out: () => {},
      err: () => {},
      readStdin: async () => `${value}\n`,
    },
    { launch: null },
  );
}

describe("DC-G4: the remote key is a secret, set from stdin and used at once", () => {
  test("`akou config set dictation.remote.key -` stores it masked, and the next dictation sends it", async () => {
    const rm = remote();
    const r = await rig({
      settings: { "dictation.engine": "remote", "dictation.remote.url": rm.url },
    });
    expect(await setFromStdin(r, "dictation.remote.key", "k-first")).toBe(0);
    const cfg = await r.api("GET", "/config");
    expect(cfg.body.settings["dictation.remote.key"]).toBe("(set)");
    expect(JSON.stringify(cfg.body)).not.toContain("k-first");
    const first = await upload(r);
    expect(first.body).toMatchObject({ text: "from the remote", engine: "remote" });
    expect(rm.bearers).toEqual(["Bearer k-first"]);
    // A new key applies to the next dictation, with no restart.
    expect(await setFromStdin(r, "dictation.remote.key", "k-second")).toBe(0);
    await upload(r);
    expect(rm.bearers).toEqual(["Bearer k-first", "Bearer k-second"]);
  });

  test("positive control: engine fast on the clip never reaches the remote", async () => {
    const rm = remote();
    const r = await rig({
      settings: { "dictation.engine": "remote", "dictation.remote.url": rm.url },
    });
    const form = new FormData();
    form.append("file", new Blob([monoWav(concat(speak(["hello"]), silence(1)))]), "c.wav");
    form.append("engine", "fast");
    const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations`, {
      method: "POST",
      headers: { authorization: `Bearer ${r.token}` },
      body: form,
    });
    expect(await res.json()).toMatchObject({ text: "hello", engine: "fast" });
    expect(rm.bearers).toEqual([]);
  });
});

describe("owner rule: the remote's URL is set from the window or the file, never over HTTP", () => {
  test("HTTP is refused; the window writes it; a later HTTP save keeps it", async () => {
    const r = await rig({});
    const url = { "dictation.remote.url": "https://akou.example" };
    const http = await r.api("PATCH", "/config", url);
    expect(http.status).toBe(400);
    expect(http.body.message).toContain("akou window");
    const win = await new Bridge(r.app).json("PATCH", "/config", url);
    expect(win.status).toBe(200);
    const file = () => JSON.parse(readFileSync(r.app.config().paths.configFile, "utf8"));
    expect(file()["dictation.remote.url"]).toBe("https://akou.example");
    const other = await r.api("PATCH", "/config", { "dictation.sendAlways": true });
    expect(other.status).toBe(200);
    expect(file()["dictation.remote.url"]).toBe("https://akou.example");
    const schema = (await r.api("GET", "/config")).body.schema["dictation.remote.url"];
    expect(schema).toMatchObject({ apiWritable: false, windowWritable: true });
  });
});
