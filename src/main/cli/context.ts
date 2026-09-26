/**
 * What every CLI command gets: its output streams, `--json`, the API client, and one way to turn an
 * API answer into output and an exit code (docs/DESIGN.md section 6.1).
 *
 * Human output goes to stdout, problems to stderr. With `--json` the API's own JSON body goes to
 * stdout, errors included, so an agent reads one shape and the exit code.
 */

import { formatWall } from "../../core/log/clock.ts";
import type { ModelSpecEntry } from "../asr/models.ts";
import { type FlagSpec, type FlagSpecs, type Parsed, UsageError } from "./args.ts";
import { type ApiClient, type ApiResponse, EXIT, exitFor, type RequestOptions } from "./client.ts";

/** An API body as a command reads it, field by field. */
// biome-ignore lint/suspicious/noExplicitAny: bodies come from our own API and are read per command.
export type Body = any;

export interface Io {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  /** Writes without a newline (a streamed answer). Absent: commands print whole lines only. */
  write?(text: string): void;
  /** Ends `tail -f` and the MCP server. */
  signal?: AbortSignal;
  /** stdout is a terminal: colour and redraws are allowed there only (CLI-20). */
  tty?: boolean;
  /** Everything on stdin, for `config set KEY -` (CLI-06). Absent: stdin is empty. */
  readStdin?(): Promise<string>;
  /** Keys typed at a terminal, for `akou watch`. Absent: stdin is not a terminal (`config set KEY -` reads it silently). */
  keys?: Keys;
}

/** A terminal's keyboard in raw mode: each chunk as typed, Ctrl-C and Ctrl-D included. */
export interface Keys {
  /** Starts raw mode and yields what is typed until `close`. */
  read(): AsyncIterable<string>;
  close(): void;
  /** The terminal's width in columns. */
  columns(): number;
}

export interface Ctx {
  io: Io;
  json: boolean;
  client: ApiClient;
  /** Test seams: the model registry doctor and `models` check against. */
  models?: readonly ModelSpecEntry[];
  /** Where `skill install` copies from (`skills/akou` in the repository). */
  skillSource?: string;
  /** Test seam: the akou command `skill install` registers, before `mcp`. */
  self?: readonly string[];
  /** The app's version; the skill must carry the same one. */
  version: string;
  /** Colour is on: stdout is a terminal, `NO_COLOR` is unset or empty and `TERM` is not `dumb`. */
  color?: boolean;
  /** Test seam: what `doctor` asks about the OS grants (CLI-38). */
  grants?: GrantChecker;
  /** Runs another command in this process with other streams (`akou watch`'s lines). */
  run?(argv: readonly string[], io: Io): Promise<number>;
}

/** The OS grants akou needs, as `doctor` reads them (CLI-38). */
export interface Grant {
  name: string;
  /** `n/a`: this OS asks for no such grant. `unknown`: this process cannot read it. */
  state: "granted" | "missing" | "unknown" | "n/a";
  detail: string;
}

export interface GrantChecker {
  check(): Promise<Grant[]>;
  /**
   * Asks the OS for one grant, or opens its settings pane. Returns what was done, in words:
   * `not opened` when the pane failed to open.
   */
  request(name: string): Promise<"requested" | "settings opened" | "not opened">;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  flags?: FlagSpecs;
  /** At least one runnable example, printed in help (CLI-05). */
  examples: readonly string[];
  /**
   * Designed but not built: why. The command says so and exits 69, and no message may send anyone
   * to it (CLI-17).
   */
  unbuilt?: string;
  run(ctx: Ctx, p: Parsed): Promise<number>;
}

/** The system zone; every time a person reads is local wall-clock time. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function wall(ms: number | null | undefined, seconds = false): string {
  if (ms === null || ms === undefined) return "?";
  return formatWall(ms, localZone(), { seconds });
}

export function api(
  ctx: Ctx,
  method: string,
  path: string,
  o?: RequestOptions,
): Promise<ApiResponse> {
  return ctx.client.request(method, path, o);
}

/** One line explaining a refused request, with what the user can do next. */
export function describeError(r: ApiResponse): string {
  const b = r.body ?? {};
  const msg = typeof b.message === "string" ? b.message : r.text.trim() || `HTTP ${r.status}`;
  if (b.error === "no_live_call") {
    const last = b.last as { id: string; title: string; endedAt: number | null } | null;
    return last
      ? `${msg}; the last call, "${last.title}", ended at ${wall(last.endedAt)} (${last.id})`
      : `${msg}; there are no calls yet`;
  }
  if (b.error === "already_recording") return `${msg} (${b.call})`;
  if (typeof b.reason === "string" && !msg.includes(b.reason)) return `${msg} (${b.reason})`;
  return msg;
}

/**
 * Prints an API answer: `human(body)` on success (or the body itself with `--json`), the error on
 * stderr otherwise. Returns the exit code.
 */
export function finish(ctx: Ctx, r: ApiResponse, human: (body: Body) => string): number {
  const code = exitFor(r.status, r.body?.error);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(r.body ?? { error: `http_${r.status}`, message: r.text }));
    return code;
  }
  if (code === EXIT.ok) {
    const text = human(r.body);
    if (text !== "") ctx.io.out(text);
  } else {
    ctx.io.err(`akou: ${describeError(r)}`);
  }
  return code;
}

/** A command that exists in the design but is not built: says so plainly and exits 69. */
export function notBuilt(ctx: Ctx, what: string): number {
  if (ctx.json) ctx.io.out(JSON.stringify({ error: "not_implemented", message: what }));
  else ctx.io.err(`akou: ${what}`);
  return EXIT.unavailable;
}

/** `-c/--call`, the one way to name a call on every command that touches one (CLI-03). */
export function callFlag(fallback: string): FlagSpec {
  return {
    type: "string",
    short: "c",
    value: "CALL",
    desc: `live, last or a call id (default: ${fallback})`,
  };
}

/** `live` unless a call is named. */
export function ref(p: Parsed, fallback = "live"): string {
  const v = p.flags.call;
  return typeof v === "string" && v !== "" ? encodeURIComponent(v) : fallback;
}

/**
 * The call of a command whose object is a call (`show`, `open`, `finalize`, `export`): its first
 * word or `-c`, which name the same thing. Both at once must agree. Returns it unencoded.
 */
export function objectCall(p: Parsed, word: string | undefined): string | undefined {
  const flag = p.flags.call;
  const c = typeof flag === "string" && flag !== "" ? flag : undefined;
  if (word !== undefined && c !== undefined && word !== c) {
    throw new UsageError(`the call is named twice, as ${word} and as -c ${c}`);
  }
  return word ?? c;
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}
