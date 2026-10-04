/**
 * An idle desktop app gives back the memory a call loaded (`asr.modelIdleMinutes`). The app runs in
 * a process of its own (`tests/fixtures/idle-app.ts`) on the real speech models with dictation on,
 * and its memory is read with `footprint`, which counts the compressed and swapped pages that RSS
 * hides: the reference Mac's app held 3.7 GB idle with 56 MB resident.
 *
 * A fresh start holds what a dictation needs to start fast: the streaming model. A short call and
 * its final pass load Parakeet on top of it, and a few dictations run on the streaming model. One
 * idle minute later the app must be back within `MARGIN_MB` of its fresh start. Before the fix a
 * fresh start already held Parakeet and the app never let it go: idle matched the fresh start
 * because both held it, so the check that the call adds Parakeet to a fresh start is the one that
 * fails there.
 *
 * It needs macOS (`footprint`) and a models folder in `AKOU_LIVE_MODELS` with Parakeet, the VAD and
 * `nemotron-3.5-560`; without them it is skipped. It takes about three minutes:
 *
 *   AKOU_LIVE_MODELS=<models> bun test tests/idle-memory.e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, modelFile, RECOGNIZER } from "../src/main/asr/models.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { FAKE_HELPER, writeSettings } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { monoWav, stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const DIR = process.env.AKOU_LIVE_MODELS;
/** The streaming model a dictation in English and Spanish runs on. */
const STREAM = "nemotron-3.5-560";
const NEEDED = [RECOGNIZER, "silero-vad", STREAM];
const READY =
  process.platform === "darwin" &&
  !!DIR &&
  NEEDED.every((id) =>
    (MODELS.find((m) => m.id === id)?.files ?? [{ name: "missing" }]).every((f) =>
      existsSync(modelFile(DIR, id, f.name)),
    ),
  );

/**
 * How far over its fresh start an idle app may be, MB. Parakeet alone is about 2.2 GB, the
 * streaming model about 1.8 GB. Over seven runs on a busy 16 GB Mac the idle app read from 1,158 MB
 * under to 529 MB over its fresh start (the allocator's freed small regions and swap), so the
 * margin is well above that spread and below Parakeet, which an app that never lets go keeps.
 */
const MARGIN_MB = 1000;
/**
 * Less than Parakeet adds to the footprint when it loads (2.2 GB measured), and more than a call
 * adds when Parakeet is loaded already (up to 850 MB measured on a busy Mac).
 */
const PARAKEET_MB = 1500;
const CALL_SECONDS = 20;
const DICTATIONS = 5;
const MB = 1024 * 1024;

const FIXTURE = join(import.meta.dir, "fixtures", "idle-app.ts");
const VOICES = join(import.meta.dir, "fixtures", "two-voices.wav");

/** The process's footprint, MB, as `footprint` reads it. */
function footprintMb(pid: number): number {
  const out = Bun.spawnSync(["footprint", "-p", String(pid), "-f", "bytes"]).stdout.toString();
  const m = /Footprint: (\d+) B/.exec(out);
  if (!m) throw new Error(`footprint gave no total: ${out.slice(0, 200)}`);
  return Math.round(Number(m[1]) / MB);
}

