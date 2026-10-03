/**
 * Renaming a call at any time (WR-7, docs/ux/WINDOW.md section 3.1): a `call.renamed` event with a
 * higher `rev`, never an edit of `call.created`. The fold, then a headless app with the fake helper
 * driven over the API, the CLI and MCP: a saved call and a live one, the list and the status
 * following at once and after the app starts again, an empty title refused with the old name kept.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateDraft } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { runCli } from "../src/main/cli/cli.ts";
import { ApiClient } from "../src/main/cli/client.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";
import { mcpClient } from "./mcp-helpers.ts";

const LONG = 30_000;
const SAVED = "01J8Z6Q4M2VX0K7B3D4E5RENAME";

/** A saved call, written under the recordings root before the app starts. */
function seedSaved(home: string): string {
  const b = new LogBuilder();
  b.created({ id: SAVED, title: "Weekly sync" });
  b.partStarted(1, T0);
  b.seg({ id: "l000001", ch: "call", w0: T0 + 1000, text: "hello there" });
  b.partEnded(1, "stop", 2);
  b.add({ type: "call.ended", reason: "stop" });
  const dir = join(home, "Recordings", "akou", "work", "2026-09-23_153612_rename");
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    `${b.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  return dir;
}

describe("the fold", () => {
  test("the highest rev of call.renamed is the title; call.created is never changed", () => {
    const b = new LogBuilder();
    const created = b.created({ title: "Weekly sync" });
    expect(fold(b.events).titleRev).toBe(0);
    b.add({ type: "call.renamed", rev: 1, title: "Q3 planning", by: "user" });
    b.add({ type: "call.renamed", rev: 3, title: "Q3 planning, final", by: "agent:codex" });
    // A revision lower than the one in force changes nothing, wherever it lands in the log.
    b.add({ type: "call.renamed", rev: 2, title: "stale", by: "user" });
    const v = fold(b.events);
    expect(v.call?.title).toBe("Q3 planning, final");
    expect(v.titleRev).toBe(3);
    // Everything else call.created carries is still there, and the event itself is untouched.
    expect(v.call?.workspace).toBe("work");
    expect(v.call?.id).toBe(created.type === "call.created" ? created.id : "");
    expect((created as { title: string }).title).toBe("Weekly sync");
  });

  test("an empty title is not an event; rev starts at 1", () => {
    expect(validateDraft({ type: "call.renamed", rev: 1, title: "Q3", by: "user" }).ok).toBe(true);
    // Positive controls: each broken rule is refused.
    expect(validateDraft({ type: "call.renamed", rev: 1, title: "  ", by: "user" })).toEqual({
      ok: false,
      error: "call.renamed: title must not be empty",
    });
    expect(validateDraft({ type: "call.renamed", rev: 0, title: "Q3", by: "user" }).ok).toBe(false);
    expect(validateDraft({ type: "call.renamed", rev: 1, title: "Q3", by: "Ana" }).ok).toBe(false);
  });
});

describe("renaming over every door", () => {
  let home: { dir: string; cleanup: () => void };
  let rig: AppRig;
  let dir: string;

  beforeAll(async () => {
    home = tempDir("akou-rename-");
    dir = seedSaved(home.dir);
    rig = await appRig({ home: home.dir });
  });

  afterAll(async () => {
    await rig?.close();
    home?.cleanup();
  });

  const listed = async (id: string) =>
    ((await rig.api("GET", "/calls")).body.calls as { id: string; title: string }[]).find(
      (c) => c.id === id,
    )?.title;

  test("a saved call: the record and the list answer the new name at once", async () => {
    expect(await listed(SAVED)).toBe("Weekly sync");
    const r = await rig.api("PATCH", `/calls/${SAVED}`, { title: "  Q3   planning " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, call: SAVED, title: "Q3 planning" });
    expect((await rig.api("GET", `/calls/${SAVED}`)).body.title).toBe("Q3 planning");
    expect(await listed(SAVED)).toBe("Q3 planning");
    // Appended, never edited: call.created still carries the first title.
    const events = (await rig.api("GET", `/calls/${SAVED}/events`)).body.events;
    expect(events[0]).toMatchObject({ type: "call.created", title: "Weekly sync" });
    expect(events.at(-1)).toMatchObject({ type: "call.renamed", rev: 1, title: "Q3 planning" });
    // Who renamed it: this client, as every write through the API records it.
    expect(events.at(-1).by).toBe("agent:test");
    // The folder keeps its name.
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain('"call.renamed"');
  });

  test("an empty title answers 422 and the old name stays; an unknown call 404", async () => {
    for (const title of ["", "   ", "\n"]) {
      const r = await rig.api("PATCH", `/calls/${SAVED}`, { title });
      expect([title, r.status, r.body.error]).toEqual([title, 422, "bad_field"]);
    }
    expect((await rig.api("PATCH", `/calls/${SAVED}`, { title: "x".repeat(201) })).status).toBe(
      422,
    );
    expect(await listed(SAVED)).toBe("Q3 planning");
    const unknown = await rig.api("PATCH", "/calls/01J8Z6Q4M2VX0K7B3D4E5NOPE0", { title: "Q4" });
    expect(unknown.status).toBe(404);
    // An unknown call is a 404 even with a bad title: the call is looked up first.
    expect(
      (await rig.api("PATCH", "/calls/01J8Z6Q4M2VX0K7B3D4E5NOPE0", { title: "" })).status,
    ).toBe(404);
    // A field the route does not take is refused (moving takes `workspace`, PG-A4).
    const other = await rig.api("PATCH", `/calls/${SAVED}`, { title: "Q4", folder: "home" });
    expect([other.status, other.body.error]).toEqual([400, "unknown_field"]);
  });

  test(
    "a live call: renamed while it records, and the status carries the new name",
    async () => {
      const id = await rig.startCall({ title: "Standup" });
      try {
        const r = await rig.api("PATCH", "/calls/live", { title: "Standup with design" });
        expect([r.status, r.body.call]).toEqual([200, id]);
        expect((await rig.api("GET", "/status")).body.live.title).toBe("Standup with design");
        expect((await rig.api("GET", "/calls/live")).body.title).toBe("Standup with design");
        expect(await listed(id)).toBe("Standup with design");
        expect((await rig.api("GET", "/calls/live")).body.state).toBe("recording");
      } finally {
        await rig.api("POST", "/calls/live/stop");
      }
      // After the call ended, the same route renames it again, one revision up.
      const again = await rig.api("PATCH", `/calls/${id}`, { title: "Standup, 29 Sep" });
      expect(again.status).toBe(200);
      const events = (await rig.api("GET", `/calls/${id}/events`)).body.events;
      const renames = events.filter((e: { type: string }) => e.type === "call.renamed");
      expect(renames.map((e: { rev: number }) => e.rev)).toEqual([1, 2]);
      expect(await listed(id)).toBe("Standup, 29 Sep");
    },
    LONG,
  );

  test("the CLI: akou calls rename CALL TITLE…", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      env: { ...process.env, ...rig.env },
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
    };
    expect(
      await runCli(["calls", "rename", SAVED, "Planning", "review"], io, { launch: null }),
    ).toBe(0);
    expect(out).toEqual([`${SAVED} is now "Planning review"`]);
    expect(await listed(SAVED)).toBe("Planning review");
    // No title, or a blank one, is a usage error the CLI refuses without sending; name kept.
    expect(await runCli(["calls", "rename", SAVED], io, { launch: null })).toBe(64);
    expect(await runCli(["calls", "rename", SAVED, " "], io, { launch: null })).toBe(64);
    // -c only names the call to rename; listing refuses it instead of ignoring it.
    expect(await runCli(["calls", "-c", SAVED], io, { launch: null })).toBe(64);
    expect(await listed(SAVED)).toBe("Planning review");
  });

  test("MCP: akou_rename_call", async () => {
    const api = new ApiClient({ env: { ...process.env, ...rig.env }, client: "mcp", launch: null });
    const c = await mcpClient(api, "codex");
    try {
      const r = await c.call("akou_rename_call", { call: SAVED, title: "Planning, agreed" });
      expect(r.isError).toBe(false);
      expect(r.structured).toEqual({ call: SAVED, title: "Planning, agreed" });
      expect(await listed(SAVED)).toBe("Planning, agreed");
      const events = (await rig.api("GET", `/calls/${SAVED}/events`)).body.events;
      expect(events.at(-1).by).toBe("agent:codex");
    } finally {
      await c.close();
    }
  });

  test(
    "the new name survives the app starting again (the list is read from the log)",
    async () => {
      await rig.close();
      rig = await appRig({ home: home.dir });
      expect(await listed(SAVED)).toBe("Planning, agreed");
      expect((await rig.api("GET", `/calls/${SAVED}`)).body.title).toBe("Planning, agreed");
    },
    LONG,
  );
});
