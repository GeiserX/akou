/**
 * DC-E2, DC-E3 and DC-E4 through a whole app: which engine a dictation runs on this machine and
 * why, `best` kept warm while dictation is on, Qwen's download when `best` is chosen without it,
 * and the dictation's own language. Qwen is the fake llama-server (`asr.llamaServer`), its model
 * files are empty placeholders, and the model store's network is a fake that records what it was
 * asked for, so nothing is downloaded.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { MODELS, modelFile } from "../src/main/asr/models.ts";
import { GPU_BUSY_VERDICT } from "../src/main/dictation/engines.ts";
import { BEST_REWARM_MS } from "../src/main/index.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { ManualClock, until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { jsonLines, tempDir } from "./helpers.ts";

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
  o: {
    qwen?: boolean;
    llama?: string[];
    helper?: string[];
    clock?: ManualClock;
    metalHolder?: () => number | null;
  } = {},
): Promise<Rig> {
  const dir = scratch();
  const models = join(dir, "models");
  if (o.qwen) qwenOnDisk(models);
  const log = join(dir, "llama.log");
  const fetched: string[] = [];
  const r = await appRig({
    ...(o.helper ? { helperArgs: o.helper } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.metalHolder ? { metalHolder: o.metalHolder } : {}),
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
  const llama = () => jsonLines(log);
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

// Under `dictation.engine` `auto`, `dictation.final` decides (DC-E7): `qwen` is best where it can
// run, `parakeet` is always Parakeet, and the default `live` waits for a streaming model.
describe("DC-E3: auto on this machine", () => {
  test("a Metal accelerator with Qwen on disk: qwen is best, and GET /v1/dictation says why", async () => {
    const { r } = await rig(
      { "asr.accelerator": "metal", "dictation.final": "qwen" },
      { qwen: true },
    );
    const st = (await r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({ engine: "best", verdict: "best on metal", loading: false });
  });

  test("parakeet is Parakeet, even with Qwen on disk and a GPU for it", async () => {
    const { r } = await rig(
      { "asr.accelerator": "metal", "dictation.final": "parakeet" },
      { qwen: true },
    );
    const st = (await r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({ engine: "fast", final: "parakeet" });
  });

  test("a GPU with Qwen missing: the default runs Parakeet until a streaming model lands, and nothing is downloaded", async () => {
    const x = await rig({ "asr.accelerator": "metal", "dictation.enabled": true });
    const st = (await x.r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({
      engine: "fast",
      verdict: "fast: no streaming model is downloaded for live",
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

  test("asr.qwenIdleMinutes set while Qwen idles arms its timer at once", async () => {
    const clock = new ManualClock();
    const x = await rig(
      { "dictation.engine": "best", "dictation.enabled": true },
      { qwen: true, clock },
    );
    await until(() => x.llama().some((l) => l.argv), 10_000, "the warm start");
    await until(() => x.r.app.dictation()?.status().loading === false, 10_000, "the load");
    const pid = x.llama().find((l) => l.argv)?.pid as number;
    await clock.advance(2 * 60_000);
    // Positive control: with 0, the default, it stays up.
    expect(alive(pid)).toBe(true);
    await x.r.api("PATCH", "/config", { "asr.qwenIdleMinutes": 1 });
    await clock.advance(2 * 60_000);
    await until(() => !alive(pid), 10_000, "Qwen to stop after its idle time");
  });

  test("with dictation off, a clip over the API starts Qwen and stops it after", async () => {
    const x = await rig({ "dictation.engine": "best" }, { qwen: true });
    const res = await upload(x.r);
    expect(res.body).toMatchObject({ text: "hello", engine: "best" });
    const pid = x.llama().find((l) => l.argv)?.pid as number;
    await until(() => !alive(pid), 10_000, "Qwen to stop after the clip");
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

describe("DC-E2: best gives way to a final pass holding the GPU on Metal", () => {
  const metal = {
    "dictation.engine": "best",
    "dictation.enabled": true,
    "asr.accelerator": "metal",
  };

  test("while a final pass holds it, GET /v1/dictation says so and a dictation is fast; once the pass ends, best is warmed", async () => {
    const clock = new ManualClock();
    let holder: number | null = 4242;
    const x = await rig(metal, { qwen: true, clock, metalHolder: () => holder });
    const st = (await x.r.api("GET", "/dictation")).body;
    expect(st).toMatchObject({ engine: "fast", verdict: GPU_BUSY_VERDICT });
    const res = await upload(x.r);
    expect(res.body).toMatchObject({ text: "hello", engine: "fast", fallback_from: "best" });
    // No start that would fail: Qwen was never asked for.
    expect(x.llama()).toEqual([]);
    // Positive control: while the pass runs, looking again changes nothing.
    await clock.advance(BEST_REWARM_MS);
    await Bun.sleep(200);
    expect(x.llama()).toEqual([]);
    holder = null;
    await clock.advance(BEST_REWARM_MS);
    await until(() => x.llama().some((l) => l.argv), 10_000, "best warmed after the pass");
    expect((await x.r.api("GET", "/dictation")).body).toMatchObject({
      engine: "best",
      verdict: "best on metal",
    });
  });

  test("a final pass that stops the warm server: best waits for it to end, then is warmed again", async () => {
    const clock = new ManualClock();
    let holder: number | null = null;
    const x = await rig(metal, { qwen: true, clock, metalHolder: () => holder });
    await until(() => x.llama().some((l) => l.argv), 10_000, "the warm start");
    await until(() => x.r.app.dictation()?.status().loading === false, 10_000, "the load");
    const pid = x.llama().find((l) => l.argv)?.pid as number;
    // The pass takes the GPU: it stops dictation's server and holds the pid file.
    holder = 4242;
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid), 10_000, "the warm server gone");
    await clock.advance(BEST_REWARM_MS);
    await Bun.sleep(200);
    expect(x.llama().filter((l) => l.argv).length).toBe(1);
    expect((await x.r.api("GET", "/dictation")).body.verdict).toBe(GPU_BUSY_VERDICT);
    holder = null;
    await clock.advance(BEST_REWARM_MS);
    await until(
      () => x.llama().filter((l) => l.argv).length === 2,
      10_000,
      "best warmed after the pass",
    );
  });
});

describe("DC-L3: the audio check on the warm best", () => {
  const chipless = { open: () => {}, chip: () => {}, showInactive: () => {}, hide: () => {} };

  /** A spoken "deploy to kubernetes" through the fake helper, fixed in the box with Fix. */
  async function fixed(engine: string) {
    const dir = scratch();
    const wav = join(dir, "mic.wav");
    writeFileSync(wav, monoWav(concat(speak(["deploy", "to", "kubernetes"]), silence(3))));
    const x = await rig(
      { "dictation.engine": engine, "dictation.enabled": true },
      { qwen: true, helper: ["--wav", wav, "--inserter-log", join(dir, "inserted.jsonl")] },
    );
    const d = x.r.app.dictation();
    if (!d) throw new Error("the app runs no dictation");
    d.draft.attach(chipless);
    await until(() => d.status().state === "idle", 10_000, "the helper ready");
    if (engine === "best")
      await until(
        () => d.status().loading === false && x.llama().some((l) => l.argv),
        10_000,
        "the warm start",
      );
    expect((await x.r.api("POST", "/dictation/start")).status).toBe(200);
    // The fake's mic runs in real time: let the words be spoken before the stop.
    await Bun.sleep(2500);
    expect((await x.r.api("POST", "/dictation/stop")).status).toBe(200);
    await until(() => d.log.items()[0]?.state === "inserted", 10_000, "the insert");
    const id = d.log.items()[0]?.id as string;
    expect(d.log.items()[0]?.text).toBe("deploy to kubernetis");
    expect(d.draft.open(id, { focus: true, fix: true })).toEqual({ ok: true });
    await d.draft.handlers.insert({ id, text: "deploy to Kubernetes", send: false });
    return { x, learn: d.log.events().filter((e) => e.type === "dictation.learn") };
  }

  test("a fix in the box is decoded again on Qwen with the word as context: evidence audio", async () => {
    const { x, learn } = await fixed("best");
    expect(learn).toEqual([
      expect.objectContaining({ term: "Kubernetes", heard: "kubernetis", evidence: "audio" }),
    ]);
    const bodies = x.llama().filter((l) => l.body) as {
      body: { messages: { role: string; content: unknown }[] };
    }[];
    expect(bodies.at(-1)?.body.messages.find((m) => m.role === "system")?.content).toBe(
      "Kubernetes",
    );
  });

  test("positive control: dictating on fast, no check runs and the fix has evidence none", async () => {
    const { x, learn } = await fixed("fast");
    expect(learn).toEqual([expect.objectContaining({ term: "Kubernetes", evidence: "none" })]);
    expect(x.llama().filter((l) => l.body)).toEqual([]);
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
