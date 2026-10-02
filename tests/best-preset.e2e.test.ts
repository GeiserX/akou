/**
 * akou-5an.93: the `best` preset on server jobs, end to end through the real API. `best` is
 * Qwen3-ASR-1.7B through llama-server with Nemotron speaker labels; a job names it with
 * `preset: best`, and the server makes it its own default with `server.default_model: best`.
 * The engine is the fake llama-server (`asr.llamaServer`), the VAD and speaker models the fake
 * model set, so nothing downloads.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { llamaRuntime } from "../src/main/asr/llama-server.ts";
import { hostPlatform, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";
import { asKey, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");

/** Two voices, as a voice note with two people in it. */
const DIALOGUE = monoWav(
  concat(
    silence(0.4),
    speak(["hello", "world"], { voice: 1 }),
    silence(1.2),
    speak(["ok", "great"], { voice: 4 }),
    silence(0.6),
  ),
);

let rig: AppRig;
let key: Key;
let log: string;
const scratch = tempDir("akou-best-");

beforeAll(async () => {
  log = join(scratch.dir, "llama.log");
  rig = await appRig({
    settings: {
      ...SERVER,
      "asr.llamaServer": [process.execPath, FAKE_LLAMA, "--fake-log", log],
    },
  });
  key = await newKey(rig, "archive");
});

afterAll(async () => {
  await rig.close();
  scratch.cleanup();
});

async function done(id: string) {
  const r = await asKey(rig, key.key, "GET", `/jobs/${id}?wait=30`);
  expect(`${r.body.status} ${r.body.error?.message ?? ""}`).toBe("done ");
  return (await asKey(rig, key.key, "GET", `/jobs/${id}/result`)).body;
}

function requests(): { messages: { role: string; content: unknown }[] }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((l) => l.body)
    .map((l) => l.body);
}

describe("akou-5an.93: preset best", () => {
  test("GET /v1/server lists best as available, over the Qwen engine", async () => {
    const r = await asKey(rig, key.key, "GET", "/server");
    const best = r.body.presets.find((p: { name: string }) => p.name === "best");
    expect(best).toMatchObject({ available: true, engines: [QWEN_ASR] });
    const engine = r.body.engines.find((e: { id: string }) => e.id === QWEN_ASR);
    expect(engine).toBeDefined();
    expect(["cpu", "metal", "vulkan", "cuda", "custom"]).toContain(engine.provider);
  });

  test("an English note with diarize: done, Qwen and Nemotron named, speakers on the lines", async () => {
    const s = await submit(rig, key.key, DIALOGUE, {
      preset: "best",
      diarize: "true",
      language: "auto",
      metadata: JSON.stringify({ chat: 1 }),
    });
    expect(s.status).toBe(202);
    const res = await done(s.body.id);
    expect(res.engine.preset).toBe("best");
    expect(res.engine.models).toEqual([QWEN_ASR, "silero-vad", NEMOTRON]);
    expect(res.language).toBe("en");
    expect(res.text).toBe("hello world ok great");
    expect(res.segments.map((x: { speaker: string }) => x.speaker)).toEqual(["s0", "s1"]);
    expect(res.metadata).toEqual({ chat: 1 });
  });

  test("a Spanish note: the language is forced, and comes back as es", async () => {
    const before = requests().length;
    const s = await submit(rig, key.key, DIALOGUE, {
      preset: "best",
      diarize: "true",
      language: "es",
    });
    const res = await done(s.body.id);
    expect(res.language).toBe("es");
    expect(res.engine.models[0]).toBe(QWEN_ASR);
    expect(res.segments.every((x: { speaker: string | null }) => x.speaker !== null)).toBe(true);
    // Each piece: the auto decode (the fake hears English), then the forced Spanish one.
    const sent = requests()
      .slice(before)
      .filter((b) => (b.messages.at(-1) as { role: string }).role === "assistant");
    expect(sent.length).toBeGreaterThan(0);
    for (const b of sent) {
      expect(b.messages.at(-1)).toEqual({
        role: "assistant",
        content: "language Spanish<asr_text>",
      });
    }
  });

  test("keywords reach Qwen as its context", async () => {
    const before = requests().length;
    const s = await submit(
      rig,
      key.key,
      monoWav(concat(silence(0.3), speak(["hetzner"]), silence(0.5))),
      {
        preset: "best",
        "keywords[]": "Hetzner",
      },
    );
    const res = await done(s.body.id);
    expect(res.text).toBe("Hetzner");
    expect(requests()[before]?.messages[0]).toEqual({ role: "system", content: "Hetzner" });
  });

  test("server.default_model best: a job that names nothing (the archive's preset auto) runs Qwen", async () => {
    const admin = await newKey(rig, "admin", "admin");
    const p = await asKey(rig, admin.key, "PATCH", "/config", { "server.default_model": "best" });
    expect(p.status).toBe(200);
    try {
      const s = await submit(rig, key.key, DIALOGUE, { preset: "auto" });
      const job = await asKey(rig, key.key, "GET", `/jobs/${s.body.id}?wait=30`);
      expect(job.body).toMatchObject({
        status: "done",
        model: QWEN_ASR,
        model_source: "server_default",
      });
      // Positive control: the same request naming fast runs Parakeet's engine, not Qwen.
      const f = await submit(rig, key.key, DIALOGUE, { preset: "fast" });
      const fj = await asKey(rig, key.key, "GET", `/jobs/${f.body.id}?wait=30`);
      expect(fj.body.model).not.toBe(QWEN_ASR);
    } finally {
      await asKey(rig, admin.key, "PATCH", "/config", { "server.default_model": "auto" });
    }
  });
});

