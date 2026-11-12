/**
 * TRAPS "A follower re-reads the whole log per event": `GET /calls/:id/events` long-polls through
 * `App.events`, which must read only what was appended since its last read of the call's log.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { EVENTS_FILE } from "../src/core/log/writer.ts";
import { type AppRig, appRig } from "./api-helpers.ts";

let rig: AppRig;
let id: string;

function seg(n: number, text: string): Promise<LogEvent> {
  return rig.app.write(id, {
    type: "seg",
    id: `l9${String(n).padStart(5, "0")}`,
    rev: 1,
    layer: "live",
    part: 1,
    ch: "call",
    spk: "c1",
    a0: n,
    a1: n + 1,
    w0: Date.now(),
    w1: Date.now() + 1000,
    text,
    model: "fake",
  } as never);
}

beforeAll(async () => {
  rig = await appRig();
  id = await rig.startCall({ title: "Follow", withoutModels: true });
}, 30_000);

afterAll(async () => {
  await rig?.close();
});

describe("[T1.47] A follower re-reads the whole log per event: App.events", () => {
  test("a poll after the head reads the appended bytes, never the log already read", async () => {
    const written: LogEvent[] = [];
    for (let i = 0; i < 300; i++) written.push(await seg(i, `line ${i} ${"x".repeat(80)}`));
    const all = await rig.app.events(id, 0);
    expect(all.slice(-300)).toEqual(written);
    const head = all.at(-1)?.seq as number;
    // At the head nothing can follow.
    expect(await rig.app.events(id, head)).toEqual([]);

    // Probe: rewrite a line already read, in place and at its length, into an event past the head.
    // Only a reader that parses the whole log again sees it.
    const c = await rig.app.call(id);
    const file = join(c.dir, EVENTS_FILE);
    const text = readFileSync(file, "utf8");
    const old = JSON.stringify(written[10]);
    const at = Buffer.byteLength(text.slice(0, text.indexOf(old)));
    const bare = JSON.stringify({ ...written[10], seq: 900_000, text: "z" });
    const probe = `${bare.slice(0, -1)}${" ".repeat(Buffer.byteLength(old) - Buffer.byteLength(bare))}}`;
    expect(Buffer.byteLength(probe)).toBe(Buffer.byteLength(old));
    const fd = openSync(file, "r+");
    writeSync(fd, probe, at);
    closeSync(fd);

    const next = await seg(300, "after the probe");
    expect(await rig.app.events(id, head)).toEqual([next]);
    expect(await rig.app.events(id, next.seq)).toEqual([]);
  });
});
