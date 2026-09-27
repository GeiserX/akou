/**
 * Retention (docs/ux/DICTATION.md DC-H2) through the dictation service, on an injected clock:
 * `dictation.retainDays` deletes a dictation past its days, leaving a tombstone, and 0 keeps only
 * the last one. The engine is a stub; nothing opens a device.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DictationService } from "../src/main/dictation/service.ts";
import type { DictationEngine } from "../src/main/dictation/session.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const DAY = 24 * 60 * 60 * 1000;

const said: DictationEngine = {
  name: "fast",
  decode: async () => ({
    text: "private words",
    words: [],
    language: "en",
    model: "stub",
    ms: 1,
    spans: 1,
  }),
};

function service(retainDays: () => number) {
  const t = tempDir("akou-dict-retain-");
  cleanups.push(t.cleanup);
  const clock = { now: 1_000 * DAY };
  const svc = new DictationService({
    configDir: t.dir,
    engine: () => said,
    now: () => clock.now,
    retainDays,
  });
  cleanups.push(() => svc.close());
  return { svc, clock };
}

const clip = () => new Float32Array(1600);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("DC-H2: dictation.retainDays", () => {
  test("31 days on, the sweep deletes the dictation and the log holds its tombstone", async () => {
    const { svc, clock } = service(() => 30);
    const it = await svc.transcribeClip(clip(), { by: "user" });
    clock.now += 29 * DAY;
    expect(svc.sweep()).toEqual([]);
    clock.now += 2 * DAY;
    expect(svc.sweep()).toEqual([it.id]);
    expect(svc.log.items()).toEqual([]);
    const file = readFileSync(svc.log.path, "utf8");
    expect(file).not.toContain("private words");
    expect(
      file
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).type),
    ).toEqual(["dictation.deleted"]);
  });

  test("0 keeps only the last: a second dictation deletes the first", async () => {
    const { svc } = service(() => 0);
    const first = await svc.transcribeClip(clip(), { by: "user" });
    const second = await svc.transcribeClip(clip(), { by: "user" });
    await settle();
    expect(svc.log.items().map((i) => i.id)).toEqual([second.id]);
    expect(readFileSync(svc.log.path, "utf8")).toContain(
      `"type":"dictation.deleted","id":"${first.id}"`,
    );
  });

  test("positive control: with 30 days both dictations stay", async () => {
    const { svc } = service(() => 30);
    await svc.transcribeClip(clip(), { by: "user" });
    await svc.transcribeClip(clip(), { by: "user" });
    await settle();
    expect(svc.log.items()).toHaveLength(2);
  });
});
