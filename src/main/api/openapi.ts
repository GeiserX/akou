/**
 * The OpenAPI 3.1 file, generated from the one route table (docs/ux/PROGRAMMABILITY.md PG-A2,
 * docs/ux/SERVER.md SV-C4) and shaped for Executor (docs/research/service-interface.md SI-2).
 *
 * - `buildOpenApi` turns the route table (`Router.entries()`, each route with its `RouteDoc`) into
 *   the whole file: every route of both modes. `scripts/openapi.ts` writes it to
 *   `docs/api/openapi.json`, and `tests/openapi.test.ts` fails when the committed file differs.
 * - `servedOpenApi` is the copy `GET /v1/openapi.json` answers: only the running mode's routes,
 *   `servers[0]` set to akou's address, and with `?scope=jobs` only what a `jobs` key can call.
 * - `openApiProblems` holds the rules of service-interface.md section 2, which decide how
 *   Executor names its tools and derives its one auth template.
 */

import { type Access, SCOPES, type Scope } from "./access.ts";
import { ERROR_CODES, type ErrorCode, errorsOf, type RouteErrors } from "./errors.ts";
import {
  type BodySpec,
  type FieldType,
  isMultipart,
  MODES,
  type Mode,
  type MultipartSpec,
  OPEN_BODY,
  type QueryParam,
  type RouteDoc,
  type RouteEntry,
} from "./http.ts";

export const OPENAPI_VERSION = "3.1.0";
/** The one security scheme: every key and the app's token travel as `Authorization: Bearer`. */
export const SECURITY_SCHEME = "bearerAuth";
/** The committed file's address: the desktop app's local API on its default port. */
export const LOCAL_SERVER = "http://127.0.0.1:8476";
/** `<tag>.<verb>`: Executor strips the tag, so the tool is `jobs.create`, not a long made-up name. */
export const OPERATION_ID = /^([a-z][A-Za-z0-9]*)\.([a-z][A-Za-z0-9]*)$/;
/** The tag of the one compatibility dialect, the OpenAI endpoint (`x-akou-door: compat`). */
export const COMPAT_TAG = "openai";

type Json = Record<string, unknown>;

export interface OpenApiOperation {
  operationId: string;
  tags: string[];
  description: string;
  parameters?: Json[];
  requestBody?: Json;
  responses: Record<string, Json>;
  security?: Record<string, string[]>[];
  "x-akou-modes": Mode[];
  "x-akou-access": Access;
  "x-akou-door"?: "compat" | "spec";
  /** The operation upgrades to a WebSocket: a client opens it, a tool cannot call it. */
  "x-akou-upgrade"?: "websocket";
}

export interface OpenApiDoc {
  openapi: string;
  info: Json;
  servers: { url: string; description?: string }[];
  security: Record<string, string[]>[];
  tags: { name: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, Json>;
    responses: Record<string, Json>;
    schemas: Record<string, Json>;
  };
}

const STATUS_TEXT: Record<number, string> = {
  101: "Switching protocols: the WebSocket is open",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No content",
};

const ERROR_STATUS_TEXT: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  413: "Body too large",
  415: "Unsupported media type",
  416: "Range not satisfiable",
  422: "Unprocessable",
  426: "Upgrade required",
  429: "Too many requests",
  499: "Cancelled",
  500: "Internal error",
  501: "Not implemented",
  503: "Unavailable",
};

/**
 * The refusals any route of its kind may answer before or around its handler: the guard's (Host,
 * browser headers, the key and its scope, the body's type and size), the declared body's and
 * query's parsing, and an unexpected failure.
 */
export function sharedErrors(method: string, d: RouteDoc): RouteErrors {
  const own: Partial<Record<number, ErrorCode[]>> = {
    403: ["bad_host", "browser_request"],
    413: ["body_too_large"],
    500: ["internal"],
  };
  const add = (status: number, ...codes: ErrorCode[]) => {
    own[status] = [...(own[status] ?? []), ...codes];
  };
  if (d.access !== "open") {
    add(401, "unauthorized");
    add(403, "forbidden");
  }
  const changes = method !== "GET" && method !== "HEAD";
  const multipart = d.body !== undefined && isMultipart(d.body);
  if (changes) add(415, multipart ? "multipart_required" : "json_required");
  if (changes && d.body) {
    if (multipart) add(400, "bad_multipart");
    else {
      const fields = Object.keys(d.body);
      add(400, "bad_json");
      if (d.body !== OPEN_BODY) add(400, "unknown_field");
      if (fields.some((k) => !k.endsWith("?"))) add(400, "missing_field");
      if (fields.length > 0) add(400, "bad_field");
    }
  }
  const checked = Object.values(d.query ?? {}).some(
    (p) => p.type === "integer" || (p.type === "string" && p.values !== undefined),
  );
  if (checked) add(400, "bad_param");
  return own;
}

