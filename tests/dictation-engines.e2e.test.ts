/**
 * DC-E2, DC-E3 and DC-E4 through a whole app: which engine a dictation runs on this machine and
 * why, `best` kept warm while dictation is on, Qwen's download when `best` is chosen without it,
 * and the dictation's own language. Qwen is the fake llama-server (`asr.llamaServer`), its model
 * files are empty placeholders, and the model store's network is a fake that records what it was
 * asked for, so nothing is downloaded.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { MODELS, modelFile } from "../src/main/asr/models.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function scratch(): string {
  const t = tempDir("akou-dict-engines-");
  cleanups.push(t.cleanup);
  return t.dir;
}

/** Qwen's files, empty: the fake llama-server reads none of them. */
function qwenOnDisk(models: string): void {
  const qwen = MODELS.find((m) => m.id === QWEN_ASR);
  for (const f of qwen?.files ?? []) {
    const path = modelFile(models, QWEN_ASR, f.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
}

interface Rig {
  r: AppRig;
  dir: string;
  /** The fake llama-server's starts (`argv`, `pid`) and requests (`body`). */
  llama(): Record<string, unknown>[];
  /** The URLs the model store asked the network for. */
  fetched: string[];
}

async function rig(
  settings: Record<string, unknown>,
  o: { qwen?: boolean; llama?: string[] } = {},
): Promise<Rig> {
  const dir = scratch();
  const models = join(dir, "models");
  if (o.qwen) qwenOnDisk(models);
  const log = join(dir, "llama.log");
  const fetched: string[] = [];
  const r = await appRig({
    settings: {
      "asr.modelsDir": models,
      "asr.llamaServer": [process.execPath, FAKE_LLAMA, "--fake-log", log, ...(o.llama ?? [])],
      "asr.accelerator": "cpu",
      ...settings,
    },
    jobs: {
      modelStore: {
        freeBytes: () => 1e13,
        // A download that never finishes: the store shows it as downloading.
        fetch: ((url: string | URL | Request) => {
          fetched.push(String(url instanceof Request ? url.url : url));
          return new Promise<Response>(() => {});
        }) as typeof fetch,
      },
    },
  });
  cleanups.push(() => r.close());
  const llama = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { r, dir, llama, fetched };
}

async function upload(r: AppRig, fields: Record<string, string> = {}) {
  const form = new FormData();
  const wav = monoWav(concat(silence(0.6), speak(["hello"]), silence(1)));
  form.append("file", new Blob([wav]), "clip.wav");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations`, {
    method: "POST",
    headers: { authorization: `Bearer ${r.token}`, "x-akou-client": "test" },
    body: form,
  });
  // biome-ignore lint/suspicious/noExplicitAny: test bodies are inspected field by field.
  return { status: res.status, body: (await res.json()) as any };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("DC-E3: auto on this machine", () => {
  test("a Metal accelerator with Qwen on disk: auto is best, and GET /v1/dictation says why", async () => {
    const { r } = await rig({ "asr.accelerator": "metal" }, { qwen: true });
    const st = (await r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({ engine: "best", verdict: "best on metal", loading: false });
  });

  test("on the CPU, auto is fast", async () => {
    const { r } = await rig({ "asr.accelerator": "cpu" }, { qwen: true });
    const st = (await r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({ engine: "fast", verdict: "fast: best needs a GPU" });
  });

  test("a GPU with Qwen missing: fast, and nothing is downloaded", async () => {
    const x = await rig({ "asr.accelerator": "metal", "dictation.enabled": true });
    const st = (await x.r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({
      engine: "fast",
      verdict: "fast: best (Qwen3-ASR) is not downloaded",
    });
    expect(x.fetched).toEqual([]);
  });
});

describe("DC-E3: best chosen with Qwen missing", () => {
  test("the download starts, and dictation runs on fast meanwhile, saying so", async () => {
    const x = await rig({ "dictation.engine": "best", "dictation.enabled": true });
    await until(() => x.fetched.length > 0, 10_000, "Qwen's download to start");
    const qwen = MODELS.find((m) => m.id === QWEN_ASR);
    expect(qwen?.files.some((f) => x.fetched.includes(f.url))).toBe(true);
    const st = (await x.r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({ engine: "fast", verdict: "downloading best, using fast" });
    const res = await upload(x.r);
    expect(res.body).toMatchObject({ text: "hello", engine: "fast", fallback_from: "best" });
    expect(x.llama()).toEqual([]);
  });

  test("positive control: with dictation off, choosing best downloads nothing", async () => {
    const x = await rig({ "dictation.engine": "best" });
    await Bun.sleep(300);
    expect(x.fetched).toEqual([]);
  });
});

describe("DC-E2: best kept warm while dictation is on", () => {
  test("enabling starts Qwen before any dictation; a dictation uses it; disabling stops it", async () => {
    const x = await rig({ "dictation.engine": "best", "dictation.enabled": true }, { qwen: true });
    await until(() => x.llama().some((l) => l.argv), 10_000, "the warm start");
    const pid = x.llama().find((l) => l.argv)?.pid as number;
    const res = await upload(x.r);
    expect(res.body).toMatchObject({ text: "hello", engine: "best", model: QWEN_ASR });
    expect(res.body.fallback_from).toBeUndefined();
    expect(x.llama().filter((l) => l.argv).length).toBe(1);
    await x.r.api("PATCH", "/config", { "dictation.enabled": false });
    await until(() => !alive(pid), 10_000, "Qwen to stop with dictation off");
  });

  test("positive control: with dictation off, nothing starts Qwen until a dictation needs it", async () => {
    const x = await rig({ "dictation.engine": "best" }, { qwen: true });
    await Bun.sleep(300);
    expect(x.llama()).toEqual([]);
  });

  test("a llama-server that dies mid-request: the fast text, with fallback_from best", async () => {
    const x = await rig(
      { "dictation.engine": "best", "dictation.enabled": true },
      { qwen: true, llama: ["--fake-die-on", "1"] },
    );
    const res = await upload(x.r);
    expect(res.body).toMatchObject({ text: "hello", engine: "fast", fallback_from: "best" });
    const one = await x.r.api("GET", `/dictations/${res.body.id}`);
    expect(one.body).toMatchObject({ engine: "fast", fallback_from: "best" });
  });
});

describe("DC-E4: the dictation's language", () => {
  test("best is forced into the language named, and the item says it was", async () => {
    const x = await rig({ "dictation.engine": "best" }, { qwen: true });
    const res = await upload(x.r, { language: "es" });
    expect(res.body).toMatchObject({ engine: "best", language: "es", language_forced: true });
    const prefills = x
      .llama()
      .filter((l) => l.body)
      .map((l) => (l.body as { messages: { role: string; content: unknown }[] }).messages.at(-1))
      .filter((m) => m?.role === "assistant");
    expect(prefills).toEqual([{ role: "assistant", content: "language Spanish<asr_text>" }]);
  });

  test("dictation.language reaches best with no field on the request", async () => {
    const x = await rig({ "dictation.engine": "best", "dictation.language": "es" }, { qwen: true });
    const res = await upload(x.r);
    expect(res.body).toMatchObject({ language: "es", language_forced: true });
  });

  test("fast ignores a forced tag and records language_forced false", async () => {
    const x = await rig({ "dictation.engine": "fast", "dictation.language": "en" });
    const res = await upload(x.r);
    expect(res.body).toMatchObject({ engine: "fast", text: "hello", language_forced: false });
    const auto = await rig({ "dictation.engine": "fast" });
    expect((await upload(auto.r)).body.language_forced).toBeUndefined();
  });

  test("auto among dictation.languages: a Spanish answer among [en, es] stays es; asr.languages untouched", async () => {
    const x = await rig(
      { "dictation.engine": "best" },
      { qwen: true, llama: ["--fake-lang", "Spanish"] },
    );
    const set = await x.r.api("PATCH", "/config", { "dictation.languages": ["en", "es"] });
    expect(set.status).toBe(200);
    expect((await upload(x.r)).body).toMatchObject({ language: "es" });
    expect((await x.r.api("GET", "/config")).body.settings["asr.languages"]).toEqual([]);
  });

  test("positive control: with dictation.languages [en], the same answer is forced to en", async () => {
    const x = await rig(
      { "dictation.engine": "best", "dictation.languages": ["en"] },
      { qwen: true, llama: ["--fake-lang", "Spanish"] },
    );
    expect((await upload(x.r)).body).toMatchObject({ language: "en" });
  });
});
