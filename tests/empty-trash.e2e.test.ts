/**
 * Empty trash (docs/ux/WINDOW.md W13.3, TRAPS TRASH-1): every call in the trash deleted for good,
 * now, over the API and the CLI, through the same purge the start runs after 30 days. A headless
 * app with saved calls written before it starts; calls that are not in the trash are never touched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRASH_DIR } from "../src/main/call/manager.ts";
import { runCli } from "../src/main/cli/cli.ts";
import type { Io, Keys } from "../src/main/cli/context.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const DAY = 24 * 3600_000;
const KEEP = "01J8Z6Q4M2VX0K7B3D4E5TRSHKP";
const GONE_A = "01J8Z6Q4M2VX0K7B3D4E5TRSHAA";
const GONE_B = "01J8Z6Q4M2VX0K7B3D4E5TRSHBB";
const EARLIER = "01J8Z6Q4M2VX0K7B3D4E5TRSHCC";
/** Calls the CLI tests trash and empty. */
const CLI_CALLS = [
  "01J8Z6Q4M2VX0K7B3D4E5TRSHD1",
  "01J8Z6Q4M2VX0K7B3D4E5TRSHD2",
  "01J8Z6Q4M2VX0K7B3D4E5TRSHD3",
  "01J8Z6Q4M2VX0K7B3D4E5TRSHD4",
] as const;
/** Calls the `upTo` test trashes: one before the question is asked, one after. */
const ASKED = "01J8Z6Q4M2VX0K7B3D4E5TRSHE1";
const LATER = "01J8Z6Q4M2VX0K7B3D4E5TRSHE2";

