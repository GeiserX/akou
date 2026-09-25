/**
 * Small HTTP pieces the routes share: JSON answers, errors, strict body parsing (unknown fields are
 * refused, DESIGN 6.3 rule 5), and a path router.
 */

import type { Outcome } from "../call/state.ts";
import type { RouteMeta } from "./access.ts";
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

/**
 * How much of a request body the server reads and discards before answering a request whose body
 * it did not consume: a 413, or any refusal of a request that carried a body. An answer sent while
 * the body is still arriving closes the socket with unread bytes on it, the kernel resets the
 * connection instead of closing it, and on macOS and Windows a reset drops what the client had
 * not read yet, so it sees `ECONNRESET` in place of the 413. Bun 1.4 closes at once, so the server
 * reads the rest out first (up to this cap, 16 times the body limit) and only then answers. This
 * is also Bun's `maxRequestBodySize`: past it Bun refuses on its own and the socket may reset.
 */
export const DRAIN_BODY_BYTES = 16 * MAX_BODY_BYTES;

/**
 * How long the drain may take. Bun's `idleTimeout` is an inactivity limit that every chunk resets,
 * so without this a client trickling a chunked body could hold a refused request open for as long
 * as it liked; past this the socket is closed with the rest unread.
 */
export const DRAIN_BODY_MS = 2_000;

/**
 * Reads and discards the rest of a body, up to `DRAIN_BODY_BYTES` counting `read` so far, and for
 * at most `DRAIN_BODY_MS` on `now`'s clock.
 */