/**
 * Each refusal status of an operation, as a reference to the shared response that lists the codes
 * it answers under that status. Many operations refuse alike, so each set is one component,
 * named `<status>.<code>.<code>`, and `into` collects them.
 */
function errorResponses(
  method: string,
  d: RouteDoc,
  into: Record<string, Json>,
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [status, codes] of Object.entries(errorsOf(sharedErrors(method, d), d.errors))) {
    const name = [status, ...(codes ?? [])].join(".");
    into[name] ??= {
      description: ERROR_STATUS_TEXT[Number(status)] ?? "Error",
      content: {
        "application/json": {
          schema: {
            allOf: [
              { $ref: "#/components/schemas/Error" },
              { properties: { error: { enum: [...(codes ?? [])] } } },
            ],
          },
        },
      },
    };
    out[status] = { $ref: `#/components/responses/${name}` };
  }
  return out;
}

const MEDIA: Record<NonNullable<RouteDoc["type"]>, [string, Json]> = {
  json: ["application/json", { type: "object" }],
  sse: ["text/event-stream", { type: "string" }],
  text: ["text/plain", { type: "string" }],
  markdown: ["text/markdown", { type: "string" }],
  audio: ["audio/ogg", { type: "string", format: "binary" }],
  wav: ["audio/wav", { type: "string", format: "binary" }],
};

/** `/calls/:id` under `/v1` as OpenAPI writes it: `/v1/calls/{id}`. */
export function openApiPath(path: string): string {
  return `/v1${path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`;
}

function fieldSchema(t: FieldType | "file"): Json {
  switch (t) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "object":
      return { type: t };
    case "string[]":
      return { type: "array", items: { type: "string" } };
    case "any":
      return {};
    case "file":
      // Executor turns a multipart field into a file argument only with `format: binary`;
      // `contentMediaType` alone, the 3.1 style, is not recognised (service-interface.md §2).
      return { type: "string", format: "binary", contentMediaType: "application/octet-stream" };
  }
}

function objectSchema(fields: Readonly<Record<string, FieldType | "file">>, open: boolean): Json {
  const properties: Json = {};
  const required: string[] = [];
  for (const [k, t] of Object.entries(fields)) {
    const optional = k.endsWith("?");
    const name = optional ? k.slice(0, -1) : k;
    properties[name] = fieldSchema(t);
    if (!optional) required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    // Unknown fields are refused with 400 (DESIGN 6.3 rule 5), except in an open body.
    additionalProperties: open,
  };
}

function requestBody(body: BodySpec | MultipartSpec): Json {
  if (isMultipart(body)) {
    const schema = objectSchema(body.multipart, false);
    return {
      required: true,
      content: { "multipart/form-data": { schema } },
    };
  }
  const schema = objectSchema(body, body === OPEN_BODY);
  return {
    required: Array.isArray(schema.required),
    content: { "application/json": { schema } },
  };
}

function queryParameter(name: string, p: QueryParam): Json {
  const schema: Json = { type: p.type };
  if (p.type === "integer") {
    schema.minimum = p.min;
    schema.maximum = p.max;
    if (p.default !== undefined) schema.default = p.default;
  }
  if (p.type === "string") {
    if (p.values) schema.enum = [...p.values];
    if (p.default !== undefined) schema.default = p.default;
  }
  const required = p.type === "string" && p.required === true;
  return { name, in: "query", required, description: p.doc, schema };
}

