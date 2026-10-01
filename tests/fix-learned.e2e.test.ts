/**
 * Telling the agent what a fix taught akou, over the API (docs/DESIGN.md section 5.4,
 * docs/ux/design-explorations/fix-a-word-on-the-line.md): a headless app on a seeded, ended call. A
 * fix that learns a term writes one `vocab.learned` event; Undo and the heard word written back take
 * it back; a read from a cursor carries `learned` only when a fix changed something after it; a
 * context pack lists the five newest. No test runs a real model.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventDraft, LogEvent } from "../src/core/log/events.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const CALL = "01J8Z6Q4M2VX0K7B3D4E5F6G7H";
const LONG = 30_000;

function seed(home: string): void {
  const b = new LogBuilder();
  b.created({ id: CALL });
  b.partStarted(1, T0);
  const line = (id: string, w: number, text: string) =>
    b.seg({ id, ch: "call", spk: "c1", a0: w, a1: w + 1, w0: T0 + w * 1000, text });
  line("l000001", 1, "deploy to versal today");
  line("l000002", 3, "versal is down again");
  line("l000003", 5, "their plan works");
  line("l000004", 6, "ask mark about it");
  line("l000005", 8, "then mark said yes");
  line("l000006", 9, "we moved to vercell");
  b.partEnded(1, "stop", 10);
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

async function rigWith(): Promise<AppRig> {
  const home = tempDir("akou-learned-");
  seed(home.dir);
  const rig = await appRig({ home: home.dir });
  rigs.push(rig);
  const close = rig.close;
  rig.close = async () => {
    await close();
    home.cleanup();
  };
  return rig;
}

type Learned = LogEvent & {
  id: string;
  rev: number;
  term: string | null;
  heard?: string[];
  by: string;
  lines?: number;
  kept?: string;
  vocab?: string[];
  was?: string;
};

async function learnedEvents(rig: AppRig): Promise<Learned[]> {
  const evs = (await rig.api("GET", `/calls/${CALL}/events`)).body.events as LogEvent[];
  return evs.filter((e) => e.type === "vocab.learned") as Learned[];
}

async function texts(rig: AppRig): Promise<Record<string, string>> {
  const r = await rig.api("GET", `/calls/${CALL}/transcript`);
  return Object.fromEntries(
    (r.body.lines as { id: string; text: string }[]).map((l) => [l.id, l.text]),
  );
}

async function words(rig: AppRig): Promise<{ term: string; heard: string[] }[]> {
  return (await rig.api("GET", "/vocab?workspace=work")).body.entries ?? [];
}

const cursor = async (rig: AppRig): Promise<number> =>
  (await rig.api("GET", `/calls/${CALL}/transcript`)).body.cursor;

const fixLine = (rig: AppRig, line: string, text: string) =>
  rig.api("POST", `/calls/${CALL}/fix`, { line, text });

describe("the vocab.learned event", () => {
  test(
    "a fix that learns a term writes one, with where it is kept and the call entries it came with",
    async () => {
      const rig = await rigWith();
      const r = await fixLine(rig, "l000001", "deploy to Vercel today");
      expect(r.status).toBe(200);
      const [k, ...more] = await learnedEvents(rig);
      expect(more).toEqual([]);
      expect(k).toMatchObject({
        rev: 1,
        term: "Vercel",
        heard: ["versal"],
        by: "agent:test",
        lines: 2,
        kept: "workspace",
        vocab: r.body.undo.vocab,
      });
      // `kept: workspace` is where it is: the workspace's file.
      expect((await words(rig)).map((e) => e.term)).toContain("Vercel");
      // A rewording learns nothing, so it says nothing; a fix of a word already corrected neither.
      await fixLine(rig, "l000003", "there plan works");
      await fixLine(rig, "l000002", "Vercel is down again");
      expect(await learnedEvents(rig)).toHaveLength(1);
    },
    LONG,
  );

  test(
    "`lines` counts the lines this fix changed, not lines that read the term before it",
    async () => {
      const rig = await rigWith();
      // A word the workspace file already knows: one line reads Vercel before any fix.
      await rig.api("POST", "/vocab", { term: "Vercel", heard: ["vercell"], workspace: "work" });
      expect((await texts(rig)).l000006).toBe("we moved to Vercel");
      await fixLine(rig, "l000001", "deploy to Vercel today");
      const [k] = await learnedEvents(rig);
      expect(k).toMatchObject({ term: "Vercel", lines: 2 });
    },
    LONG,
  );

  test(
    "the same word fixed on one more line is told once",
    async () => {
      const rig = await rigWith();
      // `mark` is a common word: each fix stays on its line, the term itself is learned once.
      await fixLine(rig, "l000004", "ask Marc about it");
      await fixLine(rig, "l000005", "then Marc said yes");
      expect((await texts(rig)).l000005).toBe("then Marc said yes");
      const ks = await learnedEvents(rig);
      expect(ks.map((k) => [k.term, k.heard])).toEqual([["Marc", ["mark"]]]);
    },
    LONG,
  );

  test(
    "Undo writes a revision that takes it back",
    async () => {
      const rig = await rigWith();
      const r = await fixLine(rig, "l000001", "deploy to Vercel today");
      const u = await rig.api("POST", `/calls/${CALL}/fix/undo`, r.body.undo);
      expect(u.body.undone).toEqual({ vocab: 1, notes: 1, words: 1, learned: 1 });
      const ks = await learnedEvents(rig);
      const kid = ks[0]?.id as string;
      expect(ks.map((k) => [k.id, k.rev, k.term])).toEqual([
        [kid, 1, "Vercel"],
        [kid, 2, null],
      ]);
    },
    LONG,
  );

  test(
    "writing the heard word back takes it back too",
    async () => {
      const rig = await rigWith();
      await fixLine(rig, "l000001", "deploy to Vercel today");
      const r = await fixLine(rig, "l000002", "versal is down again");
      expect(r.body.reverted).toEqual([{ heard: "versal", term: "Vercel" }]);
      expect((await learnedEvents(rig)).map((k) => k.term)).toEqual(["Vercel", null]);
    },
    LONG,
  );

  test(
    "writing back one of several heard forms keeps the term: the call still reads it",
    async () => {
      const rig = await rigWith();
      await rig.api("POST", `/calls/${CALL}/fix`, { term: "Vercel", heard: ["versal", "vercell"] });
      const r = await fixLine(rig, "l000002", "versal is down again");
      expect(r.body.reverted).toEqual([{ heard: "versal", term: "Vercel" }]);
      // One term taught, with both heard forms.
      const [k, ...more] = await learnedEvents(rig);
      expect(more.filter((x) => x.rev === 1)).toEqual([]);
      expect(k).toMatchObject({ rev: 1, term: "Vercel", heard: ["versal", "vercell"] });
      // The call still reads `vercell` as Vercel, so nothing is taken back.
      const call = (await rig.api("GET", `/calls/${CALL}/vocab`)).body.callVocab as {
        term: string;
        heard: string[];
      }[];
      expect(call).toEqual([expect.objectContaining({ term: "Vercel", heard: ["vercell"] })]);
      expect((await learnedEvents(rig)).map((x) => x.term)).toEqual(["Vercel"]);
    },
    LONG,
  );

  test(
    "an agent's own correction is told apart from the user's by `by`",
    async () => {
      const rig = await rigWith();
      await rig.api(
        "POST",
        `/calls/${CALL}/fix`,
        { term: "Vercel", heard: ["versal"] },
        { "x-akou-client": "claude" },
      );
      expect((await learnedEvents(rig))[0]).toMatchObject({ term: "Vercel", by: "agent:claude" });
    },
    LONG,
  );
});

describe("`learned` on a read from a cursor", () => {
  test(
    "lists what fixes changed after the cursor, newest last, and is left out when there is none",
    async () => {
      const rig = await rigWith();
      const before = await cursor(rig);
      const r = await fixLine(rig, "l000001", "deploy to Vercel today");
      const mid = await cursor(rig);
      const read = (since: number) =>
        rig.api("GET", `/calls/${CALL}/transcript?since=${since}&review=skip`);
      const first = await read(before);
      expect(first.body.learned).toEqual([
        {
          term: "Vercel",
          heard: ["versal"],
          by: "agent:test",
          time: expect.stringMatching(/^\d\d:\d\d:\d\d$/),
          lines: 2,
          kept: "workspace",
        },
      ]);
      // Nothing after the cursor, and no cursor at all: no field.
      expect("learned" in (await read(mid)).body).toBe(false);
      expect("learned" in (await rig.api("GET", `/calls/${CALL}/transcript`)).body).toBe(false);
      await rig.api("POST", `/calls/${CALL}/fix/undo`, r.body.undo);
      expect((await read(mid)).body.learned).toEqual([
        {
          term: null,
          was: "Vercel",
          heard: ["versal"],
          by: "agent:test",
          time: expect.stringMatching(/^\d\d:\d\d:\d\d$/),
        },
      ]);
      expect(
        ((await read(before)).body.learned as { term: string | null }[]).map((x) => x.term),
      ).toEqual(["Vercel", null]);
    },
    LONG,
  );

  test(
    "a page trimmed by limitTokens reports only what its cursor covers",
    async () => {
      const rig = await rigWith();
      const before = await cursor(rig);
      const line = (id: string, w: number, text: string) =>
        rig.app.write(CALL, {
          type: "seg",
          id,
          rev: 1,
          layer: "live",
          part: 1,
          ch: "call",
          spk: "c1",
          a0: w,
          a1: w + 1,
          w0: T0 + w * 1000,
          w1: T0 + w * 1000 + 900,
          text,
          model: "fake",
        } as EventDraft);
      // A line, then the fix, then another line: a page of one line stops before the fix.
      await line("l000010", 6, "one line before the fix");
      await fixLine(rig, "l000001", "deploy to Vercel today");
      await line("l000011", 7, "one line after the fix");
      const read = (since: number) =>
        rig.api("GET", `/calls/${CALL}/transcript?since=${since}&limitTokens=1&review=skip`);
      const page = await read(before);
      expect(page.body.lines.map((l: { id: string }) => l.id)).toEqual(["l000010"]);
      expect("learned" in page.body).toBe(false);
      const next = await read(page.body.cursor);
      expect(next.body.lines.map((l: { id: string }) => l.id)).toEqual(["l000011"]);
      expect(next.body.learned).toEqual([expect.objectContaining({ term: "Vercel" })]);
    },
    LONG,
  );
});

describe("`learned` with offset paging", () => {
  test(
    "comes on the first page only, since every page shares one cursor",
    async () => {
      const rig = await rigWith();
      const before = await cursor(rig);
      await fixLine(rig, "l000001", "deploy to Vercel today");
      // Lines changed after the cursor, so there is more than one page.
      for (const [id, w] of [
        ["l000010", 6],
        ["l000011", 7],
      ] as const) {
        await rig.app.write(CALL, {
          type: "seg",
          id,
          rev: 1,
          layer: "live",
          part: 1,
          ch: "call",
          spk: "c1",
          a0: w,
          a1: w + 1,
          w0: T0 + w * 1000,
          w1: T0 + w * 1000 + 900,
          text: `a line after the fix ${id}`,
          model: "fake",
        } as EventDraft);
      }
      const page = (offset: number) =>
        rig.api(
          "GET",
          `/calls/${CALL}/transcript?since=${before}&offset=${offset}&limitTokens=1&review=skip`,
        );
      const first = await page(0);
      expect(first.body.nextOffset).toBe(1);
      expect(first.body.learned).toEqual([expect.objectContaining({ term: "Vercel" })]);
      expect("learned" in (await page(1)).body).toBe(false);
    },
    LONG,
  );
});

describe("akou_context lists what fixes taught", () => {
  test(
    "the five newest, newest first, among akou's notes and outside the call text",
    async () => {
      const rig = await rigWith();
      const terms = ["Zorblax", "Quintrel", "Vexmo", "Plonkit", "Drabwell", "Kestrix"];
      for (const term of terms) {
        const r = await rig.api("POST", `/calls/${CALL}/fix`, { term, heard: [] });
        expect(r.status).toBe(200);
      }
      const pack = (
        await rig.api("POST", `/calls/${CALL}/context`, { question: "what was deployed?" })
      ).body.pack as string;
      const at = pack.indexOf("Words fixes taught akou in this call, newest first:");
      expect(at).toBeGreaterThan(-1);
      const listed = pack
        .slice(at)
        .split("\n")
        .slice(1, 7)
        .filter((l) => l.startsWith("- "))
        .map((l) => /"([^"]+)"/.exec(l)?.[1]);
      expect(listed).toEqual(["Kestrix", "Drabwell", "Plonkit", "Vexmo", "Quintrel"]);
      // Outside the quoted call text.
      const open = pack.indexOf("<call-text>");
      const close = pack.indexOf("</call-text>");
      expect(at < open || at > close).toBe(true);
    },
    LONG,
  );
});
