/**
 * Telling the agent what a fix taught akou, and renaming or forgetting a learned term, over the API
 * (docs/DESIGN.md section 5.4, docs/ux/design-explorations/fix-a-word-on-the-line.md): a headless app
 * on a seeded, ended call. A fix that learns a term writes one `vocab.learned` event; Undo, Forget and
 * the heard word written back take it back; a new spelling over a learned word renames it instead of
 * adding a second term; a read from a cursor carries `learned` only when a fix changed something
 * after it; a context pack lists the five newest. No test runs a real model.
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
    "the same word fixed on one more line is told once, and Forget takes both lines back",
    async () => {
      const rig = await rigWith();
      // `mark` is a common word: each fix stays on its line, the term itself is learned once.
      await fixLine(rig, "l000004", "ask Marc about it");
      await fixLine(rig, "l000005", "then Marc said yes");
      expect((await texts(rig)).l000005).toBe("then Marc said yes");
      const ks = await learnedEvents(rig);
      expect(ks.map((k) => [k.term, k.heard])).toEqual([["Marc", ["mark"]]]);
      await rig.api("POST", `/calls/${CALL}/fix/forget`, { learned: ks[0]?.id });
      const t = await texts(rig);
      expect([t.l000004, t.l000005]).toEqual(["ask mark about it", "then mark said yes"]);
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

describe("renaming a learned term", () => {
  test(
    "a new spelling over a learned word renames it in the call and the file, with no second term",
    async () => {
      const rig = await rigWith();
      await fixLine(rig, "l000001", "deploy to Vercel today");
      const r = await fixLine(rig, "l000001", "deploy to Vercel.com today");
      expect(r.status).toBe(200);
      expect(r.body.pairs).toEqual([
        expect.objectContaining({ heard: "versal", term: "Vercel.com", renamed: "Vercel" }),
      ]);
      expect((await texts(rig)).l000002).toBe("Vercel.com is down again");
      // The call holds one entry for the heard form, renamed: a revision, not a second add.
      const call = (await rig.api("GET", `/calls/${CALL}/vocab`)).body.callVocab as {
        term: string;
        heard: string[];
      }[];
      expect(call.filter((v) => v.heard.includes("versal")).map((v) => v.term)).toEqual([
        "Vercel.com",
      ]);
      // The file's entry takes the new term and keeps its heard forms.
      const file = await words(rig);
      expect(file.map((e) => e.term)).not.toContain("Vercel");
      expect(file).toContainEqual(
        expect.objectContaining({ term: "Vercel.com", heard: ["versal"] }),
      );
      const ks = await learnedEvents(rig);
      expect(ks.map((k) => [k.rev, k.term, k.was])).toEqual([
        [1, "Vercel", undefined],
        [2, "Vercel.com", "Vercel"],
      ]);
      expect(new Set(ks.map((k) => k.id)).size).toBe(1);
      // Undo names it back everywhere.
      await rig.api("POST", `/calls/${CALL}/fix/undo`, r.body.undo);
      expect((await texts(rig)).l000002).toBe("Vercel is down again");
      expect((await words(rig)).map((e) => e.term)).toContain("Vercel");
      expect((await words(rig)).map((e) => e.term)).not.toContain("Vercel.com");
      expect((await learnedEvents(rig)).at(-1)).toMatchObject({
        rev: 3,
        term: "Vercel",
        was: "Vercel.com",
      });
    },
    LONG,
  );
});

describe("renaming or forgetting when the file is in the way", () => {
  /** Breaks the workspace's vocabulary file so it no longer parses. */
  async function breakFile(rig: AppRig): Promise<void> {
    const files = (await rig.api("GET", "/vocab?workspace=work")).body.files as {
      scope: string;
      path: string;
    }[];
    const path = files.find((f) => f.scope === "workspace")?.path as string;
    writeFileSync(path, "entries:\n  - term: [unclosed\n");
  }

  test(
    "a rename onto a term the file already holds leaves the file alone, so Undo loses nothing",
    async () => {
      const rig = await rigWith();
      await rig.api("POST", "/vocab", { term: "Vercel.com", heard: ["vercom"], workspace: "work" });
      await fixLine(rig, "l000001", "deploy to Vercel today");
      const r = await fixLine(rig, "l000001", "deploy to Vercel.com today");
      expect(r.body.warnings).toEqual([expect.stringContaining("Vercel.com was not renamed")]);
      // The call reads the new spelling; the file keeps both entries as they were.
      expect((await texts(rig)).l000002).toBe("Vercel.com is down again");
      expect(await words(rig)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ term: "Vercel", heard: ["versal"] }),
          expect.objectContaining({ term: "Vercel.com", heard: ["vercom"] }),
        ]),
      );
      await rig.api("POST", `/calls/${CALL}/fix/undo`, r.body.undo);
      expect(await words(rig)).toContainEqual(
        expect.objectContaining({ term: "Vercel.com", heard: ["vercom"] }),
      );
    },
    LONG,
  );

  test(
    "a file that no longer parses does not stop Undo of a rename, or Forget",
    async () => {
      const rig = await rigWith();
      await fixLine(rig, "l000001", "deploy to Vercel today");
      const r = await fixLine(rig, "l000001", "deploy to Vercel.com today");
      await breakFile(rig);
      const u = await rig.api("POST", `/calls/${CALL}/fix/undo`, r.body.undo);
      expect(u.status).toBe(200);
      expect((await learnedEvents(rig)).at(-1)).toMatchObject({
        term: "Vercel",
        was: "Vercel.com",
      });
      const [k] = await learnedEvents(rig);
      const f = await rig.api("POST", `/calls/${CALL}/fix/forget`, { learned: k?.id });
      expect(f.status).toBe(200);
      expect(f.body.forgotten).toMatchObject({ term: "Vercel", file: false });
      expect(f.body.warnings).toEqual([expect.stringContaining("was not taken out of the file")]);
      expect((await learnedEvents(rig)).at(-1)).toMatchObject({ term: null });
      // The call's own entries are gone; the lines read whatever the file last held.
      const call = (await rig.api("GET", `/calls/${CALL}/vocab`)).body.callVocab as unknown[];
      expect(call).toEqual([]);
    },
    LONG,
  );
});

