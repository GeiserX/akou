/**
 * What the web UI's Jobs page (SV-U4) needs of the job routes: each job names the key that made
 * it, and an admin can keep one key's jobs with `GET /v1/jobs?key=`. A `jobs` key still sees only
 * its own, whatever it names.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type AppRig, appRig } from "./api-helpers.ts";
import { asKey, clip, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(60_000);

let rig: AppRig;
let admin: Key;
let a: Key;
let b: Key;
const ids: Record<string, string> = {};

beforeAll(async () => {
  rig = await appRig({ settings: SERVER });
  admin = await newKey(rig, "ops", "admin");
  a = await newKey(rig, "archive");
  b = await newKey(rig, "other");
  for (const k of [a, b]) {
    const s = await submit(rig, k.key, clip(["hello"], 2));
    expect(s.status).toBe(202);
    ids[k.id] = s.body.id;
    await asKey(rig, k.key, "GET", `/jobs/${s.body.id}?wait=60`);
  }
});

afterAll(async () => {
  await rig?.close();
});

describe("SV-U4: the job routes behind the Jobs page", () => {
  test("a job names its key", async () => {
    const j = await asKey(rig, a.key, "GET", `/jobs/${ids[a.id]}`);
    expect(j.body.key_id).toBe(a.id);
  });

  test("an admin keeps one key's jobs with ?key=; with none it sees every key's", async () => {
    const all = await asKey(rig, admin.key, "GET", "/jobs");
    expect(all.body.jobs.map((j: { id: string }) => j.id).sort()).toEqual(
      [ids[a.id], ids[b.id]].sort(),
    );
    const one = await asKey(rig, admin.key, "GET", `/jobs?key=${a.id}`);
    expect(one.status).toBe(200);
    expect(one.body.jobs.map((j: { id: string }) => j.id)).toEqual([ids[a.id]]);
  });

  test("a jobs key naming another key's id sees nothing of it", async () => {
    const other = await asKey(rig, a.key, "GET", `/jobs?key=${b.id}`);
    expect(other.status).toBe(200);
    expect(other.body.jobs).toEqual([]);
    // Positive control: naming itself, it sees its own job.
    const own = await asKey(rig, a.key, "GET", `/jobs?key=${a.id}`);
    expect(own.body.jobs.map((j: { id: string }) => j.id)).toEqual([ids[a.id]]);
  });
});
