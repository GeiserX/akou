/**
 * SV-J4 and SV-C1 against the real models: a job that names no model (`preset: auto`, as
 * Telegram-Archive sends it) on a server with Qwen3-ASR on disk runs `best` (SV-R2), and its result
 * names the spoken language as a BCP-47 tag, `en` for an English FLEURS clip and `es` for a Spanish
 * one, with no language in the request. The OpenAI route's `verbose_json` carries the same tag.
 * The failing control is the same Spanish clip on `fast`: Parakeet names no language, so the
 * result carries none. Model-gated, so it never runs in CI's test jobs and never downloads
 * anything. It needs what tests/live-upgrade-qwen.test.ts needs:
 *
 *   AKOU_LIVE_MODELS=<models> AKOU_FLEURS=<data> bun test tests/server-language.test.ts
 *
 * The server writes its last-used ledger into `AKOU_LIVE_MODELS`, and never deletes or fetches a
 * model there (`server.models_unused_days` 0, `server.auto_download` off); point it at a copy when
 * the folder is shared.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEURS } from "../scripts/eval/nightly.ts";
import { QWEN_ASR, QWEN_MODEL_FILE } from "../src/main/asr/llama-catalog.ts";
import { modelFile } from "../src/main/asr/models.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { asKey, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

const MODELS = process.env.AKOU_LIVE_MODELS;
const DATA = process.env.AKOU_FLEURS;
const READY = !!MODELS && !!DATA && existsSync(modelFile(MODELS, QWEN_ASR, QWEN_MODEL_FILE));
const LONG = 20 * 60_000;

setDefaultTimeout(LONG);

/** The first clip of the benchmark's FLEURS subset of a language, as the WAV file it is. */
function clip(lang: "en" | "es"): Uint8Array {
  const set = FLEURS.sets[lang];
  const ids = (
    JSON.parse(
      readFileSync(join(import.meta.dir, "..", "docs", "research", "asr-benchmark.json"), "utf8"),
    ) as { fleurs_ids: Record<string, string[]> }
  ).fleurs_ids[set.ids] as string[];
  return new Uint8Array(
    readFileSync(join(DATA as string, "fleurs", set.config, "test", `${ids[0]}.wav`)),
  );
}

let rig: AppRig;
let key: Key;

beforeAll(async () => {
  if (!READY) return;
  rig = await appRig({
    realModels: true,
    settings: {
      ...SERVER,
      "asr.modelsDir": MODELS,
      "server.auto_download": false,
      "server.models_unused_days": 0,
    },
  });
  await until(() => rig.app.recognizer() === "ready", 5 * 60_000, "the recognizer");
  key = await newKey(rig, "archive");
}, LONG);

afterAll(async () => {
  await rig?.close();
});

async function result(fields: Record<string, string>, audio: Uint8Array) {
  const s = await submit(rig, key.key, audio, fields);
  expect(s.status).toBe(202);
  let j = await asKey(rig, key.key, "GET", `/jobs/${s.body.id}?wait=60`);
  while (j.body.status === "queued" || j.body.status === "running")
    j = await asKey(rig, key.key, "GET", `/jobs/${s.body.id}?wait=60`);
  expect(`${j.body.status} ${j.body.error?.message ?? ""}`).toBe("done ");
  return { job: j.body, res: (await asKey(rig, key.key, "GET", `/jobs/${s.body.id}/result`)).body };
}

describe("[SV-J4] a job with no opinion names the language it heard", () => {
  test.skipIf(!READY)(
    "auto runs best here, and an English and a Spanish clip come back en and es (skipped: needs AKOU_LIVE_MODELS with Qwen, and AKOU_FLEURS)",
    async () => {
      const auto = (await rig.api("GET", "/server")).body.auto;
      expect(auto).toMatchObject({ preset: "best", model: QWEN_ASR });
      for (const lang of ["en", "es"] as const) {
        const { job, res } = await result({ preset: "auto", language: "auto" }, clip(lang));
        expect([lang, job.model_source, res.engine.models[0], res.language]).toEqual([
          lang,
          "hardware",
          QWEN_ASR,
          lang,
        ]);
        expect(res.text.length).toBeGreaterThan(20);
      }
    },
  );

  test.skipIf(!READY)(
    "[SV-C1] the OpenAI route's verbose_json carries the same tag with no language asked",
    async () => {
      const form = new FormData();
      form.append("file", new Blob([clip("es")], { type: "audio/wav" }), "es.wav");
      form.append("model", "whisper-1");
      form.append("response_format", "verbose_json");
      const r = await fetch(`http://127.0.0.1:${rig.port}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}` },
        body: form,
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { language: string }).language).toBe("es");
    },
  );

  test.skipIf(!READY)(
    "failing control: the same Spanish clip on fast carries no language, since Parakeet names none",
    async () => {
      const { res } = await result({ preset: "fast", language: "auto" }, clip("es"));
      expect(res.engine.models[0]).not.toBe(QWEN_ASR);
      expect(res.language).toBeNull();
    },
  );
});