export async function drainBody(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">,
  read = 0,
  now: () => number = () => performance.now(),
): Promise<void> {
  let n = read;
  const until = now() + DRAIN_BODY_MS;
  try {
    while (n <= DRAIN_BODY_BYTES && now() < until) {
      const { done, value } = await reader.read();
      if (done) return;
      n += value.byteLength;
    }
    await reader.cancel();
  } catch {
    // A body that ended early or errored is nothing left to wait for.
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
      // The rest is read out before the refusal, or the refusal may never reach the client.
      await drainBody(reader, n);
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
  /**
   * Sets this request's idle timeout, seconds; 0 turns it off. A route that waits on a model
   * (ask, enhance) turns it off, so a slow answer is not cut at the server's idle limit.
   */
  timeout?: (seconds: number) => void;
}

export type Handler<A> = (c: RouteContext<A>) => Response | Promise<Response>;

/** Which akou serves a route: the desktop app, server mode, or both (docs/ux/SERVER.md). */
export type Mode = "app" | "server";
export const MODES: readonly Mode[] = ["app", "server"];

/** One query parameter a route reads. A route reads only the parameters it declares. */
export type QueryParam =
  | { type: "integer"; min: number; max: number; default?: number; doc: string }
  | {
      type: "string";
      values?: readonly string[];
      default?: string;
      /** The route refuses a request without it. */
      required?: true;
      doc: string;
    }
  | { type: "boolean"; doc: string };

/** A `multipart/form-data` body: its parts, `file` for an uploaded file. */
export interface MultipartSpec {
  multipart: Readonly<Record<string, FieldType | "file">>;
}

/** A body spec's values are type names, so only a multipart spec has an object under a key. */
export function isMultipart(spec: BodySpec | MultipartSpec): spec is MultipartSpec {
  return typeof (spec as MultipartSpec).multipart === "object";
}

/**
 * What the OpenAPI file says about a route (docs/ux/PROGRAMMABILITY.md PG-A2 and
 * docs/research/service-interface.md section 2). It sits beside the handler in the one route
 * table, and the body and query specs here are the ones the handler validates with, so the file
 * cannot describe a request the route would refuse.
 */
export interface RouteDoc extends RouteMeta {
  /** The `operationId`, `<tag>.<verb>`: the tag is the resource, and becomes the tool group. */
  id: string;
  /** What the route does, written for an agent: the only text a tool built from it carries. */
  doc: string;
  modes: readonly Mode[];
  /**
   * `compat`: a route that speaks another tool's dialect (the OpenAI endpoint), a second way into
   * the same pipeline. `spec`: the OpenAPI file itself. Neither is in the `?scope=jobs` view.
   */
  door?: "compat" | "spec";
  /** The body the handler reads with `c.body()`. Absent: the route reads no body. */
  body?: BodySpec | MultipartSpec;
  /** The query parameters the handler reads through `c.query`. */
  query?: Readonly<Record<string, QueryParam>>;
  /** The path parameters, `:name` in the pattern, described. */
  params?: Readonly<Record<string, string>>;
  /** The status of a success. */
  ok: number;
  /** What a success carries. Default `json`. */
  type?: "json" | "sse" | "text" | "markdown" | "audio";
}

/** The query parameters of one request, read through the route's declared `query`. */
export interface Query {
  /** A declared `integer` parameter: its value, checked against the range, or the default. */
  int(name: string): number | undefined;
  /** A declared `string` parameter with `values`: one of them, or the default. */
  oneOf<T extends string>(name: string): T;
  /** Any declared parameter as sent, `null` when absent. The route checks it. */
  raw(name: string): string | null;
}

/** The context a routed handler sees: the request, plus its declared body and query. */
export interface RoutedContext<A> extends RouteContext<A> {
  /** The body, parsed against the route's declared `body` (`readBody`). */
  body<T = Record<string, unknown>>(): Promise<T>;
  query: Query;
}

export type RoutedHandler<A> = (c: RoutedContext<A>) => Response | Promise<Response>;

export interface Route<A> {
  method: string;
  pattern: string;
  handler: Handler<A>;
}

/** A route as the OpenAPI generator sees it. */
export interface RouteEntry {
  method: string;
  /** `/calls/:id`, relative to `/v1`. */
  path: string;
  doc: RouteDoc;
}

function declared(doc: RouteDoc, name: string, type?: QueryParam["type"]): QueryParam {
  const p = doc.query?.[name];
  // A programming error, not a client's: the file would not list what the route reads.
  if (!p) throw new Error(`${doc.id} reads the query parameter "${name}" it does not declare`);
  if (type && p.type !== type) throw new Error(`${doc.id}: "${name}" is declared ${p.type}`);
  return p;
}

function queryOf(doc: RouteDoc, url: URL): Query {
  return {
    int(name) {
      const p = declared(doc, name, "integer") as Extract<QueryParam, { type: "integer" }>;
      return intParam(url, name, p.default, p.min, p.max);
    },
    oneOf<T extends string>(name: string): T {
      const p = declared(doc, name, "string") as Extract<QueryParam, { type: "string" }>;
      if (!p.values || p.default === undefined) {
        throw new Error(`${doc.id}: "${name}" is declared with no values or no default`);
      }
      return enumParam(url, name, p.values as readonly T[], p.default as T);
    },
    raw(name) {
      declared(doc, name);
      return url.searchParams.get(name);
    },
  };
}

function bodyOf(doc: RouteDoc, req: Request) {
  return <T>(): Promise<T> => {
    const spec = doc.body;
    // Programming errors, not a client's: the file would not describe what the route reads.
    if (!spec) throw new Error(`${doc.id} reads a body it does not declare`);
    if (isMultipart(spec)) {
      throw new Error(`${doc.id}: a multipart body is read by the route itself`);
    }
    return readBody<T>(req, spec, { open: spec === OPEN_BODY });
  };
}

/**
 * A body of any keys, checked by the route itself (`PATCH /config`, whose keys the settings
 * registry checks). In the file it is an open object.
 */
export const OPEN_BODY: BodySpec = Object.freeze({});

/**
 * The route table. Every route is added with its `RouteDoc`, and `entries()` is what the OpenAPI
 * file is generated from (`scripts/openapi.ts`), so a route added here is in the file with no
 * other step, and CI fails until the committed file is regenerated. Routes of both modes live in
 * this one table, each marked with the modes that serve it.
 */
export class Router<A> {
  private readonly routes: {
    method: string;
    parts: string[];
    handler: Handler<A>;
    doc: RouteDoc;
  }[] = [];

  add(method: string, pattern: string, doc: RouteDoc, handler: RoutedHandler<A>): this {
    const routed: Handler<A> = (c) =>
      handler({ ...c, body: bodyOf(doc, c.req), query: queryOf(doc, c.url) });
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler: routed, doc });
    return this;
  }

  /** The handler and params for a request, `405` when the path exists with other methods. */
  match(
    method: string,
    path: string,
  ):
    | { handler: Handler<A>; params: Record<string, string>; doc: RouteDoc }
    | { status: 404 | 405 } {
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
        return { handler: r.handler, params, doc: r.doc };
      }
    }
    return { status: pathMatched ? 405 : 404 };
  }

  list(): { method: string; path: string }[] {
    return this.routes.map((r) => ({ method: r.method, path: `/${r.parts.join("/")}` }));
  }

  /** Every route with its doc, in the order added. */
  entries(): RouteEntry[] {
    return this.routes.map((r) => ({
      method: r.method,
      path: `/${r.parts.join("/")}`,
      doc: r.doc,
    }));
  }
}

/** `X-Akou-Client: claude-code` names the agent in `by`; anything odd is replaced. */
export function authorOf(req: Request): string {
  const raw = (req.headers.get("x-akou-client") ?? "").trim().toLowerCase();
  const client = /^[a-z0-9][a-z0-9._-]{0,39}$/.test(raw) ? raw : "api";
  return `agent:${client}`;
}