describe("akou-5an.93: best is listed available only when a job on it can run", () => {
  test("auto_download off and Qwen not on disk: unavailable; once its files are there: available", async () => {
    const reg = modelRegistry();
    const build = llamaRuntime(
      { "asr.accelerator": "auto", "asr.llamaServer": [] },
      hostPlatform(),
    ) as string;
    const catalog = [
      reg.entry(RECOGNIZER, ["a.onnx"]),
      reg.entry("silero-vad", ["vad.onnx"]),
      reg.entry(NEMOTRON, ["diar.onnx"]),
      reg.entry(QWEN_ASR, ["q.gguf", "p.gguf"]),
      reg.entry(build, ["llama.tar.gz"]),
    ];
    const t = tempDir("akou-best-avail-");
    const models = join(t.dir, "models");
    for (const e of catalog.slice(0, 3)) reg.install(models, e);
    const r = await appRig({
      modelRegistry: catalog,
      settings: { ...SERVER, "asr.modelsDir": models, "server.auto_download": false },
      jobs: { modelStore: { freeBytes: () => 1e12 } },
    });
    const best = async () =>
      (await r.api("GET", "/server")).body as { presets: { name: string; available: boolean }[] };
    try {
      const pick = (b: Awaited<ReturnType<typeof best>>, n: string) =>
        b.presets.find((p) => p.name === n)?.available;
      const before = await best();
      expect(pick(before, "best")).toBe(false);
      // With downloads allowed the same missing files are no obstacle: a job would fetch them.
      const on = await r.api("PATCH", "/config", { "server.auto_download": true });
      expect(on.status).toBe(200);
      expect(pick(await best(), "best")).toBe(true);
      await r.api("PATCH", "/config", { "server.auto_download": false });
      expect(pick(await best(), "best")).toBe(false);
      reg.install(models, catalog[3] as (typeof catalog)[number]);
      reg.install(models, catalog[4] as (typeof catalog)[number]);
      expect(pick(await best(), "best")).toBe(true);
    } finally {
      await r.close();
      reg.stop();
      t.cleanup();
    }
  });
});

describe("lidc on the server: asr.languages", () => {
  test("a language outside asr.languages is replaced by the better forced decode", async () => {
    const t = tempDir("akou-best-lidc-");
    const r = await appRig({
      settings: {
        ...SERVER,
        "asr.languages": ["en", "es"],
        "asr.llamaServer": [
          process.execPath,
          FAKE_LLAMA,
          "--fake-lang",
          "Chinese",
          "--fake-lp",
          "Spanish=-0.1",
          "--fake-lp",
          "English=-2",
        ],
      },
    });
    try {
      const k = await newKey(r, "archive");
      const s = await submit(r, k.key, DIALOGUE, { preset: "best" });
      const j = await asKey(r, k.key, "GET", `/jobs/${s.body.id}?wait=30`);
      expect(j.body.status).toBe("done");
      const res = (await asKey(r, k.key, "GET", `/jobs/${s.body.id}/result`)).body;
      expect(res.language).toBe("es");
    } finally {
      await r.close();
      t.cleanup();
    }
  });
});

