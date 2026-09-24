/**
 * What every CLI command gets: its output streams, `--json`, the API client, and one way to turn an
 * API answer into output and an exit code (docs/DESIGN.md section 6.1).
 *
 * Human output goes to stdout, problems to stderr. With `--json` the API's own JSON body goes to
 * stdout, errors included, so an agent reads one shape and the exit code.
 */

import { formatWall } from "../../core/log/clock.ts";
import type { ModelSpecEntry } from "../asr/models.ts";
import type { FlagSpecs, Parsed } from "./args.ts";
import { type ApiClient, type ApiResponse, EXIT, exitFor, type RequestOptions } from "./client.ts";

/** An API body as a command reads it, field by field. */
// biome-ignore lint/suspicious/noExplicitAny: bodies come from our own API and are read per command.
export type Body = any;

export interface Io {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  /** Ends `tail -f` and the MCP server. */
  signal?: AbortSignal;
}

export interface Ctx {
  io: Io;
  json: boolean;
  client: ApiClient;
  /** Test seams: the model registry doctor and `models` check against. */
  models?: readonly ModelSpecEntry[];
  /** The app's version. */
  version: string;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  flags?: FlagSpecs;
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

/** `live` unless a call is named. */
export function ref(p: Parsed, fallback = "live"): string {
  const v = p.flags.call;
  return typeof v === "string" && v !== "" ? encodeURIComponent(v) : fallback;
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}
