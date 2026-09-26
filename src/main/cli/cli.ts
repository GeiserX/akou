#!/usr/bin/env bun
/**
 * The `akou` command line (docs/DESIGN.md section 6.1): every command is a thin client of the
 * app's local API (`client.ts`), except the few that touch only akou's own folders (`token`,
 * `models`, `skill`, `doctor`). Human output by default, the API's JSON with `--json`, and the
 * design's exit codes:
 *
 *   0 ok · 3 nothing live · 64 usage · 65 a vocabulary term fails validation · 69 unavailable
 *   (app, model, provider, or not built yet) · 70 software · 75 already recording · 77 permission
 *
 * If the app is not running, a command that needs it launches it headless and waits up to 3 s.
 *
 * This is the one file that reads `process.argv`: the arguments are the CLI's interface. The app
 * never reads them (TRAPS "Command-line arguments dropped by the launcher"); it takes headless mode
 * from `AKOU_HEADLESS`, which is what this CLI sets when it launches it.
 */

import { APP_VERSION } from "../app-info.ts";
import type { ModelSpecEntry } from "../asr/models.ts";
import { parseArgs, UsageError } from "./args.ts";
import { ApiClient, EXIT, Unreachable } from "./client.ts";
import { callCommands } from "./commands/calls.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { followCommands } from "./commands/follow.ts";
import { handoffCommands } from "./commands/handoff.ts";
import { noteCommands } from "./commands/notes.ts";
import { setupCommands } from "./commands/setup.ts";
import { skillCommand } from "./commands/skill.ts";
import { vocab } from "./commands/vocab.ts";
import { watch } from "./commands/watch.ts";
import type { Command, Ctx, GrantChecker, Io, Keys } from "./context.ts";
import { commandHelp } from "./help.ts";

const mcp: Command = {
  name: "mcp",
  summary: "Serve MCP on stdin and stdout for an agent (a thin client of the local API)",
  usage: "akou mcp",
  flags: { json: { type: "boolean", desc: "ignored: MCP already speaks JSON-RPC on stdout" } },
  examples: ["akou mcp"],
  run: async (ctx) => {
    // Loaded only here, so the SDK never slows down the other commands.
    const { runMcpStdio } = await import("../mcp/server.ts");
    await runMcpStdio({ client: ctx.client, version: ctx.version });
    return EXIT.ok;
  },
};

export const COMMANDS: readonly Command[] = [
  ...callCommands,
  ...followCommands,
  watch,
  ...noteCommands,
  ...handoffCommands,
  vocab,
  doctorCommand,
  ...setupCommands,
  skillCommand,
  mcp,
];

function help(): string {
  const w = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    `akou ${APP_VERSION}: record calls locally and question them live`,
    "",
    "Usage: akou COMMAND [options] [--json]",
    "",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`),
    "",
    "`akou help COMMAND` shows a command's options. Exit codes: 0 ok, 3 nothing live, 64 usage,",
    "65 bad vocabulary term, 69 unavailable, 70 software, 75 already recording, 77 permission.",
  ].join("\n");
}

/** Colour on a terminal only, and only when `NO_COLOR` is unset or empty and `TERM` is not dumb. */
export function colorOn(io: Pick<Io, "tty" | "env">): boolean {
  return io.tty === true && (io.env.NO_COLOR ?? "") === "" && io.env.TERM !== "dumb";
}

export interface CliOptions {
  /** The launch command for a cold app (tests pin it); null never launches. */
  launch?: readonly string[] | null;
  launchBudgetMs?: number;
  models?: readonly ModelSpecEntry[];
  skillSource?: string;
  self?: readonly string[];
  version?: string;
  grants?: GrantChecker;
}

/** Runs one command. Returns the exit code; never calls `process.exit`. */
export async function runCli(argv: readonly string[], io: Io, o: CliOptions = {}): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "help" && rest.length > 0) {
    // `akou help tail` is `akou tail --help`, byte for byte.
    const cmd = COMMANDS.find((c) => c.name === rest[0]);
    if (!cmd || rest.length > 1) {
      io.err(`akou: unknown command "${rest.join(" ")}"; \`akou help\` lists them`);
      return EXIT.usage;
    }
    io.out(commandHelp(cmd));
    return EXIT.ok;
  }
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    io.out(help());
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    io.out(o.version ?? APP_VERSION);
    return EXIT.ok;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    io.err(`akou: unknown command "${name}"; \`akou help\` lists them`);
    return EXIT.usage;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rest, cmd.flags ?? {});
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(`akou ${name}: ${err.message}\nusage: ${cmd.usage}`);
    return EXIT.usage;
  }
  if (parsed.flags.help === true) {
    io.out(commandHelp(cmd));
    return EXIT.ok;
  }
  const json = parsed.flags.json === true;
  const ctx: Ctx = {
    io,
    json,
    client: new ApiClient({
      env: io.env,
      client: "cli",
      launch: o.launch,
      launchBudgetMs: o.launchBudgetMs,
    }),
    models: o.models,
    skillSource: o.skillSource,
    self: o.self,
    version: o.version ?? APP_VERSION,
    color: !json && colorOn(io),
    grants: o.grants,
    run: (args, sub) => runCli(args, sub, o),
  };
  try {
    return await cmd.run(ctx, parsed);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`akou ${name}: ${err.message}\nusage: ${cmd.usage}`);
      return EXIT.usage;
    }
    if (err instanceof Unreachable) {
      if (json) io.out(JSON.stringify({ error: "unavailable", message: err.message }));
      else io.err(`akou: ${err.message}`);
      return EXIT.unavailable;
    }
    const msg = (err as Error).message ?? String(err);
    if (json) io.out(JSON.stringify({ error: "software", message: msg }));
    else io.err(`akou: ${msg}`);
    return EXIT.software;
  }
}

/** The terminal's keyboard in raw mode, for `akou watch`. */
function stdinKeys(): Keys {
  let closed = false;
  let wake: (() => void) | null = null;
  return {
    columns: () => process.stdout.columns || 80,
    close: () => {
      if (closed) return;
      closed = true;
      process.stdin.setRawMode(false);
      process.stdin.pause();
      wake?.();
    },
    read: async function* () {
      process.stdin.setRawMode(true);
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      const queue: string[] = [];
      const onData = (d: string) => {
        queue.push(d);
        wake?.();
      };
      process.stdin.on("data", onData);
      try {
        while (!closed) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((r) => {
            wake = r;
          });
          wake = null;
        }
      } finally {
        process.stdin.off("data", onData);
      }
    },
  };
}

if (import.meta.main) {
  const ac = new AbortController();
  process.on("SIGINT", () => {
    if (ac.signal.aborted) process.exit(130);
    ac.abort();
  });
  const code = await runCli(process.argv.slice(2), {
    env: process.env,
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
    write: (t) => process.stdout.write(t),
    signal: ac.signal,
    tty: process.stdout.isTTY === true,
    readStdin: () => Bun.stdin.text(),
    keys: process.stdin.isTTY ? stdinKeys() : undefined,
  });
  process.exit(code);
}
