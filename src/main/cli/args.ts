/**
 * A small command-line parser for `akou` (docs/DESIGN.md section 6.1). Each command declares its
 * flags; anything else is a usage error (exit 64), never silently ignored.
 *
 *   akou start -w work -t "Weekly sync" --vocab Ben,Hetzner --json
 *
 * Flags take their value as the next word or after `=` (`--budget=4000`). `--` ends the flags.
 * `--json` and `--help` are accepted by every command.
 */

export type FlagType = "string" | "boolean";

export interface FlagSpec {
  type: FlagType;
  /** A one-letter alias, without the dash (`w` for `-w`). */
  short?: string;
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

export interface Parsed {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export class UsageError extends Error {
  override name = "UsageError";
}

const COMMON: FlagSpecs = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

/**
 * Flags that would carry a secret. They are refused by name on every command, so a key never lands
 * in the process list or the shell history (CLI-06); the message names the environment form.
 */
const SECRET_FLAGS = new Set(["key", "api-key", "token", "secret", "password"]);

/** A word the parser reads as a flag or as `--`, never as a value. */
function isFlag(a: string): boolean {
  return a.startsWith("--") || /^-[a-zA-Z]$/.test(a);
}

export function parseArgs(argv: readonly string[], spec: FlagSpecs): Parsed {
  const all: Record<string, FlagSpec> = { ...COMMON, ...spec };
  const byShort = new Map<string, string>();
  for (const [name, s] of Object.entries(all)) if (s.short) byShort.set(s.short, name);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      inline = eq > 0 ? a.slice(eq + 1) : undefined;
    } else if (/^-[a-zA-Z]$/.test(a)) {
      name = byShort.get(a.slice(1));
      if (!name) throw new UsageError(`unknown option ${a}`);
    } else {
      positional.push(a);
      continue;
    }
    const s = all[name];
    if (!s && SECRET_FLAGS.has(name)) {
      throw new UsageError(
        `--${name} would put a secret on the command line, where the process list and the shell history keep it; ` +
          "set AKOU_API_KEY, or AKOU_API_KEY_FILE to a file that holds it\n" +
          "try: AKOU_API_KEY_FILE=~/.config/akou/remote.key akou jobs list",
      );
    }
    if (!s) throw new UsageError(`unknown option --${name}`);
    if (s.type === "boolean") {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      // The next word, unless it is itself a flag (`-t --json`); `--title=--json` still works.
      const next = argv[i + 1];
      if (next === undefined || isFlag(next)) throw new UsageError(`--${name} needs a value`);
      value = next;
      i++;
    }
    flags[name] = value;
  }
  return { flags, positional };
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function bool(p: Parsed, name: string): boolean {
  return p.flags[name] === true;
}

export function int(p: Parsed, name: string, min: number, max: number): number | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/** `a,b , c` into `["a", "b", "c"]`. */
export function list(p: Parsed, name: string): string[] | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  return v
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

/** `90s`, `5m`, `1h` or bare seconds, into seconds. */
export function duration(p: Parsed, name: string): number | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(v.trim());
  if (!m) throw new UsageError(`--${name} must look like 90s, 5m or 1h`);
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n;
}
