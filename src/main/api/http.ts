/**
 * Small HTTP pieces the routes share: JSON answers, errors, strict body parsing (unknown fields are
 * refused, DESIGN 6.3 rule 5), and a path router.
 */

import type { Outcome } from "../call/state.ts";
import { MAX_BODY_BYTES } from "./guard.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const NO_STORE = { "cache-control": "no-store" };

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function errorResponse(e: HttpError): Response {
  return json(e.status, { error: e.code, message: e.message, ...e.extra });
}

/** An `Outcome` from the call layer, as HTTP: the success body, or its status and code. */
export function outcome(o: Outcome, okStatus = 200): Response {
  if (o.ok) {
    const { ok: _ok, ...rest } = o;
    return json(okStatus, { ok: true, ...rest });
  }
  const { ok: _ok, status, code, error, ...extra } = o;
  return json(status, { error: code, message: error, ...extra });
}

export function throwOutcome(o: Extract<Outcome, { ok: false }>): never {
  const { ok: _ok, status, code, error, ...extra } = o;
  throw new HttpError(status, code, error, extra);
}

// ---------------------------------------------------------------------------
// Bodies

export type FieldType = "string" | "number" | "integer" | "boolean" | "string[]" | "object" | "any";

/** `name` is required, `name?` optional. */
export type BodySpec = Readonly<Record<string, FieldType>>;

function typeOk(v: unknown, t: FieldType): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "string[]":
      return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "any":
      return v !== undefined;
  }
}

/** Reads at most `MAX_BODY_BYTES`, whatever `Content-Length` claimed (or did not claim). */
async function readCapped(req: Request): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "body_too_large", `bodies are capped at ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Parses a JSON object body against a spec. An empty body is `{}`. Unknown fields, missing
 * required fields and wrong types are refused with 400. With `open`, any key is accepted (the
 * config patch, whose keys the settings registry checks).
 */
export async function readBody<T = Record<string, unknown>>(
  req: Request,
  spec: BodySpec,
  opts: { open?: boolean } = {},
): Promise<T> {
  const text = await readCapped(req);
  let body: unknown = {};
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, "bad_json", "the body is not valid JSON");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "bad_json", "the body must be a JSON object");
  }
  const o = body as Record<string, unknown>;
  const fields = new Map<string, { type: FieldType; optional: boolean }>();
  for (const [k, t] of Object.entries(spec)) {
    const optional = k.endsWith("?");
    fields.set(optional ? k.slice(0, -1) : k, { type: t, optional });
  }
  for (const k of Object.keys(o)) {
    if (!fields.has(k) && !opts.open) {
      throw new HttpError(400, "unknown_field", `unknown field "${k}"`, { field: k });
    }
  }
  for (const [k, f] of fields) {
    const v = o[k];
    if (v === undefined || v === null) {
      if (!f.optional)
        throw new HttpError(400, "missing_field", `"${k}" is required`, { field: k });
      delete o[k];
      continue;
    }
    if (!typeOk(v, f.type)) {
      throw new HttpError(400, "bad_field", `"${k}" must be ${f.type}`, { field: k });
    }
  }
  return o as T;
}

// ---------------------------------------------------------------------------
// Query strings

export function intParam(
  url: URL,
  name: string,
  def: number | undefined,
  min: number,
  max: number,
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, "bad_param", `${name} must be a whole number from ${min} to ${max}`, {
      param: name,
    });
  }
  return n;
}

export function enumParam<T extends string>(
  url: URL,
  name: string,
  values: readonly T[],
  def: T,
): T {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return def;
  if (!(values as readonly string[]).includes(raw)) {
    throw new HttpError(400, "bad_param", `${name} must be one of ${values.join(", ")}`, {
      param: name,
    });
  }
  return raw as T;
}

// ---------------------------------------------------------------------------
// Routing

export interface RouteContext<A> {
  req: Request;
  url: URL;
  params: Record<string, string>;
  app: A;
  /** `agent:<client>` from `X-Akou-Client`, or `agent:api`. */
  by: string;
}

export type Handler<A> = (c: RouteContext<A>) => Response | Promise<Response>;

export interface Route<A> {
  method: string;
  pattern: string;
  handler: Handler<A>;
}

export class Router<A> {
  private readonly routes: { method: string; parts: string[]; handler: Handler<A> }[] = [];

  add(method: string, pattern: string, handler: Handler<A>): this {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }

  /** The handler and params for a request, `405` when the path exists with other methods. */
  match(
    method: string,
    path: string,
  ): { handler: Handler<A>; params: Record<string, string> } | { status: 404 | 405 } {
    const segs = path.split("/").filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i] as string;
        const s = segs[i] as string;
        if (p.startsWith(":")) {
          try {
            params[p.slice(1)] = decodeURIComponent(s);
          } catch {
            ok = false;
            break;
          }
        } else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method || (method === "HEAD" && r.method === "GET")) {
        return { handler: r.handler, params };
      }
    }
    return { status: pathMatched ? 405 : 404 };
  }

  list(): { method: string; path: string }[] {
    return this.routes.map((r) => ({ method: r.method, path: `/${r.parts.join("/")}` }));
  }
}

/** `X-Akou-Client: claude-code` names the agent in `by`; anything odd is replaced. */
export function authorOf(req: Request): string {
  const raw = (req.headers.get("x-akou-client") ?? "").trim().toLowerCase();
  const client = /^[a-z0-9][a-z0-9._-]{0,39}$/.test(raw) ? raw : "api";
  return `agent:${client}`;
}
