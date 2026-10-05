/**
 * Kept recordings (docs/server.md "A phone or another live client"): a job submitted with
 * `keep_audio=true` keeps its upload after it ends, serves it back byte for byte from
 * `GET /v1/jobs/{id}/audio`, and is skipped whole by the `server.retain_days` sweep (row, result,
 * events, audio) until a client deletes it. Each rule has its positive control: the same job
 * submitted without `keep_audio`, which keeps SV-J6 as it was.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appRig } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";
import { asKey, clip, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const NOTE = clip(["hello", "world"], 3);
const DAY = 86_400_000;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("keep_audio: a job that keeps its recording", () => {
  test("its audio comes back byte for byte, with Range; a job without it answers 409 not_kept", async () => {
    const rig = await appRig({ settings: SERVER });
    try {
      const k = await newKey(rig, "keeper");
      const kept = await submit(rig, k.key, NOTE, {
        keep_audio: "true",
        metadata: '{"workspace":"home"}',
      });
      const plain = await submit(rig, k.key, NOTE);
      expect(kept.status).toBe(202);
      expect(kept.body).toMatchObject({ keep_audio: true, metadata: { workspace: "home" } });
      expect(kept.body.links.audio).toBe(`/v1/jobs/${kept.body.id}/audio`);
      expect(plain.body.keep_audio).toBe(false);
      for (const id of [kept.body.id, plain.body.id]) {
        expect((await asKey(rig, k.key, "GET", `/jobs/${id}?wait=60`)).body.status).toBe("done");
      }
      const res = await fetch(`http://127.0.0.1:${rig.port}/v1/jobs/${kept.body.id}/audio`, {
        headers: { authorization: `Bearer ${k.key}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/wav");
      expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(NOTE));
      const part = await fetch(`http://127.0.0.1:${rig.port}/v1/jobs/${kept.body.id}/audio`, {
        headers: { authorization: `Bearer ${k.key}`, range: "bytes=4-11" },
      });
      expect(part.status).toBe(206);
      expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...NOTE.subarray(4, 12)]);
      // Positive control: the job that did not ask kept nothing, as SV-J6 says.
      const none = await asKey(rig, k.key, "GET", `/jobs/${plain.body.id}/audio`);
      expect(none.status).toBe(409);
      expect(none.body.error).toBe("not_kept");
      // Another key does not reach it.
      const other = await newKey(rig, "stranger");
      expect((await asKey(rig, other.key, "GET", `/jobs/${kept.body.id}/audio`)).status).toBe(404);
    } finally {
      await rig.close();
    }
  });

  test("retention past retain_days skips a kept job whole; only a delete removes it", async () => {
    let now = Date.now();
    const home = tempDir("akou-keep-");
    const start = () =>
      appRig({
        home: home.dir,
        settings: { ...SERVER, "server.retain_days": 7 },
        jobs: { now: () => now },
      });
    let rig = await start();
    try {
      const k = await newKey(rig, "keeper-retain");
      const kept = (await submit(rig, k.key, NOTE, { keep_audio: "true" })).body.id as string;
      const plain = (await submit(rig, k.key, NOTE)).body.id as string;
      for (const id of [kept, plain]) {
        expect((await asKey(rig, k.key, "GET", `/jobs/${id}?wait=60`)).body.status).toBe("done");
      }
      const uploads = join(rig.app.configDir, "jobs", "audio");
      const files = () => (existsSync(uploads) ? readdirSync(uploads) : []);
      expect(files().length).toBe(1);
      const jobs = rig.app.jobs();
      if (!jobs) throw new Error("no job service");
      now += 7 * DAY + 1;
      // The unkept job goes, as before; the kept one is not touched.
      expect(jobs.sweep()).toBe(1);
      expect((await asKey(rig, k.key, "GET", `/jobs/${plain}`)).status).toBe(410);
      expect((await asKey(rig, k.key, "GET", `/jobs/${kept}`)).body.status).toBe("done");
      expect((await asKey(rig, k.key, "GET", `/jobs/${kept}/result`)).body.text).toBe(
        "hello world",
      );
      const audio = await fetch(`http://127.0.0.1:${rig.port}/v1/jobs/${kept}/audio`, {
        headers: { authorization: `Bearer ${k.key}` },
      });
      expect(sha(new Uint8Array(await audio.arrayBuffer()))).toBe(sha(NOTE));
      const feed = (await asKey(rig, k.key, "GET", "/events")).body.events;
      const keptEvent = feed.find((e: { job_id: string }) => e.job_id === kept);
      expect(keptEvent.type).toBe("transcription.completed");
      expect(keptEvent.data.deleted).toBeUndefined();
      // A year later, after a restart (whose sweep deletes the uploads no job names), it is
      // still there.
      now += 365 * DAY;
      await rig.close();
      rig = await start();
      expect(rig.app.jobs()?.sweep()).toBe(0);
      expect(files().length).toBe(1);
      expect((await asKey(rig, k.key, "GET", `/jobs/${kept}/audio`)).status).toBe(200);
      // A client's delete removes the job and its file.
      expect((await asKey(rig, k.key, "DELETE", `/jobs/${kept}`)).status).toBe(200);
      expect(files()).toEqual([]);
      expect((await asKey(rig, k.key, "GET", `/jobs/${kept}/audio`)).status).toBe(410);
    } finally {
      await rig.close();
      home.cleanup();
    }
  });
});