describe("an idle app gives back what a call loaded", () => {
  test.skipIf(!READY)(
    "a fresh start holds no Parakeet, a call loads it, and an idle minute after the call and a few dictations the app is back within 1000 MB of its fresh start (skipped off macOS, or without AKOU_LIVE_MODELS holding Parakeet, the VAD and nemotron-3.5-560)",
    async () => {
      const home = tempDir("akou-idle-");
      // The call plays two-voices.wav on both sides, the call side 12 s behind, for its whole length.
      const voices = await readUploadAudio(VOICES);
      const n = (CALL_SECONDS + 5) * 16_000;
      const loop = (off: number) =>
        Float32Array.from({ length: n }, (_, i) => voices[(i + off) % voices.length] as number);
      const wav = join(home.dir, "call.wav");
      writeFileSync(wav, stereoWav(loop(0), loop(12 * 16_000)));
      const clip = monoWav(voices.subarray(0, 6 * 16_000));
      writeSettings(home.dir, {
        "api.port": 0,
        "capture.helper": [process.execPath, FAKE_HELPER, "--wav", wav],
        "provider.kind": "none",
        "asr.modelsDir": DIR,
        "asr.languages": ["en", "es"],
        // Parakeet in the final pass's Worker too, with no llama-server to need.
        "asr.final.model": "parakeet",
        "asr.modelIdleMinutes": 1,
        "dictation.enabled": true,
        "server.auto_download": false,
      });
      const child = Bun.spawn([process.execPath, FIXTURE], {
        env: {
          ...process.env,
          AKOU_HOME: home.dir,
          AKOU_IDLE_CALL_WAV: wav,
          AKOU_NO_DOWNLOAD: "1",
          NO_PROXY: "127.0.0.1,localhost",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: Bun.file(join(home.dir, "app.log")),
      });
      try {
        const reader = child.stdout.getReader();
        let first = "";
        while (!first.includes("\n")) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`the app quit: ${readFileSync(join(home.dir, "app.log"))}`);
          first += new TextDecoder().decode(value);
        }
        const { port, token } = JSON.parse(first) as { port: number; token: string };
        const headers = { authorization: `Bearer ${token}`, "x-akou-client": "test" };
        const api = async <T>(method: string, path: string, body?: unknown) => {
          const r = await fetch(`http://127.0.0.1:${port}/v1${path}`, {
            method,
            headers: { ...headers, "content-type": "application/json" },
            body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
          });
          return { status: r.status, body: (await r.json()) as T };
        };
        type Status = { asr?: { state?: string; loads?: Record<string, number> } };

        // Fresh: the recognizer started and the dictation's model loaded ahead of any press.
        await until(
          async () => {
            const st = (await api<Status>("GET", "/status")).body;
            return st.asr?.state === "ready" && (st.asr?.loads?.[STREAM] ?? 0) > 0;
          },
          180_000,
          "the dictation's models",
        );
        await until(
          async () => (await api<{ loading: boolean }>("GET", "/dictation")).body.loading === false,
          60_000,
          "the warm-up",
        );
        await Bun.sleep(5000);
        const fresh = footprintMb(child.pid);

        // A short call and its final pass.
        const started = await api<{ call: string }>("POST", "/calls", {
          workspace: "work",
          title: "Idle",
        });
        expect(started.status).toBe(201);
        const call = started.body.call;
        await Bun.sleep(CALL_SECONDS * 1000);
        expect((await api("POST", "/calls/live/stop")).status).toBe(200);
        await until(
          async () =>
            (await api<{ final?: { state: string } }>("GET", `/calls/${call}`)).body.final
              ?.state === "done",
          300_000,
          "the final pass",
        );
        const afterCall = footprintMb(child.pid);

        // A few dictations, on the streaming model.
        for (let i = 0; i < DICTATIONS; i++) {
          const form = new FormData();
          form.append("file", new Blob([clip]), "clip.wav");
          const r = await fetch(`http://127.0.0.1:${port}/v1/dictations`, {
            method: "POST",
            headers,
            body: form,
          });
          expect(r.status).toBe(200);
          expect(((await r.json()) as { engine: string }).engine).toBe("live");
        }

        // Idle: the models' minute runs out, Parakeet goes and the streaming model loads again.
        let idle = footprintMb(child.pid);
        const end = Date.now() + 150_000;
        while (idle > fresh + MARGIN_MB && Date.now() < end) {
          await Bun.sleep(5000);
          idle = footprintMb(child.pid);
        }
        // Read it again once the dictation's model is loaded back, as the app sits from then on.
        await until(
          async () => (await api<{ loading: boolean }>("GET", "/dictation")).body.loading === false,
          60_000,
          "the dictation's models loaded again",
        );
        await Bun.sleep(5000);
        idle = footprintMb(child.pid);
        console.log(
          `footprint: fresh ${fresh} MB, after the call ${afterCall} MB, idle ${idle} MB`,
        );
        // A fresh start holds no Parakeet, so the call's load of it shows; the idle app lets it go.
        expect(afterCall - fresh).toBeGreaterThan(PARAKEET_MB);
        expect(idle).toBeLessThanOrEqual(fresh + MARGIN_MB);
      } finally {
        child.stdin.end();
        const quit = await Promise.race([child.exited, Bun.sleep(20_000).then(() => null)]);
        if (quit === null) child.kill();
        home.cleanup();
      }
    },
    600_000,
  );
});
