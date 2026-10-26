/**
 * The translate task end to end through the real API (`task=translate` on `POST /v1/jobs`,
 * `POST /v1/audio/translations`), with the fake model set: the test module's `createEngine` stands
 * in for Canary and Whisper on transcribe-cpp, so nothing downloads. The engine is chosen by the
 * source language; the result is English and keeps the source; a language no engine reads is 422.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CANARY_1B_V2, WHISPER_LARGE_V3 } from "../src/main/asr/models.ts";
import { TRANSLATE_LANGUAGES } from "../src/main/asr/transcribe-cpp.ts";
import { RemoteError, Remotes } from "../src/main/server/remotes.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";
import { asKey, clip, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const NOTE = clip(["hello", "world"], 3);

describe("task=translate through the API, with fakes", () => {
  let rig: AppRig;
  let key: Key;
  beforeAll(async () => {
    rig = await appRig({ settings: { ...SERVER } });
    key = await newKey(rig, "translator");
  });
  afterAll(async () => {
    await rig.close();
  });

  async function done(id: string) {
    const r = await asKey(rig, key.key, "GET", `/jobs/${id}?wait=30`);
    expect(`${r.body.status} ${r.body.error?.message ?? ""}`).toBe("done ");
    return { job: r.body, result: (await asKey(rig, key.key, "GET", `/jobs/${id}/result`)).body };
  }

  test("POST /v1/jobs task=translate: Canary for Spanish, an English result that keeps its source and times", async () => {
    const r = await submit(rig, key.key, NOTE, { task: "translate", language: "es" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      task: "translate",
      model: CANARY_1B_V2,
      language: "es",
      preset: "custom",
    });
    const { job, result } = await done(r.body.id);
    expect(job.task).toBe("translate");
    expect(result).toMatchObject({
      language: "en",
      source_language: "es",
      task: "translate",
      text: "hello world",
    });
    expect(result.engine.models).toContain(CANARY_1B_V2);
    expect(result.segments.length).toBeGreaterThan(0);
    for (const s of result.segments) expect(s.e).toBeGreaterThan(s.s);
    // The OpenAI shape of the result says the same.
    const v = await asKey(rig, key.key, "GET", `/jobs/${r.body.id}/result?format=verbose_json`);
    expect([v.body.task, v.body.language]).toEqual(["translate", "en"]);
  });

  test("auto, or a language Canary does not read, runs Whisper; the heard source is kept", async () => {
    const auto = await submit(rig, key.key, NOTE, { task: "translate", language: "auto" });
    expect(auto.body.model).toBe(WHISPER_LARGE_V3);
    const { result } = await done(auto.body.id);
    // The fake engine hears English on auto, as Whisper would name whatever it detected.
    expect([result.language, result.source_language]).toEqual(["en", "en"]);
    const ja = await submit(rig, key.key, NOTE, { task: "translate", language: "ja" });
    expect(ja.body.model).toBe(WHISPER_LARGE_V3);
    expect((await done(ja.body.id)).result.source_language).toBe("ja");
  });

  test("positive control: the same file without task transcribes, with no source_language", async () => {
    const r = await submit(rig, key.key, NOTE, { language: "es" });
    expect(r.body.task).toBe("transcribe");
    expect(r.body.model).not.toBe(CANARY_1B_V2);
    const { result } = await done(r.body.id);
    expect(result.language).toBe("es");
    expect("source_language" in result).toBe(false);
  });

  test("refusals: a language no engine reads, Canary on auto, another model, an unknown task", async () => {
    const tlh = await submit(rig, key.key, NOTE, { task: "translate", language: "tlh" });
    expect([tlh.status, tlh.body.error, tlh.body.field]).toEqual([
      422,
      "unsupported_language",
      "language",
    ]);
    const canaryAuto = await submit(rig, key.key, NOTE, {
      task: "translate",
      model: CANARY_1B_V2,
    });
    expect([canaryAuto.status, canaryAuto.body.error]).toEqual([422, "unsupported_language"]);
    const other = await submit(rig, key.key, NOTE, {
      task: "translate",
      language: "es",
      model: "parakeet-tdt-0.6b-v3",
    });
    expect([other.status, other.body.error, other.body.field]).toEqual([422, "bad_field", "model"]);
    const bad = await submit(rig, key.key, NOTE, { task: "summarize" });
    expect([bad.status, bad.body.error, bad.body.field]).toEqual([422, "bad_field", "task"]);
    // A named engine that reads the language is used.
    const named = await submit(rig, key.key, NOTE, {
      task: "translate",
      language: "es",
      model: WHISPER_LARGE_V3,
    });
    expect([named.status, named.body.model]).toEqual([202, WHISPER_LARGE_V3]);
    await done(named.body.id);
  });

  test("a retried Idempotency-Key with another task answers 422 idempotency_conflict naming task", async () => {
    const send = (task?: string) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(NOTE)], { type: "audio/wav" }), "note.wav");
      form.append("language", "es");
      if (task) form.append("task", task);
      return fetch(`http://127.0.0.1:${rig.port}/v1/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}`, "idempotency-key": "translate-once" },
        body: form,
      });
    };
    const first = await send("translate");
    expect(first.status).toBe(202);
    const again = await send("translate");
    expect(again.status).toBe(200);
    const other = await send();
    expect(other.status).toBe(422);
    expect(await other.json()).toMatchObject({ error: "idempotency_conflict", fields: ["task"] });
    await done(((await first.json()) as { id: string }).id);
  });

  test("/v1/audio/translations: OpenAI shape, verbose_json task translate, language en", async () => {
    const send = async (fields: Record<string, string>) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(NOTE)], { type: "audio/wav" }), "note.wav");
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      const res = await fetch(`http://127.0.0.1:${rig.port}/v1/audio/translations`, {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}` },
        body: form,
      });
      return { status: res.status, text: await res.text() };
    };
    const v = await send({ model: "whisper-1", response_format: "verbose_json" });
    expect(v.status).toBe(200);
    const body = JSON.parse(v.text);
    expect(body).toMatchObject({ task: "translate", language: "en", text: "hello world" });
    expect(body.segments.length).toBeGreaterThan(0);
    const srt = await send({ language: "es", response_format: "srt" });
    expect(srt.status).toBe(200);
    expect(srt.text).toContain("-->");
    expect(srt.text).toContain("hello world");
    const json = await send({ language: "es", temperature: "0", prompt: "planning" });
    expect(JSON.parse(json.text)).toMatchObject({ text: "hello world" });
    const tlh = await send({ language: "tlh" });
    expect([tlh.status, JSON.parse(tlh.text).error]).toEqual([422, "unsupported_language"]);
    // A translation has no speakers: diarized_json is refused rather than labelled a transcript.
    const diarized = await send({ language: "es", response_format: "diarized_json" });
    expect([diarized.status, JSON.parse(diarized.text).field]).toEqual([422, "response_format"]);
    // Only the fields the route declares: the transcription's others are refused, not half-applied.
    for (const [k, v] of [
      ["stream", "true"],
      ["interactive", "true"],
      ["timestamp_granularities[]", "word"],
      ["metadata", "{}"],
    ]) {
      const r = await send({ language: "es", [k as string]: v as string });
      expect([k, r.status, JSON.parse(r.text).error]).toEqual([k, 400, "unknown_field"]);
    }
  });

  test("GET /v1/server: capabilities.translate and the source languages", async () => {
    const r = await asKey(rig, key.key, "GET", "/server");
    expect(r.body.capabilities.translate).toBe(true);
    expect(r.body.translate_languages).toEqual([...TRANSLATE_LANGUAGES]);
    expect(r.body.translate_languages).toContain("ja");
  });
});

describe("a translate job forwarded to a remote", () => {
  const url = "http://remote.example";
  function remotes(answer: (form: FormData) => Response) {
    const dir = tempDir("akou-remote-translate-").dir;
    const keyFile = join(dir, "worker.key");
    writeFileSync(keyFile, "ak_x\n", { mode: 0o600 });
    const sent: FormData[] = [];
    const r = new Remotes({
      entries: () => [`${url} ${keyFile}`],
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        const form = init?.body as FormData;
        sent.push(form);
        return answer(form);
      }) as unknown as typeof fetch,
      log: () => {},
    });
    expect(r.configured()).toBe(true);
    return { r, sent };
  }
  const job = (task?: "translate") => ({
    id: "job_1",
    audio: join(import.meta.dir, "fixtures", "two-voices.wav"),
    language: "es",
    keywords: [],
    languages: [],
    diarize: false,
    model: CANARY_1B_V2,
    ...(task ? { task } : {}),
  });

  test("the task is sent only for a translate job, and an older remote's 400 unknown_field is a rejection, so the job runs here", async () => {
    // A remote from before the field: it refuses any field it does not know.
    const old = remotes((form) =>
      form.has("task")
        ? Response.json({ error: "unknown_field", field: "task" }, { status: 400 })
        : Response.json({ id: "remote_1" }, { status: 202 }),
    );
    const err = await old.r.submit(url, job("translate")).catch((e: unknown) => e);
    expect(old.sent[0]?.get("task")).toBe("translate");
    expect(err).toBeInstanceOf(RemoteError);
    expect([(err as RemoteError).kind, (err as RemoteError).status]).toEqual(["rejected", 400]);
    // Positive control: a transcribe job sends no task, and the same remote takes it.
    expect(await old.r.submit(url, job())).toBe("remote_1");
    expect(old.sent[1]?.has("task")).toBe(false);
  });
});