/** A saved call under `<root>/<workspace>/<folder>`. */
function seed(root: string, workspace: string, folder: string, id: string, title: string): string {
  const b = new LogBuilder();
  b.created({ id, title, workspace }, T0);
  b.partStarted(1, T0);
  b.seg({ id: "l000001", ch: "call", w0: T0 + 1000, text: `the ${title} line` });
  b.partEnded(1, "stop", 2);
  b.add({ type: "call.ended", reason: "stop" });
  const dir = join(root, workspace, folder);
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(join(dir, "audio", "part-001.opus"), "not really audio");
  writeFileSync(
    join(dir, "events.jsonl"),
    `${b.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  return dir;
}

let rig: AppRig;
let home: { dir: string; cleanup: () => void };
let kept: string;
const root = () => join(home.dir, "Recordings", "akou");
const listed = async () =>
  ((await rig.api("GET", "/calls")).body.calls as { id: string }[]).map((c) => c.id);
const inTrash = async () =>
  ((await rig.api("GET", "/trash")).body.calls as { id: string }[]).map((c) => c.id);

beforeAll(async () => {
  home = tempDir("akou-empty-trash-");
  kept = seed(root(), "work", "2026-09-23_153612_keep", KEEP, "Keep me");
  seed(root(), "work", "2026-09-24_1000_aa", GONE_A, "Alpha");
  seed(root(), "hiring", "2026-09-24_1100_bb", GONE_B, "Beta");
  for (const [i, id] of CLI_CALLS.entries()) {
    seed(root(), "work", `2026-09-25_100${i}_d${i}`, id, `Cli ${i}`);
  }
  seed(root(), "work", "2026-09-26_1000_e1", ASKED, "Asked");
  seed(root(), "work", "2026-09-26_1100_e2", LATER, "Later");
  // A call trashed 10 days ago, by an earlier run: inside the 30 days, so the start keeps it.
  const earlier = seed(join(root(), TRASH_DIR), "work", "2026-09-01_0900_cc", EARLIER, "Earlier");
  writeFileSync(
    `${earlier}.json`,
    JSON.stringify({ id: EARLIER, workspace: "work", trashedAt: Date.now() - 10 * DAY }),
  );
  rig = await appRig({ home: home.dir });
});

afterAll(async () => {
  await rig?.close();
  home?.cleanup();
});

describe("[TRASH-1] Empty trash deletes trashed calls for good, now, and nothing else", () => {
  test("GET /trash lists the trash, newest first; DELETE /trash empties it at once", async () => {
    for (const id of [GONE_A, GONE_B]) {
      expect((await rig.api("DELETE", `/calls/${id}`)).status).toBe(200);
    }
    const trash = (await rig.api("GET", "/trash")).body.calls as {
      id: string;
      workspace: string;
      trashedAt: number;
    }[];
    expect(trash.map((c) => c.id).sort()).toEqual([EARLIER, GONE_A, GONE_B].sort());
    expect(trash.at(-1)).toMatchObject({ id: EARLIER, workspace: "work" });
    expect(trash.find((c) => c.id === GONE_B)?.workspace).toBe("hiring");
    // Positive control: the trashed folders are on disk before the empty, so their absence after
    // means something; the call trashed today would wait 30 days without it.
    const trashA = join(root(), TRASH_DIR, "work", "2026-09-24_1000_aa");
    const trashB = join(root(), TRASH_DIR, "hiring", "2026-09-24_1100_bb");
    const trashC = join(root(), TRASH_DIR, "work", "2026-09-01_0900_cc");
    for (const d of [trashA, trashB, trashC]) {
      expect(existsSync(join(d, "events.jsonl"))).toBe(true);
      expect(existsSync(`${d}.json`)).toBe(true);
    }
    const keptLog = readFileSync(join(kept, "events.jsonl"), "utf8");

    const r = await rig.api("DELETE", "/trash");
    expect([r.status, r.body]).toEqual([200, { ok: true, deleted: 3 }]);
    for (const d of [trashA, trashB, trashC]) {
      expect(existsSync(d)).toBe(false);
      expect(existsSync(`${d}.json`)).toBe(false);
    }
    expect(await inTrash()).toEqual([]);
    // Gone for good: no restore brings one back.
    expect((await rig.api("POST", `/calls/${GONE_A}/restore`)).status).toBe(404);

    // The call that was never trashed is untouched: listed, readable, its folder byte for byte.
    expect((await listed()).sort()).toEqual([KEEP, ...CLI_CALLS, ASKED, LATER].sort());
    expect(readFileSync(join(kept, "events.jsonl"), "utf8")).toBe(keptLog);
    expect(existsSync(join(kept, "audio", "part-001.opus"))).toBe(true);
    expect((await rig.api("GET", `/calls/${KEEP}/transcript`)).text).toContain("the Keep me line");

    // An empty trash empties to nothing.
    expect((await rig.api("DELETE", "/trash")).body).toEqual({ ok: true, deleted: 0 });
  });

  test("with upTo, a call trashed after the question was asked stays in the trash", async () => {
    expect((await rig.api("DELETE", `/calls/${ASKED}`)).status).toBe(200);
    // The question the user answers: what GET /trash held then.
    const asked = (await rig.api("GET", "/trash")).body.calls as { trashedAt: number }[];
    expect(asked.length).toBe(1);
    const upTo = Math.max(...asked.map((c) => c.trashedAt));
    await Bun.sleep(20);
    // While the question is open, another call goes to the trash (its Undo still on screen).
    expect((await rig.api("DELETE", `/calls/${LATER}`)).status).toBe(200);

    expect((await rig.api("DELETE", `/trash?upTo=${upTo}`)).body).toEqual({ ok: true, deleted: 1 });
    expect(await inTrash()).toEqual([LATER]);
    // Its Undo still works.
    expect((await rig.api("POST", `/calls/${LATER}/restore`)).status).toBe(200);
    expect(await listed()).toContain(LATER);

    // A bad upTo deletes nothing.
    expect((await rig.api("DELETE", `/calls/${LATER}`)).status).toBe(200);
    expect((await rig.api("DELETE", "/trash?upTo=soon")).status).toBe(400);
    expect(await inTrash()).toEqual([LATER]);
    // Positive control: without upTo the same call goes, so its staying above was upTo's doing.
    expect((await rig.api("DELETE", "/trash")).body).toEqual({ ok: true, deleted: 1 });
    expect(await inTrash()).toEqual([]);
  });

  test("a live call is never touched by an empty", async () => {
    const live = await rig.startCall({ title: "Live one" });
    try {
      expect((await rig.api("DELETE", "/trash")).body).toEqual({ ok: true, deleted: 0 });
      expect((await rig.api("GET", `/calls/${live}`)).body.state).toBe("recording");
    } finally {
      await rig.api("POST", "/calls/live/stop");
    }
    expect(await listed()).toContain(live);
  }, 30_000);
});

/** A terminal that answers the question with `answer`, and records that it was asked. */
function terminal(
  answer: string,
  meanwhile?: () => Promise<void>,
): Keys & { asked: boolean; closed: boolean } {
  const k = {
    asked: false,
    closed: false,
    columns: () => 80,
    close() {
      k.closed = true;
    },
    async *read() {
      k.asked = true;
      await meanwhile?.();
      yield answer;
    },
  };
  return k;
}

describe("[TRASH-1] akou calls empty-trash", () => {
  const run = async (argv: string[], keys?: Keys) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      env: { ...process.env, ...rig.env },
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      keys,
    };
    const code = await runCli(argv, io, { launch: null });
    return { code, out, err };
  };

  test("without --yes and no terminal it deletes nothing and says how to; --yes deletes", async () => {
    const [d1, d2, d3] = CLI_CALLS;
    for (const id of [d1, d2]) {
      expect((await rig.api("DELETE", `/calls/${id}`)).status).toBe(200);
    }

    const refused = await run(["calls", "empty-trash"]);
    expect(refused.code).toBe(64);
    expect(refused.err.join("\n")).toContain("the trash holds 2 calls; calls empty-trash --yes");
    expect((await inTrash()).sort()).toEqual([d1, d2].sort());

    // A person at a terminal who answers anything but y keeps them.
    const no = terminal("n");
    const kept2 = await run(["calls", "empty-trash"], no);
    expect([kept2.code, no.asked, no.closed]).toEqual([0, true, true]);
    expect(kept2.err.join("\n")).toContain(
      "Delete the 2 calls in the trash for good? This cannot be undone.",
    );
    expect((await inTrash()).length).toBe(2);

    // While the question waits for y, another call goes to the trash: it is not one the user
    // was asked about, so it stays.
    const d4 = CLI_CALLS[3];
    const yes = terminal("y", async () => {
      await Bun.sleep(20);
      expect((await rig.api("DELETE", `/calls/${d4}`)).status).toBe(200);
    });
    const deleted = await run(["calls", "empty-trash"], yes);
    expect([deleted.code, deleted.out]).toEqual([0, ["Deleted 2 calls from the trash for good"]]);
    expect(await inTrash()).toEqual([d4]);
    expect((await rig.api("POST", `/calls/${d4}/restore`)).status).toBe(200);
    expect(await inTrash()).toEqual([]);
    // The live test's call is listed too; what matters is the untrashed calls stay, the others don't.
    const left = await listed();
    expect([left.includes(KEEP), left.includes(d3), left.includes(d1), left.includes(d2)]).toEqual([
      true,
      true,
      false,
      false,
    ]);

    // Nothing left: said so, with or without --yes.
    expect((await run(["calls", "empty-trash"])).out).toEqual(["The trash is empty."]);
    expect((await run(["calls", "empty-trash", "--yes"])).out).toEqual(["The trash is empty."]);
    expect((await run(["calls", "empty-trash", "--yes", "--json"])).out).toEqual([
      JSON.stringify({ ok: true, deleted: 0 }),
    ]);
    // It names no call: one given is a usage error, and --yes means nothing elsewhere.
    expect((await run(["calls", "empty-trash", KEEP, "--yes"])).code).toBe(64);
    expect((await run(["calls", "--yes"])).code).toBe(64);
    expect(await listed()).toContain(KEEP);
  }, 30_000);

  test("--yes deletes without asking", async () => {
    const d3 = CLI_CALLS[2];
    expect((await rig.api("DELETE", `/calls/${d3}`)).status).toBe(200);
    const asked = terminal("n");
    const r = await run(["calls", "empty-trash", "--yes"], asked);
    expect([r.code, r.out, asked.asked]).toEqual([
      0,
      ["Deleted 1 call from the trash for good"],
      false,
    ]);
    expect(await inTrash()).toEqual([]);
    expect(await listed()).toContain(KEEP);
  }, 30_000);
});
