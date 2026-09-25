/**
 * Sweeps over the command registry (docs/ux/CLI.md sections 4 and 9): rules every command follows,
 * checked over every command so a new one is covered the day it is added.
 *
 * - CLI-05: help is generated from the registry. Every flag the parser accepts is listed with a
 *   description, every command has an example that parses, and `akou help CMD` prints the same
 *   bytes as `akou CMD --help`.
 * - CLI-03: every command that reaches a call-scoped route (`/calls/{call}/…`) declares `call`
 *   with the short form `-c`. The routes are read from what each command's examples actually
 *   request, against a client that records the requests, not from a hand-kept list.
 */

import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/main/cli/args.ts";
import { COMMANDS, runCli } from "../src/main/cli/cli.ts";
import type { ApiClient, ApiResponse, RequestOptions } from "../src/main/cli/client.ts";
import type { Command, Ctx } from "../src/main/cli/context.ts";
import { acceptedFlags, commandHelp } from "../src/main/cli/help.ts";

/** The flags a help page leaves out, of those the parser accepts for `cmd`. */
export function unlistedFlags(cmd: Command, help: string): string[] {
  const rows = help.split("\n").filter((l) => /^ {2}(?:-[a-zA-Z], | {4})--/.test(l));
  const missing: string[] = [];
  for (const [name, f] of acceptedFlags(cmd)) {
    const row = rows.find((l) => new RegExp(`^ {2}(?:-[a-zA-Z], | {4})--${name}(?:\\s|$)`).test(l));
    const described = row?.replace(/^\s*(?:-[a-zA-Z], )?--\S+(?: [^\s]+)?\s{2,}/, "").trim();
    if (!row || !described) missing.push(`--${name}`);
    else if (f.short && !row.includes(`-${f.short}, --${name}`)) missing.push(`-${f.short}`);
  }
  return missing;
}