describe("forgetting a learned term", () => {
  test(
    "Forget takes it out of the call and out of the file, at any time after the fix",
    async () => {
      const rig = await rigWith();
      await fixLine(rig, "l000001", "deploy to Vercel today");
      await fixLine(rig, "l000003", "there plan works");
      const [k] = await learnedEvents(rig);
      const f = await rig.api("POST", `/calls/${CALL}/fix/forget`, { learned: k?.id });
      expect(f.status).toBe(200);
      expect(f.body.forgotten).toEqual({ term: "Vercel", vocab: 1, file: true });
      const t = await texts(rig);
      expect(t.l000001).toBe("deploy to versal today");
      expect(t.l000002).toBe("versal is down again");
      // A rewording is no vocabulary and stays.
      expect(t.l000003).toBe("there plan works");
      expect((await words(rig)).map((e) => e.term)).not.toContain("Vercel");
      expect((await learnedEvents(rig)).map((x) => [x.rev, x.term])).toEqual([
        [1, "Vercel"],
        [2, null],
      ]);
      // Gone: a second Forget finds nothing.
      expect((await rig.api("POST", `/calls/${CALL}/fix/forget`, { learned: k?.id })).status).toBe(
        404,
      );
      expect((await rig.api("POST", `/calls/${CALL}/fix/forget`, {})).status).toBe(400);
    },
    LONG,
  );

  test(
    "an entry the user wrote before keeps itself and loses only the heard form the fix added",
    async () => {
      const rig = await rigWith();
      await rig.api("POST", "/vocab", { term: "Vercel", heard: ["vercell"], workspace: "work" });
      await fixLine(rig, "l000001", "deploy to Vercel today");
      const [k] = await learnedEvents(rig);
      await rig.api("POST", `/calls/${CALL}/fix/forget`, { learned: k?.id });
      expect(await words(rig)).toContainEqual(
        expect.objectContaining({ term: "Vercel", heard: ["vercell"] }),
      );
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