function operation(
  method: string,
  path: string,
  d: RouteDoc,
  refusals: Record<string, Json>,
): OpenApiOperation {
  const m = OPERATION_ID.exec(d.id);
  const parameters: Json[] = [];
  for (const name of path.match(/:([A-Za-z0-9_]+)/g) ?? []) {
    const n = name.slice(1);
    const described = d.params?.[n];
    parameters.push({
      name: n,
      in: "path",
      required: true,
      ...(described ? { description: described } : {}),
      schema: { type: "string" },
    });
  }
  for (const [name, p] of Object.entries(d.query ?? {})) parameters.push(queryParameter(name, p));
  const [media, plain] = MEDIA[d.type ?? "json"];
  const schema = (d.reply as Json | undefined) ?? plain;
  const op: OpenApiOperation = {
    operationId: d.id,
    // A route whose id is not `<tag>.<verb>` gets no tag here, and the rules below fail it.
    tags: m ? [m[1] as string] : [],
    description: d.doc,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(d.body && method !== "GET" ? { requestBody: requestBody(d.body) } : {}),
    responses: {
      ...Object.fromEntries(
        [d.ok, ...(d.alsoOk ?? [])].map((status) => [
          String(status),
          // An upgrade's success has no body: the socket carries what follows.
          d.upgrade
            ? { description: STATUS_TEXT[status] ?? "Success" }
            : { description: STATUS_TEXT[status] ?? "Success", content: { [media]: { schema } } },
        ]),
      ),
      ...errorResponses(method, d, refusals),
      default: { $ref: "#/components/responses/Error" },
    },
    // An anonymous route overrides the file's one security requirement with none.
    ...(d.access === "open" ? { security: [] } : {}),
    "x-akou-modes": [...d.modes],
    "x-akou-access": d.access,
    ...(d.door ? { "x-akou-door": d.door } : {}),
    ...(d.upgrade ? { "x-akou-upgrade": d.upgrade } : {}),
  };
  return op;
}

/** The whole file: every route of the table, of both modes, in the order they were added. */
export function buildOpenApi(
  routes: readonly RouteEntry[],
  o: { version: string; serverUrl?: string },
): OpenApiDoc {
  const paths: OpenApiDoc["paths"] = {};
  const tags: string[] = [];
  const refusals: Record<string, Json> = {};
  for (const r of routes) {
    const p = openApiPath(r.path);
    const op = operation(r.method, r.path, r.doc, refusals);
    const byMethod = paths[p] ?? {};
    // The router serves the first match, so a second route would be described and never run.
    if (byMethod[r.method.toLowerCase()]) {
      throw new Error(`${r.method} ${p} is in the route table twice`);
    }
    byMethod[r.method.toLowerCase()] = op;
    paths[p] = byMethod;
    for (const t of op.tags) if (!tags.includes(t)) tags.push(t);
  }
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "akou",
      version: o.version,
      description:
        "The akou API over HTTP. Every operation is marked with the modes that serve it (`x-akou-modes`: the desktop app, server mode, or both) and the key it needs (`x-akou-access`). Generated from the route table; do not edit by hand.",
      license: { name: "GPL-3.0-or-later", identifier: "GPL-3.0-or-later" },
    },
    servers: [{ url: o.serverUrl ?? LOCAL_SERVER }],
    security: [{ [SECURITY_SCHEME]: [] }],
    tags: tags.map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        [SECURITY_SCHEME]: {
          type: "http",
          scheme: "bearer",
          description:
            "An akou key (`ak_…`) or, on the desktop, the app's token. The key's scope decides which operations it may call.",
        },
      },
      responses: {
        Error: {
          description: "An error, in the one error shape.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        ...Object.fromEntries(Object.entries(refusals).sort(([a], [b]) => a.localeCompare(b))),
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "message"],
          properties: {
            error: { $ref: "#/components/schemas/ErrorCode" },
            message: { type: "string", description: "What went wrong, for a person." },
          },
          additionalProperties: true,
        },
        ErrorCode: {
          type: "string",
          description:
            "A stable code: clients may keep it, so it is never renamed. Each operation lists the codes it answers under each status.",
          oneOf: Object.entries(ERROR_CODES).map(([code, description]) => ({
            const: code,
            description,
          })),
        },
      },
    },
  };
}

/**
 * Whether a `jobs` key may call an operation, and it belongs in the `?scope=jobs` view: a WebSocket
 * is not, since a tool built from it could never hold the socket.
 */
function inJobsView(op: OpenApiOperation): boolean {
  return (
    op["x-akou-access"] !== "admin" &&
    op["x-akou-door"] === undefined &&
    op["x-akou-upgrade"] === undefined
  );
}

/**
 * The copy `GET /v1/openapi.json` serves: the operations of the running mode only, and with
 * `scope: "jobs"` only those a `jobs` key can call, with no compatibility route and not the file
 * itself. A tool for a route that answers 404 or 403 every time would mislead an agent.
 */
