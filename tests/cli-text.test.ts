/**
 * Honest text (docs/ux/CLI.md CLI-17, PRINCIPLES rule 13): every backticked `akou …` a person or
 * an agent can read names a command, subcommand, flag and setting that exist, and nothing tells
 * anyone to run `akou start`, which records the whole computer, just to launch the app.
 *
 * The scan reads the sources themselves: the CLI, the settings schema, the API's messages, the
 * window, the skills and TRAPS.md. Each mention is parsed against the command registry.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs, UsageError } from "../src/main/cli/args.ts";
import { COMMANDS } from "../src/main/cli/cli.ts";
import { isSettingKey } from "../src/main/config/schema.ts";

const ROOT = join(import.meta.dir, "..");

/** Every file whose text reaches a person or an agent, or documents a command for them. */
function scannedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|md)$/.test(name)) out.push(path);
    }
  };
  walk(join(ROOT, "src", "main"));
  walk(join(ROOT, "src", "ui"));
  walk(join(ROOT, "skills"));
  out.push(join(ROOT, "docs", "TRAPS.md"));
  return out;
}

/**
 * The backticked `akou …` strings in a source text. Inside a template literal the backticks are
 * escaped (\`akou …\`) and a `${…}` is a value. Anywhere else (a string, a comment, Markdown) a
 * mention sits on one line, or wraps inside a doc comment; a template literal that itself starts
 * with `akou` carries `${`, so it is code, not a mention.
 */
export function akouMentions(source: string): string[] {
  const out: string[] = [];
  // A mention may wrap inside a doc comment: join the comment's lines first.
  const text = source.replace(/\n[ \t]*\*[ \t]?/g, " ");
  const escaped = /\\`(akou\s[^`]*?)\\`/g;
  for (const m of text.matchAll(escaped)) {
    out.push((m[1] as string).replace(/\$\{[^}]*\}/g, "VALUE"));
  }
  for (const m of text.replace(escaped, "").matchAll(/`(akou\s[^`\n$]*)`/g)) {
    out.push(m[1] as string);
  }
  return out;
}

/** The subcommands a command's usage names (`akou share on|off|status` gives on, off, status). */
function subcommands(name: string, usage: string): Set<string> {
  const subs = new Set<string>();
  const re = new RegExp(`akou ${name} ([a-z][a-z-]*(?:\\|[a-z][a-z-]*)*)(?=\\s|$)`, "g");
  for (const m of usage.matchAll(re)) for (const s of (m[1] as string).split("|")) subs.add(s);
  return subs;
}

const isPlaceholder = (t: string) => /^(?:[A-Z][A-Z0-9_]*(?:…|\.\.\.)?|<[^>]*>|…|\.\.\.)$/.test(t);

/** Why a mention does not parse against the registry, or null when it does. */
export function checkMention(mention: string): string | null {
  const words = (mention.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) =>
    // Optional parts and alternatives are grammar: `[--stage S]`, `json|md`.
    w.replace(/[[\]]/g, ""),
  );
  const [, name, ...rest] = words.filter((w) => w !== "");
  if (name === undefined) return "names no command";
  if (isPlaceholder(name) || name === "help" || name === "--version" || name === "--help") {
    return null;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) return `there is no command "${name}"`;
  if (cmd.unbuilt) return `"${name}" is not built: ${cmd.unbuilt}`;
  const args = rest.filter((w) => w !== "…" && w !== "...").map((w) => w.split("|")[0] as string);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args, cmd.flags ?? {});
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    // Naming a flag without its value (`akou start --vocab`) still names a flag that exists.
    if (!/needs a value$/.test(err.message)) return `${name}: ${err.message}`;
    return null;
  }
  const subs = subcommands(name, cmd.usage);
  const sub = parsed.positional[0];
  if (subs.size > 0 && sub !== undefined && !isPlaceholder(sub) && !subs.has(sub)) {
    return `${name} has no subcommand "${sub}" (it has ${[...subs].join(", ")})`;
  }
  const key = parsed.positional[1];
  if (
    name === "config" &&
    (sub === "set" || sub === "unset" || sub === "get") &&
    key !== undefined &&
    !isPlaceholder(key) &&
    !isSettingKey(key)
  ) {
    return `there is no setting "${key}"`;
  }
  return null;
}

/** A line that offers `akou start` as the way to launch or open the app. */
export function startAsLaunch(line: string): boolean {
  return (
    /`akou start`/.test(line.replace(/\\`/g, "`")) && /launch|not running|open akou/i.test(line)
  );
}

describe("[CLI-17] Honest text", () => {
  const files = scannedFiles();

  test("every backticked `akou …` in the sources, the schema, the skills and TRAPS.md parses", () => {
    const bad: string[] = [];
    let count = 0;
    for (const f of files) {
      for (const m of akouMentions(readFileSync(f, "utf8"))) {
        count++;
        const why = checkMention(m);
        if (why) bad.push(`${relative(ROOT, f)}: \`${m}\`: ${why}`);
      }
    }
    // The scan finds the mentions it is meant to check: a scan that finds none passes anything.
    expect(count).toBeGreaterThan(40);
    expect(bad).toEqual([]);
  });

  test("positive controls: a flag, a subcommand, a command or a setting that does not exist fails", () => {
    expect(akouMentions("a per-entry boost is set with `akou vocab check --boost`")).toEqual([
      "akou vocab check --boost",
    ]);
    expect(checkMention("akou vocab check --boost")).toBe("vocab: unknown option --boost");
    expect(checkMention("akou vocab frobnicate")).toContain('no subcommand "frobnicate"');
    expect(checkMention("akou launch")).toBe('there is no command "launch"');
    expect(checkMention("akou config set asr.segmentPuase 5")).toBe(
      'there is no setting "asr.segmentPuase"',
    );
    // A command that exits 69 "not built" is not a command a message may send anyone to.
    expect(checkMention("akou devices")).toContain('"devices" is not built');
    // In a template literal, the escaped form with a value is read too.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal.
    const tpl = 'err(`akou: no answer; \\`akou context "${q}"\\` prints it`)';
    expect(akouMentions(tpl)).toEqual(['akou context "VALUE"']);
    expect(checkMention('akou context "VALUE"')).toBeNull();
    // And the grammar forms real messages use still parse.
    for (const ok of [
      "akou hooks run CALL [--stage S]",
      "akou vocab list --call VALUE --unconfirmed",
      "akou models import <dir>",
      "akou share on|off|status [--bind tailnet|lan|IP]",
      "akou start --vocab",
      "akou COMMAND --help",
    ]) {
      expect([ok, checkMention(ok)]).toEqual([ok, null]);
    }
  });

  test("no message offers `akou start`, which records, as the way to launch the app", () => {
    const bad: string[] = [];
    // Messages live in the sources. TRAPS.md describes what `akou start` itself does (T4.11).
    for (const f of files.filter((x) => x.endsWith(".ts"))) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (startAsLaunch(line)) bad.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
    // Positive control: the status message as it read before.
    expect(startAsLaunch('ctx.io.err("akou is not running (`akou start` launches it)");')).toBe(
      true,
    );
    expect(startAsLaunch('detail: "akou is not running; `akou start` launches it headless"')).toBe(
      true,
    );
    expect(startAsLaunch("Record with `akou start -w work`")).toBe(false);
  });
});
