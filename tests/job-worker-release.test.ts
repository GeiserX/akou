import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobWorker } from "../src/main/asr/finalize-worker.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";

// A job Worker that is terminated still holding its models keeps them for the life of the process:
// a terminated Bun Worker never runs the native finalizers. So `close` of an idle Worker has it free
// them first. The model set here is the fake one, with a `release` that leaves a file behind, so the
// host can see it ran (in the Worker, on another thread) and whether it ran before the terminate.

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");
let dir = "";
let spy = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "akou-job-release-"));
  spy = join(dir, "spy-models.ts");
  writeFileSync(
    spy,
    `import { writeFileSync } from "node:fs";
import { createModels as fake } from ${JSON.stringify(FAKE)};
export function createModels(options, model) {
  const m = fake(options, model);
  const release = m.release.bind(m);
  m.release = async () => {
    writeFileSync(options.marker, "released");
    await release();
  };
  return m;
}
`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Every `terminate` of a Worker, with whether the model set had been released by then. */
const terminated: { released: boolean }[] = [];
let marker = "";
const terminate = Worker.prototype.terminate;
beforeAll(() => {
  Worker.prototype.terminate = function (this: Worker) {
    terminated.push({ released: existsSync(marker) });
    return terminate.call(this);
  };
});
afterAll(() => {
  Worker.prototype.terminate = terminate;
});

const workers: JobWorker[] = [];
afterEach(() => {
  for (const w of workers.splice(0)) w.cancel();
  terminated.length = 0;
});

function worker(name: string, options: Record<string, unknown> = {}, releaseMs?: number) {
  marker = join(dir, `${name}.released`);
  const w = new JobWorker(
    { kind: "module", path: spy, model: "fake-parakeet", options: { marker, ...options } },
    undefined,
    releaseMs,
  );
  workers.push(w);
  return w;
}

const clip = () => concat(silence(0.3), speak(["deploy", "today"]), silence(0.5));

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond() && performance.now() < end) await Bun.sleep(10);
}

describe("closing a job Worker frees its models", () => {
  test("an idle Worker releases its models before it is terminated", async () => {
    const w = worker("idle");
    const r = await w.run({ samples: clip(), diarize: false, decode: null });
    expect(r.segments.map((s) => s.text)).toEqual(["deploy today"]);
    w.close();
    await until(() => terminated.length > 0);
    expect(existsSync(marker)).toBe(true);
    expect(terminated).toEqual([{ released: true }]);
  });

  test("a busy Worker is still cancelled at once", async () => {
    const w = worker("busy", { slowMs: 5000 });
    const run = w.run({ samples: clip(), diarize: false, decode: null });
    await Bun.sleep(300);
    const t = performance.now();
    w.close();
    await expect(run).rejects.toThrow("the job Worker closed");
    expect(performance.now() - t).toBeLessThan(1000);
    expect(terminated).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });

  test("a Worker that never answers the release is terminated after the timeout", async () => {
    const w = worker("stuck", { releaseMs: 60_000 }, 400);
    await w.run({ samples: clip(), diarize: false, decode: null });
    w.close();
    await Bun.sleep(150);
    // Still waiting for the release: not terminated yet.
    expect(terminated).toHaveLength(0);
    await until(() => terminated.length > 0, 3000);
    expect(terminated).toHaveLength(1);
  });
});
