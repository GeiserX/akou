/**
 * Workspaces (docs/ux/WINDOW.md section 3.1, docs/ux/CLI.md section 4): a workspace is a folder
 * under the recordings folder. `GET /workspaces` lists the folders, empty ones included, and the
 * workspace of every call; `POST /workspaces` makes the folder of a new one, so it is there before
 * its first call and after the app starts again. The CLI's `workspaces` and `workspace add` are
 * the same over the API.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/main/cli/cli.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const LONG = 30_000;

/** A saved call in `work`, and a file and a hidden folder under the root that are no workspace. */
function seed(home: string): string {
  const root = join(home, "Recordings", "akou");
  const b = new LogBuilder();
  b.created({ id: "01J8Z6Q4M2VX0K7B3D4E5WSPACE", title: "Weekly sync" });
  b.partStarted(1, T0);
  b.partEnded(1, "stop", 2);
  b.add({ type: "call.ended", reason: "stop" });
  const dir = join(root, "work", "2026-09-23_153612_weekly-sync");
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    `${b.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  mkdirSync(join(root, ".trash"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "not a workspace\n");
  return root;
}

describe("workspaces over the API and the CLI", () => {
  let home: { dir: string; cleanup: () => void };
  let rig: AppRig;
  let root: string;

  beforeAll(async () => {
    home = tempDir("akou-ws-");
    root = seed(home.dir);
    rig = await appRig({ home: home.dir });
  });

  afterAll(async () => {
    await rig?.close();
    home?.cleanup();
  });

  const names = async () =>
    (
      (await rig.api("GET", "/workspaces")).body.workspaces as { name: string; calls: number }[]
    ).map((w) => `${w.name} ${w.calls}`);

  test("the list: every workspace folder with its calls; a file or a hidden folder is none", async () => {
    expect(await names()).toEqual(["work 1"]);
  });

  test("POST makes the folder: created when new, not when it exists, nothing on a bad name", async () => {
    const r = await rig.api("POST", "/workspaces", { name: " Personal " });
    expect([r.status, r.body]).toEqual([200, { ok: true, workspace: "Personal", created: true }]);
    expect(statSync(join(root, "Personal")).isDirectory()).toBe(true);
    // An empty workspace is listed, with no calls.
    expect(await names()).toEqual(["Personal 0", "work 1"]);
    const again = await rig.api("POST", "/workspaces", { name: "work" });
    expect([again.status, again.body.created]).toEqual([200, false]);
    for (const name of ["", "a/b", "..", ".hidden", "with space"]) {
      const bad = await rig.api("POST", "/workspaces", { name });
      expect([name, bad.status, bad.body.error]).toEqual([name, 400, "bad_workspace"]);
    }
    expect(existsSync(join(root, "a"))).toBe(false);
    // A file with the name is not a workspace to reuse.
    const file = await rig.api("POST", "/workspaces", { name: "notes.txt" });
    expect([file.status, file.body.error]).toEqual([409, "workspace_not_folder"]);
    const missing = await rig.api("POST", "/workspaces", {});
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });

  test("the CLI: akou workspaces, akou workspace add NAME", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      env: { ...process.env, ...rig.env },
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
    };
    expect(await runCli(["workspace", "add", "clients"], io, { launch: null })).toBe(0);
    expect(out).toEqual(["Added workspace clients"]);
    expect(await runCli(["workspace", "add", "clients"], io, { launch: null })).toBe(0);
    expect(out.at(-1)).toBe("Workspace clients already exists");
    out.length = 0;
    expect(await runCli(["workspaces"], io, { launch: null })).toBe(0);
    expect(out).toEqual(["clients  0 calls\nPersonal  0 calls\nwork  1 call"]);
    out.length = 0;
    expect(await runCli(["workspaces", "--json"], io, { launch: null })).toBe(0);
    expect(JSON.parse(out[0] as string).workspaces).toContainEqual({ name: "work", calls: 1 });
    // Usage errors never send: no name, two names, another verb.
    for (const argv of [
      ["workspace"],
      ["workspace", "add"],
      ["workspace", "add", "a", "b"],
      ["workspace", "rm", "a"],
    ]) {
      expect([argv.join(" "), await runCli(argv, io, { launch: null })]).toEqual([
        argv.join(" "),
        64,
      ]);
    }
    // A name the app refuses is the API's refusal.
    expect(await runCli(["workspace", "add", "a/b"], io, { launch: null })).not.toBe(0);
  });

  test(
    "an empty workspace survives the app starting again, and a call can start in it",
    async () => {
      await rig.close();
      rig = await appRig({ home: home.dir });
      expect(await names()).toEqual(["clients 0", "Personal 0", "work 1"]);
      const id = await rig.startCall({ workspace: "Personal", title: "First" });
      await rig.api("POST", "/calls/live/stop");
      expect((await rig.api("GET", `/calls/${id}`)).body.workspace).toBe("Personal");
      expect(await names()).toEqual(["clients 0", "Personal 1", "work 1"]);
    },
    LONG,
  );

  test(
    "a disk that ignores case keeps one workspace under its folder's spelling; one that keeps case keeps two",
    async () => {
      const folded = existsSync(join(root, "PERSONAL"));
      const add = await rig.api("POST", "/workspaces", { name: "PERSONAL" });
      expect(add.body).toEqual(
        folded
          ? { ok: true, workspace: "Personal", created: false }
          : { ok: true, workspace: "PERSONAL", created: true },
      );
      const id = await rig.startCall({ workspace: "personal", title: "Second" });
      await rig.api("POST", "/calls/live/stop");
      expect((await rig.api("GET", `/calls/${id}`)).body.workspace).toBe("personal");
      expect(await names()).toEqual(
        folded
          ? ["clients 0", "Personal 2", "work 1"]
          : ["clients 0", "personal 1", "Personal 1", "PERSONAL 0", "work 1"],
      );
    },
    LONG,
  );
});
