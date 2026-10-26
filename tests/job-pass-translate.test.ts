/**
 * A translate job's engine in the job Worker (`ModelSpec.translate`): kept loaded across jobs as
 * Qwen's llama-server is, freed when the Worker closes, and stopped mid-decode when its job is
 * cancelled. The engine is the test module's `createEngine`, which notes its loads, unloads and
 * aborted decodes in a file, since it runs in the Worker's thread.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobWorker } from "../src/main/asr/finalize-worker.ts";
import { CANARY_1B_V2 } from "../src/main/asr/models.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "akou-job-translate-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const workers: JobWorker[] = [];
afterEach(() => {
  for (const w of workers.splice(0)) w.cancel();
});

function worker(name: string, options: Record<string, unknown>, releaseMs?: number) {
  const events = join(dir, `${name}.events`);
  const o = { engineEvents: events, ...options };
  const w = new JobWorker(
    {
      kind: "module",
      path: FAKE,
      model: "fake-parakeet",
      options: o,
      translate: { kind: "module", path: FAKE, engine: CANARY_1B_V2, options: o },
    },
    undefined,
    releaseMs,
  );
  workers.push(w);
  const read = () => (existsSync(events) ? readFileSync(events, "utf8").trim().split("\n") : []);
  return { w, read };
}

const clip = () => concat(silence(0.3), speak(["deploy", "today"]), silence(0.5));

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond() && performance.now() < end) await Bun.sleep(10);
}

describe("[bun#45252 / transcribe-cpp] a translate job's engine in the job Worker", () => {
  test("the translate engine decodes the job, reports its source, and stays loaded across two jobs until the Worker closes", async () => {
    const { w, read } = worker("kept", {});
    const a = await w.run({ samples: clip(), diarize: false, decode: null, language: "es" });
    expect(a.model).toBe(CANARY_1B_V2);
    expect(a.language).toBe("es");
    expect(a.segments.map((s) => s.text)).toEqual(["deploy today"]);
    // Segments keep their times, so subtitles can be built from them.
    expect(a.segments[0]?.e ?? 0).toBeGreaterThan(a.segments[0]?.s ?? 0);
    await w.run({ samples: clip(), diarize: false, decode: null, language: "es" });
    expect(read()).toEqual([`load ${CANARY_1B_V2}`]);
    w.close();
    await until(() => read().length > 1);
    expect(read()).toEqual([`load ${CANARY_1B_V2}`, `unload ${CANARY_1B_V2}`]);
  });

  test("a cancelled translate job aborts the decode in flight, frees the engine, then the Worker ends", async () => {
    // Positive control: the fake decode blocks for good when no signal reaches it, so the engine
    // is never freed and only `releaseMs` (30 s) would end the Worker.
    const { w, read } = worker("cancel", { engineBlocks: true }, 30_000);
    const run = w.run({ samples: clip(), diarize: false, decode: null, language: "es" });
    run.catch(() => {});
    await until(() => read().includes(`load ${CANARY_1B_V2}`));
    expect(read()).toEqual([`load ${CANARY_1B_V2}`]);
    const from = performance.now();
    w.cancel();
    await expect(run).rejects.toThrow("cancelled");
    await until(() => read().includes(`unload ${CANARY_1B_V2}`));
    // The aborted unit is halved and tried again before the job stops, each try aborted at once.
    expect([...new Set(read())]).toEqual([
      `load ${CANARY_1B_V2}`,
      `abort ${CANARY_1B_V2}`,
      `unload ${CANARY_1B_V2}`,
    ]);
    expect(performance.now() - from).toBeLessThan(5000);
  });
});