/** Why an example does not parse against its command, or null. */
function exampleProblem(cmd: Command, example: string): string | null {
  const words = (example.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) =>
    /^(["']).*\1$/.test(w) ? w.slice(1, -1) : w,
  );
  // A pipe feeds a command (`printf … | akou config set KEY -`): the akou part is what parses.
  const at = words.lastIndexOf("akou");
  if (at < 0 || words[at + 1] !== cmd.name) return `does not run akou ${cmd.name}`;
  try {
    parseArgs(words.slice(at + 2), cmd.flags ?? {});
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

/** A client that answers every request with a 404 and records what was asked. */
function recordingClient(seen: string[]): ApiClient {
  const answer = (): ApiResponse => ({
    status: 404,
    body: { error: "not_found", message: "recorded" },
    text: "",
    contentType: "application/json",
  });
  return {
    configDir: "/nonexistent",
    runtime: () => null,
    request: async (method: string, path: string, _o?: RequestOptions) => {
      seen.push(`${method} ${path}`);
      return answer();
    },
    stream: async (method: string, path: string) => {
      seen.push(`${method} ${path}`);
      return new Response(JSON.stringify(answer().body), { status: 404 });
    },
  } as unknown as ApiClient;
}

/** The requests a command sends for one argument list. */
async function requestsOf(cmd: Command, argv: string[]): Promise<string[]> {
  const seen: string[] = [];
  const ctx: Ctx = {
    // A terminal whose keyboard closes at once, so `watch` runs as far as its first requests.
    io: {
      env: {},
      out: () => {},
      err: () => {},
      write: () => {},
      tty: true,
      keys: { read: async function* () {}, close: () => {}, columns: () => 80 },
    },
    json: false,
    client: recordingClient(seen),
    version: "0",
  };
  try {
    await cmd.run(ctx, parseArgs(argv, cmd.flags ?? {}));
  } catch {}
  return seen;
}

/** Commands that touch only akou's own folders or the terminal (CLI.md rule 1): no route. */
const LOCAL_ONLY: Readonly<Record<string, string>> = {
  token: "reads and writes the token file",
  models: "downloads and checks model files",
  skill: "copies the skills and registers the MCP server",
  doctor: "checks akou's folders and asks the running app only for /status",
  mcp: "serves MCP on stdin and stdout until they close",
};

const CALL_ROUTE = /^[A-Z]+ \/calls\/[^/?]+/;
/** Routes that act on one call named in the body (`call`, default live), not in the path. */
const CALL_BODY_ROUTES = new Set(["POST /share", "DELETE /share"]);

function argvOf(example: string): string[] {
  const words = (example.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) =>
    /^(["']).*\1$/.test(w) ? w.slice(1, -1) : w,
  );
  return words.slice(words.lastIndexOf("akou") + 2);
}

/** The commands that do not declare `-c/--call` although they reach a call-scoped route. */
async function callFlagGaps(commands: readonly Command[]): Promise<string[]> {
  const gaps: string[] = [];
  for (const cmd of commands) {
    if (Object.hasOwn(LOCAL_ONLY, cmd.name) || cmd.unbuilt) continue;
    const routes = new Set<string>();
    for (const ex of cmd.examples) {
      for (const r of await requestsOf(cmd, argvOf(ex))) routes.add(r);
    }
    // An example that sends nothing hides the command from the sweep: it fails instead.
    if (routes.size === 0) {
      gaps.push(`${cmd.name} (no example sent a request; mark it LOCAL_ONLY if it needs none)`);
      continue;
    }
    const scoped = [...routes].filter((r) => CALL_ROUTE.test(r) || CALL_BODY_ROUTES.has(r));
    const flag = cmd.flags?.call;
    if (scoped.length > 0 && (flag?.type !== "string" || flag.short !== "c")) {
      gaps.push(`${cmd.name} (${scoped.join(", ")})`);
    }
  }
  return gaps;
}

describe("[CLI-05] Help lists every flag with an example, and help CMD works", () => {
  test("every flag the parser accepts is on its command's help page, with a description", () => {
    const gaps = COMMANDS.flatMap((c) =>
      unlistedFlags(c, commandHelp(c)).map((f) => `${c.name} ${f}`),
    );
    expect(gaps).toEqual([]);
    // The audit's misses are on the page now.
    const vocab = commandHelp(COMMANDS.find((c) => c.name === "vocab") as Command);
    for (const f of ["--heard", "--no-decode", "--note", "--text", "-k", "--unconfirmed"]) {
      expect(vocab).toContain(f);
    }
    expect(commandHelp(COMMANDS.find((c) => c.name === "show") as Command)).toContain("--json");
  });

  test("positive control: a page missing a flag, a short form or a description fails", () => {
    const tail = COMMANDS.find((c) => c.name === "tail") as Command;
    const page = commandHelp(tail);
    expect(unlistedFlags(tail, page)).toEqual([]);
    const without = page
      .split("\n")
      .filter((l) => !l.includes("--since"))
      .join("\n");
    expect(unlistedFlags(tail, without)).toEqual(["--since"]);
    expect(unlistedFlags(tail, page.replace("-f, --follow", "    --follow"))).toEqual(["-f"]);
    expect(unlistedFlags(tail, page.replace("keep printing until the call ends", ""))).toEqual([
      "--follow",
    ]);
  });

  test("--json says what it does on each command: tail's is --format json; watch refuses it; mcp ignores it", () => {
    const jsonRow = (name: string) =>
      commandHelp(COMMANDS.find((c) => c.name === name) as Command)
        .split("\n")
        .find((l) => /^ {6}--json /.test(l))
        ?.replace(/^\s*--json\s+/, "");
    expect(jsonRow("tail")).toBe("same as --format json");
    expect(jsonRow("watch")).toContain("exits 64");
    expect(jsonRow("mcp")).toContain("ignored");
    // Positive control: a command that prints its answer as JSON keeps the common line.
    expect(jsonRow("show")).toBe("print the answer as JSON, errors included");
  });

  test("every command has at least one example, and each parses against its own flags", () => {
    const bad: string[] = [];
    for (const c of COMMANDS) {
      if (c.examples.length === 0) bad.push(`${c.name}: no example`);
      for (const ex of c.examples) {
        const why = exampleProblem(c, ex);
        if (why) bad.push(`${c.name}: \`${ex}\`: ${why}`);
      }
    }
    expect(bad).toEqual([]);
    // Positive control: an example with a flag the command does not have.
    const tail = COMMANDS.find((c) => c.name === "tail") as Command;
    expect(exampleProblem(tail, "akou tail --bogus")).toBe("unknown option --bogus");
    expect(exampleProblem(tail, "akou show last")).toBe("does not run akou tail");
  });

  test("`akou help CMD` and `akou CMD --help` print identical bytes, for every command", async () => {
    const run = async (argv: string[]) => {
      const out: string[] = [];
      const code = await runCli(
        argv,
        { env: {}, out: (t) => out.push(t), err: () => {} },
        {
          launch: null,
        },
      );
      return { code, out: out.join("\n") };
    };
    for (const c of COMMANDS) {
      const a = await run(["help", c.name]);
      const b = await run([c.name, "--help"]);
      expect([c.name, a.code, a.out]).toEqual([c.name, 0, b.out]);
      expect(b.out).toStartWith(`akou ${c.name}: `);
    }
    // The page the design sketches.
    const tail = await run(["help", "tail"]);
    expect(tail.out).toContain("  -c, --call CALL");
    expect(tail.out).toContain("example: akou tail -f --last 2m");
    const unknown = await run(["help", "frobnicate"]);
    expect(unknown.code).toBe(64);
    const v = await run(["-v"]);
    expect([v.code, v.out]).toEqual([0, (await run(["--version"])).out]);
  });
});

describe("[CLI-03] One way to name a call in every command", () => {
  test("every command that reaches a call-scoped route declares `call` with short `c`", async () => {
    expect(await callFlagGaps(COMMANDS)).toEqual([]);
    // The sweep sees the routes it is meant to: these reach a call-scoped route.
    const scoped: string[] = [];
    for (const name of ["tail", "stop", "show", "note", "finalize", "export", "vocab"]) {
      const c = COMMANDS.find((x) => x.name === name) as Command;
      for (const ex of c.examples) {
        const r = await requestsOf(c, argvOf(ex));
        if (r.some((x) => CALL_ROUTE.test(x))) {
          scoped.push(name);
          break;
        }
      }
    }
    expect(scoped).toEqual(["tail", "stop", "show", "note", "finalize", "export", "vocab"]);
  });

  test("positive control: a call command without `-c` fails the sweep", async () => {
    const bare: Command = {
      name: "poke",
      summary: "a test command",
      usage: "akou poke",
      examples: ["akou poke"],
      flags: { call: { type: "string", desc: "a call, but no -c" } },
      run: async (ctx) => {
        await ctx.client.request("POST", "/calls/live/poke");
        return 0;
      },
    };
    expect(await callFlagGaps([bare])).toEqual(["poke (POST /calls/live/poke)"]);
    // An example that throws before its first request cannot hide a command from the sweep.
    const broken: Command = {
      ...bare,
      name: "broken",
      run: async () => {
        throw new Error("boom");
      },
    };
    expect(await callFlagGaps([broken])).toEqual([
      "broken (no example sent a request; mark it LOCAL_ONLY if it needs none)",
    ]);
    // A call named in the body, on a route that acts on one call, counts as call-scoped.
    const sharing: Command = {
      ...bare,
      name: "sharing",
      run: async (ctx) => {
        await ctx.client.request("POST", "/share", { body: {} });
        return 0;
      },
    };
    expect(await callFlagGaps([sharing])).toEqual(["sharing (POST /share)"]);
  });

  test("a call named with -c sends the same request as the call as first word", async () => {
    const pairs: [string, string[], string[]][] = [
      ["show", ["last", "--format", "txt"], ["-c", "last", "--format", "txt"]],
      ["finalize", ["01JB7X"], ["-c", "01JB7X"]],
      ["export", ["01JB7X"], ["-c", "01JB7X"]],
      ["hooks", ["run", "01JB7X"], ["run", "-c", "01JB7X"]],
      ["open", ["01JB7X"], ["-c", "01JB7X"]],
    ];
    for (const [name, word, flag] of pairs) {
      const c = COMMANDS.find((x) => x.name === name) as Command;
      expect([name, await requestsOf(c, flag)]).toEqual([name, await requestsOf(c, word)]);
    }
    // Controls take -c too, and act on the live call when none is named.
    const mute = COMMANDS.find((x) => x.name === "mute") as Command;
    expect(await requestsOf(mute, [])).toEqual(["POST /calls/live/mute"]);
    expect(await requestsOf(mute, ["-c", "01JB7X"])).toEqual(["POST /calls/01JB7X/mute"]);
  });

  test("share names its call with -c in the body, and sends none without it (the app's live)", async () => {
    const share = COMMANDS.find((x) => x.name === "share") as Command;
    const bodies: unknown[] = [];
    const client = {
      request: async (method: string, path: string, o?: RequestOptions) => {
        bodies.push([method, path, (o?.body as { call?: string } | undefined)?.call]);
        return { status: 200, body: { ok: true }, text: "", contentType: "application/json" };
      },
    } as unknown as ApiClient;
    const ctx: Ctx = {
      io: { env: {}, out: () => {}, err: () => {} },
      json: false,
      client,
      version: "0",
    };
    for (const argv of [["on", "-c", "last"], ["on"], ["off", "-c", "01JB7X"], ["off"]]) {
      await share.run(ctx, parseArgs(argv, share.flags ?? {}));
    }
    expect(bodies).toEqual([
      ["POST", "/share", "last"],
      ["POST", "/share", undefined],
      ["DELETE", "/share", "01JB7X"],
      ["DELETE", "/share", undefined],
    ]);
  });

  test("the call named twice, two different ways, is a usage error", async () => {
    const out: string[] = [];
    const code = await runCli(
      ["show", "one", "-c", "two"],
      { env: {}, out: () => {}, err: (t) => out.push(t) },
      { launch: null },
    );
    expect(code).toBe(64);
    expect(out.join("\n")).toContain("the call is named twice");
  });
});
