/**
 * Help pages, generated from the command registry (docs/ux/CLI.md section 9, CLI-05): each
 * command's flags as the parser accepts them, each with its one line, and the command's examples.
 * A flag cannot be parsed without appearing here, and `akou help CMD` and `akou CMD --help` print
 * this same page.
 */

import { COMMON, type FlagSpec } from "./args.ts";
import type { Command } from "./context.ts";

/** Every flag the parser accepts for a command, the command's own first, in help order. */
export function acceptedFlags(cmd: Command): [string, FlagSpec][] {
  const own = Object.entries(cmd.flags ?? {});
  const common = Object.entries(COMMON).filter(([name]) => !Object.hasOwn(cmd.flags ?? {}, name));
  return [...own, ...common];
}

/** `-c, --call CALL`, or `    --json` for a flag without a short form. */
function flagLabel(name: string, f: FlagSpec): string {
  const short = f.short ? `-${f.short}, ` : "    ";
  return `${short}--${name}${f.type === "string" ? ` ${f.value ?? "VALUE"}` : ""}`;
}

export function commandHelp(cmd: Command): string {
  const rows = acceptedFlags(cmd).map(([name, f]) => [flagLabel(name, f), f.desc] as const);
  const w = Math.max(...rows.map(([label]) => label.length));
  return [
    `akou ${cmd.name}: ${cmd.summary}`,
    "",
    `usage: ${cmd.usage}`,
    "",
    ...rows.map(([label, desc]) => `  ${label.padEnd(w)}  ${desc}`),
    "",
    ...cmd.examples.map((e) => `example: ${e}`),
    ...(cmd.unbuilt ? ["", `not built yet: ${cmd.unbuilt}`] : []),
  ].join("\n");
}
