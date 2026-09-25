/**
 * A stand-in for `claude` or `codex` when `akou skill install` registers its MCP server, so no test
 * ever touches a real harness's config. It keeps its entries in `STATE_DIR/<kind>.json`, appends
 * each run's arguments to `STATE_DIR/<kind>.log`, one JSON array per line, and answers the way the
 * real programs did against a throwaway config folder (claude 2.1.281, codex-cli 0.151.0):
 *
 * - claude: `mcp get NAME` prints `Command:` and `Args:` lines, or exits 1 when there is none;
 *   `mcp add -s user NAME -- CMD ARGS…` exits 1 when NAME exists; `mcp remove -s user NAME` exits 1
 *   when there is none.
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
const file = join(dir, `${kind}.json`);
type Entry = { command: string; args: string[] };
const entries: Record<string, Entry> = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : {};
const save = () => writeFileSync(file, JSON.stringify(entries));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (args[0] !== "mcp") fail(`fake ${kind}: only mcp is faked`);
const verb = args[1];
const rest = args.slice(2).filter((a, i, all) => a !== "-s" && all[i - 1] !== "-s");
const name = rest.find((a) => !a.startsWith("-")) as string;

if (verb === "get") {
  const e = entries[name];
  if (!e) fail(`No MCP server named "${name}".`);
  if (kind === "codex") {
    process.stdout.write(
      `${JSON.stringify({ name, transport: { type: "stdio", command: e.command, args: e.args } })}\n`,
    );
  } else {
    process.stdout.write(
      `${name}:\n  Scope: User config\n  Type: stdio\n  Command: ${e.command}\n  Args: ${e.args.join(" ")}\n`,
    );
  }
} else if (verb === "add") {
  if (existsSync(join(dir, "fail"))) fail("fake add failed on purpose");
  const dash = args.indexOf("--");
  const [command, ...cmdArgs] = args.slice(dash + 1);
  if (dash < 0 || command === undefined) fail("add needs -- COMMAND");
  if (kind === "claude" && entries[name]) fail(`MCP server ${name} already exists in user config`);
  entries[name] = { command, args: cmdArgs };
  save();
} else if (verb === "remove") {
  if (!entries[name]) {
    if (kind === "claude") fail(`No MCP server named "${name}" in user scope`);
  } else {
    delete entries[name];
    save();
  }
} else {
  fail(`fake ${kind}: mcp ${verb} is not faked`);
}
