/**
 * Dictation through a whole app (DC-G1, DC-G3, DC-A1's master switch): a clip in, its word out, on
 * the API and the CLI, and the helper's `dictate` process started only with `dictation.enabled`.
 * The app runs the fake helper and the fake engine; nothing opens a device or presses a key.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ApiResult, type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function rig(o: Parameters<typeof appRig>[0] = {}): Promise<AppRig> {
  const r = await appRig(o);
  cleanups.push(() => r.close());
  return r;
}

function clip(dir: string, words: string[] = ["hello"]): string {
  const path = join(dir, "clip.wav");
  writeFileSync(path, monoWav(concat(silence(0.6), speak(words), silence(1))));
  return path;
}

async function upload(
  r: AppRig,
  path: string,
  fields: Record<string, string> = {},
): Promise<Pick<ApiResult, "status" | "body">> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path)]), "clip.wav");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations`, {
    method: "POST",
    headers: { authorization: `Bearer ${r.token}`, "x-akou-client": "test" },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

function scratch(): string {
  const t = tempDir("akou-dict-e2e-");
  cleanups.push(t.cleanup);
  return t.dir;
}

describe("DC-G1: POST /v1/dictations", () => {
  test("a generated clip comes back as its word, and the log keeps it", async () => {
    const r = await rig();
    const res = await upload(r, clip(scratch()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      text: "hello",
      raw: "hello",
      engine: "fast",
      model: "fake-parakeet",
      state: "done",
      by: "agent:test",
      app: null,
    });
    const list = await r.api("GET", "/dictations");
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([res.body.id]);
    const one = await r.api("GET", `/dictations/${res.body.id}`);
    expect(one.body).toMatchObject({ id: res.body.id, text: "hello" });
    expect((await r.api("GET", "/dictations/dnope")).status).toBe(404);
  });

  test("an unknown engine and an unknown field are refused", async () => {
    const r = await rig();
    const path = clip(scratch());
    expect((await upload(r, path, { engine: "slow" })).status).toBe(422);
    expect((await upload(r, path, { insert: "true" })).body.error).toBe("unknown_field");
  });

  test("the upload is not kept once decoded", async () => {
    const r = await rig();
    await upload(r, clip(scratch()));
    const uploads = join(r.home, ".config", "akou", "dictation", "uploads");
    const left = existsSync(uploads) ? readdirSync(uploads) : [];
    expect(left).toEqual([]);
  });

  test("`q` keeps the dictations whose text holds it", async () => {
    const r = await rig();
    const dir = scratch();
    await upload(r, clip(dir, ["hello"]));
    await upload(r, clip(dir, ["thanks"]));
    const hit = await r.api("GET", "/dictations?q=THANKS");
    expect(hit.body.items.map((i: { text: string }) => i.text)).toEqual(["thanks"]);
  });
});

describe("DC-G3: akou dictate FILE", () => {
  test("prints the word", async () => {
    const r = await rig();
    const run = await rigCli(r)(["dictate", clip(scratch())]);
    expect(run.code).toBe(0);
    expect(run.out).toBe("hello");
  });

  test("--json prints the dictation", async () => {
    const r = await rig();
    const run = await rigCli(r)(["dictate", clip(scratch()), "--json"]);
    expect(run.json).toMatchObject({ text: "hello", engine: "fast" });
  });
});

describe("DC-A1: dictation.enabled is the master switch", () => {
  test("off: no helper is spawned and GET /config says so", async () => {
    const commands = join(scratch(), "commands.jsonl");
    const r = await rig({ helperArgs: ["--commands-log", commands] });
    expect((await r.api("GET", "/config")).body.settings["dictation.enabled"]).toBe(false);
    expect(r.app.dictation()?.status()).toMatchObject({ enabled: false, state: "off" });
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(commands)).toBe(false);
  });

  test("positive control: on, the helper starts and is bound; off again, it stops", async () => {
    const commands = join(scratch(), "commands.jsonl");
    const r = await rig({
      helperArgs: ["--commands-log", commands],
      settings: { "dictation.enabled": true },
    });
    await until(() => existsSync(commands), 10_000, "the helper's first command");
    const first = JSON.parse(readFileSync(commands, "utf8").split("\n")[0] as string);
    expect(first).toMatchObject({ type: "rebind", activation: "hold-or-toggle" });
    await until(() => r.app.dictation()?.status().state === "idle", 5000, "the helper to be ready");
    const off = await r.api("PATCH", "/config", { "dictation.enabled": false });
    expect(off.status).toBe(200);
    // `enabled` turns false as soon as the stop begins; the helper reads `stop` a moment later.
    await until(() => r.app.dictation()?.status().enabled === false, 5000, "the stop to begin");
    await until(
      () => readFileSync(commands, "utf8").includes('"type":"stop"'),
      5000,
      "the helper to read stop",
    );
  });
});

describe("DC-L6: a dictation goes through its vocabulary", () => {
  test("a `scope: dictation` entry fixes the next dictation, the raw text stays, and removing it undoes that", async () => {
    const r = await rig();
    const vocab = join(r.app.configDir, "vocabulary.yaml");
    writeFileSync(
      vocab,
      [
        "version: 1",
        "entries:",
        '  - term: "Hetzner"',
        '    heard: ["hetzna"]',
        '    source: "dictation:d1"',
        "    confirmed: true",
        '    added_at: "2026-09-27"',
        '    scope: "dictation"',
        "",
      ].join("\n"),
    );
    const path = clip(scratch(), ["deploy", "hetzner"]);
    const first = await upload(r, path);
    expect(first.body).toMatchObject({ raw: "deploy hetzna", text: "deploy Hetzner" });
    // The entry leaves the file; the next dictation reads the file again and inserts what it heard.
    writeFileSync(vocab, "version: 1\nentries: []\n");
    r.app.vocabChanged();
    const second = await upload(r, path);
    expect(second.body).toMatchObject({ raw: "deploy hetzna", text: "deploy hetzna" });
  });
});