describe("akou-5an.106: lidc per job, languages[]", () => {
  // The fake hears Chinese on auto; forced, Spanish scores better than English.
  const CHINESE = [
    process.execPath,
    FAKE_LLAMA,
    "--fake-lang",
    "Chinese",
    "--fake-lp",
    "Spanish=-0.1",
    "--fake-lp",
    "English=-2",
  ];
  let r: AppRig;
  let k: Key;

  beforeAll(async () => {
    r = await appRig({ settings: { ...SERVER, "asr.llamaServer": CHINESE } });
    k = await newKey(r, "archive");
  });

  afterAll(async () => {
    await r?.close();
  });

  async function languageOf(fields: Record<string, string>) {
    const s = await submit(r, k.key, DIALOGUE, { preset: "best", ...fields });
    expect(s.status).toBe(202);
    const j = await asKey(r, k.key, "GET", `/jobs/${s.body.id}?wait=30`);
    expect(`${j.body.status} ${j.body.error?.message ?? ""}`).toBe("done ");
    return {
      job: j.body,
      language: (await asKey(r, k.key, "GET", `/jobs/${s.body.id}/result`)).body.language,
    };
  }

  test("a clip Qwen names Chinese comes back in a listed language, and the job echoes the list", async () => {
    const bound = await languageOf({ "languages[]": "es,EN" });
    // Spanish: the forced decode among the listed ones that scores higher.
    expect(bound.language).toBe("es");
    expect(bound.job.languages).toEqual(["es", "en"]);
    // Positive control: no list and asr.languages empty, so whatever the model names stands.
    const free = await languageOf({});
    expect(free.language).toBe("zh");
    expect(free.job.languages).toEqual([]);
  });

  test("the request's list wins over asr.languages; with none, asr.languages bounds it", async () => {
    const admin = await newKey(r, "admin", "admin");
    expect(
      (await asKey(r, admin.key, "PATCH", "/config", { "asr.languages": ["en"] })).status,
    ).toBe(200);
    try {
      expect((await languageOf({})).language).toBe("en");
      expect((await languageOf({ "languages[]": "es" })).language).toBe("es");
    } finally {
      await asKey(r, admin.key, "PATCH", "/config", { "asr.languages": [] });
    }
  });

  test("a code no engine here can choose is refused with 422, never dropped", async () => {
    const s = await submit(r, k.key, DIALOGUE, { preset: "best", "languages[]": "es,bg" });
    expect(s.status).toBe(422);
    expect(s.body).toMatchObject({ error: "unsupported_language", codes: ["bg"] });
    const bad = await submit(r, k.key, DIALOGUE, { preset: "best", "languages[]": "spanish" });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ error: "bad_field", field: "languages[]" });
    // The OpenAI door refuses it the same way.
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(DIALOGUE)], { type: "audio/wav" }), "a.wav");
    form.append("model", "best");
    form.append("languages[]", "bg");
    const o = await fetch(`http://127.0.0.1:${r.port}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${k.key}` },
      body: form,
    });
    expect(o.status).toBe(422);
    expect(((await o.json()) as { error: string }).error).toBe("unsupported_language");
  });

  test("the OpenAI door bounds auto with languages[] too", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(DIALOGUE)], { type: "audio/wav" }), "a.wav");
    form.append("model", "best");
    form.append("response_format", "verbose_json");
    form.append("languages[]", "es");
    form.append("languages[]", "en");
    const o = await fetch(`http://127.0.0.1:${r.port}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${k.key}` },
      body: form,
    });
    expect(o.status).toBe(200);
    expect(((await o.json()) as { language: string }).language).toBe("es");
  });

  test("languages[] is in the Idempotency-Key fingerprint, in any order and case", async () => {
    const send = async (languages: string) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(DIALOGUE)], { type: "audio/wav" }), "a.wav");
      form.append("preset", "best");
      form.append("languages[]", languages);
      const res = await fetch(`http://127.0.0.1:${r.port}/v1/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${k.key}`, "idempotency-key": "lang-fp-1" },
        body: form,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const first = await send("es,en");
    expect(first.status).toBe(202);
    const same = await send("EN, es");
    expect(same.status).toBe(200);
    expect(same.body.id).toBe(first.body.id);
    const other = await send("es");
    expect(other.status).toBe(422);
    expect(other.body).toMatchObject({
      error: "idempotency_conflict",
      id: first.body.id,
      fields: ["languages"],
    });
    // Without a key, two submits differing only in languages are two jobs.
    const a = await submit(r, k.key, DIALOGUE, { preset: "best", "languages[]": "es" });
    const b = await submit(r, k.key, DIALOGUE, { preset: "best", "languages[]": "en" });
    expect(a.body.id).not.toBe(b.body.id);
    for (const id of [first.body.id, a.body.id, b.body.id]) {
      await asKey(r, k.key, "GET", `/jobs/${id}?wait=30`);
    }
  });

  test("GET /v1/server says jobs take languages[], and which codes", async () => {
    const s = (await asKey(r, k.key, "GET", "/server")).body;
    expect(s.capabilities.languages_bound).toBe(true);
    expect(s.bound_languages).toContain("es");
    expect(s.bound_languages).toContain("yue");
    expect(s.bound_languages).not.toContain("bg");
  });
});
