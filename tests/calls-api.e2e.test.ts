/**
 * A call's way out of every state over the API (docs/ux/PROGRAMMABILITY.md): rename with the
 * export following, move to another workspace, trash and restore (PG-A4); who spoke one line
 * (PG-A5); and the calls an indexer pulls, changed since a cursor (PG-A6). The fold first, then a
 * headless app with the fake helper over saved calls written before it starts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { validateDraft } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { TRASH_DAYS, TRASH_DIR } from "../src/main/call/manager.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const LONG = 30_000;
const DAY = 24 * 3600_000;
const SYNC = "01J8Z6Q4M2VX0K7B3D4E5CALSA";
const PLAN = "01J8Z6Q4M2VX0K7B3D4E5CALSB";
const OLD = "01J8Z6Q4M2VX0K7B3D4E5CALSC";
const FRESH = "01J8Z6Q4M2VX0K7B3D4E5CALSD";

/** A saved call under `<root>/<workspace>/<folder>`, two call-side speakers and one mic line. */
function seed(
  root: string,
  workspace: string,
  folder: string,
  id: string,
  title: string,
  t0: number,
) {
  const b = new LogBuilder();
  b.created({ id, title }, t0);
  b.partStarted(1, t0);
  b.seg({
    id: "l000001",
    ch: "call",
    spk: "c2",
    w0: t0 + 1000,
    text: "the budget moves to friday",
  });
  b.seg({ id: "l000002", ch: "call", spk: "c3", w0: t0 + 3000, text: "fine by me" });
  b.seg({ id: "l000003", ch: "mic", spk: "you", w0: t0 + 5000, text: "agreed then" });
  b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
  b.partEnded(1, "stop", 6);
  b.add({ type: "call.ended", reason: "stop" });
  const dir = join(root, workspace, folder);
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    `${b.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  return dir;
}

let rig: AppRig;
let home: { dir: string; cleanup: () => void };
let out: { dir: string; cleanup: () => void };
const root = () => join(home.dir, "Recordings", "akou");
// biome-ignore lint/suspicious/noExplicitAny: events are inspected field by field.
const eventsOf = async (id: string): Promise<any[]> =>
  (await rig.api("GET", `/calls/${id}/events`)).body.events;
const listed = async () =>
  ((await rig.api("GET", "/calls")).body.calls as { id: string }[]).map((c) => c.id);

beforeAll(async () => {
  home = tempDir("akou-app-");
  out = tempDir("akou-export-");
  const r = join(home.dir, "Recordings", "akou");
  seed(r, "work", "2026-09-23_153612_sync", SYNC, "Weekly sync", T0);
  seed(r, "work", "2026-09-24_153612_plan", PLAN, "Planning", T0 + DAY);
  // Two calls already in the trash: one past the 30 days, one not.
  for (const [id, days] of [
    [OLD, TRASH_DAYS + 1],
    [FRESH, TRASH_DAYS - 1],
  ] as const) {
    const dir = seed(join(r, TRASH_DIR), "work", `trashed-${id.slice(-1)}`, id, "Old", T0);
    writeFileSync(
      `${dir}.json`,
      JSON.stringify({ id, workspace: "work", trashedAt: Date.now() - days * DAY }),
    );
  }
  rig = await appRig({ home: home.dir, settings: { "export.dir": out.dir } });
});

afterAll(async () => {
  await rig?.close();
  home?.cleanup();
  out?.cleanup();
});

describe("[PG-A4] the fold", () => {
  test("call.moved sets the workspace; the highest rev wins and call.created is never changed", () => {
    const b = new LogBuilder();
    const created = b.created({ title: "Weekly sync" });
    expect(fold(b.events).workspaceRev).toBe(0);
    b.add({ type: "call.moved", rev: 1, workspace: "clients", by: "user" });
    b.add({ type: "call.moved", rev: 3, workspace: "archive", by: "agent:codex" });
    b.add({ type: "call.moved", rev: 2, workspace: "stale", by: "user" });
    const v = fold(b.events);
    expect([v.call?.workspace, v.workspaceRev, v.call?.title]).toEqual([
      "archive",
      3,
      "Weekly sync",
    ]);
    expect((created as { workspace: string }).workspace).toBe("work");
    expect(validateDraft({ type: "call.moved", rev: 1, workspace: " ", by: "user" }).ok).toBe(
      false,
    );
    expect(validateDraft({ type: "call.moved", rev: 0, workspace: "a", by: "user" }).ok).toBe(
      false,
    );
  });
});

describe("[PG-A4] rename, move, trash and restore", () => {
  test(
    "a rename renames the export akou wrote, found again by its akou_id",
    async () => {
      const first = await rig.api("POST", `/calls/${SYNC}/export`);
      expect(first.status).toBe(200);
      expect(first.body.path).toEndWith("Weekly sync.md");
      const r = await rig.api("PATCH", `/calls/${SYNC}`, { title: "Q3 planning" });
      expect(r.body).toMatchObject({
        ok: true,
        call: SYNC,
        title: "Q3 planning",
        workspace: "work",
      });
      const renamed = join(
        out.dir,
        "work",
        basename(first.body.path).replace("Weekly sync", "Q3 planning"),
      );
      await until(async () => existsSync(renamed), 10_000, "the export under its new name");
      expect(existsSync(first.body.path)).toBe(false);
      expect(readFileSync(renamed, "utf8")).toContain(`akou_id: ${SYNC}`);
      expect(readdirSync(join(out.dir, "work")).filter((f) => f.endsWith(".md"))).toEqual([
        basename(renamed),
      ]);
    },
    LONG,
  );

  test(
    "PATCH workspace moves the folder and writes call.moved; a call that is recording is refused",
    async () => {
      const r = await rig.api("PATCH", `/calls/${PLAN}`, { workspace: "clients" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ call: PLAN, workspace: "clients", title: "Planning" });
      expect(existsSync(join(root(), "clients", "2026-09-24_153612_plan", "events.jsonl"))).toBe(
        true,
      );
      expect(existsSync(join(root(), "work", "2026-09-24_153612_plan"))).toBe(false);
      const moved = (await eventsOf(PLAN)).filter((e) => e.type === "call.moved");
      expect(moved).toMatchObject([{ rev: 1, workspace: "clients", by: "agent:test" }]);
      expect((await rig.api("GET", `/calls/${PLAN}`)).body.workspace).toBe("clients");
      const row = (await rig.api("GET", "/calls?workspace=clients")).body.calls;
      expect(row.map((c: { id: string }) => c.id)).toEqual([PLAN]);
      // The same workspace again moves nothing and writes nothing.
      expect((await rig.api("PATCH", `/calls/${PLAN}`, { workspace: "clients" })).status).toBe(200);
      expect((await eventsOf(PLAN)).filter((e) => e.type === "call.moved")).toHaveLength(1);
      expect((await rig.api("PATCH", `/calls/${PLAN}`, { workspace: ".trash" })).status).toBe(400);
      expect((await rig.api("PATCH", `/calls/${PLAN}`, {})).status).toBe(422);
      const live = await rig.startCall();
      try {
        const refused = await rig.api("PATCH", `/calls/${live}`, { workspace: "clients" });
        expect([refused.status, refused.body.error]).toEqual([409, "live_call"]);
        const del = await rig.api("DELETE", `/calls/${live}`);
        expect([del.status, del.body.error]).toEqual([409, "live_call"]);
      } finally {
        await rig.api("POST", "/calls/live/stop");
      }
    },
    LONG,
  );

  test(
    "DELETE moves the call to the trash and out of every list; restore brings it back unchanged",
    async () => {
      const before = (await rig.api("GET", `/calls/${PLAN}`)).body.folder as string;
      const log = readFileSync(join(before, "events.jsonl"), "utf8");
      const transcript = (await rig.api("GET", `/calls/${PLAN}/transcript`)).text;
      const del = await rig.api("DELETE", `/calls/${PLAN}`);
      expect(del.body).toEqual({ ok: true, call: PLAN, trashed: true });
      expect(await listed()).not.toContain(PLAN);
      expect((await rig.api("GET", `/calls/${PLAN}`)).status).toBe(404);
      const trashed = join(root(), TRASH_DIR, "clients", "2026-09-24_153612_plan");
      expect(existsSync(join(trashed, "events.jsonl"))).toBe(true);
      expect(existsSync(before)).toBe(false);
      // Not a workspace: the trash never shows in the workspace list.
      const ws = (await rig.api("GET", "/workspaces")).body.workspaces.map(
        (w: { name: string }) => w.name,
      );
      expect(ws).not.toContain(TRASH_DIR);
      const back = await rig.api("POST", `/calls/${PLAN}/restore`);
      expect(back.body).toEqual({ ok: true, call: PLAN, workspace: "clients" });
      expect(await listed()).toContain(PLAN);
      expect(readFileSync(join(before, "events.jsonl"), "utf8")).toBe(log);
      expect((await rig.api("GET", `/calls/${PLAN}/transcript`)).text).toBe(transcript);
      expect(existsSync(`${trashed}.json`)).toBe(false);
      expect((await rig.api("POST", `/calls/${PLAN}/restore`)).status).toBe(409);
      expect((await rig.api("POST", "/calls/01J8Z6Q4M2VX0K7B3D4E5NOPEXX/restore")).status).toBe(
        404,
      );
    },
    LONG,
  );

  test("the trash keeps a call 30 days: an older one is gone at the start, a newer one stays", async () => {
    const t = join(root(), TRASH_DIR, "work");
    expect(existsSync(join(t, `trashed-${OLD.slice(-1)}`))).toBe(false);
    expect(existsSync(join(t, `trashed-${OLD.slice(-1)}.json`))).toBe(false);
    expect(existsSync(join(t, `trashed-${FRESH.slice(-1)}`, "events.jsonl"))).toBe(true);
    expect(await listed()).not.toContain(FRESH);
    expect((await rig.api("POST", `/calls/${OLD}/restore`)).status).toBe(404);
  });
});

describe("[PG-A5] who spoke one line", () => {
  test(
    "PATCH a segment's spk: a new revision by the caller; the text, the raw text and the old revision stay",
    async () => {
      // The export written by the rename test above, and who it says spoke "fine by me".
      const [file] = readdirSync(join(out.dir, "work")).filter(
        (f) => f.endsWith(".md") && readFileSync(join(out.dir, "work", f), "utf8").includes(SYNC),
      );
      const exported = join(out.dir, "work", file as string);
      const speakerOf = () => {
        const md = readFileSync(exported, "utf8");
        const head = md.slice(0, md.indexOf("fine by me")).matchAll(/\*\*([^*\n]+)\*\* · /g);
        return [...head].at(-1)?.[1];
      };
      expect(speakerOf()).not.toBe("Ben");
      const r = await rig.api("PATCH", `/calls/${SYNC}/segments/l000002`, { spk: "c2" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ line: "l000002", rev: 2, spk: "c2", speaker: "Ben" });
      // The export is written again with the edit.
      await until(async () => speakerOf() === "Ben", 10_000, "the export under the new speaker");
      const lines = (await rig.api("GET", `/calls/${SYNC}/transcript?format=json`)).body.lines;
      expect(lines.find((l: { id: string }) => l.id === "l000002")).toMatchObject({
        speaker: "Ben",
        text: "fine by me",
      });
      const revs = (await eventsOf(SYNC)).filter((e) => e.type === "seg" && e.id === "l000002");
      expect(revs.map((e) => [e.rev, e.spk, e.by ?? null])).toEqual([
        [1, "c3", null],
        [2, "c2", "agent:test"],
      ]);
      // The next pack reads the line under its new speaker.
      const pack = (await rig.api("POST", `/calls/${SYNC}/context`, { question: "who said fine?" }))
        .body.pack;
      expect(pack).toMatch(/Ben: fine by me/);
      // A new voice the call missed gets its own id.
      expect(
        (await rig.api("PATCH", `/calls/${SYNC}/segments/l000002`, { spk: "c9" })).body.spk,
      ).toBe("c9");
      const mic = await rig.api("PATCH", `/calls/${SYNC}/segments/l000003`, { spk: "c2" });
      expect([mic.status, mic.body.error]).toEqual([422, "mic_line"]);
      expect(
        (await rig.api("PATCH", `/calls/${SYNC}/segments/l000002`, { spk: "Ben" })).status,
      ).toBe(422);
      expect(
        (await rig.api("PATCH", `/calls/${SYNC}/segments/l999999`, { spk: "c2" })).status,
      ).toBe(404);
      expect(
        (await rig.api("PATCH", `/calls/${SYNC}/segments/l000002`, { text: "x" })).status,
      ).toBe(400);
    },
    LONG,
  );
});

describe("[PG-A6] an indexer pulls only the calls changed since its cursor", () => {
  test(
    "updatedAfter, then the cursor: nothing new, then a rename puts an old call back",
    async () => {
      const first = (await rig.api("GET", "/calls?updatedAfter=0&limit=1000")).body;
      const ids = first.calls.map((c: { id: string }) => c.id);
      expect(ids).toEqual(expect.arrayContaining([SYNC, PLAN]));
      const times = first.calls.map((c: { updatedAt: number }) => c.updatedAt);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(first.more).toBe(false);
      expect(typeof first.cursor).toBe("string");
      const quiet = (await rig.api("GET", `/calls?cursor=${first.cursor}`)).body;
      expect([quiet.calls, quiet.more, quiet.cursor]).toEqual([[], false, first.cursor]);
      // A page of one leaves the rest for the next request.
      const one = (await rig.api("GET", "/calls?updatedAfter=0&limit=1")).body;
      expect([one.calls.length, one.more]).toEqual([1, ids.length > 1]);
      expect(
        (await rig.api("GET", `/calls?cursor=${one.cursor}&limit=1000`)).body.calls.map(
          (c: { id: string }) => c.id,
        ),
      ).toEqual(ids.slice(1));
      // A rename on the oldest call brings it back, and only it.
      const oldest = ids[0] as string;
      await rig.api("PATCH", `/calls/${oldest}`, { title: "Renamed for the indexer" });
      const next = (await rig.api("GET", `/calls?cursor=${first.cursor}`)).body;
      expect(next.calls.map((c: { id: string }) => c.id)).toEqual([oldest]);
      expect(next.cursor).not.toBe(first.cursor);
      // Positive controls: the plain list is still newest first with no cursor, and a cursor akou
      // never gave is refused.
      const plain = (await rig.api("GET", "/calls")).body;
      expect(plain.cursor).toBeUndefined();
      expect((await rig.api("GET", "/calls?cursor=yesterday")).status).toBe(400);
      expect((await rig.api("GET", "/calls?updatedAfter=soon")).status).toBe(400);
      const iso = (
        await rig.api("GET", `/calls?updatedAfter=${new Date(Date.now() + DAY).toISOString()}`)
      ).body;
      expect(iso.calls).toEqual([]);
    },
    LONG,
  );
});