export function servedOpenApi(
  full: OpenApiDoc,
  o: { mode: Mode; scope?: Scope; serverUrl: string },
): OpenApiDoc {
  const paths: OpenApiDoc["paths"] = {};
  const used = new Set<string>();
  for (const [p, byMethod] of Object.entries(full.paths)) {
    const kept: Record<string, OpenApiOperation> = {};
    for (const [method, op] of Object.entries(byMethod)) {
      if (!op["x-akou-modes"].includes(o.mode)) continue;
      if (o.scope === "jobs" && !inJobsView(op)) continue;
      kept[method] = op;
      for (const t of op.tags) used.add(t);
    }
    if (Object.keys(kept).length > 0) paths[p] = kept;
  }
  return {
    ...full,
    servers: [{ url: o.serverUrl }],
    tags: full.tags.filter((t) => used.has(t.name)),
    paths,
  };
}

/**
 * The address `servers[0]` names: `server.public_host` when set (a bare host means https, since
 * a proxy terminates TLS in front of it), else the host the request came in on. That host is
 * `http://` only when it is loopback, akou itself; any other Host reached akou through the proxy
 * that SV-D2 requires for a non-loopback bind, so it is `https://`, and a key never travels in
 * clear text because akou saw plain HTTP behind that proxy.
 */
export function serverUrlFor(publicHost: unknown, req: Request): string {
  if (typeof publicHost === "string" && publicHost.trim() !== "") {
    const h = publicHost.trim().replace(/\/+$/, "");
    return /^https?:\/\//.test(h) ? h : `https://${h}`;
  }
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  const loopback = name === "127.0.0.1" || name === "localhost" || name === "[::1]";
  return `${loopback ? new URL(req.url).protocol : "https:"}//${host}`;
}

/** Every operation of a file, with where it is. */
export function operations(
  doc: OpenApiDoc,
): { method: string; path: string; op: OpenApiOperation }[] {
  const out: { method: string; path: string; op: OpenApiOperation }[] = [];
  for (const [path, byMethod] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(byMethod ?? {})) out.push({ method, path, op });
  }
  return out;
}

/** A response, or the component response its `$ref` names; null when the file has no such one. */
export function resolveResponse(doc: OpenApiDoc, r: Json): Json | null {
  const ref = r.$ref;
  if (typeof ref !== "string") return r;
  const prefix = "#/components/responses/";
  if (!ref.startsWith(prefix)) return null;
  return doc.components?.responses?.[ref.slice(prefix.length)] ?? null;
}

/** The codes a refusal's schema names under `error`: its own `enum`, or its `allOf` parts'. */
function refusalCodes(schema: Json | undefined): unknown[] | null {
  if (!schema) return null;
  const parts = [schema, ...((schema.allOf as Json[] | undefined) ?? [])];
  let found: unknown[] | null = null;
  for (const s of parts) {
    const e = ((s.properties as Json | undefined)?.error as Json | undefined)?.enum;
    if (Array.isArray(e)) found = [...(found ?? []), ...e];
  }
  return found;
}

/**
 * PG-A7, as a list of what breaks it: the file lists its codes in `ErrorCode`, and every refusal
 * an operation documents (a 4xx or 5xx response) is the one error shape and names its codes, each
 * one listed.
 */
export function errorProblems(doc: OpenApiDoc): string[] {
  const problems: string[] = [];
  const listed = new Set(
    (((doc.components?.schemas?.ErrorCode as Json | undefined)?.oneOf as Json[] | undefined) ?? [])
      .map((o) => o.const)
      .filter((c): c is string => typeof c === "string"),
  );
  if (listed.size === 0) problems.push("components.schemas.ErrorCode lists no code");
  for (const { method, path, op } of operations(doc)) {
    const where = `${method.toUpperCase()} ${path}`;
    for (const [status, given] of Object.entries(op.responses ?? {})) {
      if (!/^[45]\d\d$/.test(status)) continue;
      const r = resolveResponse(doc, given);
      if (!r) {
        problems.push(`${where} ${status}: ${JSON.stringify(given.$ref)} is not in the file`);
        continue;
      }
      const schema = ((r.content as Json | undefined)?.["application/json"] as Json | undefined)
        ?.schema as Json | undefined;
      const shaped =
        schema?.$ref === "#/components/schemas/Error" ||
        ((schema?.allOf as Json[] | undefined) ?? []).some(
          (s) => s.$ref === "#/components/schemas/Error",
        );
      if (!shaped) problems.push(`${where} ${status}: not the one error shape`);
      const codes = refusalCodes(schema);
      if (!codes || codes.length === 0) {
        problems.push(`${where} ${status}: names no error code`);
        continue;
      }
      for (const c of codes) {
        if (typeof c !== "string" || !listed.has(c)) {
          problems.push(`${where} ${status}: error code ${JSON.stringify(c)} is not listed`);
        }
      }
    }
  }
  return problems;
}

