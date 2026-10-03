/**
 * Exit 3 means "no call to act on", in every command (docs/ux/CLI.md section 6, CLI-16): with no
 * calls at all, with `-c` naming a call that does not exist, and with nothing live for a command
 * that acts on the live call. The table lists every command in the registry, so a new command
 * fails here until it says whether it acts on a call.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { COMMANDS, runCli } from "../src/main/cli/cli.ts";
import { EXIT } from "../src/main/cli/client.ts";
import type { Command } from "../src/main/cli/context.ts";
import { type AppRig, appRig } from "./api-helpers.ts";

const LONG = 60_000;
/** A call id no call has. */
const NO_SUCH = "01JB7X0000000000000000NONE";

/** `-c CALL` when a call is named, nothing otherwise (the command's own default). */
const c = (call?: string): string[] => (call ? ["-c", call] : []);

/**
 * Every command in the registry: how to run it on a call (`call` undefined: its default, or
 * `last` where it needs one named), or why it acts on no call.
 */
const TABLE: Readonly<Record<string, ((call?: string) => string[]) | string>> = {
  start: "starts a call",
  stop: (x) => ["stop", ...c(x)],
  pause: (x) => ["pause", ...c(x)],
  resume: (x) => ["resume", ...c(x)],
  mute: (x) => ["mute", ...c(x)],
  unmute: (x) => ["unmute", ...c(x)],
  restart: (x) => ["restart", ...c(x)],
  status: "reports the app, live or not",
  open: (x) => ["open", "-c", x ?? "last"],
  calls: (x) => ["calls", "rename", "-c", x ?? "last", "Weekly", "sync"],
  workspaces: "lists workspaces",
  workspace: "adds a workspace",
  show: (x) => ["show", "-c", x ?? "last"],
  finalize: (x) => ["finalize", ...c(x)],
  enhance: (x) => ["enhance", ...c(x)],
  templates: "lists and prints the note templates",
  quit: "quits the app",
  tail: (x) => ["tail", ...c(x)],
  context: (x) => ["context", "what was decided?", ...c(x)],
  ask: (x) => ["ask", "what was decided?", ...c(x)],
  search: (x) => ["search", "deploy", ...c(x)],
  wait: (x) => ["wait", "--for", "final.done", "--timeout", "5s", ...c(x)],
  watch: (x) => ["watch", ...c(x)],
  name: (x) => ["name", "c2", "Ben", ...c(x)],
  note: (x) => ["note", "ship on Friday", ...c(x)],
  remember: (x) => ["remember", "Ben owns the deploy", ...c(x)],
  export: (x) => ["export", ...c(x)],
  // `hooks run` takes no `last` (its route refuses it on every app), so the default names `live`.
  hooks: (x) => ["hooks", "run", "-c", x ?? "live"],
  import: "imports folders as new calls",
  jobs: "lists transcription jobs",
  vocab: (x) => ["vocab", "list", "-c", x ?? "last"],
  doctor: "checks the install",
  config: "reads and writes settings",
  token: "reads and writes the token file",
  models: "downloads and checks model files",
  share: (x) => ["share", "on", ...c(x)],
  keys: "reads and writes the keys file",
  admin: "writes the admin password hash",
  transcribe: "transcribes a file into a job",
  dictate: "dictates a clip",
  dictations: "lists dictations",
  skill: "installs the skill",
  mcp: "serves MCP",
  serve: "is the server",
  devices: "not built",
  apps: "not built",
  "self-update": "not built",
};

/** One command in process against the rig, on a terminal whose keyboard closes at once. */
async function run(rig: AppRig, argv: string[]): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const code = await runCli(
    argv,
    {
      env: { ...process.env, ...rig.env },
      out: () => {},
      err: (t) => err.push(t),
      write: () => {},
      tty: true,
      keys: { read: async function* () {}, close: () => {}, columns: () => 80 },
    },
    { launch: null },
  );
  return { code, err: err.join("\n") };
}

