/**
 * `akou quit` during a Qwen final pass: the app waits its 5 s grace, then stops the pass, Worker
 * and llama-server both, so no llama-server outlives the app holding its gigabytes. The log keeps
 * `final.started`, and the next start's catch-up runs the pass again. Qwen is the fake
 * llama-server, slow to answer its health check, so the pass is still starting Qwen at the quit.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { readLog } from "../src/core/log/reader.ts";
import { EVENTS_FILE } from "../src/core/log/writer.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { appRig, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const home = tempDir("akou-final-quit-");
const reg = modelRegistry();

afterAll(() => {
  reg.stop();
  home.cleanup();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  // A zombie the test process has not reaped is gone for this purpose.
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  return !r.stdout.toString().trim().startsWith("Z");
};

describe("quitting during a Qwen pass", () => {
  test("no llama-server outlives the app, and the log keeps the pass for the next start", async () => {
    const catalog: ModelSpecEntry[] = [
      reg.entry(RECOGNIZER, ["a.onnx"]),
      reg.entry("silero-vad", ["vad.onnx"]),
      reg.entry(NEMOTRON, ["diar.onnx"]),
      { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
    ];
    const models = join(home.dir, "models");
    mkdirSync(models, { recursive: true });
    for (const m of catalog) reg.install(models, m);
    const wav = speechWav(home.dir);
    const llamaLog = join(home.dir, "llama.log");
    const rig = await appRig({
      modelRegistry: catalog,
      helperArgs: ["--wav", wav],
      // A real Worker, as in the app: the quit has to stop it.
      asrInThread: false,
      finalAudio: ({ parts }) => ({
        kind: "wav",
        files: Object.fromEntries(parts.map((p) => [p, wav])),
      }),
      settings: {
        "asr.modelsDir": models,
        "asr.languages": ["en"],
        // Never ready within the test: the pass stays on "starting Qwen".
        "asr.llamaServer": [
          process.execPath,
          FAKE_LLAMA,
          "--fake-log",
          llamaLog,
          "--fake-loading-ms",
          "120000",
        ],
      },
    });
    try {
      await until(() => rig.app.recognizer() === "ready", 20_000, "the recognizer");
      const id = await rig.startCall({});
      await until(
        async () => (await rig.app.events(id, 0)).some((e: LogEvent) => e.type === "seg"),
        20_000,
        "a line",
      );
      expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
      const pid = await (async () => {
        let found = 0;
        await until(
          () => {
            if (!existsSync(llamaLog)) return false;
            const start = readFileSync(llamaLog, "utf8")
              .trim()
              .split("\n")
              .map((l) => JSON.parse(l) as { pid?: number })
              .find((l) => typeof l.pid === "number");
            found = start?.pid ?? 0;
            return found > 0;
          },
          20_000,
          "the pass's llama-server",
        );
        return found;
      })();
      expect(alive(pid)).toBe(true);
      expect((await rig.api("GET", "/status")).body.finals[0]).toMatchObject({
        call: id,
        step: "starting",
        model: QWEN_ASR,
      });
      const folder = (await rig.api("GET", `/calls/${id}`)).body.folder as string;
      await rig.app.quit();
      await until(() => !alive(pid), 10_000, "the llama-server to go with the app");
      const { events } = await readLog(join(folder, EVENTS_FILE));
      // The pass is left for the next start: started, never ended.
      expect(events.findLast((e: LogEvent) => e.type.startsWith("final."))?.type).toBe(
        "final.started",
      );
    } finally {
      // A second quit waits for the first; this one also removes the rig's folder.
      await rig.close();
    }
  });
});
