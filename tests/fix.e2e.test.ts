/**
 * Fix once, applied everywhere, over the API (docs/DESIGN.md section 5.4, "A fix on a line"): a
 * headless app on a seeded, ended call. A fix of one line corrects every other line with the same
 * heard form; a term lands in the call's and the workspace's vocabulary with no review step; a
 * rewording stays on its line and lands in the Notes; the note is written for a term too while the
 * engine takes no word list; Undo takes every part back. No test runs a real model.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const CALL = "01J8Z6Q4M2VX0K7B3D4E5F6G7H";
const LONG = 30_000;

/** An ended call in workspace `work`, written where the app finds it. */
function seed(home: string): void {
  const b = new LogBuilder();
  b.created({ id: CALL });
  b.partStarted(1, T0);
  const line = (id: string, w: number, text: string) =>
    b.seg({ id, ch: "call", spk: "c1", a0: w, a1: w + 1, w0: T0 + w * 1000, text });
  line("l000001", 1, "deploy to versal today");
  line("l000002", 3, "versal is down again");
  line("l000003", 5, "the universal plan is their plan");
  line("l000004", 7, "their plan works");
  b.partEnded(1, "stop", 12);
  b.add({ type: "call.ended", reason: "stop" });
  const dir = join(home, "Recordings", "akou", "work", "2026-09-23_153612_f6g7h");
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    `${b.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

const rigs: AppRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});

async function rigWith(settings: Record<string, unknown> = {}): Promise<AppRig> {
  const home = tempDir("akou-fix-");
  seed(home.dir);
  const rig = await appRig({ home: home.dir, settings });
  rigs.push(rig);
  // The home goes with the rig's own cleanup.
  const close = rig.close;
  rig.close = async () => {
    await close();
    home.cleanup();
  };
  return rig;
}

async function texts(rig: AppRig): Promise<Record<string, string>> {
  const r = await rig.api("GET", `/calls/${CALL}/transcript`);
  return Object.fromEntries(
    (r.body.lines as { id: string; text: string }[]).map((l) => [l.id, l.text]),
  );
}

async function events(rig: AppRig): Promise<LogEvent[]> {
  return (await rig.api("GET", `/calls/${CALL}/events`)).body.events as LogEvent[];
}

async function workspaceWords(
  rig: AppRig,
): Promise<{ term: string; heard: string[]; source: string; confirmed: boolean }[]> {
  return (await rig.api("GET", "/vocab?workspace=work")).body.entries;
}

describe("a fix of one line", () => {
  test(
    "corrects every other line with the same heard form at once, and learns the term without review",
    async () => {
      const rig = await rigWith();
      const r = await rig.api("POST", `/calls/${CALL}/fix`, {
        line: "l000001",
        text: "deploy to Vercel today",
      });
      expect(r.status).toBe(200);
      expect(r.body.pairs).toEqual([
        { heard: "versal", term: "Vercel", kind: "term", learned: true, noted: true, lines: 2 },
      ]);
      const t = await texts(rig);
      expect(t.l000001).toBe("deploy to Vercel today");
      expect(t.l000002).toBe("Vercel is down again");
      // Whole words only: "universal" keeps its letters.
      expect(t.l000003).toBe("the universal plan is their plan");
      // The call's list, for this call and its decoding: no line restriction.
      const add = (await events(rig)).find((e) => e.type === "vocab.add") as LogEvent & {
        segs?: string[];
      };
      expect(add).toMatchObject({ term: "Vercel", heard: ["versal"] });
      expect(add.segs).toBeUndefined();
      // The workspace's list, confirmed: no review step.
      expect(await workspaceWords(rig)).toContainEqual(
        expect.objectContaining({
          term: "Vercel",
          heard: ["versal"],
          source: "correction",
          confirmed: true,
        }),
      );
      const vocab = await rig.api("GET", `/calls/${CALL}/vocab`);
      expect(vocab.body.review.proposals).toEqual([]);
      expect(vocab.body.review.unconfirmed).toEqual([]);
    },
    LONG,
  );

  test(
    "a rewording stays on its line and lands in the Notes, never in a vocabulary",
    async () => {
      const rig = await rigWith();
      const r = await rig.api("POST", `/calls/${CALL}/fix`, {
        line: "l000004",
        text: "there plan works",
      });
      expect(r.body.pairs).toEqual([
        { heard: "their", term: "there", kind: "rewording", learned: false, noted: true, lines: 1 },
      ]);
      const t = await texts(rig);
      expect(t.l000004).toBe("there plan works");
      expect(t.l000003).toBe("the universal plan is their plan");
      const notes = (await rig.api("GET", `/calls/${CALL}/notes`)).body.notes;
      expect(notes).toEqual([
        expect.objectContaining({ text: "Fixed: their -> there", from: "fix", w: T0 + 7000 }),
      ]);
      expect((await workspaceWords(rig)).map((e) => e.term)).not.toContain("there");
    },
    LONG,
  );

  test(
    "a term is noted only while the engine takes no word list",
    async () => {
      const rig = await rigWith({ "asr.parakeet.decoding": "beam" });
      const r = await rig.api("POST", `/calls/${CALL}/fix`, {
        line: "l000001",
        text: "deploy to Vercel today",
      });
      expect(r.body.takesWords).toBe(true);
      expect(r.body.pairs[0]).toMatchObject({ learned: true, noted: false });
      expect((await rig.api("GET", `/calls/${CALL}/notes`)).body.notes).toEqual([]);
    },
    LONG,
  );

  test(
    "Undo removes the learned term, the line's correction and the note",
    async () => {
      const rig = await rigWith();
      const r = await rig.api("POST", `/calls/${CALL}/fix`, {
        line: "l000001",
        text: "deploy to Vercel today",
      });
      expect((await rig.api("GET", `/calls/${CALL}/notes`)).body.notes).toHaveLength(1);
      const u = await rig.api("POST", `/calls/${CALL}/fix/undo`, r.body.undo);
      expect(u.status).toBe(200);
      expect(u.body.undone).toEqual({ vocab: 1, notes: 1, words: 1 });
      const t = await texts(rig);
      expect(t.l000001).toBe("deploy to versal today");
      expect(t.l000002).toBe("versal is down again");
      expect((await workspaceWords(rig)).map((e) => e.term)).not.toContain("Vercel");
      expect((await rig.api("GET", `/calls/${CALL}/notes`)).body.notes).toEqual([]);
      // The log keeps every event: the fix and its retraction.
      const adds = (await events(rig)).filter((e) => e.type === "vocab.add");
      expect(adds.map((e) => (e as { term: string | null }).term)).toEqual(["Vercel", null]);
    },
    LONG,
  );

  test(
    "a word the fix only added to an entry already there leaves again on Undo; the entry stays",
    async () => {
      const rig = await rigWith();
      await rig.api("POST", "/vocab", { term: "Vercel", heard: ["vercell"], workspace: "work" });
      const r = await rig.api("POST", `/calls/${CALL}/fix`, {
        line: "l000001",
        text: "deploy to Vercel today",
      });
      expect(await workspaceWords(rig)).toContainEqual(
        expect.objectContaining({ term: "Vercel", heard: ["vercell", "versal"] }),
      );
      await rig.api("POST", `/calls/${CALL}/fix/undo`, r.body.undo);
      expect(await workspaceWords(rig)).toContainEqual(
        expect.objectContaining({ term: "Vercel", heard: ["vercell"] }),
      );
    },
    LONG,
  );

  test(
    "a stated word with no line, as an agent passes it on, does the same",
    async () => {
      const rig = await rigWith();
      const r = await rig.api("POST", `/calls/${CALL}/fix`, { term: "Vercel", heard: ["versal"] });
      expect(r.body.pairs[0]).toMatchObject({ kind: "term", learned: true, lines: 2 });
      expect((await texts(rig)).l000002).toBe("Vercel is down again");
      const bad = await rig.api("POST", `/calls/${CALL}/fix`, { line: "l000001" });
      expect(bad.status).toBe(400);
      const none = await rig.api("POST", `/calls/${CALL}/fix`, {
        line: "l000001",
        text: "Deploy to Vercel today.",
      });
      // Only the capital at the start and a full stop changed: nothing new to fix.
      expect(none.body.pairs).toEqual([]);
    },
    LONG,
  );
});