/** Each call command's exit for one way of naming the call, as `name: code`. */
async function exits(rig: AppRig, call: string | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const [name, row] of Object.entries(TABLE)) {
    if (typeof row === "string") continue;
    const r = await run(rig, row(call));
    out.push(`${name}: ${r.code}${r.code === EXIT.notLive ? "" : ` (${r.err})`}`);
  }
  return out;
}

const allThree = () =>
  Object.entries(TABLE)
    .filter(([, row]) => typeof row !== "string")
    .map(([name]) => `${name}: ${EXIT.notLive}`);

/** The commands whose call defaults to the live one: the controls and the live questions. */
const LIVE_DEFAULT = COMMANDS.filter((x) =>
  /\(default: live[;)]/.test(x.flags?.call?.desc ?? ""),
).map((x) => x.name);

/** What the table gets wrong about `commands`: a command it misses, or a call command it excuses. */
function tableGaps(commands: readonly Command[]): string[] {
  const gaps = commands
    .filter((x) => !Object.hasOwn(TABLE, x.name))
    .map((x) => `${x.name}: missing`);
  // `start --call` names an audio source, not a call, so only `-c` makes a call command.
  for (const x of commands) {
    if (x.flags?.call?.short === "c" && typeof TABLE[x.name] === "string") {
      gaps.push(`${x.name}: takes -c but has no call row`);
    }
  }
  const names = new Set(commands.map((x) => x.name));
  for (const n of Object.keys(TABLE)) if (!names.has(n)) gaps.push(`${n}: not a command`);
  return gaps;
}

describe("[CLI-16] Exit 3 means no call to act on, in every command", () => {
  test("the table names every command in the registry, and every command with -c is a call row", () => {
    expect(tableGaps(COMMANDS)).toEqual([]);
    // Positive control: a new command missing from the table, or excused although it takes -c.
    const poke: Command = {
      name: "poke",
      summary: "a test command",
      usage: "akou poke [-c CALL]",
      examples: ["akou poke"],
      flags: { call: { type: "string", short: "c", desc: "a call" } },
      run: async () => 0,
    };
    expect(tableGaps([...COMMANDS, poke])).toEqual(["poke: missing"]);
    const status = COMMANDS.map((x) => (x.name === "status" ? { ...poke, name: "status" } : x));
    expect(tableGaps(status)).toEqual(["status: takes -c but has no call row"]);
    // The controls and the live questions default to the live call.
    for (const n of ["stop", "pause", "resume", "mute", "unmute", "tail", "ask", "note"]) {
      expect(LIVE_DEFAULT).toContain(n);
    }
    expect(LIVE_DEFAULT).not.toContain("restart");
  });

  describe("against a running app", () => {
    let rig: AppRig;
    beforeAll(async () => {
      rig = await appRig();
    }, LONG);
    afterAll(() => rig?.close());

    test(
      "with no calls at all, every call command exits 3, by default and with -c naming no call",
      async () => {
        expect((await rig.api("GET", "/calls")).body.calls).toEqual([]);
        expect(await exits(rig, undefined)).toEqual(allThree());
        expect(await exits(rig, NO_SUCH)).toEqual(allThree());
      },
      LONG,
    );

    test(
      "with one ended call and nothing live, every command that acts on the live call exits 3",
      async () => {
        const id = await rig.startCall({ title: "Ended", withoutModels: true });
        expect((await rig.api("POST", `/calls/${id}/stop`)).status).toBe(200);
        const got: string[] = [];
        for (const name of LIVE_DEFAULT) {
          const row = TABLE[name] as (call?: string) => string[];
          const r = await run(rig, row());
          got.push(`${name}: ${r.code}${r.code === EXIT.notLive ? "" : ` (${r.err})`}`);
        }
        expect(got).toEqual(LIVE_DEFAULT.map((n) => `${n}: ${EXIT.notLive}`));
        // Control: the same commands on the ended call, by id, are not refused as "no call".
        expect((await run(rig, ["show", "-c", id])).code).toBe(EXIT.ok);
        expect((await run(rig, ["tail", "-c", id])).code).toBe(EXIT.ok);
        // Another missing thing is still a usage error, never "no call".
        expect((await run(rig, ["note", "--del", "n9999", "-c", id])).code).toBe(EXIT.usage);
      },
      LONG,
    );
  });
});