/**
 * The rules of service-interface.md section 2, as a list of what breaks them (empty when the file
 * keeps them all): version 3.1.0; exactly one security scheme, `http` bearer; on every operation
 * one tag, a description, an `operationId` `<tag>.<verb>` unique in the file, `x-akou-modes`, an
 * `x-akou-access` of `open` or a scope, an `x-akou-door` only of `compat` or `spec`, `compat`
 * exactly on the `openai` tag; and every multipart file field `format: binary`.
 */
export function openApiProblems(doc: OpenApiDoc): string[] {
  const problems: string[] = [];
  if (doc.openapi !== OPENAPI_VERSION) {
    problems.push(`openapi is ${JSON.stringify(doc.openapi)}, not ${OPENAPI_VERSION}`);
  }
  const schemes = Object.entries(doc.components?.securitySchemes ?? {});
  if (schemes.length !== 1) {
    problems.push(`${schemes.length} security schemes; Executor wants exactly one`);
  }
  for (const [name, s] of schemes) {
    if (s.type !== "http" || s.scheme !== "bearer") {
      problems.push(`security scheme ${name} is not http bearer`);
    }
  }
  const ids = new Set<string>();
  for (const { method, path, op } of operations(doc)) {
    const where = `${method.toUpperCase()} ${path}`;
    const tags = op.tags ?? [];
    if (tags.length !== 1) problems.push(`${where}: ${tags.length} tags, not one`);
    if (typeof op.description !== "string" || op.description.trim() === "") {
      problems.push(`${where}: no description`);
    }
    const m = OPERATION_ID.exec(op.operationId ?? "");
    if (!m) {
      problems.push(`${where}: operationId ${JSON.stringify(op.operationId)} is not <tag>.<verb>`);
    } else if (m[1] !== tags[0]) {
      problems.push(`${where}: operationId ${op.operationId} is not in its tag ${tags[0]}`);
    }
    if (op.operationId !== undefined) {
      if (ids.has(op.operationId)) problems.push(`${where}: operationId ${op.operationId} twice`);
      ids.add(op.operationId);
    }
    const modes = op["x-akou-modes"];
    if (
      !Array.isArray(modes) ||
      modes.length === 0 ||
      modes.some((x) => !MODES.includes(x as Mode))
    ) {
      problems.push(`${where}: x-akou-modes ${JSON.stringify(modes)} is not a list of modes`);
    }
    const access = op["x-akou-access"];
    if (access !== "open" && !(SCOPES as readonly string[]).includes(access)) {
      problems.push(`${where}: x-akou-access ${JSON.stringify(access)}`);
    }
    const door = op["x-akou-door"];
    if (door !== undefined && door !== "compat" && door !== "spec") {
      problems.push(`${where}: x-akou-door ${JSON.stringify(door)}`);
    }
    const upgrade = op["x-akou-upgrade"];
    if (upgrade !== undefined && (upgrade !== "websocket" || method !== "get")) {
      problems.push(`${where}: x-akou-upgrade ${JSON.stringify(upgrade)}`);
    }
    // The `?scope=jobs` view drops a compatibility route by its door, so the OpenAI dialect must
    // carry it, and nothing else may.
    if (tags[0] === COMPAT_TAG && door !== "compat") {
      problems.push(`${where}: tag ${COMPAT_TAG} without x-akou-door: compat`);
    } else if (door === "compat" && tags[0] !== COMPAT_TAG) {
      problems.push(`${where}: x-akou-door: compat on tag ${tags[0]}, not ${COMPAT_TAG}`);
    }
    const form = (op.requestBody?.content as Json | undefined)?.["multipart/form-data"] as
      | { schema?: { properties?: Record<string, Json> } }
      | undefined;
    for (const [field, s] of Object.entries(form?.schema?.properties ?? {})) {
      const isFile =
        s.format === "binary" ||
        s.format === "byte" ||
        s.contentMediaType !== undefined ||
        s.contentEncoding !== undefined;
      if (isFile && s.format !== "binary") {
        problems.push(`${where}: multipart file field ${field} is not format: binary`);
      }
    }
  }
  return problems;
}
