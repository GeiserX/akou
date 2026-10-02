/**
 * A job that asks for speaker labels on a machine with no `akou-diarize` helper (akou-5an.110): a
 * source checkout has none, and before this the job finished with every label silently gone. Now
 * it fails `diarize_unavailable` with what to do, before its audio is read; a job without
 * `diarize`, a found helper and the embeddings diarizer all run as before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import { MODELS } from "../src/main/asr/models.ts";
import { diarizeHelperMissing, JobService } from "../src/main/server/jobs.ts";
import { ModelStore } from "../src/main/server/model-store.ts";
import type { Job } from "../src/main/server/store.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const GONE = join("/nonexistent", "akou-diarize");

function sherpa(o: { diarizer?: "nemotron" | "embeddings"; helper?: string[] }): ModelSpec {
  return {
    kind: "sherpa",
    dir: "/nonexistent",
    cacheDir: "/nonexistent",
    ...(o.diarizer ? { diarizer: o.diarizer } : {}),
    ...(o.helper ? { diarizeHelper: o.helper } : {}),
  };
}

describe("diarizeHelperMissing: Nemotron on sherpa needs its helper", () => {
  test("a helper that is not there is named, with the settings that fix it", () => {
    const why = diarizeHelperMissing(sherpa({ helper: [GONE] }));
    expect(why).toContain(GONE);
    expect(why).toContain("asr.diarizeHelper");
    expect(why).toContain("asr.diarizer to embeddings");
  });

  test("no reason for a helper that is there, the embeddings diarizer, or a test engine", () => {
    expect(diarizeHelperMissing(sherpa({ helper: [process.execPath] }))).toBeNull();
    expect(diarizeHelperMissing(sherpa({ diarizer: "embeddings", helper: [GONE] }))).toBeNull();
    expect(diarizeHelperMissing({ kind: "module", path: "x", model: "fake" })).toBeNull();
  });
});

describe("a diarize job with no helper fails and says why, before its audio is read", () => {
  function rig(spec: ModelSpec) {
    const t = tempDir("akou-diarize-helper-");
    cleanups.push(t.cleanup);
    const decoded: string[] = [];
    const svc = new JobService({
      dir: t.dir,
      version: "0.0.0",
      models: () => spec,
      // A job that gets this far reached its audio: it ends here, with no Worker built.
      decode: async (path) => {
        decoded.push(path);
        throw new Error("ended by the test");
      },
      shelf: new ModelStore({
        dir: () => join(t.dir, "models"),
        machine: () => null,
        catalog: () => MODELS,
        autoDownload: () => false,
        maxGb: () => 0,
        unusedDays: () => 0,
        log: () => {},
      }),
      defaultModel: () => "auto",
      diarizer: () => "nemotron",
      secrets: () => [],
      hostListed: () => false,
      retainDays: () => 7,
      maxAudioMinutes: () => 240,
      log: () => {},
    });
    cleanups.push(() => svc.close());
    svc.start();
    let n = 0;
    const put = (diarize: boolean): Job => {
      const audio = join(svc.uploadDir, `u${++n}.upload`);
      writeFileSync(audio, "audio");
      const r = svc.submit({
        key_id: "key_a",
        preset: "fast",
        language: "auto",
        keywords: [],
        diarize,
        callback_url: null,
        metadata: null,
        idempotency_key: null,
        file_sha256: "0".repeat(64),
        audio,
      });
      if (!("job" in r)) throw new Error(`expected a job, got ${JSON.stringify(r)}`);
      return r.job;
    };
    const ended = async (j: Job) => {
      await until(() => svc.store.job(j.id)?.status === "failed", 10_000, "the job to end");
      return svc.store.job(j.id) as Job;
    };
    return { put, ended, decoded };
  }

  test("diarize with no helper: failed diarize_unavailable, the audio never read", async () => {
    const r = rig(sherpa({ helper: [GONE] }));
    const j = await r.ended(r.put(true));
    expect(j.error?.code).toBe("diarize_unavailable");
    expect(j.error?.message).toContain(GONE);
    expect(r.decoded).toEqual([]);
  });

  test("positive control: without diarize, or with the helper there, the job reaches its audio", async () => {
    const plain = rig(sherpa({ helper: [GONE] }));
    const a = await plain.ended(plain.put(false));
    expect(a.error?.code).toBe("decode_failed");
    expect(plain.decoded.length).toBe(1);
    const found = rig(sherpa({ helper: [process.execPath] }));
    const b = await found.ended(found.put(true));
    expect(b.error?.code).toBe("decode_failed");
    expect(found.decoded.length).toBe(1);
  });
});
