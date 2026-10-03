/**
 * A file job in the desktop app with the real speech models (akou-5an.119): the app-mode API in a
 * temporary home takes `tests/fixtures/two-voices.wav` with its one local token, runs it on the
 * `fast` preset (Parakeet over the VAD), and the result reads back. The fake-engine cases in
 * `jobs.e2e.test.ts` cover the routes, the token and the CLI; this one proves the same path runs
 * the real recognizer.
 *
 * It needs a models folder with Parakeet and the VAD, named by `AKOU_LIVE_MODELS` (the folder the
 * live-model tests read); without one it is skipped.
 *
 *   AKOU_LIVE_MODELS=<models> bun test tests/app-jobs-models.e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, modelFile, RECOGNIZER } from "../src/main/asr/models.ts";
import { startApp } from "../src/main/index.ts";
import { FAKE_HELPER, NO_GPU, writeSettings } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";

const DIR = process.env.AKOU_LIVE_MODELS;
const NEEDED = [RECOGNIZER, "silero-vad"];
const READY =
  !!DIR &&
  NEEDED.every((id) =>
    (MODELS.find((m) => m.id === id)?.files ?? [{ name: "missing" }]).every((f) =>
      existsSync(modelFile(DIR, id, f.name)),
    ),
  );

const TWO_VOICES = join(import.meta.dir, "fixtures", "two-voices.wav");

describe("akou-5an.119: a file job in the desktop app on the real models", () => {
  test.skipIf(!READY)(
    "two-voices.wav on fast with the local token comes back done with its words (skipped without AKOU_LIVE_MODELS holding Parakeet and the VAD)",
    async () => {
      const home = tempDir("akou-app-jobs-");
      writeSettings(home.dir, {
        "api.port": 0,
        "capture.helper": [process.execPath, FAKE_HELPER],
        "provider.kind": "none",
        "asr.modelsDir": DIR,
        // A job never fetches a model here: the folder is someone else's.
        "server.auto_download": false,
      });
      const app = await startApp({
        env: { AKOU_HOME: home.dir, AKOU_HEADLESS: "1" },
        accelerator: NO_GPU,
      });
      try {
        expect(app.mode()).toBe("app");
        const port = app.server?.port as number;
        const token = readFileSync(app.tokenPath, "utf8").trim();
        const auth = { authorization: `Bearer ${token}` };
        const form = new FormData();
        form.append("file", new Blob([readFileSync(TWO_VOICES)]), "two-voices.wav");
        form.append("preset", "fast");
        form.append("language", "en");
        const sent = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
          method: "POST",
          headers: auth,
          body: form,
        });
        expect(sent.status).toBe(202);
        const { id } = (await sent.json()) as { id: string };
        let job: { status: string; error?: unknown } = { status: "queued" };
        for (let i = 0; i < 5 && ["queued", "running"].includes(job.status); i++) {
          const r = await fetch(`http://127.0.0.1:${port}/v1/jobs/${id}?wait=60`, {
            headers: auth,
          });
          job = (await r.json()) as typeof job;
        }
        expect(job).toMatchObject({ status: "done" });
        const r = await fetch(`http://127.0.0.1:${port}/v1/jobs/${id}/result`, { headers: auth });
        expect(r.status).toBe(200);
        const result = (await r.json()) as {
          text: string;
          segments: unknown[];
          duration_s: number;
          engine: { preset: string };
        };
        expect(result.engine.preset).toBe("fast");
        expect(result.duration_s).toBeGreaterThan(24);
        // The VAD cut the four sentences into more than one piece, and the words came back.
        expect(result.segments.length).toBeGreaterThan(1);
        const text = result.text.toLowerCase();
        for (const w of ["planning", "migration", "cluster", "shared folder"]) {
          expect(text).toContain(w);
        }
      } finally {
        await app.quit();
        home.cleanup();
      }
    },
    300_000,
  );
});
