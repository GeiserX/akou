/**
 * A stand-in for `claude` or `codex` when `akou skill install` registers its MCP server, so no test
 * ever touches a real harness's config. It keeps its entries in `STATE_DIR/<kind>.json`, appends
 * each run's arguments to `STATE_DIR/<kind>.log`, one JSON array per line, and answers the way the
 * real programs did against a throwaway config folder (claude 2.1.281, codex-cli 0.151.0):
 *
 * - claude: `mcp get NAME` prints `Scope:`, `Command:` and `Args:` lines, or exits 1 when there is
 *   none; a local-scope entry wins over a user-scope one of the same name. `mcp add -s SCOPE NAME
 *   -- CMD ARGS…` exits 1 when NAME exists in that scope; `mcp remove -s SCOPE NAME` exits 1 when
 *   there is none in it. User-scope entries are in `claude.json`, local ones in `claude-local.json`.
 * - codex: `mcp get NAME --json` prints `{name, transport: {type, command, args}}`, or exits 1;
 *   `mcp add NAME -- CMD ARGS…` replaces an entry of the same name; `mcp remove NAME` exits 0
 *   either way.
 *
 * A file `STATE_DIR/fail` makes every `mcp add` fail, exit 1.
 *
 *   bun fake-mcp-cli.ts claude|codex STATE_DIR ARGS…
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [kind, dir, ...args] = process.argv.slice(2) as [string, string, ...string[]];
appendFileSync(join(dir, `${kind}.log`), `${JSON.stringify(args)}\n`);
type Entry = { command: string; args: string[] };
type Entries = Record<string, Entry>;
const s = args.indexOf("-s");
const scope = s >= 0 ? (args[s + 1] as string) : "user";
const fileOf = (sc: string) => join(dir, sc === "user" ? `${kind}.json` : `${kind}-${sc}.json`);
const load = (sc: string): Entries =>
  existsSync(fileOf(sc)) ? JSON.parse(readFileSync(fileOf(sc), "utf8")) : {};
const entries = load(scope);
const save = () => writeFileSync(fileOf(scope), JSON.stringify(entries));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (args[0] !== "mcp") fail(`fake ${kind}: only mcp is faked`);
const verb = args[1];
const rest = args.slice(2).filter((a, i, all) => a !== "-s" && all[i - 1] !== "-s");
const name = rest.find((a) => !a.startsWith("-")) as string;

if (verb === "get") {
  const local = kind === "claude" ? load("local")[name] : undefined;
  const e = local ?? load("user")[name];
  if (!e) fail(`No MCP server named "${name}".`);
  if (kind === "codex") {
    process.stdout.write(
      `${JSON.stringify({ name, transport: { type: "stdio", command: e.command, args: e.args } })}\n`,
    );
  } else {
    process.stdout.write(
      `${name}:\n  Scope: ${local ? "Local config (private to you in this project)" : "User config (available in all your projects)"}\n  Type: stdio\n  Command: ${e.command}\n  Args: ${e.args.join(" ")}\n`,
    );
  }
} else if (verb === "add") {
  if (existsSync(join(dir, "fail"))) fail("fake add failed on purpose");
  const dash = args.indexOf("--");
  const [command, ...cmdArgs] = args.slice(dash + 1);
  if (dash < 0 || command === undefined) fail("add needs -- COMMAND");
  if (kind === "claude" && entries[name])
    fail(`MCP server ${name} already exists in ${scope} config`);
  entries[name] = { command, args: cmdArgs };
  save();
} else if (verb === "remove") {
  if (!entries[name]) {
    if (kind === "claude") fail(`No MCP server named "${name}" in ${scope} scope`);
  } else {
    delete entries[name];
    save();
  }
} else {
  fail(`fake ${kind}: mcp ${verb} is not faked`);
}
