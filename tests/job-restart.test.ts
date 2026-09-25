/**
 * A job the last process left running is queued again at start (SV-J9), once. A job that was
 * running when the server stopped twice, the likely sign that the job itself brings the server
 * down, fails as `interrupted` instead of running a third time, so no upload can put the server
 * in a restart loop.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JobService } from "../src/main/server/jobs.ts";
import { JOBS_DB, JobStore } from "../src/main/server/store.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

/** A jobs folder holding one job that was running when the process stopped `stops` times. */
function leftRunning(stops: number): { dir: string; id: string; audio: string } {
  const t = tempDir("akou-restart-");
  cleanups.push(t.cleanup);
  mkdirSync(join(t.dir, "audio"));
  const audio = join(t.dir, "audio", "a.upload");
  writeFileSync(audio, "audio");
  const s = new JobStore(join(t.dir, JOBS_DB));
  const { job } = s.submit({
    key_id: "key_a",
    preset: "fast",
    language: "auto",
    keywords: [],
    diarize: false,
    callback_url: null,
    metadata: null,
    idempotency_key: null,
    file_sha256: "0".repeat(64),
    audio,
  });
  for (let i = 0; i < stops; i++) {
    if (i > 0) s.requeueRunning();
    s.markRunning(job.id);
  }
  s.close();
  return { dir: t.dir, id: job.id, audio };
}

function service(dir: string): JobService {
  const svc = new JobService({
    dir,
    version: "0.0.0",
    // No models: a job that runs again fails at once as models_missing, which tells it apart.
    models: () => null,
    diarizer: () => "embeddings",
    secrets: () => [],
    hostListed: () => false,
    retainDays: () => 7,
    maxAudioMinutes: () => 240,
    log: () => {},
  });
  cleanups.push(() => svc.close());
  svc.start();
  return svc;
}

describe("SV-J9: a job left running is queued again once, not forever", () => {
  test("positive control: a job running at one stop runs again", async () => {
    const { dir, id } = leftRunning(1);
    const svc = service(dir);
    await until(() => svc.store.job(id)?.status === "failed", 3000, "the job to run again");
    expect(svc.store.job(id)?.error?.code).toBe("models_missing");
  });

  test("a job running at two stops fails as interrupted, with its event, and its audio is deleted", () => {
    const { dir, id, audio } = leftRunning(2);
    const svc = service(dir);
    const job = svc.store.job(id);
    expect(job?.status).toBe("failed");
    expect(job?.error?.code).toBe("interrupted");
    const events = svc.store.events("key_a", 0, 10);
    expect(events.map((e) => e.type)).toEqual(["transcription.failed"]);
    expect(existsSync(audio)).toBe(false);
  });
});
